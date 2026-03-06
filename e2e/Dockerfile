# Subspace Transceiver daemon image for E2E testing.
#
# Each container runs a single daemon in foreground mode (no PID file).
# Identity is generated fresh per container unless a volume is mounted at /data.
#
# Build from repo root: docker build -f e2e/Dockerfile -t subspace-daemon .

FROM node:20-alpine

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++ wget

# Copy dependency manifests first (layer caching)
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY packages/daemon/package.json packages/daemon/
COPY packages/cli/package.json packages/cli/
COPY packages/skill/package.json packages/skill/
COPY patches/ patches/

# Install all dependencies
RUN npm ci --workspace=packages/core \
           --workspace=packages/daemon \
           --workspace=packages/cli \
           --workspace=packages/skill \
    && node patches/gossipsub-multiaddr-compat.js \
    && node patches/gossipsub-stream-compat.js \
    && node patches/gossipsub-handler-compat.js

# Copy source and build
COPY packages/ packages/
COPY tsconfig.base.json ./
RUN npm run build --workspace=packages/core \
    && npm run build --workspace=packages/daemon \
    && npm run build --workspace=packages/cli

# Default data directory (override via SUBSPACE_DATA_DIR)
ENV SUBSPACE_DATA_DIR=/data
RUN mkdir -p /data

# Expose daemon HTTP API port
EXPOSE 7432

# Run daemon in foreground (required for container — no PID file daemonization)
ENTRYPOINT ["node", "packages/daemon/dist/index.js", "--foreground"]
CMD ["--port", "7432"]
