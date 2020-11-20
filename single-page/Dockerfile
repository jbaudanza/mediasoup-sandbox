# Based on https://medium.com/javascript-in-plain-english/build-a-production-ready-node-express-api-with-docker-9a45443427a0

FROM node:14-alpine AS node

# Builder stage

FROM node AS builder

# These are need to build media-soup
RUN apk add build-base python linux-headers

# Use /app as the CWD
WORKDIR /app

# Copy yarn files to /app
COPY package.json ./
COPY yarn.lock ./

# Install all dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the code
COPY . .

# Invoke the build script to transpile code to js
RUN npm run build

# Final stage

FROM node AS final

USER node

RUN mkdir /home/node/app
WORKDIR /home/node/app

COPY --chown=node:node package.json ./
COPY --chown=node:node yarn.lock ./

# Copy the mediasoup dependency directly. This will save a rebuild

# Need to create the cache directory. 
RUN mkdir -p /home/node/.cache/yarn/v6/
COPY --chown=node:node --from=builder \
    /usr/local/share/.cache/yarn/v6/npm-mediasoup-3.6.21-66297d9b14611cd453e6a119e824c37ada1f7f0b-integrity \
    /home/node/.cache/yarn/v6/npm-mediasoup-3.6.21-66297d9b14611cd453e6a119e824c37ada1f7f0b-integrity

RUN mkdir -p /home/node/app/node_modules
RUN cp \
    --recursive \
    --link \
    /home/node/.cache/yarn/v6/npm-mediasoup-3.6.21-66297d9b14611cd453e6a119e824c37ada1f7f0b-integrity/node_modules/mediasoup \
    /home/node/app/node_modules/mediasoup

#COPY --chown=node:node --from=builder /app/node_modules/mediasoup ./node_modules/mediasoup

# Install libraries as user node
RUN yarn install --frozen-lockfile --production --non-interactive --verbose

# Copy js files and change ownership to user node
COPY --chown=node:node --from=builder /app/dist ./dist

# Open desired ports
EXPOSE 3000/tcp 40000-49999/udp

# Use js files to run the application
ENTRYPOINT ["node", "./dist/server.js"]
