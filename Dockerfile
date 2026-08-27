FROM node:24-trixie-slim AS build
WORKDIR /opt/elpis
COPY package.json package-lock.json ./
COPY packages/gateway-protocol/package.json ./packages/gateway-protocol/package.json
RUN npm ci --legacy-peer-deps --workspace @elpis/gateway-protocol --include-workspace-root
COPY tsconfig.json tsconfig.console.json ./
COPY packages/gateway-protocol/tsconfig.json ./packages/gateway-protocol/tsconfig.json
COPY packages/gateway-protocol/src ./packages/gateway-protocol/src
COPY scripts/build-console.mjs ./scripts/build-console.mjs
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --legacy-peer-deps --workspace @elpis/gateway-protocol --include-workspace-root

FROM node:24-trixie-slim AS runtime
ARG ELPIS_BUILD_REVISION
ARG ELPIS_BUILD_TAG
ARG ELPIS_BUILD_DIRTY=false
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl file git jq less openssh-client procps \
    python3 python3-pip python3-venv ripgrep tar tini wget \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 elpis \
  && useradd --uid 10001 --gid 10001 --home-dir /data/home --shell /bin/bash elpis
WORKDIR /opt/elpis
COPY --from=build --chown=root:root /opt/elpis/package.json /opt/elpis/package-lock.json ./
COPY --from=build --chown=root:root /opt/elpis/node_modules ./node_modules
COPY --from=build --chown=root:root /opt/elpis/packages/gateway-protocol/package.json ./packages/gateway-protocol/package.json
COPY --from=build --chown=root:root /opt/elpis/packages/gateway-protocol/dist ./packages/gateway-protocol/dist
COPY --from=build --chown=root:root /opt/elpis/dist ./dist
COPY --chown=root:root deploy/container-entrypoint.sh /usr/local/bin/elpis-container-entrypoint
RUN chmod 0555 /usr/local/bin/elpis-container-entrypoint \
  && mkdir -p /data /etc/elpis \
  && touch /etc/elpis/restricted \
  && chmod 0444 /etc/elpis/restricted \
  && chown 10001:10001 /data
ENV NODE_ENV=production \
    ELPIS_CONFIG=/config.yaml \
    ELPIS_BUILD_REVISION=${ELPIS_BUILD_REVISION} \
    ELPIS_BUILD_TAG=${ELPIS_BUILD_TAG} \
    ELPIS_BUILD_DIRTY=${ELPIS_BUILD_DIRTY} \
    HOME=/data/home \
    TMPDIR=/data/tmp
VOLUME ["/data"]
WORKDIR /data
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/elpis-container-entrypoint"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "process.kill(1, 0)"]
CMD ["node", "/opt/elpis/dist/index.js"]
