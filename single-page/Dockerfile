# Based on https://medium.com/javascript-in-plain-english/build-a-production-ready-node-express-api-with-docker-9a45443427a0

FROM node:14-alpine AS node

#
# Install and build production dependencies
#

FROM node AS production-dependencies

WORKDIR /app
COPY package.json ./
COPY yarn.lock ./
RUN apk add build-base python linux-headers
RUN yarn install --frozen-lockfile --production


#
# Install dev dependencies and compile typescripe
#

FROM production-dependencies AS build-typescript

# Install all dependencies
RUN yarn install --frozen-lockfile

# Copy the rest of the code
COPY . .

# Invoke the build script to transpile code to js
RUN yarn tsc

#
# Final stage
#
FROM node AS final

USER node

RUN mkdir /home/node/app
WORKDIR /home/node/app

# Copy in dependencies
COPY --chown=node:node package.json ./
COPY --chown=node:node yarn.lock ./
COPY --chown=node:node --from=production-dependencies \
   /app/node_modules \
   ./node_modules

# Sanity check on dependencies
RUN yarn check --verify-tree --production

# Copy compiled js files
COPY --chown=node:node --from=build-typescript /app/dist ./dist
COPY --chown=node:node config.js .
COPY --chown=node:node deploy.json .

# Open desired ports
EXPOSE 3000/tcp 40000-49999/udp

# Use js files to run the application
ENTRYPOINT ["node", "./dist/server.js"]
