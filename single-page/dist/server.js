"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config = require('../config');
const debugModule = require('debug');
const mediasoup = __importStar(require("mediasoup"));
const express_1 = __importDefault(require("express"));
const socketio_jwt_1 = __importDefault(require("socketio-jwt"));
const Sentry = __importStar(require("@sentry/node"));
const protocol = __importStar(require("./protocol"));
Sentry.init({ dsn: process.env["SENTRY_DSN"] });
const https = require('https');
const fs = require('fs');
const expressApp = express_1.default();
expressApp.disable("x-powered-by");
// The Sentry handler must be the first middleware in the stack
expressApp.use(Sentry.Handlers.requestHandler());
const log = debugModule('demo-app');
// One worker. If we scale this to multiple CPUs, we should create more workers
let worker;
const emptyRoom = Object.freeze({
    // external
    peers: {},
    // internal
    transports: {},
    producers: [],
    consumers: []
});
const roomState = {};
//
//
// internally, we keep lists of transports, producers, and
// consumers. whenever we create a transport, producer, or consumer,
// we save the remote peerId in the object's `appData`. for producers
// and consumers we also keep track of the client-side "media tag", to
// correlate tracks.
//
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
let io;
function updatePeers(roomId) {
    if (roomId in roomState) {
        io.to(`room:${roomId}`).emit("peers", {
            peers: roomState[roomId].peers
        });
    }
}
function withAsyncHandler(handler) {
    return (req, res, next) => {
        handler(req, res, next).catch((error) => {
            next(error);
        });
    };
}
let applicationSecret;
if (typeof process.env["JWT_SECRET"] !== "string") {
    throw new Error("Missing JWT_SECRET env variable");
}
else {
    applicationSecret = process.env["JWT_SECRET"];
}
//
// main() -- our execution entry point
//
async function main() {
    // start mediasoup
    console.log('starting mediasoup');
    worker = await startMediasoup();
    // start https server, falling back to http if https fails
    console.log('starting express');
    let server;
    try {
        server = createHttpsServer();
    }
    catch (e) {
        if (e.code === 'ENOENT') {
            console.error('no certificates found (check config.js)');
            console.error('  could not start https server ... trying http');
            server = createHttpServer();
        }
        else {
            throw e;
        }
    }
    server.on('error', (e) => {
        console.error('https server error,', e.message);
        process.exit(1);
    });
    server.listen(config.httpPort, config.httpIp, () => {
        console.log(`server is running and listening on ` +
            `https://${config.httpIp}:${config.httpPort}`);
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
    io.on('connection', socketio_jwt_1.default.authorize({
        secret: applicationSecret,
        timeout: 15000 // 15 seconds to send the authentication message
    })).on("authenticated", setSocketHandlers);
}
function setSocketHandlers(socket) {
    function logSocket(msg) {
        console.log(`[${new Date().toISOString()}] ${socket.handshake.address} ${socket.id} ${msg}`);
    }
    logSocket("socketio connection");
    socket.on('disconnect', (reason) => {
        logSocket(`socketio disconnect: ${reason}`);
    });
    socket.on('error', (error) => {
        logSocket(`socketio error:`);
        console.error(error);
    });
    // --> /signaling/join-as-new-peer
    //
    // adds the peer to the roomState data structure and creates a
    // transport that the peer will use for receiving media. returns
    // router rtpCapabilities for mediasoup-client device initialization
    //
    socket.on('join-as-new-peer', withAsyncSocketHandler(async function (data) {
        const request = protocol.joinAsNewPeerRequest(data);
        const { peerId, roomId } = request;
        console.log('join-as-new-peer', peerId, roomId);
        if (!(roomId in roomState)) {
            // Create a new room with a new router
            const mediaCodecs = config.mediasoup.router.mediaCodecs;
            const router = await worker.createRouter({ mediaCodecs });
            roomState[roomId] = Object.assign({ router }, emptyRoom);
        }
        const room = roomState[roomId];
        room.peers[peerId] = {
            joinTs: Date.now(),
            userId: userIdFromSocket(socket),
            media: {}, consumerLayers: {}, stats: { producers: {}, consumers: {} }
        };
        const response = {
            routerRtpCapabilities: room.router.rtpCapabilities
        };
        updatePeers(roomId);
        setSocketHandlersForPeer(socket, peerId, roomId);
        socket.join(`room:${roomId}`);
        return response;
    }));
}
function userIdFromSocket(socket) {
    //@ts-ignore missing definitions for decoded_token
    const decoded_token = socket.decoded_token;
    const userId = Number(decoded_token.sub);
    if (Number.isFinite(userId)) {
        return userId;
    }
    else {
        throw new Error("Expected userId to be a number");
    }
}
function setSocketHandlersForPeer(socket, peerId, roomId) {
    // --> /signaling/leave
    //
    // removes the peer from the roomState data structure and and closes
    // all associated mediasoup objects
    //
    socket.on('leave', withAsyncSocketHandler(async function (data) {
        log('leave', peerId);
        await closePeer(roomId, peerId);
        updatePeers(roomId);
        return ({ left: true });
    }));
    socket.on('disconnect', () => {
        closePeer(roomId, peerId).then(() => {
            updatePeers(roomId);
        }, (error) => {
            console.error(error);
            Sentry.captureException(error);
        });
    });
    socket.on('chat-message', (data) => {
        io.to(`room:${roomId}`).emit('chat-message', {
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
        log('create-transport', peerId, request.direction);
        if (!(roomId in roomState)) {
            throw new Error(`No room ${roomId}`);
        }
        const room = roomState[roomId];
        let transport = await createWebRtcTransport({ router: room.router, peerId, direction: request.direction });
        room.transports[transport.id] = transport;
        let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
        const response = {
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
    socket.on('send-track', withAsyncSocketHandler(async (data) => {
        console.log("send-track");
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
        const room = roomState[roomId];
        const producer = room.producers.find((p) => p.appData.mediaTag === mediaTag &&
            p.appData.peerId === mediaPeerId);
        if (!producer) {
            throw new Error('server-side producer for ' + `${mediaPeerId}:${mediaTag} not found`);
        }
        if (!room.router.canConsume({ producerId: producer.id,
            // @ts-ignore
            rtpCapabilities })) {
            throw new Error(`client cannot consume ${mediaPeerId}:${mediaTag}`);
        }
        const transport = Object.values(room.transports).find((t) => t.appData.peerId === peerId && t.appData.clientDirection === 'recv');
        if (!transport) {
            throw new Error(`server-side recv transport for ${peerId} not found`);
        }
        const consumer = await transport.consume({
            producerId: producer.id,
            // @ts-ignore
            rtpCapabilities,
            paused: true,
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
        room.consumers.push(consumer);
        room.peers[peerId].consumerLayers[consumer.id] = {
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
        const response = {
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
        }
        else {
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
        }
        else {
            console.warn(`resume-producer unable to find roomId ${roomId}`);
        }
        return ({ resumed: true });
    }));
}
main().catch(console.error);
function withAsyncSocketHandler(handler) {
    return (data, callback) => {
        handler(data).then((result) => {
            callback(result);
        }).catch((err) => {
            const eventId = Sentry.captureException(err);
            console.warn(`Error raised (${eventId})`);
            console.error(err);
            callback({ error: err.message, eventId: eventId });
        });
    };
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
//
// -- our minimal signaling is just http polling --
//
// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
expressApp.use(express_1.default.json({ type: '*/*' }));
async function closePeer(roomId, peerId) {
    log('closing peer', peerId);
    const room = roomState[roomId];
    if (room == null) {
        console.log(`closePeer unable to find room ${roomId}`);
    }
    else {
        for (let [id, transport] of Object.entries(room.transports)) {
            if (transport.appData.peerId === peerId) {
                try {
                    await closeTransport(roomId, transport);
                }
                catch (e) {
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
                    console.log(`Closing zombie transport ${id}`);
                    await closeTransport(roomId, transport);
                }
                catch (e) {
                    console.error(e);
                }
            }
            delete roomState[roomId];
        }
    }
}
async function closeTransport(roomId, transport) {
    log('closing transport', transport.id, transport.appData);
    // our producer and consumer event handlers will take care of
    // calling closeProducer() and closeConsumer() on all the producers
    // and consumers associated with this transport
    await transport.close();
    // so all we need to do, after we call transport.close(), is update
    // our roomState data structure
    delete roomState[roomId].transports[transport.id];
}
async function closeProducer(roomId, producer) {
    log('closing producer', producer.id, producer.appData);
    await producer.close();
    const room = roomState[roomId];
    if (room == null) {
        console.warn(`closeProducer unable to find roomId ${roomId}`);
    }
    else {
        // remove this producer from our room.producers list
        room.producers = room.producers.filter((p) => p.id !== producer.id);
        // remove this track's info from our room...mediaTag bookkeeping
        if (room.peers[producer.appData.peerId]) {
            delete (room.peers[producer.appData.peerId]
                .media[producer.appData.mediaTag]);
        }
    }
}
async function closeConsumer(roomId, consumer) {
    log('closing consumer', consumer.id, consumer.appData);
    await consumer.close();
    const room = roomState[roomId];
    if (room == null) {
        console.warn(`closeConsumer unable to find roomId ${roomId}`);
    }
    else {
        // remove this consumer from our room.consumers list
        room.consumers = room.consumers.filter((c) => c.id !== consumer.id);
        // remove layer info from from our room...consumerLayers bookkeeping
        if (room.peers[consumer.appData.peerId]) {
            delete room.peers[consumer.appData.peerId].consumerLayers[consumer.id];
        }
    }
}
async function createWebRtcTransport(params) {
    const { peerId, direction, router } = params;
    const { listenIps, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport;
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
function notFoundHandler(req, res) {
    res.status(404).json({
        error: "This API endpoint doesn't exist",
        code: "not_found"
    });
}
function errorHandler(err, req, res, next) {
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
    }
    else {
        console.warn("Non-Error exception raised: " + String(err));
        const eventId = Sentry.captureException(err);
        sendInternalServerError(res, String(err), eventId);
        next();
    }
}
function sendInternalServerError(res, message, eventId) {
    let string;
    if (process.env["NODE_ENV"] === "development") {
        string = message;
    }
    else {
        if (eventId) {
            string = `Internal Server Error (${eventId})`;
        }
        else {
            string = `Internal Server Error`;
        }
    }
    let obj = {
        error: string,
        code: "internal_error"
    };
    if (eventId) {
        res.status(500).json({ ...obj, eventId });
    }
    else {
        res.status(500).json(obj);
    }
}
//
// stats
//
async function updatePeerStats(roomId) {
    for (let producer of roomState[roomId].producers) {
        if (producer.kind !== 'video') {
            continue;
        }
        try {
            let stats = await producer.getStats(), peerId = producer.appData.peerId;
            roomState[roomId].peers[peerId].stats.producers[producer.id] = stats.map((s) => ({
                bitrate: s.bitrate,
                fractionLost: s.fractionLost,
                jitter: s.jitter,
                score: s.score,
                rid: s.rid
            }));
        }
        catch (e) {
            console.warn('error while updating producer stats', e);
        }
    }
    for (let consumer of roomState[roomId].consumers) {
        try {
            let stats = (await consumer.getStats())
                .find((s) => s.type === 'outbound-rtp'), peerId = consumer.appData.peerId;
            if (!stats || !roomState[roomId].peers[peerId]) {
                continue;
            }
            roomState[peerId].peers[peerId].stats.consumers[consumer.id] = {
                bitrate: stats.bitrate,
                fractionLost: stats.fractionLost,
                score: stats.score
            };
        }
        catch (e) {
            console.warn('error while updating consumer stats', e);
        }
    }
}
