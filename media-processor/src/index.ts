require("dotenv").config();

const S3 = require("aws-sdk/clients/s3");
const beamcoder = require("beamcoder");
const SocketIO = require("socket.io-client");
const jsonwebtoken = require("jsonwebtoken");

import type { Demuxer } from "beamcoder";

import { captureException, init as SentryInit } from "@sentry/node";

SentryInit({ dsn: process.env["SENTRY_DSN"] });

const s3 = new S3();

export function makeJWT(): string {
  const payload = { service: "media-processing" };

  return jsonwebtoken.sign(payload, applicationSecret);
}

const applicationSecret = process.env["JWT_SECRET"];
const jwt = makeJWT();

const socket = SocketIO("ws://0.0.0.0:3000", {
  transports: ["websocket"],
  jsonp: false,
  transportOptions: {
    websocket: { extraHeaders: { Authorization: `Bearer ${jwt}` } },
  },
});

socket.on("connect", () => {
  console.log("connected");
});
socket.on("error", (data: any) => {
  console.log("error", data);
});

socket.on("disconnect", () => {
  console.log("disconnect");
});
socket.on("unauthorized", (msg: any) => {
  console.log("unauthorized", msg);
});

let demuxers: { [producerId: string]: Demuxer } = {};

function makeRequest(name: string, request: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (socket.connected) {
      socket.emit(name, request, (result: any) => {
        if (typeof result.error === "string") {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });
    } else {
      reject(new Error("socket not connected"));
    }
  });
}

socket.on(
  "start-recording",
  withErrorReporting(async (data) => {
    const { userId, roomId, producerId } = data;

    const ipAddress = "127.0.0.1"; // TODO: should come from a config somewhere
    const rtpPort = choosePort();
    const rtcpPort = choosePort();

    const { transportId, ipAddress: remoteIpAddress } = await makeRequest(
      "create-plain-transport",
      {
        ipAddress,
        rtpPort,
        rtcpPort,
        roomId,
      },
    );

    // TODO: Possible to combine this with create-plain-transport message?
    const { consumerId, rtpParameters } = await makeRequest("recv-track", {
      roomId,
      producerId,
      transportId,
    });

    const props = {
      userId,
      producerId,
      rtpPort,
      rtcpPort,
      remoteIpAddress,
      codec: rtpParameters.codecs[0],
    };

    console.log(`Opening RTP connection for ${producerId} on port ${rtpPort}`);

    // TODO: demuxer gets initialize much faster if the RTP packets are already flowing
    // If so, what's the point of having a resume-consumer?
    const demuxerPromise = createRTPDemuxer(props);
    makeRequest("resume-consumer", { consumerId });

    const demuxer = await demuxerPromise;

    demuxers[producerId] = demuxer;

    await startRecordingProcess(demuxer, props);
  }),
);

socket.on(
  "stop-recording",
  withErrorReporting(async (data) => {
    const { producerId } = data;
    console.log("stop-recording", producerId);
    const demuxer = demuxers[producerId];
    if (demuxer) {
      demuxer.interrupt();
    } else {
      console.warn("Unknown producerId " + producerId);
    }
  }),
);

socket.on("disconenct", () => {
  console.log("disconnected");
  for (let demuxer of Object.values(demuxers)) {
    demuxer.forceClose();
  }
  demuxers = {};
});

function withErrorReporting(fn: (data: any) => Promise<any>) {
  return (data: any) => {
    fn(data).catch((error: Error) => {
      console.error(error);
      captureException(error);
    });
  };
}

type RecordingProps = {
  userId: number;
  producerId: string;
  codec: any;
  remoteIpAddress: string;
  rtpPort: number;
  rtcpPort: number;
};

async function createRTPDemuxer(props: RecordingProps): Promise<Demuxer> {
  const sdp = createSDP(props);

  console.log("creating demuxer");
  const demuxer = await beamcoder.demuxer({
    url: dataUrl(sdp),
    options: {
      protocol_whitelist: "data,rtp,udp",
    },
  });
  console.log("finished");

  /*
    This is a bit of a hack.

    extradata needs to contain the opus header. The libavformat demuxer seems to leave this as null for some reason.

    My mailing list posts about this issue:

      http://www.ffmpeg-archive.org/Error-raised-in-oggenc-c-when-trying-to-create-opus-file-from-RTP-stream-td4694549.html
      ttp://ffmpeg.org/pipermail/libav-user/2020-October/012587.html

    It looks like this someone tried to fix this issue once before, but it caused a regression. See this thread:

        http://ffmpeg.org/pipermail/ffmpeg-user/2019-September/045274.html

    I think this is where it ideally should be done:

      https://github.com/FFmpeg/FFmpeg/blob/979cc0c7cbe29fe8821803fc4da0f9a1233a56e1/libavformat/rtpdec.c#L555
  */
  const streamConfig = demuxer.streams[0];
  if (streamConfig.codecpar.extradata == null) {
    streamConfig.codecpar.extradata = buildOpusHeader({
      channelCount: streamConfig.codecpar.channels,
      sampleRate: streamConfig.codecpar.sample_rate,
    });
  }

  return demuxer;
}

async function startRecordingProcess(demuxer: Demuxer, props: RecordingProps) {
  // Create a streaming muxer and connect it to S3
  // https://github.com/Streampunk/beamcoder#muxer-stream
  const muxerStream = beamcoder.muxerStream({ highwaterMark: 65536 });

  muxerStream.on("error", (error: Error) => {
    console.log("Muxer error");
    console.error(error);
  });

  // Note: This will upload in chunks of 5mb. See the docs on `partSize`
  // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3/ManagedUpload.html#minPartSize-property
  const s3Key = props.producerId + ".opus";
  console.log(`Starting S3 upload to ${s3Key}`);
  const s3Upload = s3.upload({
    Bucket: requireEnv("S3_BUCKET"),
    Key: s3Key,
    Body: muxerStream,
    ContentType: props.codec.mimeType,
  });

  // Need to call promise to actually start the reading from muxerStream
  const s3UploadPromise = s3Upload.promise();

  const muxer = muxerStream.muxer({ format_name: "opus" });

  const stream = muxer.newStream(demuxer.streams[0]);
  await muxer.openIO();

  // NOTE: If this throws "no extradata present", it's because the OPUS header is missing in extradata
  await muxer.writeHeader();

  while (true) {
    let packet;
    try {
      packet = await demuxer.read();
    } catch (error) {
      // This is the string version of AVERROR_EXIT from ffmpeg. Unfortunately, beamcoder doesn't
      // expose error codes directly, so we have to do a string match.
      // This error is expected to be thrown when demuxer.interrupt() is caled.
      if (error.message.indexOf("Immediate exit requested") === -1) {
        console.error(error);
        captureException(error);
      }
      break;
    }

    if (packet == null) break;
    await muxer.writeFrame(packet);
  }

  await muxer.writeTrailer();

  await s3Upload.promise();
  console.log(`Finished S3 upload to ${s3Key}`);
}

function buildOpusHeader(props: { channelCount: number; sampleRate: number }): Buffer {
  const buffer = Buffer.alloc(19);

  // Official description of header fields:
  // https://www.opus-codec.org/docs/opusfile_api-0.4/structOpusHead.html#details

  // libavfilter implements this a couple times:
  //
  // https://github.com/FFmpeg/FFmpeg/blob/1e5b3f77d9f6f6827b5755763ef041d360969d0c/libavcodec/libopusenc.c#L86
  // https://github.com/FFmpeg/FFmpeg/blob/2502e13b073370edd62451808ed286f2d7d7a196/libavcodec/opusenc.c#L60

  // This is the references implementation:
  // https://github.com/xiph/opusfile/blob/master/src/info.c#L40

  // magic bytes for opus
  buffer.write("OpusHead", 0, 8, "ascii");
  // Version
  buffer.writeUInt8(1, 8);
  // Channel count
  buffer.writeUInt8(props.channelCount, 9);
  // Pre skip
  buffer.writeUInt16LE(0, 10);
  // Sample rate
  buffer.writeUInt32LE(props.sampleRate, 12);
  // Output gain (db)
  buffer.writeUInt16LE(0, 16);
  // Mapping family
  buffer.writeUInt8(0, 18);

  return buffer;
}

type Codec = {
  mimeType: string;
  payloadType: number;
  clockRate: number;
  channels: number;
  parameters: { [key: string]: number };
};

const testRtpParameters = {
  codecs: [
    {
      mimeType: "audio/opus",
      payloadType: 100,
      clockRate: 48000,
      channels: 2,
      parameters: { minptime: 10, useinbandfec: 1 },
      rtcpFeedback: [],
    },
  ],
  headerExtensions: [
    { uri: "urn:ietf:params:rtp-hdrext:sdes:mid", id: 1, encrypt: false, parameters: {} },
    {
      uri: "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
      id: 4,
      encrypt: false,
      parameters: {},
    },
    { uri: "urn:ietf:params:rtp-hdrext:ssrc-audio-level", id: 10, encrypt: false, parameters: {} },
  ],
  encodings: [{ ssrc: 148802405 }],
  rtcp: { cname: "nZ0lK3nvTuPqWxWA", reducedSize: true, mux: true },
  mid: "0",
};

function createSDP({
  userId,
  producerId,
  remoteIpAddress,
  rtpPort,
  rtcpPort,
  codec,
}: RecordingProps) {
  const match = codec.mimeType.match(/(\w+)\/(\w+)/);
  if (!match) {
    throw new Error(`Unexpected mimeType: ${codec.mimeType}`);
  }

  const mediaType = match[1];
  const codecName = match[2];

  const fmtp = Object.entries(codec.parameters)
    .map(([key, value]) => `${key}=${value}`)
    .join(";");

  // https://tools.ietf.org/html/rfc4566
  return `v=0
o=${userId} ${producerId} 0 IN IP4 ${remoteIpAddress}
s=Mediasoup
c=IN IP4 ${remoteIpAddress}
t=0 0
m=${mediaType} ${rtpPort} RTP/AVPF ${codec.payloadType}
a=rtcp:${rtcpPort}
a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}/${codec.channels}
a=fmtp:${codec.payloadType} ${fmtp}
`;
}

function dataUrl(input: string): string {
  return "data:application/sdp;base64," + Buffer.from(input).toString("base64");
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (typeof value === "string") {
    return value;
  } else {
    throw new Error(`Missing required env ${key}`);
  }
}

const minPort = parseInt(requireEnv("MIN_PORT"));
const maxPort = parseInt(requireEnv("MAX_PORT"));
let portCounter = 0;

if (minPort % 2 !== 0) {
  // The RTP spec recommends an even number for RTP port values.
  // https://tools.ietf.org/html/rfc3550#section-11
  throw new Error("MIN_PORT must be an even value.");
}

function choosePort() {
  const i = portCounter++;
  return minPort + (i % (maxPort - minPort + 1));
}
