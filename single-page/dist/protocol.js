"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeProducerRequest = exports.resumeProducerRequest = exports.pauseProducerRequest = exports.closeConsumerRequest = exports.resumeConsumerRequest = exports.pauseConsumerRequest = exports.recvTrackResponse = exports.recvTrackRequest = exports.sendTrackResponse = exports.sendTrackRequest = exports.closeTransportRequest = exports.connectTransportRequest = exports.createTransportResponse = exports.createTransportRequest = exports.joinAsNewPeerResponse = exports.joinAsNewPeerRequest = void 0;
const decoders_1 = require("decoders");
exports.joinAsNewPeerRequest = decoders_1.guard(decoders_1.object({
    peerId: decoders_1.string,
    roomId: decoders_1.string
}));
exports.joinAsNewPeerResponse = decoders_1.guard(decoders_1.object({
    routerRtpCapabilities: decoders_1.mixed
}));
// getRouterCapabilities - no params
// leave - no params
const transportDirection = decoders_1.either(decoders_1.constant("send"), decoders_1.constant("recv"));
exports.createTransportRequest = decoders_1.guard(decoders_1.object({ direction: transportDirection }));
exports.createTransportResponse = decoders_1.guard(decoders_1.object({
    transportOptions: decoders_1.object({
        id: decoders_1.string,
        iceParameters: decoders_1.mixed,
        iceCandidates: decoders_1.mixed,
        dtlsParameters: decoders_1.mixed
    })
}));
exports.connectTransportRequest = decoders_1.guard(decoders_1.object({
    transportId: decoders_1.string,
    dtlsParameters: decoders_1.mixed
}));
exports.closeTransportRequest = decoders_1.guard(decoders_1.object({
    transportId: decoders_1.string
}));
const mediaKind = decoders_1.either(decoders_1.constant('audio'), decoders_1.constant('video'));
exports.sendTrackRequest = decoders_1.guard(decoders_1.object({
    transportId: decoders_1.string,
    kind: mediaKind,
    rtpParameters: decoders_1.jsonObject,
    paused: decoders_1.boolean,
    appData: decoders_1.object({ mediaTag: decoders_1.string })
}));
exports.sendTrackResponse = decoders_1.guard(decoders_1.object({
    id: decoders_1.string
}));
exports.recvTrackRequest = decoders_1.guard(decoders_1.object({
    mediaPeerId: decoders_1.string,
    mediaTag: decoders_1.string,
    rtpCapabilities: decoders_1.mixed
}));
exports.recvTrackResponse = decoders_1.guard(decoders_1.object({
    producerId: decoders_1.string,
    id: decoders_1.string,
    kind: mediaKind,
    rtpParameters: decoders_1.mixed,
    type: decoders_1.string,
    producerPaused: decoders_1.boolean
}));
exports.pauseConsumerRequest = decoders_1.guard(decoders_1.object({
    consumerId: decoders_1.string
}));
exports.resumeConsumerRequest = decoders_1.guard(decoders_1.object({
    consumerId: decoders_1.string
}));
exports.closeConsumerRequest = decoders_1.guard(decoders_1.object({
    consumerId: decoders_1.string
}));
exports.pauseProducerRequest = decoders_1.guard(decoders_1.object({
    producerId: decoders_1.string
}));
exports.resumeProducerRequest = decoders_1.guard(decoders_1.object({
    producerId: decoders_1.string
}));
exports.closeProducerRequest = decoders_1.guard(decoders_1.object({
    producerId: decoders_1.string
}));
