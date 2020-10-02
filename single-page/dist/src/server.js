var config = require('../config');
var debugModule = require('debug');
var express_1 = require("express");
var https = require('https');
var fs = require('fs');
var expressApp = express_1["default"]();
var httpsServer;
var log = debugModule('demo-app');
var warn = debugModule('demo-app:WARN');
var err = debugModule('demo-app:ERROR');
{
    Consumer;
}
from;
"mediasoup/lib/Consumer";
{
    Producer;
}
from;
"mediasoup/lib/Producer";
{
    Transport;
}
from;
"mediasoup/lib/Transport";
{
    Router;
}
from;
"mediasoup/lib/Router";
{
    Worker;
}
from;
"mediasoup/lib/Worker";
{
    AudioLevelObserver;
}
from;
"mediasoup/lib/AudioLevelObserver";
{
    Socket;
}
from;
"socket.io";
// one mediasoup worker and router
//
var worker, router, audioLevelObserver;
null, volume;
number | null, peerId;
string | null;
transports: {
    [key, string];
    Transport;
}
producers: Array < Producer > ,
    consumers;
Array();
//
// and one "room" ...
//
var roomState = {
    // external
    peers: {},
    activeSpeaker: { producerId: null, volume: null, peerId: null },
    // internal
    transports: {},
    producers: [],
    consumers: []
};
null, clientSelectedLayer;
boolean | null;
;
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
expressApp.use(express_1["default"].static(__dirname));
function createHttpsServer() {
    var https = require('https');
    var tls = {
        cert: fs.readFileSync(config.sslCrt),
        key: fs.readFileSync(config.sslKey)
    };
    return https.createServer(tls, expressApp);
}
function createHttpServer() {
    var http = require('http');
    var server = http.createServer(expressApp);
    return server;
}
var io;
function updatePeers() {
    io.emit("peers", {
        peers: roomState.peers,
        activeSpeaker: roomState.activeSpeaker
    });
}
function withAsyncHandler(handler) {
    return function (req, res, next) {
        handler(req, res).catch(function (error) {
            next(error);
        });
    };
}
//
// main() -- our execution entry point
//
async;
function main() {
    // start mediasoup
    console.log('starting mediasoup');
    (worker = await.worker, router = await.router, audioLevelObserver = await.audioLevelObserver, await);
    startMediasoup();
    ;
    // start https server, falling back to http if https fails
    console.log('starting express');
    var server;
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
    server.on('error', function (e) {
        console.error('https server error,', e.message);
        process.exit(1);
    });
    server.listen(config.httpPort, config.httpIp, function () {
        console.log("server is running and listening on " +
            ("https://" + config.httpIp + ":" + config.httpPort));
    });
    // Socket.io
    io = require('socket.io')(server, { serveClient: false });
    io.on('connection', function (socket) {
        function logSocket(msg) {
            console.log("[" + new Date().toISOString() + "] " + socket.id + " " + msg);
        }
        logSocket("socketio connection");
        socket.emit("peers", {
            peers: roomState.peers,
            activeSpeaker: roomState.activeSpeaker
        });
        socket.on('disconnect', function () {
            logSocket("socketio disconnect");
        });
    });
    // periodically clean up peers that disconnected without sending us
    // a final "beacon"
    setInterval(function () {
        var now = Date.now();
        Object.entries(roomState.peers).forEach(function (_a) {
            var id = _a[0], p = _a[1];
            if ((now - p.lastSeenTs) > config.httpPeerStale) {
                warn("removing stale peer " + id);
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
async;
function startMediasoup() {
    var worker = await, mediasoup, createWorker = ({
        logLevel: config.mediasoup.worker.logLevel,
        logTags: config.mediasoup.worker.logTags,
        rtcMinPort: config.mediasoup.worker.rtcMinPort,
        rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    });
    worker.on('died', function () {
        console.error('mediasoup worker died (this should never happen)');
        process.exit(1);
    });
    var mediaCodecs = config.mediasoup.router.mediaCodecs;
    var router = await, worker, createRouter = ({ mediaCodecs: mediaCodecs });
    // audioLevelObserver for signaling active speaker
    //
    var audioLevelObserver = await, router, createAudioLevelObserver = ({
        interval: 800
    });
    audioLevelObserver.on('volumes', function (volumes) {
        var _a = volumes[0], producer = _a.producer, volume = _a.volume;
        log('audio-level volumes event', producer.appData.peerId, volume);
        roomState.activeSpeaker.producerId = producer.id;
        roomState.activeSpeaker.volume = volume;
        roomState.activeSpeaker.peerId = producer.appData.peerId;
    });
    audioLevelObserver.on('silence', function () {
        log('audio-level silence event');
        roomState.activeSpeaker.producerId = null;
        roomState.activeSpeaker.volume = null;
        roomState.activeSpeaker.peerId = null;
    });
    return { worker: worker, router: router, audioLevelObserver: audioLevelObserver };
}
//
// -- our minimal signaling is just http polling --
//
// parse every request body for json, no matter the content-type. this
// lets us use sendBeacon or fetch interchangeably to POST to
// signaling endpoints. (sendBeacon can't set the Content-Type header)
//
expressApp.use(express_1["default"].json({ type: '*/*' }));
// --> /signaling/sync
//
// client polling endpoint. send back our 'peers' data structure and
// 'activeSpeaker' info
//
expressApp.post('/signaling/sync', async(req, res), {
    let: (_a = req.body, peerId = _a.peerId, _a),
    try: {
        // make sure this peer is connected. if we've disconnected the
        // peer because of a network outage we want the peer to know that
        // happened, when/if it returns
        if: function () { } } }, !roomState.peers[peerId]);
{
    throw new Error('not connected');
}
// update our most-recently-seem timestamp -- we're not stale!
roomState.peers[peerId].lastSeenTs = Date.now();
res.send({
    peers: roomState.peers,
    activeSpeaker: roomState.activeSpeaker
});
try { }
catch (e) {
    console.error(e.message);
    res.send({ error: e.message });
}
;
// --> /signaling/join-as-new-peer
//
// adds the peer to the roomState data structure and creates a
// transport that the peer will use for receiving media. returns
// router rtpCapabilities for mediasoup-client device initialization
//
expressApp.post('/signaling/join-as-new-peer', async(req, res), {
    try: {
        let: (_b = req.body, peerId = _b.peerId, _b),
        now:  = Date.now(),
        log: function () { }, 'join-as-new-peer': , peerId:  } });
roomState.peers[peerId] = {
    joinTs: now,
    lastSeenTs: now,
    media: {}, consumerLayers: {}, stats: { producers: {}, consumers: {} }
};
res.send({ routerRtpCapabilities: router.rtpCapabilities });
updatePeers();
try { }
catch (e) {
    console.error('error in /signaling/join-as-new-peer', e);
    res.send({ error: e });
}
;
// --> /signaling/router-capabilities
//
//
expressApp.post('/signaling/router-capabilities', async(req, res), {
    try: {
        res: .send({ routerRtpCapabilities: router.rtpCapabilities })
    }, catch: function (e) {
        res.send({ error: e });
    }
});
// --> /signaling/leave
//
// removes the peer from the roomState data structure and and closes
// all associated mediasoup objects
//
expressApp.post('/signaling/leave', async(req, res), {
    try: {
        let: (_c = req.body, peerId = _c.peerId, _c),
        log: function () { }, 'leave': , peerId:  } });
await;
closePeer(peerId);
res.send({ left: true });
updatePeers();
try { }
catch (e) {
    console.error('error in /signaling/leave', e);
    res.send({ error: e });
}
;
function closePeer(peerId) {
    log('closing peer', peerId);
    for (var _i = 0, _a = Object.entries(roomState.transports); _i < _a.length; _i++) {
        var _b = _a[_i], id_1 = _b[0], transport_1 = _b[1];
        if (transport_1.appData.peerId === peerId) {
            closeTransport(transport_1);
        }
    }
    delete roomState.peers[peerId];
}
async;
function closeTransport(transport) {
    try {
        log('closing transport', transport.id, transport.appData);
        // our producer and consumer event handlers will take care of
        // calling closeProducer() and closeConsumer() on all the producers
        // and consumers associated with this transport
        await;
        transport.close();
        // so all we need to do, after we call transport.close(), is update
        // our roomState data structure
        delete roomState.transports[transport.id];
    }
    catch (e) {
        err(e);
    }
}
async;
function closeProducer(producer) {
    log('closing producer', producer.id, producer.appData);
    await;
    producer.close();
    // remove this producer from our roomState.producers list
    roomState.producers = roomState.producers
        .filter(function (p) { return p.id !== producer.id; });
    // remove this track's info from our roomState...mediaTag bookkeeping
    if (roomState.peers[producer.appData.peerId]) {
        delete (roomState.peers[producer.appData.peerId]
            .media[producer.appData.mediaTag]);
    }
}
async;
function closeConsumer(consumer) {
    log('closing consumer', consumer.id, consumer.appData);
    await;
    consumer.close();
    // remove this consumer from our roomState.consumers list
    roomState.consumers = roomState.consumers.filter(function (c) { return c.id !== consumer.id; });
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
expressApp.post('/signaling/create-transport', async(req, res), {
    try: {
        let: (_d = req.body, peerId = _d.peerId, direction = _d.direction, _d),
        log: function () { }, 'create-transport': , peerId: peerId, direction:  } });
var transport = await, createWebRtcTransport = ({ peerId: peerId, direction: direction });
roomState.transports[transport.id] = transport;
var id = transport.id, iceParameters = transport.iceParameters, iceCandidates = transport.iceCandidates, dtlsParameters = transport.dtlsParameters;
res.send({
    transportOptions: { id: id, iceParameters: iceParameters, iceCandidates: iceCandidates, dtlsParameters: dtlsParameters }
});
updatePeers();
try { }
catch (e) {
    console.error('error in /signaling/create-transport', e);
    res.send({ error: e });
}
;
async;
function createWebRtcTransport(params) {
    var peerId = params.peerId, direction = params.direction;
    var _a = config.mediasoup.webRtcTransport, listenIps = _a.listenIps, initialAvailableOutgoingBitrate = _a.initialAvailableOutgoingBitrate;
    var transport = await, router, createWebRtcTransport = ({
        listenIps: listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
        appData: { peerId: peerId, clientDirection: direction }
    });
    return transport;
}
// --> /signaling/connect-transport
//
// called from inside a client's `transport.on('connect')` event
// handler.
//
expressApp.post('/signaling/connect-transport', async(req, res), {
    try: {
        let: (_e = req.body, peerId = _e.peerId, transportId = _e.transportId, dtlsParameters = _e.dtlsParameters, _e),
        transport:  = roomState.transports[transportId],
        if: function () { } } }, !transport);
{
    err("connect-transport: server-side transport " + transportId + " not found");
    res.send({ error: "server-side transport " + transportId + " not found" });
    return;
}
log('connect-transport', peerId, transport.appData);
await;
transport.connect({ dtlsParameters: dtlsParameters });
res.send({ connected: true });
updatePeers();
try { }
catch (e) {
    console.error('error in /signaling/connect-transport', e);
    res.send({ error: e });
}
;
// --> /signaling/close-transport
//
// called by a client that wants to close a single transport (for
// example, a client that is no longer sending any media).
//
expressApp.post('/signaling/close-transport', async(req, res), {
    try: {
        let: (_f = req.body, peerId = _f.peerId, transportId = _f.transportId, _f),
        transport:  = roomState.transports[transportId],
        if: function () { } } }, !transport);
{
    err("close-transport: server-side transport " + transportId + " not found");
    res.send({ error: "server-side transport " + transportId + " not found" });
    return;
}
log('close-transport', peerId, transport.appData);
await;
closeTransport(transport);
res.send({ closed: true });
updatePeers();
try { }
catch (e) {
    console.error('error in /signaling/close-transport', e);
    res.send({ error: e.message });
}
;
// --> /signaling/close-producer
//
// called by a client that is no longer sending a specific track
//
expressApp.post('/signaling/close-producer', async(req, res), {
    try: {
        let: (_g = req.body, peerId = _g.peerId, producerId = _g.producerId, _g),
        producer:  = roomState.producers.find(function (p) { return p.id === producerId; }),
        if: function () { } } }, !producer);
{
    err("close-producer: server-side producer " + producerId + " not found");
    res.send({ error: "server-side producer " + producerId + " not found" });
    return;
}
log('close-producer', peerId, producer.appData);
await;
closeProducer(producer);
res.send({ closed: true });
updatePeers();
try { }
catch (e) {
    console.error(e);
    res.send({ error: e.message });
}
;
// --> /signaling/send-track
//
// called from inside a client's `transport.on('produce')` event handler.
//
expressApp.post('/signaling/send-track', async(req, res), {
    try: {
        let: (_h = req.body, peerId = _h.peerId, transportId = _h.transportId, kind = _h.kind, rtpParameters = _h.rtpParameters, _j = _h.paused,  = _j === void 0 ? false : _j, appData = _h.appData, _h),
        transport:  = roomState.transports[transportId],
        if: function () { } } }, !transport);
{
    err("send-track: server-side transport " + transportId + " not found");
    res.send({ error: "server-side transport " + transportId + " not found" });
    return;
}
var producer = await, transport, produce = ({
    kind: kind,
    rtpParameters: rtpParameters,
    paused: paused,
    appData: { appData: appData, peerId: peerId, transportId: transportId }
});
// if our associated transport closes, close ourself, too
producer.on('transportclose', function () {
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
    paused: paused,
    encodings: rtpParameters.encodings
};
res.send({ id: producer.id });
updatePeers();
try { }
catch (e) {
    console.error(e);
    res.send({ error: e.message });
}
;
// --> /signaling/recv-track
//
// create a mediasoup consumer object, hook it up to a producer here
// on the server side, and send back info needed to create a consumer
// object on the client side. always start consumers paused. client
// will request media to resume when the connection completes
//
expressApp.post('/signaling/recv-track', async(req, res), {
    try: {
        let: (_k = req.body, peerId = _k.peerId, mediaPeerId = _k.mediaPeerId, mediaTag = _k.mediaTag, rtpCapabilities = _k.rtpCapabilities, _k),
        let: producer = roomState.producers.find(function (p) { return p.appData.mediaTag === mediaTag &&
            p.appData.peerId === mediaPeerId; }),
        if: function () { } } }, !producer);
{
    var msg = 'server-side producer for ' +
        (mediaPeerId + ":" + mediaTag + " not found");
    err('recv-track: ' + msg);
    res.send({ error: msg });
    return;
}
if (!router.canConsume({ producerId: producer.id,
    rtpCapabilities: rtpCapabilities })) {
    var msg = "client cannot consume " + mediaPeerId + ":" + mediaTag;
    err("recv-track: " + peerId + " " + msg);
    res.send({ error: msg });
    return;
}
var transport = Object.values(roomState.transports).find(function (t) {
    return t.appData.peerId === peerId && t.appData.clientDirection === 'recv';
});
if (!transport) {
    var msg = "server-side recv transport for " + peerId + " not found";
    err('recv-track: ' + msg);
    res.send({ error: msg });
    return;
}
var consumer = await, transport, consume = ({
    producerId: producer.id,
    rtpCapabilities: rtpCapabilities,
    paused: true,
    appData: { peerId: peerId, mediaPeerId: mediaPeerId, mediaTag: mediaTag }
});
// need both 'transportclose' and 'producerclose' event handlers,
// to make sure we close and clean up consumers in all
// circumstances
consumer.on('transportclose', function () {
    log("consumer's transport closed", consumer.id);
    closeConsumer(consumer);
});
consumer.on('producerclose', function () {
    log("consumer's producer closed", consumer.id);
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
consumer.on('layerschange', function (layers) {
    log("consumer layerschange " + mediaPeerId + "->" + peerId, mediaTag, layers);
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
try { }
catch (e) {
    console.error('error in /signaling/recv-track', e);
    res.send({ error: e });
}
;
// --> /signaling/pause-consumer
//
// called to pause receiving a track for a specific client
//
expressApp.post('/signaling/pause-consumer', async(req, res), {
    try: {
        let: (_l = req.body, peerId = _l.peerId, consumerId = _l.consumerId, _l),
        consumer:  = roomState.consumers.find(function (c) { return c.id === consumerId; }),
        if: function () { } } }, !consumer);
{
    err("pause-consumer: server-side consumer " + consumerId + " not found");
    res.send({ error: "server-side producer " + consumerId + " not found" });
    return;
}
log('pause-consumer', consumer.appData);
await;
consumer.pause();
res.send({ paused: true });
try { }
catch (e) {
    console.error('error in /signaling/pause-consumer', e);
    res.send({ error: e });
}
;
// --> /signaling/resume-consumer
//
// called to resume receiving a track for a specific client
//
expressApp.post('/signaling/resume-consumer', async(req, res), {
    try: {
        let: (_m = req.body, peerId = _m.peerId, consumerId = _m.consumerId, _m),
        consumer:  = roomState.consumers.find(function (c) { return c.id === consumerId; }),
        if: function () { } } }, !consumer);
{
    err("pause-consumer: server-side consumer " + consumerId + " not found");
    res.send({ error: "server-side consumer " + consumerId + " not found" });
    return;
}
log('resume-consumer', consumer.appData);
await;
consumer.resume();
res.send({ resumed: true });
try { }
catch (e) {
    console.error('error in /signaling/resume-consumer', e);
    res.send({ error: e });
}
;
// --> /signalign/close-consumer
//
// called to stop receiving a track for a specific client. close and
// clean up consumer object
//
expressApp.post('/signaling/close-consumer', async(req, res), {
    try: {
        let: (_o = req.body, peerId = _o.peerId, consumerId = _o.consumerId, _o),
        consumer:  = roomState.consumers.find(function (c) { return c.id === consumerId; }),
        if: function () { } } }, !consumer);
{
    err("close-consumer: server-side consumer " + consumerId + " not found");
    res.send({ error: "server-side consumer " + consumerId + " not found" });
    return;
}
await;
closeConsumer(consumer);
res.send({ closed: true });
try { }
catch (e) {
    console.error('error in /signaling/close-consumer', e);
    res.send({ error: e });
}
;
// --> /signaling/consumer-set-layers
//
// called to set the largest spatial layer that a specific client
// wants to receive
//
expressApp.post('/signaling/consumer-set-layers', async(req, res), {
    try: {
        let: (_p = req.body, peerId = _p.peerId, consumerId = _p.consumerId, spatialLayer = _p.spatialLayer, _p),
        consumer:  = roomState.consumers.find(function (c) { return c.id === consumerId; }),
        if: function () { } } }, !consumer);
{
    err("consumer-set-layers: server-side consumer " + consumerId + " not found");
    res.send({ error: "server-side consumer " + consumerId + " not found" });
    return;
}
log('consumer-set-layers', spatialLayer, consumer.appData);
await;
consumer.setPreferredLayers({ spatialLayer: spatialLayer });
res.send({ layersSet: true });
try { }
catch (e) {
    console.error('error in /signaling/consumer-set-layers', e);
    res.send({ error: e });
}
;
// --> /signaling/pause-producer
//
// called to stop sending a track from a specific client
//
expressApp.post('/signaling/pause-producer', async(req, res), {
    try: {
        let: (_q = req.body, peerId = _q.peerId, producerId = _q.producerId, _q),
        producer:  = roomState.producers.find(function (p) { return p.id === producerId; }),
        if: function () { } } }, !producer);
{
    err("pause-producer: server-side producer " + producerId + " not found");
    res.send({ error: "server-side producer " + producerId + " not found" });
    return;
}
log('pause-producer', producer.appData);
await;
producer.pause();
roomState.peers[peerId].media[producer.appData.mediaTag].paused = true;
res.send({ paused: true });
try { }
catch (e) {
    console.error('error in /signaling/pause-producer', e);
    res.send({ error: e });
}
;
// --> /signaling/resume-producer
//
// called to resume sending a track from a specific client
//
expressApp.post('/signaling/resume-producer', async(req, res), {
    try: {
        let: (_r = req.body, peerId = _r.peerId, producerId = _r.producerId, _r),
        producer:  = roomState.producers.find(function (p) { return p.id === producerId; }),
        if: function () { } } }, !producer);
{
    err("resume-producer: server-side producer " + producerId + " not found");
    res.send({ error: "server-side producer " + producerId + " not found" });
    return;
}
log('resume-producer', producer.appData);
await;
producer.resume();
roomState.peers[peerId].media[producer.appData.mediaTag].paused = false;
res.send({ resumed: true });
try { }
catch (e) {
    console.error('error in /signaling/resume-producer', e);
    res.send({ error: e });
}
;
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
            case "UnauthorizedError":
                res.status(err.status).json({ error: err.message, code: err.code });
                break;
            case "ValidationError":
                res.status(400).json({ error: err.message, code: "validation_error" });
                break;
            default: {
                var eventId = Sentry.captureException(err);
                console.warn("Error raised (" + eventId + ")");
                console.error(err);
                sendInternalServerError(res, err.toString(), eventId);
                next();
            }
        }
    }
    else {
        console.warn("Non-Error exception raised: " + String(err));
        var eventId = Sentry.captureException(err);
        sendInternalServerError(res, String(err), eventId);
        next();
    }
}
function sendInternalServerError(res, message, eventId, string) {
    var string;
    if (process.env["NODE_ENV"] === "development") {
        string = message;
    }
    else {
        if (eventId) {
            string = "Internal Server Error (" + eventId + ")";
        }
        else {
            string = "Internal Server Error";
        }
    }
    var obj = {
        error: string,
        code: "internal_error"
    };
    if (eventId) {
        obj.eventId = eventId;
    }
    res.status(500).json(obj);
}
//
// stats
//
async;
function updatePeerStats() {
    for (var _i = 0, _a = roomState.producers; _i < _a.length; _i++) {
        var producer_1 = _a[_i];
        if (producer_1.kind !== 'video') {
            continue;
        }
        try {
            var stats = await, producer_2 = void 0, getStats = (), peerId = producer_2.appData.peerId;
            roomState.peers[peerId].stats.producers[producer_2.id] = stats.map(function (s) { return ({
                bitrate: s.bitrate,
                fractionLost: s.fractionLost,
                jitter: s.jitter,
                score: s.score,
                rid: s.rid
            }); });
        }
        catch (e) {
            warn('error while updating producer stats', e);
        }
    }
    for (var _b = 0, _c = roomState.consumers; _b < _c.length; _b++) {
        var consumer_1 = _c[_b];
        try {
            var stats = (await), consumer_2 = void 0, getStats = ();
            find(function (s) { return s.type === 'outbound-rtp'; }),
                peerId = consumer_2.appData.peerId;
            if (!stats || !roomState.peers[peerId]) {
                continue;
            }
            roomState.peers[peerId].stats.consumers[consumer_2.id] = {
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
var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r;
