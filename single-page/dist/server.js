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
const Sentry = __importStar(require("@sentry/node"));
Sentry.init({ dsn: process.env["SENTRY_DSN"] });
const https = require('https');
const fs = require('fs');
const expressApp = express_1.default();
expressApp.disable("x-powered-by");
// The Sentry handler must be the first middleware in the stack
expressApp.use(Sentry.Handlers.requestHandler());
let httpsServer;
const log = debugModule('demo-app');
const warn = debugModule('demo-app:WARN');
const err = debugModule('demo-app:ERROR');
// one mediasoup worker and router
//
let worker, router, audioLevelObserver;
//
// and one "room" ...
//
const roomState = {
    // external
    peers: {},
    activeSpeaker: { producerId: null, volume: null, peerId: null },
    // internal
    transports: {},
    producers: [],
    consumers: []
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
expressApp.use(express_1.default.static(__dirname));
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
function updatePeers() {
    io.emit("peers", {
        peers: roomState.peers,
        activeSpeaker: roomState.activeSpeaker
    });
}
function withAsyncHandler(handler) {
    return (req, res, next) => {
        handler(req, res, next).catch((error) => {
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
    ({ worker, router, audioLevelObserver } = await startMediasoup());
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
    // Socket.io
    io = require('socket.io')(server, { serveClient: false });
    io.on('connection', socket => {
        function logSocket(msg) {
            console.log(`[${new Date().toISOString()}] ${socket.id} ${msg}`);
        }
        logSocket("socketio connection");
        socket.emit("peers", {
            peers: roomState.peers,
            activeSpeaker: roomState.activeSpeaker
        });
        socket.on('disconnect', () => {
            logSocket(`socketio disconnect`);
        });
        socket.on('chat-message', (data) => {
            logSocket('chat-message');
            io.emit('chat-message', data);
        });
    });
    // periodically clean up peers that disconnected without sending us
    // a final "beacon"
    setInterval(() => {
        let now = Date.now();
        Object.entries(roomState.peers).forEach(([id, p]) => {
            if ((now - p.lastSeenTs) > config.httpPeerStale) {
                warn(`removing stale peer ${id}`);
                closePeer(id);
                updatePeers();
            }
        });
    }, 1000);
    // periodically update video stats we're sending to peers
    setInterval(updatePeerStats, 3000);
}
main().catch(console.error);
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
    // audioLevelObserver for signaling active speaker
    //
    const audioLevelObserver = await router.createAudioLevelObserver({
        interval: 800
    });
    audioLevelObserver.on('volumes', (volumes) => {
        const { producer, volume } = volumes[0];
        log('audio-level volumes event', producer.appData.peerId, volume);
        roomState.activeSpeaker.producerId = producer.id;
        roomState.activeSpeaker.volume = volume;
        roomState.activeSpeaker.peerId = producer.appData.peerId;
    });
    audioLevelObserver.on('silence', () => {
        log('audio-level silence event');
        roomState.activeSpeaker.producerId = null;
        roomState.activeSpeaker.volume = null;
        roomState.activeSpeaker.peerId = null;
    });
    return { worker, router, audioLevelObserver };
}
//
// -- our minimal signaling is just http polling --
//
// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
expressApp.use(express_1.default.json({ type: '*/*' }));
// --> /signaling/sync
//
// client polling endpoint. send back our 'peers' data structure and
// 'activeSpeaker' info
//
expressApp.post('/signaling/sync', withAsyncHandler(async (req, res) => {
    let { peerId } = req.body;
    // make sure this peer is connected. if we've disconnected the
    // peer because of a network outage we want the peer to know that
    // happened, when/if it returns
    if (!roomState.peers[peerId]) {
        throw new Error('not connected');
    }
    // update our most-recently-seem timestamp -- we're not stale!
    roomState.peers[peerId].lastSeenTs = Date.now();
    res.send({
        peers: roomState.peers,
        activeSpeaker: roomState.activeSpeaker
    });
}));
// --> /signaling/join-as-new-peer
//
// adds the peer to the roomState data structure and creates a
// transport that the peer will use for receiving media. returns
// router rtpCapabilities for mediasoup-client device initialization
//
expressApp.post('/signaling/join-as-new-peer', withAsyncHandler(async (req, res) => {
    let { peerId } = req.body, now = Date.now();
    log('join-as-new-peer', peerId);
    roomState.peers[peerId] = {
        joinTs: now,
        lastSeenTs: now,
        media: {}, consumerLayers: {}, stats: { producers: {}, consumers: {} }
    };
    res.send({ routerRtpCapabilities: router.rtpCapabilities });
    updatePeers();
}));
// --> /signaling/router-capabilities
//
//
expressApp.post('/signaling/router-capabilities', withAsyncHandler(async (req, res) => {
    res.send({ routerRtpCapabilities: router.rtpCapabilities });
}));
// --> /signaling/leave
//
// removes the peer from the roomState data structure and and closes
// all associated mediasoup objects
//
expressApp.post('/signaling/leave', withAsyncHandler(async (req, res) => {
    let { peerId } = req.body;
    log('leave', peerId);
    await closePeer(peerId);
    res.send({ left: true });
    updatePeers();
}));
function closePeer(peerId) {
    log('closing peer', peerId);
    for (let [id, transport] of Object.entries(roomState.transports)) {
        if (transport.appData.peerId === peerId) {
            closeTransport(transport);
        }
    }
    delete roomState.peers[peerId];
}
async function closeTransport(transport) {
    try {
        log('closing transport', transport.id, transport.appData);
        // our producer and consumer event handlers will take care of
        // calling closeProducer() and closeConsumer() on all the producers
        // and consumers associated with this transport
        await transport.close();
        // so all we need to do, after we call transport.close(), is update
        // our roomState data structure
        delete roomState.transports[transport.id];
    }
    catch (e) {
        err(e);
    }
}
async function closeProducer(producer) {
    log('closing producer', producer.id, producer.appData);
    await producer.close();
    // remove this producer from our roomState.producers list
    roomState.producers = roomState.producers
        .filter((p) => p.id !== producer.id);
    // remove this track's info from our roomState...mediaTag bookkeeping
    if (roomState.peers[producer.appData.peerId]) {
        delete (roomState.peers[producer.appData.peerId]
            .media[producer.appData.mediaTag]);
    }
}
async function closeConsumer(consumer) {
    log('closing consumer', consumer.id, consumer.appData);
    await consumer.close();
    // remove this consumer from our roomState.consumers list
    roomState.consumers = roomState.consumers.filter((c) => c.id !== consumer.id);
    // remove layer info from from our roomState...consumerLayers bookkeeping
    if (roomState.peers[consumer.appData.peerId]) {
        delete roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id];
    }
}
// --> /signaling/create-transport
//
// create a mediasoup transport object and send back info needed
// to create a transport object on the client side
//
expressApp.post('/signaling/create-transport', withAsyncHandler(async (req, res) => {
    let { peerId, direction } = req.body;
    log('create-transport', peerId, direction);
    let transport = await createWebRtcTransport({ peerId, direction });
    roomState.transports[transport.id] = transport;
    let { id, iceParameters, iceCandidates, dtlsParameters } = transport;
    res.send({
        transportOptions: { id, iceParameters, iceCandidates, dtlsParameters }
    });
    updatePeers();
}));
async function createWebRtcTransport(params) {
    const { peerId, direction } = params;
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
// --> /signaling/connect-transport
//
// called from inside a client's `transport.on('connect')` event
// handler.
//
expressApp.post('/signaling/connect-transport', withAsyncHandler(async (req, res) => {
    let { peerId, transportId, dtlsParameters } = req.body, transport = roomState.transports[transportId];
    if (!transport) {
        err(`connect-transport: server-side transport ${transportId} not found`);
        res.send({ error: `server-side transport ${transportId} not found` });
        return;
    }
    log('connect-transport', peerId, transport.appData);
    await transport.connect({ dtlsParameters });
    res.send({ connected: true });
    updatePeers();
}));
// --> /signaling/close-transport
//
// called by a client that wants to close a single transport (for
// example, a client that is no longer sending any media).
//
expressApp.post('/signaling/close-transport', withAsyncHandler(async (req, res) => {
    let { peerId, transportId } = req.body, transport = roomState.transports[transportId];
    if (!transport) {
        err(`close-transport: server-side transport ${transportId} not found`);
        res.send({ error: `server-side transport ${transportId} not found` });
        return;
    }
    log('close-transport', peerId, transport.appData);
    await closeTransport(transport);
    res.send({ closed: true });
    updatePeers();
}));
// --> /signaling/close-producer
//
// called by a client that is no longer sending a specific track
//
expressApp.post('/signaling/close-producer', withAsyncHandler(async (req, res) => {
    let { peerId, producerId } = req.body, producer = roomState.producers.find((p) => p.id === producerId);
    if (!producer) {
        err(`close-producer: server-side producer ${producerId} not found`);
        res.send({ error: `server-side producer ${producerId} not found` });
        return;
    }
    log('close-producer', peerId, producer.appData);
    await closeProducer(producer);
    res.send({ closed: true });
    updatePeers();
}));
// --> /signaling/send-track
//
// called from inside a client's `transport.on('produce')` event handler.
//
expressApp.post('/signaling/send-track', withAsyncHandler(async (req, res) => {
    let { peerId, transportId, kind, rtpParameters, paused = false, appData } = req.body, transport = roomState.transports[transportId];
    if (!transport) {
        err(`send-track: server-side transport ${transportId} not found`);
        res.send({ error: `server-side transport ${transportId} not found` });
        return;
    }
    let producer = await transport.produce({
        kind,
        rtpParameters,
        paused,
        appData: { ...appData, peerId, transportId }
    });
    // if our associated transport closes, close ourself, too
    producer.on('transportclose', () => {
        log('producer\'s transport closed', producer.id);
        closeProducer(producer);
    });
    // monitor audio level of this producer. we call addProducer() here,
    // but we don't ever need to call removeProducer() because the core
    // AudioLevelObserver code automatically removes closed producers
    if (producer.kind === 'audio') {
        audioLevelObserver.addProducer({ producerId: producer.id });
    }
    roomState.producers.push(producer);
    roomState.peers[peerId].media[appData.mediaTag] = {
        paused,
        encodings: rtpParameters.encodings
    };
    res.send({ id: producer.id });
    updatePeers();
}));
// --> /signaling/recv-track
//
// create a mediasoup consumer object, hook it up to a producer here
// on the server side, and send back info needed to create a consumer
// object on the client side. always start consumers paused. client
// will request media to resume when the connection completes
//
expressApp.post('/signaling/recv-track', withAsyncHandler(async (req, res) => {
    let { peerId, mediaPeerId, mediaTag, rtpCapabilities } = req.body;
    let producer = roomState.producers.find((p) => p.appData.mediaTag === mediaTag &&
        p.appData.peerId === mediaPeerId);
    if (!producer) {
        let msg = 'server-side producer for ' +
            `${mediaPeerId}:${mediaTag} not found`;
        err('recv-track: ' + msg);
        res.send({ error: msg });
        return;
    }
    if (!router.canConsume({ producerId: producer.id,
        rtpCapabilities })) {
        let msg = `client cannot consume ${mediaPeerId}:${mediaTag}`;
        err(`recv-track: ${peerId} ${msg}`);
        res.send({ error: msg });
        return;
    }
    let transport = Object.values(roomState.transports).find((t) => t.appData.peerId === peerId && t.appData.clientDirection === 'recv');
    if (!transport) {
        let msg = `server-side recv transport for ${peerId} not found`;
        err('recv-track: ' + msg);
        res.send({ error: msg });
        return;
    }
    let consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: true,
        appData: { peerId, mediaPeerId, mediaTag }
    });
    // need both 'transportclose' and 'producerclose' event handlers,
    // to make sure we close and clean up consumers in all
    // circumstances
    consumer.on('transportclose', () => {
        log(`consumer's transport closed`, consumer.id);
        closeConsumer(consumer);
    });
    consumer.on('producerclose', () => {
        log(`consumer's producer closed`, consumer.id);
        closeConsumer(consumer);
    });
    // stick this consumer in our list of consumers to keep track of,
    // and create a data structure to track the client-relevant state
    // of this consumer
    roomState.consumers.push(consumer);
    roomState.peers[peerId].consumerLayers[consumer.id] = {
        currentLayer: null,
        clientSelectedLayer: null
    };
    // update above data structure when layer changes.
    consumer.on('layerschange', (layers) => {
        log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers);
        if (roomState.peers[peerId] &&
            roomState.peers[peerId].consumerLayers[consumer.id]) {
            roomState.peers[peerId].consumerLayers[consumer.id]
                .currentLayer = layers && layers.spatialLayer;
        }
    });
    res.send({
        producerId: producer.id,
        id: consumer.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        type: consumer.type,
        producerPaused: consumer.producerPaused
    });
}));
// --> /signaling/pause-consumer
//
// called to pause receiving a track for a specific client
//
expressApp.post('/signaling/pause-consumer', withAsyncHandler(async (req, res) => {
    let { peerId, consumerId } = req.body, consumer = roomState.consumers.find((c) => c.id === consumerId);
    if (!consumer) {
        err(`pause-consumer: server-side consumer ${consumerId} not found`);
        res.send({ error: `server-side producer ${consumerId} not found` });
        return;
    }
    log('pause-consumer', consumer.appData);
    await consumer.pause();
    res.send({ paused: true });
}));
// --> /signaling/resume-consumer
//
// called to resume receiving a track for a specific client
//
expressApp.post('/signaling/resume-consumer', withAsyncHandler(async (req, res) => {
    let { peerId, consumerId } = req.body, consumer = roomState.consumers.find((c) => c.id === consumerId);
    if (!consumer) {
        err(`pause-consumer: server-side consumer ${consumerId} not found`);
        res.send({ error: `server-side consumer ${consumerId} not found` });
        return;
    }
    log('resume-consumer', consumer.appData);
    await consumer.resume();
    res.send({ resumed: true });
}));
// --> /signalign/close-consumer
//
// called to stop receiving a track for a specific client. close and
// clean up consumer object
//
expressApp.post('/signaling/close-consumer', withAsyncHandler(async (req, res) => {
    let { peerId, consumerId } = req.body, consumer = roomState.consumers.find((c) => c.id === consumerId);
    if (!consumer) {
        err(`close-consumer: server-side consumer ${consumerId} not found`);
        res.send({ error: `server-side consumer ${consumerId} not found` });
        return;
    }
    await closeConsumer(consumer);
    res.send({ closed: true });
}));
// --> /signaling/consumer-set-layers
//
// called to set the largest spatial layer that a specific client
// wants to receive
//
expressApp.post('/signaling/consumer-set-layers', withAsyncHandler(async (req, res) => {
    let { peerId, consumerId, spatialLayer } = req.body, consumer = roomState.consumers.find((c) => c.id === consumerId);
    if (!consumer) {
        err(`consumer-set-layers: server-side consumer ${consumerId} not found`);
        res.send({ error: `server-side consumer ${consumerId} not found` });
        return;
    }
    log('consumer-set-layers', spatialLayer, consumer.appData);
    await consumer.setPreferredLayers({ spatialLayer });
    res.send({ layersSet: true });
}));
// --> /signaling/pause-producer
//
// called to stop sending a track from a specific client
//
expressApp.post('/signaling/pause-producer', withAsyncHandler(async (req, res) => {
    let { peerId, producerId } = req.body, producer = roomState.producers.find((p) => p.id === producerId);
    if (!producer) {
        err(`pause-producer: server-side producer ${producerId} not found`);
        res.send({ error: `server-side producer ${producerId} not found` });
        return;
    }
    log('pause-producer', producer.appData);
    await producer.pause();
    roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;
    res.send({ paused: true });
}));
// --> /signaling/resume-producer
//
// called to resume sending a track from a specific client
//
expressApp.post('/signaling/resume-producer', withAsyncHandler(async (req, res) => {
    let { peerId, producerId } = req.body, producer = roomState.producers.find((p) => p.id === producerId);
    if (!producer) {
        err(`resume-producer: server-side producer ${producerId} not found`);
        res.send({ error: `server-side producer ${producerId} not found` });
        return;
    }
    log('resume-producer', producer.appData);
    await producer.resume();
    roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;
    res.send({ resumed: true });
}));
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
async function updatePeerStats() {
    for (let producer of roomState.producers) {
        if (producer.kind !== 'video') {
            continue;
        }
        try {
            let stats = await producer.getStats(), peerId = producer.appData.peerId;
            roomState.peers[peerId].stats.producers[producer.id] = stats.map((s) => ({
                bitrate: s.bitrate,
                fractionLost: s.fractionLost,
                jitter: s.jitter,
                score: s.score,
                rid: s.rid
            }));
        }
        catch (e) {
            warn('error while updating producer stats', e);
        }
    }
    for (let consumer of roomState.consumers) {
        try {
            let stats = (await consumer.getStats())
                .find((s) => s.type === 'outbound-rtp'), peerId = consumer.appData.peerId;
            if (!stats || !roomState.peers[peerId]) {
                continue;
            }
            roomState.peers[peerId].stats.consumers[consumer.id] = {
                bitrate: stats.bitrate,
                fractionLost: stats.fractionLost,
                score: stats.score
            };
        }
        catch (e) {
            warn('error while updating consumer stats', e);
        }
    }
}
