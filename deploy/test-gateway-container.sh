#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo 'usage: test-gateway-container.sh IMAGE' >&2
  exit 64
fi

image=$1
name="elpis-gateway-smoke-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run --detach \
  --name "$name" \
  --read-only \
  --tmpfs /data:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700 \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --env HOME=/tmp \
  --env TMPDIR=/tmp \
  --publish 127.0.0.1::8790 \
  "$image" >/dev/null

endpoint=$(docker port "$name" 8790/tcp)
port=${endpoint##*:}
ready=false
for _ in $(seq 1 60); do
  if curl --fail --silent --show-error --max-time 2 \
    "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then
    docker logs "$name" >&2
    exit 1
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs "$name" >&2
  exit 1
fi

curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:$port/healthz" >/dev/null
curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:$port/readyz" >/dev/null
docker exec "$name" node -e \
  'const fs = require("node:fs"); if (process.getuid() !== 10001 || process.getgid() !== 10001) process.exit(1); for (const [path, mode] of [["/data", 0o700], ["/data/gateway.db", 0o600]]) if ((fs.statSync(path).mode & 0o777) !== mode) process.exit(1)'
