#!/bin/sh
set -eu
umask 077

if [ ! -r /etc/elpis/restricted ]; then
  echo 'elpis: restricted-runtime sentinel is missing' >&2
  exit 70
fi
if [ ! -d /data ] || [ ! -w /data ]; then
  echo 'elpis: /data must be a writable persistent volume owned by uid 10001' >&2
  exit 73
fi
mkdir -p "$HOME" "$TMPDIR"
chmod 0700 "$HOME" "$TMPDIR"
if [ ! -r "$ELPIS_CONFIG" ]; then
  echo "elpis: config not readable at $ELPIS_CONFIG; mount a completed config.yaml in /data" >&2
  exit 78
fi
exec "$@"
