require("dotenv").config();

const S3 = require("aws-sdk/clients/s3");
const beamcoder = require("beamcoder");
const SocketIO = require("socket.io-client");
const jsonwebtoken = require("jsonwebtoken");
const speech = require('@google-cloud/speech');

import { ApiError as GoogleApiError } from "@google-cloud/common";
import { Status as GoogleStatus } from "google-gax";

import type { Demuxer } from "beamcoder";

import { captureException, init as SentryInit } from "@sentry/node";

SentryInit({ dsn: process.env["SENTRY_DSN"] });

let clientOptions;
if (process.env["GOOGLE_APPLICATION_CREDENTIALS_JSON"]) {
  clientOptions = { credentials: JSON.parse(process.env["GOOGLE_APPLICATION_CREDENTIALS_JSON"]) };
} else {
  clientOptions = {};
}
const speechClient = new speech.SpeechClient(clientOptions);

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
    const { userId, roomId, producerId, nativeLang } = data;

    const ipAddress = "127.0.0.1"; // TODO: should come from a config somewhere
    const rtpPort = choosePort();
    const rtcpPort = choosePort();

    const { rtpParameters, ipAddress: remoteIpAddress } = await makeRequest("recv-track", {
      roomId,
      ipAddress,
      rtpPort,
      rtcpPort,
      producerId,
    });

    const props = {
      userId,
      producerId,
      nativeLang,
      rtpPort,
      rtcpPort,
      remoteIpAddress,
      codec: rtpParameters.codecs[0],
    };

    console.log(`Opening RTP connection for ${producerId} on port ${rtpPort}`);

    const demuxer = await createRTPDemuxer(props);

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

socket.on("disconnect", () => {
  console.log("disconnect");
  for (let demuxer of Object.values(demuxers)) {
    demuxer.interrupt();
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
  nativeLang: string;
  producerId: string;
  codec: any;
  remoteIpAddress: string;
  rtpPort: number;
  rtcpPort: number;
};

async function createRTPDemuxer(props: RecordingProps): Promise<Demuxer> {
  const sdp = createSDP(props);

  const demuxer = await beamcoder.demuxer({
    url: dataUrl(sdp),
    options: {
      protocol_whitelist: "data,rtp,udp",
    },
  });

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

// Create a streaming muxer and connect it to S3
// https://github.com/Streampunk/beamcoder#muxer-stream
async function startRecordingProcess(demuxer: Demuxer, props: RecordingProps) {

  // The way governor.cc and adapter.h are written, buffers won't
  // get emitted until this highwaterMark is reached.
  // 64 seems to be the magic number that will release a buffer after every frame
  // is written.
  // Ideally, setting a highwaterMark shouldn't be necessary at all. It's just and odd
  // requirement from beamcoder.
  const highwaterMark = 64;

  const muxerStream = beamcoder.muxerStream({ highwaterMark });

  muxerStream.on("error", (error: Error) => {
    console.log("Muxer error");
    console.error(error);
  });

  // Note: This will upload in chunks of 5mb. See the docs on `partSize`
  // https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3/ManagedUpload.html#minPartSize-property
  const s3Key = props.producerId + ".opus";

  const muxer = muxerStream.muxer({ format_name: "opus" });
  muxer.flush_packets = 1;

  // This forces beamcoder to use av_write_frame instead of av_interleaved_write_frame. This is
  // necessary to get the muxer to flush the packets right away. Also, we're only muxing
  // one stream (Opus) so interleaving shouldn't be necessary.
  muxer.interleaved = false;

  const stream = muxer.newStream(demuxer.streams[0]);

  // TODO: comment this back in
  //uploadToS3(muxerStream, props.codec.mimeType, props.producerId);

  startTranscriptions(
    muxerStream,
    { channelCount: stream.codecpar.channels, sampleRate: stream.codecpar.sample_rate },
    props.nativeLang,
    (recognizeResponse: any) => {
      logRecognizeResponse(recognizeResponse);
      socket.emit("recognize-response", { producerId: props.producerId, recognizeResponse })
  });

  // This is a wrapper around avio_open2
  await muxer.openIO();

  // NOTE: If this throws "no extradata present", it's because the OPUS header is missing in extradata
  // This is a wrapper around avformat_write_header()
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
}

function startTranscriptions(
    readableStream: NodeJS.ReadableStream,
    opusHeaderProps: OpusHeaderProps,
    languageCode: string,
    onResponse: (data: any) => void) {
  const streamingRecognizeRequest = {
    config: {
      languageCode,
      enableWordTimeOffsets: true,
      encoding: 'OGG_OPUS',
      audioChannelCount: opusHeaderProps.channelCount,
      sampleRateHertz: opusHeaderProps.sampleRate,
    },
    interimResults: true,
  };

  function go() {
    console.log(`Starting recognizeRequest for ${languageCode}`);

    function dataListener(data: any) {
      onResponse(data);
    }

    function errorListener(error: Error) {
      // https://cloud.google.com/speech-to-text/docs/reference/rpc/google.rpc#google.rpc.Code
      if (error instanceof GoogleApiError && error.code === GoogleStatus.OUT_OF_RANGE) {
        // OUT_OF_RANGE (11) Error
        //   - Raised when the stream extends beyond 305 seconds
        //   - Raised if the stream goes too long without audio
        //
        // The correct behavior here is to restart the stream.

        // TODO: Try waiting for a silence in conversation, and restarting the stream after 3-4 minutes.
        // This may result in a better user experience
        console.log(`OUT_OF_RANGE error from RecognizeStream. Restarting. message=${error.message}`)
        go();
      } else {
        // TODO: Stop sending data from the muxer
        console.error(error);
        captureException(error);
      }

      removeListeners();
    }

    const recognizeStream = speechClient
      .streamingRecognize(streamingRecognizeRequest)
      .on("data", dataListener)
      .on("error", errorListener);

    readableStream.on("error", () => {
      console.log("Ending recognizeStream because of error from muxer")
      recognizeStream.end();
      removeListeners();
    });

    //
    // Hook the muxer up to the recognize stream. You should be able to make this work with
    // readableStream.pipe(), but for some reason I couldn't get it to restart correctly
    // after an OUT_OF_RANGE error.
    //
    function muxerDataListener(buffer: any) {
      recognizeStream.write(buffer);
    }
    function muxerErrorListener() {
      recognizeStream.end();
    }
    function muxerEndListener() {
      recognizeStream.end();
    }

    readableStream.on('data', muxerDataListener);
    readableStream.on('error', muxerErrorListener);
    readableStream.on('end', muxerEndListener);

    function removeListeners() {
      recognizeStream.removeListener("data", dataListener);
      recognizeStream.removeListener("error", errorListener);

      readableStream.removeListener("data", muxerDataListener);
      readableStream.removeListener("error", muxerErrorListener);
      readableStream.removeListener("end", muxerEndListener);
    }
  }

  go();
}

function uploadToS3(readableStream: NodeJS.ReadableStream, mimeType: string, producerId: string): Promise<any> {
  const s3Key = producerId + ".opus";
  console.log(`Starting S3 upload to ${s3Key}`);
  const s3Upload = s3.upload({
    Bucket: requireEnv("S3_BUCKET"),
    Key: s3Key,
    Body: readableStream,
    ContentType: mimeType,
  });

  // Need to call promise to actually start the reading from muxerStream
  const promise = s3Upload.promise();

  promise.then(() => { console.log(`Finished S3 upload to ${s3Key}`); });

  return promise;
}

type OpusHeaderProps = {
  channelCount: number,
  sampleRate: number,
};

function buildOpusHeader(props: OpusHeaderProps): Buffer {
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

function createSDP({
  userId,
  producerId,
  remoteIpAddress,
  rtpPort,
  rtcpPort,
  codec,
  nativeLang,
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
a=lang:${nativeLang}
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

function logRecognizeResponse(response: any) {
  if (Array.isArray(response.results)) {
    const str = response.results.map((result: any) => {
      return result.alternatives[0].transcript;
    }).join(" ");
    console.log("Transcript: " + str);
  }
}