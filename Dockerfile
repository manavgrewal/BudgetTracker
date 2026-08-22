# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv

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
# onnxruntime-node ships one tarball carrying native binaries for all five supported
# platforms and npm ci unpacks all of them regardless of target: darwin/arm64 75 MB,
# win32/arm64 67 MB, win32/x64 62 MB, none of which this container can execute. Stripping
# here means the builder and the runner both inherit the pruned tree. Both linux binaries
# stay in both architectures' images; dropping the non-target one needs TARGETARCH plumbing
# for another 20 to 37 MB and is not worth a new failure mode in this release.
RUN npm ci \
    && rm -rf node_modules/onnxruntime-node/bin/napi-v6/darwin \
              node_modules/onnxruntime-node/bin/napi-v6/win32

############################################
# 2. Build
############################################
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholder so any module that reads env at import time can load during the build. It is
# never baked into the runtime image. This literal is why the file carries
# `# check=skip=SecretsUsedInArgOrEnv` at the top: the value is a fixed, public,
# build-stage-only string, not a credential.
ENV SECRET_KEY=build-time-placeholder-secret-key-0123456789

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# public/scanner/ is generated and gitignored, so it must exist before Next collects public/.
RUN node scripts/vendor-scanner-assets.mjs
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
    && mkdir -p /data /data/backups /data/tmp /data/receipts \
    && chown -R node:node /data

# Next standalone output: server.js plus its traced dependency subset.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Migrations are read from process.cwd()/drizzle on boot; tracing does not include them.
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

# Settings -> About renders CHANGELOG.md from process.cwd() at request time (the version
# number itself is inlined at build time). Same reason as drizzle/: output tracing has no
# way to know a plain .md file is a runtime input.
COPY --from=builder --chown=node:node /app/CHANGELOG.md ./CHANGELOG.md

# Rescue tooling (scripts/reset-admin-password.ts), documented in INSTALL.md.
COPY --from=builder --chown=node:node /app/scripts ./scripts

# Compiled native addons: Next output tracing does not reliably include .node binaries.
COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder --chown=node:node /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder --chown=node:node /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
COPY --from=builder --chown=node:node /app/node_modules/node-gyp-build ./node_modules/node-gyp-build
COPY --from=builder --chown=node:node /app/node_modules/argon2 ./node_modules/argon2
COPY --from=builder --chown=node:node /app/node_modules/@phc ./node_modules/@phc

# Offline OCR assets. Next's standalone output tracing cannot know that a .wasm blob, a
# worker script loaded by string path, and a .traineddata.gz under vendor/ are runtime
# inputs, the same reason better-sqlite3, drizzle/ and CHANGELOG.md are copied explicitly.
# If any of these is missing at runtime, tesseract.js falls back to its CDN, which is the
# exact failure an offline LAN install must never hit (spec §7.2, §7.4).
COPY --from=builder --chown=node:node /app/vendor ./vendor
COPY --from=builder --chown=node:node /app/node_modules/tesseract.js ./node_modules/tesseract.js
COPY --from=builder --chown=node:node /app/node_modules/tesseract.js-core ./node_modules/tesseract.js-core
COPY --from=builder --chown=node:node /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist

# The ONNX runtime, its shared types package and sharp all load native binaries by path,
# which Next's output tracing cannot know about, same reason as better-sqlite3 above.
# vendor/ is already copied wholesale, so vendor/ocr-models/ arrives with no new line;
# public/ is already copied, so public/scanner/ does; scripts/ is already copied, so
# scripts/ocr-probe.mjs does. tests/ops/docker.test.ts asserts those three rather than
# assuming them, because "it is already covered" is exactly the belief that produces a
# missing asset in production.
COPY --from=builder --chown=node:node /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node
COPY --from=builder --chown=node:node /app/node_modules/onnxruntime-common ./node_modules/onnxruntime-common
COPY --from=builder --chown=node:node /app/node_modules/sharp ./node_modules/sharp
COPY --from=builder --chown=node:node /app/node_modules/@img ./node_modules/@img

# node-tar backs the .tar.gz backup archive and the restore script (spec §12.1).
COPY --from=builder --chown=node:node /app/node_modules/tar ./node_modules/tar

# A tracing miss must break `docker build`, not production (MUST-7.9, acceptance A3).
# OCR_ASSETS_IN_IMAGE turns on the platform-strip assertion, which is only meaningful here.
RUN OCR_ASSETS_IN_IMAGE=1 node scripts/check-ocr-assets.mjs

USER node
EXPOSE 3000
VOLUME ["/data"]

# NOTE: run this image with a read-only root filesystem and a tmpfs at /tmp.
# Node needs a writable tmpdir; docker-compose.yml already does both.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
