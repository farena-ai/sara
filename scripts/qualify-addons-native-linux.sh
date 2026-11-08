#!/usr/bin/env bash
# Q-ADDONS: one throwaway Sara on the Linux server for scripts/qualify-addons-native.mjs. Run as root;
# Sara and the script run as the `sara` user from a read-only source tree, with SARA_DATA, HOME and
# TMPDIR in a fresh folder under /dev/shm (never /tmp, never /var/lib/sara), on 127.0.0.1:7872,
# niced, and removed again on exit (stopped by PID). It never touches the live service.
#   [STORE_URL=http://127.0.0.1:<port>] bash qualify-addons-native-linux.sh <source-tree> <script> <results.json> [--only a,b]
set -euo pipefail
SRC=${1:?source tree}; SCRIPT=${2:?script}; OUT=${3:?results file}; shift 3
NODE=/opt/sara/node/bin/node; PORT=7872
[ "$(df --output=avail -k /dev/shm | tail -1)" -gt 2000000 ] || { echo "less than 2 GB free in /dev/shm" >&2; exit 1; }
if ss -ltn | grep -q ":$PORT "; then echo "port $PORT is busy" >&2; exit 1; fi
WORK=$(mktemp -d /dev/shm/sara-qp.XXXXXX); chown sara:sara "$WORK"; chmod 700 "$WORK"
PID=
# sudo does not pass our TERM on to node, so its child is stopped first.
cleanup() { set +e; if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then pkill -TERM -P "$PID"; kill "$PID"; wait "$PID"; fi; rm -rf "$WORK"; echo "cleaned $WORK (pid ${PID:-none}; alive after: $(kill -0 "$PID" 2>/dev/null && echo yes || echo no))"; }
trap cleanup EXIT
install -o sara -g sara -m 600 "$SCRIPT" "$WORK/qualify.mjs"
sudo -u sara mkdir -p "$WORK/data" "$WORK/home" "$WORK/tmp"
cd "$SRC"
sudo -u sara env -i PATH=/usr/bin:/bin HOME="$WORK/home" TMPDIR="$WORK/tmp" NODE_ENV=production \
  SARA_DATA="$WORK/data" SARA_HOST=127.0.0.1 SARA_PORT=$PORT ${STORE_URL:+SARA_STORE_URL=$STORE_URL} \
  nice -n 15 ionice -c 3 "$NODE" --disable-warning=ExperimentalWarning "$SRC/src/main.ts" > "$WORK/server.log" 2>&1 &
PID=$!
for _ in $(seq 60); do grep -q "listening on" "$WORK/server.log" 2>/dev/null && break; sleep 1; done
grep -E "Tool sandbox|listening on|Plugin" "$WORK/server.log" | head -5
TOKEN=$(grep -A1 "owner token (shown once" "$WORK/server.log" | tail -1 | tr -d ' ')
sudo -u sara env -i PATH=/usr/bin:/bin HOME="$WORK/home" TMPDIR="$WORK/tmp" SARA_TOKEN="$TOKEN" \
  nice -n 15 "$NODE" "$WORK/qualify.mjs" --base http://127.0.0.1:$PORT --data "$WORK/data" --root "$SRC" --os linux --out "$WORK/results.json" "$@" || true
cp "$WORK/results.json" "$OUT" 2>/dev/null || true
if kill -0 "$PID" 2>/dev/null; then echo "server still running at the end"; else echo "SERVER EXITED during the run:"; tail -8 "$WORK/server.log"; fi
grep -i -E "error|refus" "$WORK/server.log" | tail -20 || true
