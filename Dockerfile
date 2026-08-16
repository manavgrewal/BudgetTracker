# syntax=docker/dockerfile:1

############################################
# 1. Dependencies
############################################
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 and argon2 normally install glibc prebuilds for linux/amd64 and
# linux/arm64. The toolchain here is a safety net for unusual architectures and
# never reaches the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

############################################
# 2. Build
############################################
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder so any module that reads env at import time can load during the build.
# It is never baked into the runtime image.
ENV SECRET_KEY=build-time-placeholder-secret-key-0123456789

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

############################################
# 3. Runtime
############################################
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    TZ=America/Toronto

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /data/backups /data/tmp \
    && chown -R node:node /data

# Next standalone output: server.js plus its traced dependency subset.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Migrations are read from process.cwd()/drizzle on boot; tracing does not include them.
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

# Compiled native addons: Next output tracing does not reliably include .node binaries.
COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder --chown=node:node /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder --chown=node:node /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=builder --chown=node:node /app/node_modules/node-gyp-build ./node_modules/node-gyp-build
COPY --from=builder --chown=node:node /app/node_modules/argon2 ./node_modules/argon2
COPY --from=builder --chown=node:node /app/node_modules/@phc ./node_modules/@phc

USER node
EXPOSE 3000
VOLUME ["/data"]

# NOTE: run this image with a read-only root filesystem and a tmpfs at /tmp.
# Node needs a writable tmpdir; docker-compose.yml already does both.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
