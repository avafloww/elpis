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
private_runtime_dir() {
  path=$1
  fallback=$2
  mkdir -p "$path"
  if chmod 0700 "$path" 2>/dev/null; then
    printf '%s\n' "$path"
    return
  fi
  path="$path/$fallback"
  mkdir -p "$path"
  chmod 0700 "$path"
  printf '%s\n' "$path"
}

HOME=$(private_runtime_dir "$HOME" .elpis-home)
TMPDIR=$(private_runtime_dir "$TMPDIR" .elpis-tmp)
export HOME TMPDIR
if [ ! -r "$ELPIS_CONFIG" ]; then
  echo "elpis: config not readable at $ELPIS_CONFIG; mount a completed config.yaml read-only at /config.yaml" >&2
  exit 78
fi
exec "$@"
