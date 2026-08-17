FROM node:24-bookworm-slim AS build
WORKDIR /opt/elpis
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --legacy-peer-deps

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 elpis \
  && useradd --uid 10001 --gid 10001 --home-dir /data/home --shell /usr/sbin/nologin elpis
WORKDIR /opt/elpis
COPY --from=build --chown=root:root /opt/elpis/package.json /opt/elpis/package-lock.json ./
COPY --from=build --chown=root:root /opt/elpis/node_modules ./node_modules
COPY --from=build --chown=root:root /opt/elpis/dist ./dist
COPY --chown=root:root deploy/container-entrypoint.sh /usr/local/bin/elpis-container-entrypoint
RUN chmod 0555 /usr/local/bin/elpis-container-entrypoint \
  && mkdir -p /data /etc/elpis \
  && touch /etc/elpis/restricted \
  && chmod 0444 /etc/elpis/restricted \
  && chown 10001:10001 /data
ENV NODE_ENV=production \
    ELPIS_CONFIG=/data/config.yaml \
    HOME=/data/home \
    TMPDIR=/data/tmp
VOLUME ["/data"]
WORKDIR /data
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/elpis-container-entrypoint"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "-e", "process.kill(1, 0)"]
CMD ["node", "/opt/elpis/dist/index.js"]
