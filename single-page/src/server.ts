const config = require('../config');
const debugModule = require('debug');
import * as mediasoup from "mediasoup";
import express from "express";
import socketio from "socket.io";
import * as Sentry from "@sentry/node";

import * as protocol from "./protocol";

Sentry.init({ dsn: process.env["SENTRY_DSN"] });

const https = require('https');
const fs = require('fs');

const expressApp = express();

expressApp.disable("x-powered-by");

// The Sentry handler must be the first middleware in the stack
expressApp.use(Sentry.Handlers.requestHandler());

const log = debugModule('demo-app');

// TODO: Is this the most graceful way?
import type { Consumer } from "mediasoup/lib/Consumer";
import type { Producer } from "mediasoup/lib/Producer";
import type { Transport } from "mediasoup/lib/Transport";
import type { Router } from "mediasoup/lib/Router";
import type { Worker } from "mediasoup/lib/Worker";

import type { Socket } from "socket.io";

// one mediasoup worker and router
//
let worker: Worker, router: Router;

type Room = {
  peers: { [key: string]: Peer },
  transports: {[key: string]: Transport },
  producers: Array<Producer>,
  consumers: Array<Consumer>
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
// tracks are being sent and received. we also need to know the last
// time we saw the peer, so that we can disconnect clients that have
// network issues.
//
// for this simple demo, each client polls the server at 1hz, and we
// just send this room.peers data structure as our answer to each
// poll request.

type Peer = {
  joinTs: number,
  // TODO: I think this can be completed derived from the producers lists
  media: { [key: string]: Media },
  stats: { 
    producers: {[key: string]: Array<ProducerStats>}
    consumers: {[key: string]: ConsumerStats}
  },
  consumerLayers: {[key: string]: { currentLayer: string | null, clientSelectedLayer: boolean | null } }
};

//
// we also send information about the active speaker, as tracked by
// our audioLevelObserver.
//
// internally, we keep lists of transports, producers, and
// consumers. whenever we create a transport, producer, or consumer,
// we save the remote peerId in the object's `appData`. for producers
// and consumers we also keep track of the client-side "media tag", to
// correlate tracks.
//

//
// our http server needs to send 'index.html' and 'client-bundle.js'.
// might as well just send everything in this directory ...
//

const dir = __dirname.replace(/dist$/, "");
expressApp.use(express.static(dir));

function createHttpsServer() {
  const https = require('https');

  const tls = {
    cert: fs.readFileSync(config.sslCrt),
    key: fs.readFileSync(config.sslKey),
  };
  return https.createServer(tls, expressApp);
}

function createHttpServer() {
  const http = require('http');
  const server = http.createServer(expressApp);
  return server;
}

let io: Socket;

function updatePeers(roomId: string) {
  io.to(`room:${roomId}`).emit("peers", {
    peers: roomState[roomId].peers
  });
}

function withAsyncHandler(handler: express.Handler): express.Handler {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch((error: Error) => {
      next(error);
    });
  };
}

//
// main() -- our execution entry point
//

async function main() {
  // start mediasoup
  console.log('starting mediasoup');
  ({ worker, router } = await startMediasoup());

  // start https server, falling back to http if https fails
  console.log('starting express');
  let server;
  try {
    server = createHttpsServer();
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.error('no certificates found (check config.js)');
      console.error('  could not start https server ... trying http');
      server = createHttpServer();
    } else {
      throw e;
    }
  }

  server.on('error', (e: Error) => {
    console.error('https server error,', e.message);
    process.exit(1);
  });

  server.listen(config.httpPort, config.httpIp, () => {
    console.log(`server is running and listening on ` +
                    `https://${config.httpIp}:${config.httpPort}`);
  });

  // Socket.io
  io = require('socket.io')(server, { serveClient: false });

  io.on('connection', socket => {
    setSocketHandlers(socket);
  });
}

import type { GuardType } from "decoders";

function setSocketHandlers(socket: SocketIO.Socket) {
  function logSocket(msg: string) {
    console.log(`[${new Date().toISOString()}] ${socket.id} ${msg}`)
  }

  logSocket("socketio connection");

  socket.on('disconnect', () => {
    logSocket(`socketio disconnect`);
  });

  socket.on('chat-message', (data: object) => {
    logSocket('chat-message')
    io.emit('chat-message', data);
  });

  // --> /signaling/router-capabilities
  //
  //
  socket.on('router-capabilities', withAsyncSocketHandler(async function() {
    return { routerRtpCapabilities: router.rtpCapabilities };
  }));


  // --> /signaling/join-as-new-peer
  //
  // adds the peer to the roomState data structure and creates a
  // transport that the peer will use for receiving media. returns
  // router rtpCapabilities for mediasoup-client device initialization
  //
  socket.on('join-as-new-peer', withAsyncSocketHandler(async function(data) {
    const request = protocol.joinAsNewPeerRequest(data);
    const {peerId, roomId} = request;
    console.log('join-as-new-peer', peerId, roomId);

    if (!(roomId in roomState)) {
      roomState[roomId] = Object.assign({}, emptyRoom);
    }

    roomState[roomId].peers[peerId] = {
      joinTs: Date.now(),
      media: {}, consumerLayers: {}, stats: { producers: {}, consumers: {}}
    };

    const response: GuardType<typeof protocol.joinAsNewPeerResponse> = { 
      routerRtpCapabilities: router.rtpCapabilities
    };

    updatePeers(roomId);

    setSocketHandlersForPeer(socket, peerId, roomId);

    socket.join(`room:${roomId}`);

    return response;
  }));
}

function setSocketHandlersForPeer(socket: SocketIO.Socket, peerId: string, roomId: string) {
  // --> /signaling/leave
  //
  // removes the peer from the roomState data structure and and closes
  // all associated mediasoup objects
  //
  socket.on('leave', withAsyncSocketHandler(async function(data) {
    log('leave', peerId);

    await closePeer(roomId, peerId);
    updatePeers(roomId);

    return ({ left: true });
  }));

  socket.on('disconnect', async () => {
    log('disconnect', peerId);
    await closePeer(roomId, peerId);
    updatePeers(roomId);
  });

  // --> /signaling/create-transport
  //
  // create a mediasoup transport object and send back info needed
  // to create a transport object on the client side
  //
  socket.on('create-transport', withAsyncSocketHandler(async (data) => {
    const request = protocol.createTransportRequest(data);
    log('create-transport', peerId, request.direction);

    let transport = await createWebRtcTransport({ peerId, direction: request.direction });
    if (roomId in roomState) {
      roomState[roomId].transports[transport.id] = transport;
    } else {
      console.warn(`create-transport unable to find room ${roomId}`);
    }

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
  
    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const transport = roomState[roomId].transports[transportId];
    if (transport == null) {
      throw new Error(`connect-transport: server-side transport ${transportId} not found`);
    }

    log('connect-transport', peerId, transport.appData);

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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const transport = roomState[roomId].transports[transportId];

    if (roomState[roomId].transports[transportId]) {
      throw new Error(`close-transport: server-side transport ${transportId} not found`);
    }

    log('close-transport', peerId, transport.appData);

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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const producer = roomState[roomId].producers.find((p) => p.id === producerId);

    if (!producer) {
      throw new Error(`close-producer: server-side producer ${producerId} not found`);
    }

    log('close-producer', peerId, producer.appData);

    await closeProducer(roomId, producer);

    return { closed: true };

    updatePeers(roomId);
  }));

  // --> /signaling/send-track
  //
  // called from inside a client's `transport.on('produce')` event handler.
  //
  socket.on('/send-track', withAsyncSocketHandler(async (data) => {
    const { transportId, kind, rtpParameters, paused, appData } = protocol.sendTrackRequest(data);

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const transport = roomState[roomId].transports[transportId];

    if (!transport) {
      throw new Error(`send-track: server-side transport ${transportId} not found`);
    }

    const producer = await transport.produce({
      kind,
      // @ts-ignore
      rtpParameters,
      paused,
      appData: { ...appData, peerId, transportId }
    });

    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
      log('producer\'s transport closed', producer.id);
      closeProducer(roomId, producer);
    });

    roomState[roomId].producers.push(producer);
    roomState[roomId].peers[peerId].media[appData.mediaTag] = {
      paused,
      // @ts-ignore
      encodings: rtpParameters.encodings
    };

    updatePeers(roomId);

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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const producer = roomState[roomId].producers.find(
      (p) => p.appData.mediaTag === mediaTag &&
             p.appData.peerId === mediaPeerId
    );

    if (!producer) {
      throw new Error('server-side producer for ' + `${mediaPeerId}:${mediaTag} not found`);
    }

    if (!router.canConsume({ producerId: producer.id, 
      // @ts-ignore
      rtpCapabilities })) {
      throw new Error(`client cannot consume ${mediaPeerId}:${mediaTag}`);
    }

    const transport = Object.values(roomState[roomId].transports).find((t) =>
      t.appData.peerId === peerId && t.appData.clientDirection === 'recv'
    );

    if (!transport) {
      throw new Error(`server-side recv transport for ${peerId} not found`);
    }

    const consumer = await transport.consume({
      producerId: producer.id,
      // @ts-ignore
      rtpCapabilities,
      paused: true, // see note above about always starting paused
      appData: { peerId, mediaPeerId, mediaTag }
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
    roomState[roomId].consumers.push(consumer);
    roomState[roomId].peers[peerId].consumerLayers[consumer.id] = {
      currentLayer: null,
      clientSelectedLayer: null
    };

    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {
      log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
      if (roomState[roomId].peers[peerId] &&
          roomState[roomId].peers[peerId].consumerLayers[consumer.id]) {
        roomState[roomId].peers[peerId].consumerLayers[consumer.id]
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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const consumer = roomState[roomId].consumers.find((c) => c.id === consumerId);

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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const consumer = roomState[roomId].consumers.find((c) => c.id === consumerId);

    if (!consumer) {
      throw new Error(`pause-consumer: server-side consumer ${consumerId} not found`);
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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const consumer = roomState[roomId].consumers.find((c) => c.id === consumerId);

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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const consumer = roomState[roomId].consumers.find((c) => c.id === consumerId);

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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const producer = roomState[roomId].producers.find((p) => p.id === producerId);

    if (!producer) {
      throw new Error(`pause-producer: server-side producer ${producerId} not found`);
    }

    log('pause-producer', producer.appData);

    await producer.pause();

    if (roomState[roomId]) {
      roomState[roomId].peers[peerId].media[producer.appData.mediaTag].paused = true;
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

    if (!(roomId in roomState)) {
      throw new Error(`No room ${roomId}`);
    }

    const producer = roomState[roomId].producers.find((p) => p.id === producerId);

    if (!producer) {
      throw new Error(`resume-producer: server-side producer ${producerId} not found`);
    }

    log('resume-producer', producer.appData);

    await producer.resume();

    if (roomState[roomId]) {
      roomState[roomId].peers[peerId].media[producer.appData.mediaTag].paused = false;
    } else {
      console.warn(`resume-producer unable to find roomId ${roomId}`);
    }

    return ({ resumed: true });
  }));

}

main().catch(console.error);

function withAsyncSocketHandler(
  handler: (data: any) => Promise<any>
): (data: any, callback: (data: any) => void) => void {
  return (data: any, callback: (data: any) => void) => {
    handler(data).then((result: any) => {
      callback(result);
    }
    ).catch((err: Error) => {
      const eventId = Sentry.captureException(err);
      console.warn(`Error raised (${eventId})`);
      console.error(err);
      callback({error: err.message, eventId: eventId})
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

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  const router = await worker.createRouter({ mediaCodecs });

  return { worker, router };
}

//
// -- our minimal signaling is just http polling --
//

// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
expressApp.use(express.json({ type: '*/*' }));

function closePeer(roomId: string, peerId: string) {
  log('closing peer', peerId);
  const room = roomState[roomId];
  if (room == null) {
    console.log(`closePeer unable to find room ${roomId}`);
  } else {
    for (let [id, transport] of Object.entries(room.transports)) {
      if (transport.appData.peerId === peerId) {
        try {
          closeTransport(roomId, transport);
        } catch(e) {
          console.error(e);
        }
      }
    }
    delete room.peers[peerId];
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

async function createWebRtcTransport(params: { peerId: string, direction: string }) {
  const { peerId, direction } = params;
  const {
    listenIps,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

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
