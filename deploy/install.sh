#!/usr/bin/env bash
# Native install / upgrade of Sara as a systemd service on any systemd Linux distribution
# (Debian/Ubuntu, Fedora/RHEL/AlmaLinux/Rocky, Arch, openSUSE, ...).
#
#   sudo git clone https://github.com/farena-ai/sara /opt/sara-src
#   sudo /opt/sara-src/deploy/install.sh                       # install or upgrade
#   sudo SARA_BEHIND_PROXY=1 /opt/sara-src/deploy/install.sh   # (any time) Sara is behind an HTTPS reverse proxy
#
# The guided installer (deploy/get-sara.sh) runs this script with SARA_ACCESS=local|tailscale|
# domain|lan (plus SARA_PORT, SARA_DOMAIN, SARA_EMAIL) to also set up how she's reached
# (deploy/lib-access.sh; later: sudo sara access).
#
# Re-running upgrades the code in /opt/sara and keeps /var/lib/sara (your data) untouched.
#
# Several Saras on one server: give each its own name (deploy/lib-instance.sh lists what follows
# from it). Without a name everything is exactly as above ("sara", port 7860).
#   sudo /opt/sara-src/deploy/install.sh --instance work [--port N]   # or SARA_INSTANCE=work
#   /opt/sara-src/deploy/install.sh --dry-run --instance work         # print the plan, change nothing
# Re-running it for an instance that already exists (even one set up by hand) keeps its data,
# settings and port.
# Sara uses her own pinned, checksum-verified Node.js in /opt/sara/node, so she never depends on
# (or changes) a Node.js that other software on the server uses. SARA_USE_SYSTEM_NODE=1 uses the
# system's Node.js 24+ instead (not recommended: other packages decide when it changes, and one
# under /home can't be reached by the hardened service).
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MAJOR=24
# Pinned Node.js release (newest 24.x in https://nodejs.org/dist/index.json when last bumped) and
# the SHA-256 of each build from that release's SHASUMS256.txt. Bump all three together.
NODE_VERSION=v24.22.1
NODE_SHA256_x64=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c
NODE_SHA256_arm64=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3

# ---- Which instance --------------------------------------------------------------
INSTANCE="${SARA_INSTANCE:-}" PORT_ARG="" DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="${2:-}"; shift 2 || true ;;
    --instance=*) INSTANCE="${1#*=}"; shift ;;
    --port) PORT_ARG="${2:-}"; shift 2 || true ;;
    --port=*) PORT_ARG="${1#*=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'Unknown option: %s (install.sh [--instance NAME] [--port N] [--dry-run])\n' "$1" >&2; exit 1 ;;
  esac
done
INSTANCE="${INSTANCE:-sara}"
# Without --port, SARA_PORT (from get-sara.sh or the caller) still sets the port.
PORT_WANTED="${PORT_ARG:-${SARA_PORT:-}}"
# shellcheck source=deploy/lib-instance.sh
. "$SRC_DIR/deploy/lib-instance.sh"
[[ $DRY_RUN -eq 1 ]] || SI_ROOT=""

log() { printf '\033[1;35m[%s]\033[0m %s\n' "$INSTANCE" "$*"; }
warn() { printf '\033[1;33m[%s]\033[0m %s\n' "$INSTANCE" "$*" >&2; }
die() { printf '\033[1;31m[%s]\033[0m %s\n' "$INSTANCE" "$*" >&2; exit 1; }

si_valid_name "$INSTANCE" || die "$(si_check_name "$INSTANCE" || true)"
si_set "$INSTANCE"
APP_DIR="$SI_APP_DIR"
DATA_DIR="$SI_DATA_DIR"
ENV_FILE="$SI_ENV_FILE"
ETC_DIR="$SI_ETC_DIR"
SVC="$INSTANCE"
# The admin command's name in messages (sara for the default instance).
CMD="$INSTANCE"
if [[ -n "$PORT_WANTED" ]] && ! { [[ "$PORT_WANTED" =~ ^[0-9]+$ ]] && (( 10#$PORT_WANTED >= 1024 && 10#$PORT_WANTED <= 65535 )); }; then
  die "--port must be a number from 1024 to 65535."
fi

# The port: the one this instance already has, else the one asked for, else 7860 for the default
# instance (as always) and the next free one from 7860 for any other.
# The port this instance has now: its env file, else its service unit (a hand-built instance may
# only have it there), else nothing.
port_current() {
  local cur
  cur="$(si_file_get "$SI_ROOT$ENV_FILE" SARA_PORT)"
  [[ -n "$cur" ]] || cur="$(sed -n 's/^Environment=SARA_PORT=\([0-9]*\).*/\1/p' "$SI_ROOT$SI_UNIT_FILE" 2>/dev/null | tail -1 || true)"
  printf '%s' "$cur"
}
port_plan() {
  local cur
  cur="$(port_current)"
  if [[ -n "$PORT_WANTED" ]]; then echo "$PORT_WANTED"
  elif [[ -n "$cur" ]]; then echo "$cur"
  elif [[ "$INSTANCE" == sara ]]; then echo 7860
  else si_pick_port || die "No free port from 7860 up."
  fi
}

if [[ $DRY_RUN -eq 1 ]]; then
  # Prints what an install would create; needs no root and changes nothing.
  why="$(si_check_name "$INSTANCE" 2>&1)" || die "$why"
  PLAN_PORT="$(port_plan)"
  if [[ "${SARA_USE_SYSTEM_NODE:-0}" == 1 ]]; then plan_node="(system Node.js 24+)"; else plan_node="$APP_DIR/node/bin/node"; fi
  si_plan "$PLAN_PORT" "$plan_node"
  if [[ "$PLAN_PORT" != "$(port_current)" ]] && si_port_taken "$PLAN_PORT"; then
    echo "port_status=taken"
  else
    echo "port_status=free"
  fi
  [[ -f "$SI_ROOT$ENV_FILE" ]] && echo "existing=yes" || echo "existing=no"
  exit 0
fi

# ---- Checks (nothing is changed before these pass) ---------------------------
[[ $EUID -eq 0 ]] || die "Run as root (sudo ./deploy/install.sh${INSTANCE:+ --instance $INSTANCE})."
if ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then
  die "This system isn't running systemd (common in containers, WSL without systemd and some minimal images), so the native install can't work here. Use Docker Compose instead: docs/INSTALL.md, 'Docker Compose'."
fi
[[ -f "$SRC_DIR/src/main.ts" ]] || die "Run this script from a Sara checkout."
for cmd in curl tar gzip sha256sum; do
  command -v "$cmd" >/dev/null || die "Missing required command: $cmd (install it with your package manager, e.g. apt install $cmd or dnf install $cmd)"
done
CA_OK=0
for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
  if [[ -s "$f" ]]; then CA_OK=1; break; fi
done
[[ $CA_OK -eq 1 ]] || die "No CA certificates found, so secure (HTTPS) downloads would fail. Install them first: sudo apt install ca-certificates (or: sudo dnf install ca-certificates), then run this again."
# Never take over an ordinary account that happens to be called sara (a person on this server).
if [[ "$INSTANCE" == sara ]]; then
  if id sara >/dev/null 2>&1 && [[ "$(id -u sara)" -ge 1000 ]]; then
    die "An ordinary (non-system) account named 'sara' already exists (uid $(id -u sara)). Sara needs that name for her own locked-down service account; rename the existing account first. Nothing was changed."
  fi
else
  # Another instance: a valid, free name (never someone's account or a well-known command).
  why="$(si_check_name "$INSTANCE" 2>&1)" || die "$why"
fi
PORT_NOW="$(port_current)"
PORT_NEW="$(port_plan)"
# A port this instance doesn't have yet must be free: nothing listening on it, and no other
# instance's settings using it.
if [[ "$PORT_NEW" != "$PORT_NOW" || ! -f "$ENV_FILE" ]]; then
  if si_port_assigned "$PORT_NEW"; then
    die "Port $PORT_NEW already belongs to another Sara on this server. Pick another with --port N. Nothing was changed."
  fi
  if si_port_listening "$PORT_NEW" && ! systemctl is-active --quiet "$SVC" 2>/dev/null; then
    die "Something else is already using port $PORT_NEW. Pick another with --port N. Nothing was changed."
  fi
elif si_port_listening "$PORT_NEW" && ! systemctl is-active --quiet "$SVC" 2>/dev/null && [[ "$INSTANCE" != sara ]]; then
  die "Something else is using port $PORT_NEW, so $SVC couldn't start there. Free it, or move $SVC with --port N. Nothing was changed."
fi

# Read a value from sara.env, without surrounding quotes.
env_get() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
# Set (or add) KEY=VALUE in sara.env, keeping every other line.
env_set() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# ---- Node.js runtime -------------------------------------------------------
NODE_BIN=""
if [[ "${SARA_USE_SYSTEM_NODE:-0}" == 1 ]]; then
  if ! command -v node >/dev/null || [[ "$(node_major node)" -lt $NODE_MAJOR ]]; then
    die "SARA_USE_SYSTEM_NODE=1 but there is no Node.js $NODE_MAJOR+ on PATH."
  fi
  NODE_BIN="$(readlink -f "$(command -v node)")"
  case "$NODE_BIN" in
    /home/*|/root/*|/run/user/*) die "The system Node.js is in $(dirname "$NODE_BIN"), which the hardened service can't reach. Leave SARA_USE_SYSTEM_NODE unset to use Sara's own Node.js." ;;
  esac
  log "Using system Node.js $(node -v) at $NODE_BIN (SARA_USE_SYSTEM_NODE=1)"
else
  case "$(uname -m)" in
    x86_64) ARCH=x64; SUM="$NODE_SHA256_x64" ;;
    aarch64|arm64) ARCH=arm64; SUM="$NODE_SHA256_arm64" ;;
    *) die "Unsupported CPU architecture: $(uname -m) (the installer supports x86_64 and arm64)." ;;
  esac
  if [[ -x "$APP_DIR/node/bin/node" && "$("$APP_DIR/node/bin/node" -v 2>/dev/null)" == "$NODE_VERSION" ]]; then
    log "Private Node.js $NODE_VERSION already installed."
  else
    FILE="node-${NODE_VERSION}-linux-${ARCH}.tar.gz"
    # Another Sara on this server may already have exactly this Node.js: copy it (root-owned,
    # same version, checked by running it) instead of downloading it again.
    for other in /opt/*/node; do
      [[ "$other" != "$APP_DIR/node" && -x "$other/bin/node" && "$(stat -c %u "$other")" == 0 ]] || continue
      [[ -f "$(dirname "$other")/src/main.ts" && "$("$other/bin/node" -v 2>/dev/null)" == "$NODE_VERSION" ]] || continue
      log "Copying Node.js $NODE_VERSION from $other..."
      mkdir -p "$APP_DIR"
      rm -rf "$APP_DIR/node.new"
      cp -a "$other" "$APP_DIR/node.new"
      rm -rf "$APP_DIR/node"
      mv "$APP_DIR/node.new" "$APP_DIR/node"
      break
    done
  fi
  if [[ -x "$APP_DIR/node/bin/node" && "$("$APP_DIR/node/bin/node" -v 2>/dev/null)" == "$NODE_VERSION" ]]; then
    :
  else
    FILE="node-${NODE_VERSION}-linux-${ARCH}.tar.gz"
    log "Installing private Node.js $NODE_VERSION to $APP_DIR/node (system Node is left alone)..."
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    if ! curl -fsSL --retry 3 --connect-timeout 20 "https://nodejs.org/dist/${NODE_VERSION}/${FILE}" -o "$TMP/$FILE"; then
      if [[ -x "$APP_DIR/node/bin/node" && "$(node_major "$APP_DIR/node/bin/node")" -ge $NODE_MAJOR ]]; then
        warn "Couldn't reach nodejs.org; keeping Node.js $("$APP_DIR/node/bin/node" -v) already in $APP_DIR/node."
      else
        die "Couldn't download Node.js from nodejs.org. Check this server's internet connection and DNS (try: curl -I https://nodejs.org), then run the installer again. Nothing was changed."
      fi
    else
      echo "$SUM  $TMP/$FILE" | sha256sum -c --quiet - || die "Node.js checksum mismatch: the download was damaged or tampered with. Nothing was changed."
      mkdir -p "$APP_DIR"
      rm -rf "$APP_DIR/node.new"
      mkdir "$APP_DIR/node.new"
      tar -xzf "$TMP/$FILE" -C "$APP_DIR/node.new" --strip-components=1
      rm -rf "$APP_DIR/node"
      mv "$APP_DIR/node.new" "$APP_DIR/node"
    fi
  fi
  NODE_BIN="$APP_DIR/node/bin/node"
fi
NPM_BIN="$(dirname "$NODE_BIN")/npm"

# ---- User, code, data ------------------------------------------------------
if ! id "$SI_USER" >/dev/null 2>&1; then
  log "Creating system user '$SI_USER'..."
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SI_USER"
fi

log "Installing application to $APP_DIR..."
mkdir -p "$APP_DIR"
for item in src web persona templates skills package.json package-lock.json; do
  rm -rf "${APP_DIR:?}/$item"
  cp -r "$SRC_DIR/$item" "$APP_DIR/"
done
# Phase 87: the shared page agent her testing browser reads pages with (also in the desktop apps).
rm -rf "${APP_DIR:?}/desktop" && mkdir -p "$APP_DIR/desktop/shared"
cp "$SRC_DIR/desktop/shared/page-agent.js" "$APP_DIR/desktop/shared/"
cp -r "$SRC_DIR/desktop/linux" "$APP_DIR/desktop/"
SRC_OWNER="$(stat -c %u "$SRC_DIR")"
if [[ -d "$SRC_DIR/.git" ]] && command -v git >/dev/null; then
  git -C "$SRC_DIR" rev-parse --short HEAD > "$APP_DIR/REVISION" 2>/dev/null || rm -f "$APP_DIR/REVISION"
fi
(cd "$APP_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
chown -R root:root "$APP_DIR"

mkdir -p "$DATA_DIR" "$ETC_DIR"
# A hand-built instance may have given its data to another owner: it must be the instance's.
chown "$SI_USER:$SI_GROUP" "$DATA_DIR"
chmod 700 "$DATA_DIR"
PROXY_CHANGED=0
if [[ ! -f "$ENV_FILE" ]]; then
  PROXY="${SARA_BEHIND_PROXY:-0}"; [[ "$PROXY" == 1 ]] || PROXY=0
  cat > "$ENV_FILE" <<EOF
# Sara settings. Restart after editing: systemctl restart $SVC
SARA_HOST=${SARA_HOST:-127.0.0.1}
SARA_PORT=${PORT_NEW}
# 1 when Sara is served over HTTPS through a reverse proxy on this machine.
SARA_SECURE_COOKIES=${PROXY}
SARA_TRUST_PROXY=${PROXY}
EOF
  chmod 640 "$ENV_FILE"
elif [[ -n "${SARA_BEHIND_PROXY:-}" ]]; then
  # The documented order is "install, then add HTTPS": a re-run with SARA_BEHIND_PROXY updates just
  # these two lines of the existing settings and keeps every other line.
  PROXY="$SARA_BEHIND_PROXY"; [[ "$PROXY" == 1 ]] || PROXY=0
  if [[ "$(env_get SARA_SECURE_COOKIES)" != "$PROXY" || "$(env_get SARA_TRUST_PROXY)" != "$PROXY" ]]; then
    env_set SARA_SECURE_COOKIES "$PROXY"
    env_set SARA_TRUST_PROXY "$PROXY"
    PROXY_CHANGED=1
    log "Set SARA_SECURE_COOKIES=$PROXY and SARA_TRUST_PROXY=$PROXY in $ENV_FILE (other settings kept)."
  else
    log "Proxy settings in $ENV_FILE already match SARA_BEHIND_PROXY=$PROXY."
  fi
fi
if [[ -n "$PORT_ARG" && "$PORT_ARG" != "$(env_get SARA_PORT)" ]]; then
  env_set SARA_PORT "$PORT_ARG"
  log "Set SARA_PORT=$PORT_ARG in $ENV_FILE (other settings kept)."
elif [[ "$INSTANCE" != sara && -z "$(env_get SARA_PORT)" ]]; then
  # (a hand-built instance that had its port only in the unit)
  env_set SARA_PORT "$PORT_NEW"
fi
# Which instance this is (read by the admin command; root-owned, readable by root only).
if [[ "$INSTANCE" != sara || -f "$SI_INSTANCE_FILE" ]]; then
  cat > "$SI_INSTANCE_FILE" <<EOF
# Written by deploy/install.sh: this Sara instance. Don't edit; run the installer again instead.
SARA_INSTANCE=$INSTANCE
EOF
  chmod 644 "$SI_INSTANCE_FILE"
fi

# How she's reached (guided install): Tailscale serve, a Caddy site, or plain local/home network.
GUIDED=0
if [[ -n "${SARA_ACCESS:-}" ]]; then
  GUIDED=1
  SA_INTERACTIVE=0
  # shellcheck source=deploy/lib-access.sh
  . "$SRC_DIR/deploy/lib-access.sh"
  ACCESS_PORT="${PORT_WANTED:-$(env_get SARA_PORT)}"; ACCESS_PORT="${ACCESS_PORT:-7860}"
  sa_valid_port "$ACCESS_PORT" || die "SARA_PORT must be a number from 1024 to 65535."
  if [[ "${SARA_ACCESS_CHECKED:-0}" != 1 ]]; then
    sa_check "$SARA_ACCESS" "$ACCESS_PORT" || die "Can't set up '$SARA_ACCESS' (see above). Sara's settings were kept as they were."
    sa_prepare "$SARA_ACCESS"
  fi
  sa_apply "$SARA_ACCESS" "$ACCESS_PORT"
fi

# Admin command (sara status/update/backup/restore/logs/access) and where `sara update` pulls from.
if [[ "$INSTANCE" == sara ]]; then
  install -m 755 "$SRC_DIR/deploy/sara" /usr/local/bin/sara
else
  # A hand-made command for this instance is kept next to her settings, once.
  if [[ -f "$SI_ADMIN" ]] && ! grep -q 'Sara admin command' "$SI_ADMIN" && [[ ! -e "$ETC_DIR/$INSTANCE-command.before-install" ]]; then
    cp -p "$SI_ADMIN" "$ETC_DIR/$INSTANCE-command.before-install"
    log "Kept the previous $SI_ADMIN as $ETC_DIR/$INSTANCE-command.before-install"
  fi
  si_render_admin < "$SRC_DIR/deploy/sara" > "$SI_ADMIN.new"
  grep -q "^SARA_INSTANCE_NAME=$INSTANCE " "$SI_ADMIN.new" || { rm -f "$SI_ADMIN.new"; die "Couldn't build $SI_ADMIN from deploy/sara."; }
  chmod 755 "$SI_ADMIN.new" && mv -f "$SI_ADMIN.new" "$SI_ADMIN"
fi
install -m 644 "$SRC_DIR/deploy/lib-access.sh" "$APP_DIR/lib-access.sh"
install -m 644 "$SRC_DIR/deploy/lib-instance.sh" "$APP_DIR/lib-instance.sh"
UPDATES_OK=1
if [[ -d "$SRC_DIR/.git" ]]; then
  if [[ "$SRC_OWNER" == 0 ]]; then
    echo "$SRC_DIR" > "$SI_SOURCE_FILE"
  else
    # Updates run git as root in this folder. git refuses a checkout owned by another user
    # ("dubious ownership"), and rightly: that user could plant hooks or config in .git that root
    # would then run. Marking it safe.directory for root would hand that user root, so the
    # installer doesn't; the checkout must be root's own. It is not recorded, and the end of this
    # script tells the user the one command that moves it.
    UPDATES_OK=0
    rm -f "$SI_SOURCE_FILE"
  fi
fi
mkdir -p "$DATA_DIR/backups"
chown "$SI_USER:$SI_GROUP" "$DATA_DIR/backups"
chmod 700 "$DATA_DIR/backups"

# ---- systemd ---------------------------------------------------------------
# A hand-made unit (adopting an instance built by hand) is kept next to her settings, once.
if [[ "$INSTANCE" != sara && -f "$SI_UNIT_FILE" ]] && ! grep -q '^# Sara instance' "$SI_UNIT_FILE" && [[ ! -e "$ETC_DIR/$INSTANCE.service.before-install" ]]; then
  cp -p "$SI_UNIT_FILE" "$ETC_DIR/$INSTANCE.service.before-install"
  log "Kept the previous $SI_UNIT_FILE as $ETC_DIR/$INSTANCE.service.before-install"
fi
UNIT_PORT="$(env_get SARA_PORT)"
si_render_unit "$NODE_BIN" "${UNIT_PORT:-$PORT_NEW}" < "$SRC_DIR/deploy/sara.service" > "$SI_UNIT_FILE"
chmod 644 "$SI_UNIT_FILE"
# Phase 23: updates from Settings. Sara (an unprivileged user) can only drop a one-word request
# file ("check" or "update"); root does the work with `sara web-request`.
install -d -o root -g "$SI_GROUP" -m 750 "$SI_UPDATER_DIR"
rm -f "$DATA_DIR/update-status.json" "$DATA_DIR/update-status.json.tmp" # (older place, inside sara's folder)
si_render_updater_path < "$SRC_DIR/deploy/sara-updater.path" > "/etc/systemd/system/$SI_UPDATER_PATH"
si_render_updater_service < "$SRC_DIR/deploy/sara-updater.service" > "/etc/systemd/system/$SI_UPDATER_SERVICE"
chmod 644 "/etc/systemd/system/$SI_UPDATER_PATH" "/etc/systemd/system/$SI_UPDATER_SERVICE"
systemctl daemon-reload
systemctl enable "$SVC" >/dev/null
systemctl enable --now "$SI_UPDATER_PATH" >/dev/null 2>&1 || log "Couldn't enable $SI_UPDATER_PATH (updates from Settings won't work; $CMD update still does)."

START_TS="$(date +%s)"
systemctl restart "$SVC"

# Health check on the address Sara listens on (loopback when she listens on every address).
PORT="$(env_get SARA_PORT)"; PORT="${PORT:-7860}"
HOST="$(env_get SARA_HOST)"
case "$HOST" in ''|0.0.0.0|::|'[::]') HOST=127.0.0.1 ;; esac
if [[ "$HOST" == *:* && "$HOST" != \[* ]]; then HOST="[$HOST]"; fi
HEALTH="http://${HOST}:${PORT}/api/health"
for _ in $(seq 1 30); do
  curl -fsS "$HEALTH" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "$HEALTH" >/dev/null 2>&1 || die "Sara failed to start. Check: journalctl -u $SVC -n 50"

log "Sara $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -1)$([[ "$INSTANCE" == sara ]] || echo " ($INSTANCE)") is running on ${HOST}:${PORT}"
# First start: the server writes the one-time owner token to <data>/first-token.txt (0600, owned
# by sara; deleted after the first sign-in). Read it as sara, so a planted symlink can't make root
# print some other file.
TOKEN=""
for _ in $(seq 1 10); do
  if [[ -f "$DATA_DIR/first-token.txt" ]]; then
    TOKEN="$(runuser -u "$SI_USER" -- head -c 200 "$DATA_DIR/first-token.txt" 2>/dev/null | tr -d '\r\n ' || true)"
    break
  fi
  sleep 0.5
done
if [[ -n "$TOKEN" ]]; then
  log ""
  log "Your owner token (sign in with it, then keep it in a password manager):"
  log "    $TOKEN"
  log ""
elif journalctl -u "$SVC" --no-pager --since "@${START_TS}" 2>/dev/null | grep -q 'owner token'; then
  log "First start: your owner token was printed once. View it with:"
  log "  sudo journalctl -u $SVC --no-pager | grep -A1 'owner token' | tail -1"
fi
if [[ $PROXY_CHANGED -eq 1 ]]; then log "HTTPS proxy settings are active (Sara was restarted with them)."; fi
# How to sign in the first time: only until the owner has (afterwards an update stays short).
if [[ $GUIDED -eq 1 ]] || { [[ -n "$TOKEN" ]] && grep -q '^SARA_ACCESS=' "$ENV_FILE"; }; then
  if ! declare -F sa_print_next >/dev/null; then
    SA_INTERACTIVE=0
    # shellcheck source=deploy/lib-access.sh
    . "$SRC_DIR/deploy/lib-access.sh"
  fi
  sa_print_next
elif [[ -n "$TOKEN" ]]; then
  log "Next steps:"
  log "  On this machine:     open http://127.0.0.1:${PORT}"
  log "  From your computer:  ssh -L ${PORT}:127.0.0.1:${PORT} ${SUDO_USER:-you}@<this-server's-address>"
  log "                       then open http://localhost:${PORT} (Sara only listens on this server)"
  log "  Phones and everyday remote use: set up HTTPS, docs/INSTALL.md section 2."
fi
log "Manage her with: sudo $CMD status | sudo $CMD update | sudo $CMD backup | sudo $CMD restore <file> | sudo $CMD logs"
log "Lost the token? sudo $CMD reset-token"
if [[ $UPDATES_OK -eq 0 ]]; then
  warn "This checkout ($SRC_DIR) isn't owned by root, so '$CMD update' and Settings → Updates can't"
  warn "use it (git won't run as root in another user's folder; that protects root). Move it once:"
  warn "  sudo mv '$SRC_DIR' /opt/sara-src && sudo chown -R root:root /opt/sara-src && sudo /opt/sara-src/deploy/install.sh"
fi
if ! command -v bwrap >/dev/null; then
  log "Tip: for a safer shell for her coding tools, install bubblewrap and restart:"
  if command -v apt-get >/dev/null; then log "  sudo apt install bubblewrap && sudo systemctl restart $SVC"
  elif command -v dnf >/dev/null; then log "  sudo dnf install bubblewrap && sudo systemctl restart $SVC"
  else log "  (install the 'bubblewrap' package) then: sudo systemctl restart $SVC"; fi
fi
