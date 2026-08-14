FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libfaketime git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN cp /usr/lib/*/faketime/libfaketime.so.1 /usr/local/lib/libfaketime-elpisbench.so.1
WORKDIR /opt/elpis
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY test/helpers.ts ./test/helpers.ts
COPY bench ./bench
RUN npm run build
ENV NODE_ENV=production LD_PRELOAD=/usr/local/lib/libfaketime-elpisbench.so.1
ENTRYPOINT ["/opt/elpis/node_modules/.bin/tsx", "/opt/elpis/bench/container-main.ts"]
