#!/usr/bin/env bash
set -euo pipefail

DISPLAY="${ELPIS_DISPLAY:-:0}"
VT="${ELPIS_VT:-7}"
AGENT_USER="${ELPIS_AGENT_USER:-agent}"
DESKTOP_DIR="${ELPIS_DESKTOP_DIR:-/home/$AGENT_USER/data/elpis-data/computer}"
XAUTHORITY="$DESKTOP_DIR/Xauthority"

install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$DESKTOP_DIR"
rm -f "$XAUTHORITY"
touch "$XAUTHORITY"
chmod 0600 "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(mcookie)"
chown "$AGENT_USER:$AGENT_USER" "$XAUTHORITY"

exec /usr/lib/xorg/Xorg "$DISPLAY" "vt$VT" -nolisten tcp -auth "$XAUTHORITY" -noreset
