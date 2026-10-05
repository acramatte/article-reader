# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY index.html main.js stream-player.mjs vite.config.js ./
COPY public/ ./public/
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
# Bookworm is on LTS; security fixes arrive as DLAs after the base image
# snapshot, so pull current patches at build time
RUN apt-get update \
 && apt-get upgrade -y \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY server.mjs article.mjs streaming-server.mjs streaming.mjs streaming-api.mjs tts-provider.mjs chunks.mjs tts-client.mjs ./
# npm is only needed to install prod deps above; the container runs node
# only, and the npm bundle ships vulnerable transitive deps, so drop it
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
