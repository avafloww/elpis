#!/usr/bin/env bash
set -euo pipefail

DISPLAY="${ELPIS_DISPLAY:-:0}"
GEOMETRY="${ELPIS_GEOMETRY:-1280x800}"
DESKTOP_DIR="${ELPIS_DESKTOP_DIR:-$HOME/data/elpis-data/computer}"
XAUTHORITY="${XAUTHORITY:-$DESKTOP_DIR/Xauthority}"
export DISPLAY XAUTHORITY

install -d -m 0700 "$DESKTOP_DIR"
for _ in $(seq 1 200); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.05
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || {
  echo "Xorg did not become ready on $DISPLAY" >&2
  exit 1
}

output="$(xrandr --query | awk '/ connected primary/{print $1; exit} / connected/{fallback=$1} END{if (!NR) exit; if (!output && fallback) print fallback}')"
if [[ -n "$output" ]] && xrandr --query | grep -qE "^[[:space:]]+$GEOMETRY([[:space:]]|$)"; then
  xrandr --output "$output" --mode "$GEOMETRY"
fi
xsetroot -display "$DISPLAY" -solid '#18151f'

pids=()
cleanup() {
  trap - EXIT INT TERM
  ((${#pids[@]})) && kill "${pids[@]}" 2>/dev/null || true
  wait "${pids[@]}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

openbox &
pids+=("$!")
if command -v tint2 >/dev/null 2>&1; then
  tint2 &
  pids+=("$!")
fi

# Openbox is the load-bearing session process. Xorg has its own system service;
# tint2 is useful for human observation but not part of the control plane.
wait "${pids[0]}"
