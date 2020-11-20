require('dotenv').config();

const config = require('../config');
const debugModule = require('debug');
import * as mediasoup from "mediasoup";
import express from "express";
import socketio from "socket.io";
import socketioJwt from "socketio-jwt";
import fetch from "node-fetch";

import AWS from "aws-sdk";

import * as Sentry from "@sentry/node";

import * as protocol from "./protocol";

Sentry.init({ dsn: process.env["SENTRY_DSN"] });

const http = require('http');
const fs = require('fs');

const testPortApp = express();
testPortApp.get("/", (req, res) => { res.json({status: "OK"})});
testPortApp.listen(40100)

const expressApp = express();

expressApp.disable("x-powered-by");

// The Sentry handler must be the first middleware in the stack
expressApp.use(Sentry.Handlers.requestHandler());

const log = debugModule('demo-app');

import type { PlainTransport } from "mediasoup/lib/PlainTransport";
import type { Consumer } from "mediasoup/lib/Consumer";
import type { Producer } from "mediasoup/lib/Producer";
import type { Transport, TransportListenIp } from "mediasoup/lib/Transport";
import type { Router } from "mediasoup/lib/Router";
import type { Worker } from "mediasoup/lib/Worker";
import type { AudioLevelObserver, AudioLevelObserverVolume } from "mediasoup/lib/AudioLevelObserver";

import type { Socket } from "socket.io";

let mediaProcessorSocketId: string | null = null

// One worker. If we scale this to multiple CPUs, we should create more workers
let worker: Worker;

type Room = {
  peers: { [key: string]: Peer },
  transports: {[key: string]: Transport },
  producers: Array<Producer>,
  consumers: Array<Consumer>,
  audioLevelObserver: AudioLevelObserver,
  router: Router
};

type Media = {
  paused: boolean,
  encodings: object
};

type ProducerStats = {
  bitrate: number,
  fractionLost: number,
  jitter: number,
  score: number,
  rid: string | undefined
};

type ConsumerStats = {
  bitrate: number,
  fractionLost: number,
  score: number
};

const emptyRoom = Object.freeze({
  // external
  peers: {},
  // internal
  transports: {},
  producers: [],
  consumers: []
});

const roomState: { [roomId: string]: Room } = {};
  
//
// for each peer that connects, we keep a table of peers and what
// tracks are being sent and received. 
//
type Peer = {
  joinTs: number,
  // TODO: I think this can be completely derived from the producers lists
  media: { [key: string]: Media },
  stats: { 
    producers: {[key: string]: Array<ProducerStats>}
    consumers: {[key: string]: ConsumerStats}
  },
  userId: number,
  consumerLayers: {[key: string]: { currentLayer: string | null, clientSelectedLayer: boolean | null } }
};

//
//
// internally, we keep lists of transports, producers, and
// consumers. whenever we create a transport, producer, or consumer,
// we save the remote peerId in the object's `appData`. for producers
// and consumers we also keep track of the client-side "media tag", to
// correlate tracks.
//

let io: SocketIO.Server;

function updatePeers(roomId: string) {
  if (roomId in roomState) {
    emitToRoom(roomId, "peers", {
      peers: roomState[roomId].peers
    });
  }
}

function withAsyncHandler(handler: express.Handler): express.Handler {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch((error: Error) => {
      next(error);
    });
  };
}

let applicationSecret: string;
if (typeof process.env["JWT_SECRET"] !== "string") {
  throw new Error("Missing JWT_SECRET env variable");
} else {
  applicationSecret = process.env["JWT_SECRET"];
}

//
// main() -- our execution entry point
//

async function main() {
  // start mediasoup
  console.log('starting mediasoup');
  worker = await startMediasoup();

  const server = http.createServer(expressApp);

  server.on('error', (e: Error) => {
    console.error(e);
    process.exit(1);
  });

  const httpPort = process.env['PORT'] || 3000;
  server.listen(httpPort, () => {
    console.log(`HTTP server listening on ${httpPort}`);
  });

  //
  // The default for pingTimeout is 5000. This seems very aggressive, especially because
  // timers are throttled when the app runs in background mode.
  // There are some comments about socketio in this thread:
  //  https://mediasoup.discourse.group/t/transport-connectionstate-changes-do-disconnected/1443/8
  //
  io = require('socket.io')(server, { 
    serveClient: false,
    pingInterval: 30000,
    pingTimeout: 30000
  });

  io.use(
    socketioJwt.authorize({
      secret: applicationSecret,
      handshake: true // Allows JWT in the "Authentication" header
    })
  );

  io.on("connect", (socket) => {
    setSocketHandlers(socket).catch(error => {
      Sentry.captureException(error);
    });
  });
}

import type { GuardType } from "decoders";

function emitToRoom(roomId: string, eventName: string, data: object) {
  io.to(`room:${roomId}`).emit(eventName, data);
}

function emitToMediaProcessor(eventName: string, data: object) {
  if (mediaProcessorSocketId == null) {
    console.warn(`Unable to send ${eventName} message. Media processor offline.`)
  } else {
    io.to(mediaProcessorSocketId).emit(eventName, data);
  }
}

async function setSocketHandlers(socket: SocketIO.Socket) {
  function logSocket(msg: string) {
    console.log(`[${new Date().toISOString()}] ${socket.handshake.address} ${socket.id} ${msg}`)
  }

  socket.on('disconnect', (reason) => {
    logSocket(`socketio disconnect: ${reason}`);
  });

  socket.on('error', (error) => {
    logSocket(`socketio error:`);
    console.error(error);
  });

  // @ts-ignore no types for decoded_token
  if (socket.decoded_token.service === "media-processing") {
    setSocketHandlersForMediaProcessor(socket);
  } else {
    //@ts-ignore missing definitions for decoded_token
    logSocket(`user_id=${socket.decoded_token.sub}`);
    setSocketHandlersForUser(socket);
  }
}

async function setSocketHandlersForMediaProcessor(socket: SocketIO.Socket) {
  console.log("Connection from media processor") ;

  const transports: { [id: string]: Transport } = {};
  const consumers: { [id: string]: Consumer } = {};

  if (mediaProcessorSocketId != null) {
    console.warn(`"Media Processor already connected on socket ${mediaProcessorSocketId}`)
  }

  socket.on("recognize-response", (data) => {
    io.to(`producer:${data.producerId}`).emit("recognize-response", data.recognizeResponse);
    //console.log(`sending recognize-response to producer:${data.producerId}`);
  });

  socket.on('disconnect', () => {
    console.log("Disconnection from media processor");
    mediaProcessorSocketId = null;
    
    // Close all transports and remove it from the transport map. This will implicitly close
    // the consumers
    for (let [id, transport] of Object.entries(transports)) {
      transport.close();
      delete transports[id];
    }

    // There's no need to close the consumers, since we already closed the transports.
    // But we empty out the consumer map
    for (let id of Object.keys(consumers)) {
      delete consumers[id];
    }

    // Remove all event handlers to prevent memory leaks
    socket.removeAllListeners();
  });

  socket.on('recv-track', withAsyncSocketHandler(async (data) => {
    const request = protocol.recvRtpTrackRequest(data);

    const room = roomState[request.roomId];
    if (room == null) {
      throw Error(`No such room ${request.roomId}`)
    }

    // TODO: This should be a config file somewhere
    const listenIp: TransportListenIp = { ip: "127.0.0.1" };

    const transport = await room.router.createPlainTransport({
      // No RTP will be received from the remote side
      comedia: false,

      // FFmpeg and GStreamer don't support RTP/RTCP multiplexing ("a=rtcp-mux" in SDP)
      rtcpMux: false,

      listenIp
    });

    transports[transport.id] = transport;

    await transport.connect({
      ip: request.ipAddress,
      port: request.rtpPort,
      rtcpPort: request.rtcpPort,
    });

    console.log(
      "mediasoup AUDIO RTP SEND transport connected: %s:%d <--> %s:%d (%s)",
      transport.tuple.localIp,
      transport.tuple.localPort,
      transport.tuple.remoteIp,
      transport.tuple.remotePort,
      transport.tuple.protocol
    );

    const consumer = await transport.consume({
      producerId: request.producerId,
      rtpCapabilities: room.router.rtpCapabilities, // Assume the recorder supports same formats as mediasoup's router
      paused: false
    });

    consumer.on("producerclose", function() {
      socket.emit("stop-recording", {
        roomId: request.roomId,
        producerId: request.producerId
      });

      delete consumers[consumer.id];
      delete transports[transport.id];

      transport.close();
    });

    consumers[consumer.id] = consumer;

    console.log(
      "mediasoup AUDIO RTP SEND consumer created, kind: %s, type: %s",
      consumer.kind,
      consumer.type
    );

    const ipAddress = (listenIp.ip || listenIp.announcedIp);

    return {
      ipAddress: ipAddress,
      rtpParameters: consumer.rtpParameters
    }
  }));

  mediaProcessorSocketId = socket.id;
}

async function setSocketHandlersForUser(socket: SocketIO.Socket) {
  const { roomId } = socket.handshake.query;
  if (!roomId) {
    console.warn("Missing room ID");
    socket.disconnect();
    return;
  }

  const userId = userIdFromSocket(socket);

  // adds the peer to the roomState data structure and creates a
  // transport that the peer will use for receiving media. returns
  // router rtpCapabilities for mediasoup-client device initialization
  //
  if (!(roomId in roomState)) {
    // Create a new room with a new router
    const mediaCodecs = config.mediasoup.router.mediaCodecs;
    const router = await worker.createRouter({ mediaCodecs });
    const audioLevelObserver = await router.createAudioLevelObserver({
      interval: 500,
      maxEntries: 10
    });

    audioLevelObserver.on("volumes", (volumes: Array<AudioLevelObserverVolume>) => {
      const message = volumes.map(v => ({
        producerId: v.producer.id,
        volume:  v.volume
      }));

      emitToRoom(roomId, "volumes", message);
    });

    audioLevelObserver.on("silence", () => {
      emitToRoom(roomId, "silence", {});
    });

    roomState[roomId] = Object.assign({ router, audioLevelObserver }, emptyRoom);
  }
  const room = roomState[roomId];

  room.peers[socket.id] = {
    joinTs: Date.now(),
    userId: userId,
    media: {}, consumerLayers: {}, stats: { producers: {}, consumers: {}}
  };

  const response: GuardType<typeof protocol.joinAsNewPeerResponse> = { 
    routerRtpCapabilities: room.router.rtpCapabilities
  };
  console.log("sending router-rtp-capabilities");
  socket.emit("router-rtp-capabilities", response);

  updatePeers(roomId);

  setSocketHandlersForRoom(socket, userId, roomId, room);

  socket.join(`room:${roomId}`);
}

function userIdFromSocket(socket: SocketIO.Socket): number {
  //@ts-ignore missing definitions for decoded_token
  const decoded_token = socket.decoded_token;
  const userId = Number(decoded_token.sub);
  if (Number.isFinite(userId)) {
    return userId;
  } else {
    throw new Error("Expected userId to be a number");
  }
}

function setSocketHandlersForRoom(socket: SocketIO.Socket, userId: number, roomId: string, room: Room) {

  socket.on('disconnect', () => {
    // Remove all event handlers to prevent memory leaks
    socket.removeAllListeners();

    console.log("cleanup disconnect handler")

    closePeer(roomId, socket.id).then(() => {
      updatePeers(roomId);
    }, (error) => {
      console.error(error);
      Sentry.captureException(error);
    }) 
  });

  socket.on('chat-message', (data: object) => {
    emitToRoom(roomId, "chat-message", {
      timestamp: Date.now(),
      userId: userIdFromSocket(socket),
      body: data
    });
  });

  // --> /signaling/create-transport
  //
  // create a mediasoup transport object and send back info needed
  // to create a transport object on the client side
  //
  socket.on('create-transport', withAsyncSocketHandler(async (data) => {
    const request = protocol.createTransportRequest(data);
    log('create-transport', socket.id, request.direction);

    let transport = await createWebRtcTransport({ router: room.router, peerId: socket.id, direction: request.direction });
    room.transports[transport.id] = transport;

    let { id, iceParameters, iceCandidates, dtlsParameters } = transport;

    const response: GuardType<typeof protocol.createTransportResponse> = {
      transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
    };

    updatePeers(roomId);
    return response;
  }));

  // --> /signaling/connect-transport
  //
  // called from inside a client's `transport.on('connect')` event
  // handler.
  //
  socket.on('connect-transport', withAsyncSocketHandler(async (data) => {
    const { transportId, dtlsParameters } = protocol.connectTransportRequest(data);

    const transport = room.transports[transportId];
    if (transport == null) {
      throw new Error(`connect-transport: server-side transport ${transportId} not found`);
    }

    log('connect-transport', socket.id, transport.appData);

    await transport.connect({ dtlsParameters });

    updatePeers(roomId);

    return { connected: true };
  }));

  // --> /signaling/close-transport
  //
  // called by a client that wants to close a single transport (for
  // example, a client that is no longer sending any media).
  //
  socket.on('close-transport', withAsyncSocketHandler(async (data) => {
    const { transportId } = protocol.closeTransportRequest(data);

    const transport = room.transports[transportId];

    if (room.transports[transportId]) {
      throw new Error(`close-transport: server-side transport ${transportId} not found`);
    }

    log('close-transport', socket.id, transport.appData);

    await closeTransport(roomId, transport);

    updatePeers(roomId);

    return { closed: true };
  }));

  // --> /signaling/close-producer
  //
  // called by a client that is no longer sending a specific track
  //
  socket.on('close-producer', withAsyncSocketHandler(async (data) => {
    const { producerId } = protocol.closeProducerRequest(data);

    const producer = room.producers.find((p) => p.id === producerId);

    if (!producer) {
      throw new Error(`close-producer: server-side producer ${producerId} not found`);
    }

    log('close-producer', socket.id, producer.appData);

    await closeProducer(roomId, producer);

    return { closed: true };

    updatePeers(roomId);
  }));

  // --> /signaling/send-track
  //
  // called from inside a client's `transport.on('produce')` event handler.
  //
  socket.on('send-track', withAsyncSocketHandler(async (data) => {
    console.log("send-track");
    const { transportId, kind, rtpParameters, paused, appData } = protocol.sendTrackRequest(data);

    const transport = room.transports[transportId];

    if (!transport) {
      throw new Error(`send-track: server-side transport ${transportId} not found`);
    }

    const producer = await transport.produce({
      kind,
      // @ts-ignore
      rtpParameters,
      paused,
      appData: { ...appData, peerId: socket.id, transportId }
    });

    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      log('producer\'s transport closed', producer.id);
      closeProducer(roomId, producer);
    });

    room.producers.push(producer);
    room.peers[socket.id].media[appData.mediaTag] = {
      paused,
      // @ts-ignore
      encodings: rtpParameters.encodings
    };

    room.audioLevelObserver.addProducer({ producerId: producer.id })

    updatePeers(roomId);

    if (appData.recording) {
      emitToMediaProcessor(
        "start-recording", {
          roomId: roomId,
          producerId: producer.id,
          userId,
          nativeLang: appData.nativeLang
        }
      );
    }

    return { id: producer.id };
  }));

  // --> /signaling/recv-track
  //
  // create a mediasoup consumer object, hook it up to a producer here
  // on the server side, and send back info needed to create a consumer
  // object on the client side. always start consumers paused. client
  // will request media to resume when the connection completes
  //
  socket.on('recv-track', withAsyncSocketHandler(async (data) => {
    const { mediaPeerId, mediaTag, rtpCapabilities } = protocol.recvTrackRequest(data);

    const producer = producerFromMediaTag(mediaPeerId, mediaTag);

    if (!room.router.canConsume({ producerId: producer.id, 
      // @ts-ignore
      rtpCapabilities })) {
      throw new Error(`client cannot consume ${mediaPeerId}:${mediaTag}`);
    }

    const transport = Object.values(room.transports).find((t) =>
      t.appData.peerId === socket.id && t.appData.clientDirection === 'recv'
    );

    if (!transport) {
      throw new Error(`server-side recv transport for ${socket.id} not found`);
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      // @ts-ignore
      rtpCapabilities,
      paused: true, // see note above about always starting paused
      appData: { peerId: socket.id, mediaPeerId, mediaTag }
    });

    // need both 'transportclose' and 'producerclose' event handlers,
    // to make sure we close and clean up consumers in all
    // circumstances
    consumer.on('transportclose', () => {
      log(`consumer's transport closed`, consumer.id);
      closeConsumer(roomId, consumer);
    });
    consumer.on('producerclose', () => {
      log(`consumer's producer closed`, consumer.id);
      closeConsumer(roomId, consumer);
    });

    // stick this consumer in our list of consumers to keep track of,
    // and create a data structure to track the client-relevant state
    // of this consumer
    room.consumers.push(consumer);
    room.peers[socket.id].consumerLayers[consumer.id] = {
      currentLayer: null,
      clientSelectedLayer: null
    };

    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {
      log(`consumer layerschange ${mediaPeerId}->${socket.id}`, mediaTag, layers);
      if (roomState[roomId].peers[socket.id] &&
          roomState[roomId].peers[socket.id].consumerLayers[consumer.id]) {
        roomState[roomId].peers[socket.id].consumerLayers[consumer.id]
          .currentLayer = layers && layers.spatialLayer;
      }
    });

    const response: GuardType<typeof protocol.recvTrackResponse> = {
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    };

    return response;
  }));

  // --> /signaling/pause-consumer
  //
  // called to pause receiving a track for a specific client
  //
  socket.on('pause-consumer', withAsyncSocketHandler(async (data) => {
    const { consumerId } = protocol.pauseConsumerRequest(data);

    const consumer = room.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      throw new Error(`pause-consumer: server-side consumer ${consumerId} not found`);
      return;
    }

    log('pause-consumer', consumer.appData);

    await consumer.pause();

    return { paused: true };
  }));

  // --> /signaling/resume-consumer
  //
  // called to resume receiving a track for a specific client
  //
  socket.on('resume-consumer', withAsyncSocketHandler(async (data) => {
    const { consumerId } = protocol.resumeConsumerRequest(data);
    const consumer = room.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      throw new Error(`resume-consumer: server-side consumer ${consumerId} not found`);
    }

    log('resume-consumer', consumer.appData);

    await consumer.resume();

    return { resumed: true };
  }));

  // --> /signaling/close-consumer
  //
  // called to stop receiving a track for a specific client. close and
  // clean up consumer object
  //
  socket.on('close-consumer', withAsyncSocketHandler(async (data) => {
    const { consumerId } = protocol.closeConsumerRequest(data);

    const consumer = room.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      throw new Error(`close-consumer: server-side consumer ${consumerId} not found`);
    }

    await closeConsumer(roomId, consumer);

    return ({ closed: true });
  }));

  // --> /signaling/consumer-set-layers
  //
  // called to set the largest spatial layer that a specific client
  // wants to receive
  //
  socket.on('consumer-set-layers', withAsyncSocketHandler(async (data) => {
    const { consumerId, spatialLayer } = data;
    const consumer = room.consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      throw new Error(`consumer-set-layers: server-side consumer ${consumerId} not found`);
    }

    log('consumer-set-layers', spatialLayer, consumer.appData);

    await consumer.setPreferredLayers({ spatialLayer });

    return { layersSet: true };
  }));

  // --> /signaling/pause-producer
  //
  // called to stop sending a track from a specific client
  // 
  socket.on('pause-producer', withAsyncSocketHandler(async (data) => {
    const { producerId } = protocol.pauseProducerRequest(data);

    const producer = room.producers.find((p) => p.id === producerId);

    if (!producer) {
      throw new Error(`pause-producer: server-side producer ${producerId} not found`);
    }

    log('pause-producer', producer.appData);

    await producer.pause();

    if (roomState[roomId]) {
      roomState[roomId].peers[socket.id].media[producer.appData.mediaTag].paused = true;
    } else {
      console.warn(`pause-producer unable to find roomId ${roomId}`);
    }

    return { paused: true };
  }));

  // --> /signaling/resume-producer
  //
  // called to resume sending a track from a specific client
  //
  socket.on('resume-producer', withAsyncSocketHandler(async (data) => {
    const { producerId } = protocol.resumeProducerRequest(data);

    const producer = room.producers.find((p) => p.id === producerId);

    if (!producer) {
      throw new Error(`resume-producer: server-side producer ${producerId} not found`);
    }

    log('resume-producer', producer.appData);

    await producer.resume();

    room.peers[socket.id].media[producer.appData.mediaTag].paused = false;

    return ({ resumed: true });
  }));

  socket.on('start-transcribing', withAsyncSocketHandler(async (data) => {
    //@ts-ignore missing definitions for decoded_token
    const decoded_token = socket.decoded_token;
    if (!decoded_token.transcriptions) {
      throw new Error("JWT does not have a grant for transcriptions")
    }

    const request = protocol.startTranscribingRequest(data);

    logSocket(`start-transcribing peerId=${request.peerId}`);

    const producer = producerFromMediaTag(request.peerId, request.mediaTag);

    emitToMediaProcessor("start-transcribing", { producerId: producer.id });
    socket.join(`producer:${producer.id}`);
  }));

  socket.on('stop-transcribing', withAsyncSocketHandler(async (data) => {
    const request = protocol.stopTranscribingRequest(data);
    logSocket(`stop-transcribing peerId=${request.peerId}`);
    const producer = producerFromMediaTag(request.peerId, request.mediaTag);
    emitToMediaProcessor("stop-transcribing", { producerId: producer.id });
    socket.leave(`producer:${producer.id}`);
  }));

  function producerFromMediaTag(peerId: string, mediaTag: string): Producer {
    const producer = room.producers.find(
      (p) => p.appData.mediaTag === mediaTag &&
             p.appData.peerId === peerId
    );

    if (!producer) {
      throw new Error('Producer for ' + `${peerId}:${mediaTag} not found`);
    }

    return producer;
  }

  function logSocket(msg: string) {
    console.log(`[${new Date().toISOString()}] user_id=${userId} ${msg}`)
  }

}

main().catch(console.error);

function withAsyncSocketHandler(
  handler: (data: any) => Promise<any>
): (data: any, callback: (data: any) => void) => void {
  return (data: any, callback: (data: any) => void | undefined) => {
    handler(data).then((result: any) => {
      if (callback) {
        callback(result);
      }
    }
    ).catch((err: Error) => {
      const eventId = Sentry.captureException(err);
      console.warn(`Error raised (${eventId})`);
      console.error(err);
      if (callback) {
        callback({error: err.message, eventId: eventId})
      }
    });
  }
}

//
// start mediasoup with a single worker and router
//

async function startMediasoup() {
  let worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died (this should never happen)');
    process.exit(1);
  });

  return worker;
}

async function closePeer(roomId: string, peerId: string) {
  log('closing peer', peerId);
  const room = roomState[roomId];
  if (room == null) {
    console.log(`closePeer unable to find room ${roomId}`);
  } else {
    for (let [id, transport] of Object.entries(room.transports)) {
      if (transport.appData.peerId === peerId) {
        try {
          await closeTransport(roomId, transport);
        } catch(e) {
          console.error(e);
        }
      }
    }
    delete room.peers[peerId];

    if (Object.keys(room.peers).length === 0) {

      console.log(`Closing room ${roomId}`);
      
      // Close any remaining transports (there shouldn't be any though if the room is empty)
      for (let [id, transport] of Object.entries(room.transports)) {
        try {
          console.log(`Closing zombie transport ${id}`)
          await closeTransport(roomId, transport);
        } catch(e) {
          console.error(e);
        }
      }

      delete roomState[roomId];
    }
  }
}

async function closeTransport(roomId: string, transport: Transport) {
  log('closing transport', transport.id, transport.appData);

  // our producer and consumer event handlers will take care of
  // calling closeProducer() and closeConsumer() on all the producers
  // and consumers associated with this transport
  await transport.close();

  // so all we need to do, after we call transport.close(), is update
  // our roomState data structure
  delete roomState[roomId].transports[transport.id];
}

async function closeProducer(roomId: string, producer: Producer) {
  log('closing producer', producer.id, producer.appData);
  await producer.close();

  const room = roomState[roomId];
  if (room == null) {
    console.warn(`closeProducer unable to find roomId ${roomId}`);
  } else {
    // remove this producer from our room.producers list
    room.producers = room.producers.filter((p) => p.id !== producer.id);

    // remove this track's info from our room...mediaTag bookkeeping
    if (room.peers[producer.appData.peerId]) {
      delete (room.peers[producer.appData.peerId]
              .media[producer.appData.mediaTag]);
    }
  }
}

async function closeConsumer(roomId: string, consumer: Consumer) {
  log('closing consumer', consumer.id, consumer.appData);
  await consumer.close();

  const room = roomState[roomId];
  if (room == null) {
    console.warn(`closeConsumer unable to find roomId ${roomId}`);
  } else {
    // remove this consumer from our room.consumers list
    room.consumers = room.consumers.filter((c) => c.id !== consumer.id);

    // remove layer info from from our room...consumerLayers bookkeeping
    if (room.peers[consumer.appData.peerId]) {
      delete room.peers[consumer.appData.peerId].consumerLayers[consumer.id];
    }
  }
}

//
// Uses the AWS SDK to get the public IP address for a given ECS Task.
//
// This is way more complicated than I think it should be. Hopefully amazon improves
// their metadata API
//
async function getPublicIP(taskArn: string): Promise<string> {
  const ecs = new AWS.ECS();

  const tasks = await ecs.describeTasks({
    tasks: [taskArn],
    cluster: 'hilokal'}
  ).promise();

  if (!tasks.tasks || tasks.tasks.length == 0) {
    throw new Error("Unable to find task");
  }

  if (!tasks.tasks[0].attachments) {
    throw new Error("Unable to attachments");
  }

  const networkInterface = tasks.tasks[0].attachments.find(a => a.type === "ElasticNetworkInterface");
  if (networkInterface == null) {
    throw Error("Unable to find ElasticNetworkInterface");
  }

  if (!networkInterface.details) {
    throw new Error("Unable to find NetworkInterface details")
  }

  const item = networkInterface.details.find(d => d.name === "networkInterfaceId");
  if (item == null || item.value == null) {
    throw new Error("Unable to find detworkInterfaceId")
  }
  const eni = item.value;

  const ec2 = new AWS.EC2();

  const interfaces = await ec2.describeNetworkInterfaces({NetworkInterfaceIds: [eni]}).promise();

  if (interfaces["NetworkInterfaces"] && interfaces["NetworkInterfaces"][0]['Association'] && interfaces["NetworkInterfaces"][0]['Association']['PublicIp']) {
    return interfaces["NetworkInterfaces"][0]['Association']['PublicIp'];
  } else {
    throw new Error("Unable to find PublicIp");
  }
}

async function getListenIps(): Promise<Array<TransportListenIp>> {

  // https://docs.aws.amazon.com/AmazonECS/latest/userguide/task-metadata-endpoint-v4-fargate.html
  const metadataUrl = process.env['ECS_CONTAINER_METADATA_URI_V4'];

  if (metadataUrl) {
    const metadata = await fetch(metadataUrl).then(r => r.json());
    const taskArn = metadata["Labels"]["com.amazonaws.ecs.task-arn"];
    const publicIp = await getPublicIP(taskArn);
    return [{ ip: "0.0.0.0", announcedIp: publicIp }];
  } else {
    return [{ ip: '127.0.0.1' }];
  }
}

const listenIpsPromise = getListenIps();

listenIpsPromise.then(result => {
  console.log("ListenIps: " + JSON.stringify(result));
}, (e) => {
  console.error(e);
  Sentry.captureException(e);
  process.exit(1);
});

async function createWebRtcTransport(params: { router: Router, peerId: string, direction: string }) {
  const { peerId, direction, router } = params;
  const {
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const listenIps = await listenIpsPromise;

  const transport = await router.createWebRtcTransport({
    listenIps: listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
    appData: { peerId, clientDirection: direction }
  });

  return transport;
}

let deployment: object;
try {
 deployment = require("../deploy");
} catch {
  deployment = { "commit": "development" };
}

expressApp.get("/health-check", (req, res) => {
  res.json(deployment);
});

expressApp.use(notFoundHandler);
expressApp.use(errorHandler);

function notFoundHandler(
  req: express.Request,
  res: express.Response
) {
  res.status(404).json({
    error: "This API endpoint doesn't exist",
    code: "not_found"
  });
}

function errorHandler(
  err: object,
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (err instanceof Error) {
    switch (err.name) {
      // This is thrown by express-jwt
      case "UnauthorizedError":
        res.status(401).json({ error: err.message, code: "unauthorized" });
        break;
      case "ValidationError":
        res.status(400).json({ error: err.message, code: "validation_error" });
        break;
      default: {
        const eventId = Sentry.captureException(err);
        console.warn(`Error raised (${eventId})`);
        console.error(err);

        sendInternalServerError(res, err.toString(), eventId);
        next();
      }
    }
  } else {
    console.warn("Non-Error exception raised: " + String(err));
    const eventId = Sentry.captureException(err);

    sendInternalServerError(res, String(err), eventId);
    next();
  }
}

function sendInternalServerError(
  res: express.Response,
  message: string,
  eventId: string | null
) {
  let string;
  if (process.env["NODE_ENV"] === "development") {
    string = message;
  } else {
    if (eventId) {
      string = `Internal Server Error (${eventId})`;
    } else {
      string = `Internal Server Error`;
    }
  }

  let obj = {
    error: string,
    code: "internal_error"
  };

  if (eventId) {
    res.status(500).json({ ...obj, eventId });
  } else {
    res.status(500).json(obj);
  }
}

//
// stats
//

async function updatePeerStats(roomId: string) {
  for (let producer of roomState[roomId].producers) {
    if (producer.kind !== 'video') {
      continue;
    }
    try {
      let stats = await producer.getStats(),
          peerId = producer.appData.peerId;
      roomState[roomId].peers[peerId].stats.producers[producer.id] = stats.map((s) => ({
        bitrate: s.bitrate,
        fractionLost: s.fractionLost,
        jitter: s.jitter,
        score: s.score,
        rid: s.rid
      }));
    } catch (e) {
      console.warn('error while updating producer stats', e);
    }
  }

  for (let consumer of roomState[roomId].consumers) {
    try {
      let stats = (await consumer.getStats())
                    .find((s) => s.type === 'outbound-rtp'),
          peerId = consumer.appData.peerId;
      if (!stats || !roomState[roomId].peers[peerId]) {
        continue;
      }
      roomState[peerId].peers[peerId].stats.consumers[consumer.id] = {
        bitrate: stats.bitrate,
        fractionLost: stats.fractionLost,
        score: stats.score
      }
    } catch (e) {
      console.warn('error while updating consumer stats', e);
    }
  }
}
