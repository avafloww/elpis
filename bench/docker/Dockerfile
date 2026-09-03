FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/libfaketime-elpisbench.so.1
WORKDIR /opt/elpis
COPY package.json package-lock.json ./
COPY packages/gateway-protocol/package.json ./packages/gateway-protocol/package.json
RUN npm ci --ignore-scripts --legacy-peer-deps --workspace @elpis/gateway-protocol --include-workspace-root
COPY tsconfig.json tsconfig.console.json ./
COPY packages/gateway-protocol/tsconfig.json ./packages/gateway-protocol/tsconfig.json
COPY packages/gateway-protocol/src ./packages/gateway-protocol/src
COPY scripts/build-console.mjs ./scripts/build-console.mjs
COPY src ./src
COPY skills ./skills
COPY motor-skills ./motor-skills
COPY bench ./bench
COPY test/helpers.ts ./test/helpers.ts
RUN npm run build
ENV NODE_ENV=production LD_PRELOAD=/usr/local/lib/libfaketime-elpisbench.so.1
ENTRYPOINT ["/opt/elpis/node_modules/.bin/tsx", "/opt/elpis/bench/container-main.ts"]
