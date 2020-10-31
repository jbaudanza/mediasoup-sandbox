
The media processor is responsible for:
  - Sending audio streams to the google speech-to-text API
  - Sending audio streams to S3 for storage

This requires a .env:

    JWT_SECRET=XXXXX
    MEDIA_ROUTER_IP=127.0.01
    UV_THREADPOOL_SIZE=32
