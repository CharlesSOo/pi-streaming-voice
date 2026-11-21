#!/bin/sh
# Keeps one Rex forward up for the voice bridge (run by launchd, see scripts/bridge-install.ts):
#   bridge-forward.sh REX_BIN REX_HOST SERVER_PORT MAC_PORT
# The forward's block lives in a dedicated "voice-bridge" session on the host, away from your working windows.
# If the host is down this exits; launchd starts it again after its throttle interval.
set -u
rex=$1 host=$2 server_port=$3 mac_port=$4
session=voice-bridge
if ! "$rex" -S "$host" session ls 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$session"; then
  "$rex" -S "$host" session new "$session" --window tunnels --shell none -- sleep infinity >/dev/null || exit 1
fi
exec "$rex" -S "$host" forward new -s "$session" -R "127.0.0.1:$server_port:127.0.0.1:$mac_port"
