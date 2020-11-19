import { 
  guard, number, object, string, boolean, mixed, either, constant, json, jsonObject
} from 'decoders';

export const joinAsNewPeerResponse = guard(object({
  routerRtpCapabilities: mixed
}));

// getRouterCapabilities - no params
// leave - no params

const transportDirection = either(constant<"send">("send"), constant<"recv">("recv"));

export const createTransportRequest = guard(object({ direction: transportDirection }));
export const createTransportResponse = guard(object({
  transportOptions: object({ 
    id: string,
    iceParameters: mixed,
    iceCandidates: mixed,
    dtlsParameters: mixed
  })
}));

export const connectTransportRequest = guard(
  object({ 
    transportId: string,
    dtlsParameters: mixed
  })
);

export const closeTransportRequest = guard(
  object({ 
    transportId: string
  })
);

const mediaKind = either(constant<"audio">('audio'), constant<"video">('video'));

export const sendTrackRequest = guard(object({ 
  transportId: string,
  kind: mediaKind,
  rtpParameters: jsonObject,
  paused: boolean,
  appData: object({ mediaTag: string, recording: boolean, nativeLang: string })
}));

export const sendTrackResponse = guard(object({ 
  id: string
}));

export const recvTrackRequest = guard(object({
  mediaPeerId: string,
  mediaTag: string,
  rtpCapabilities: mixed
}));
export const recvTrackResponse = guard(object({
  producerId: string,
  id: string,
  kind: mediaKind,
  rtpParameters: mixed,
  type: string,
  producerPaused: boolean
}));

export const pauseConsumerRequest = guard(object({
  consumerId: string
}));

export const resumeConsumerRequest = guard(object({
  consumerId: string
}));

export const closeConsumerRequest = guard(object({
  consumerId: string
}));

export const pauseProducerRequest = guard(object({
  producerId: string
}));

export const resumeProducerRequest = guard(object({
  producerId: string
}));

export const closeProducerRequest = guard(object({
  producerId: string
}));

export const startTranscribingRequest = guard(object({
  peerId: string,
  mediaTag: string
}));

export const stopTranscribingRequest = guard(object({
  peerId: string,
  mediaTag: string
}));

//
// The following is used for the media processor
//
export const recvRtpTrackRequest = guard(object({ 
  roomId: string,
  producerId: string,
  ipAddress: string,
  rtpPort: number,
  rtcpPort: number
}));
export const recvRtpTrackResponse = guard(object({
  ipAddress: string,
  rtpParameters: jsonObject
}));