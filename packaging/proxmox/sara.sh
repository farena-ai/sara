#!/usr/bin/env bash
# Sara on Proxmox VE: creates a Debian 12 LXC container and installs Sara in it with her own
# one-command installer (deploy/get-sara.sh), without questions. Written in the style of the
# community Proxmox VE helper scripts (https://community-scripts.github.io/ProxmoxVE/), but
# self-contained: it needs nothing but the Proxmox host's own tools (pct, pveam, pvesh).
#
# Run on the Proxmox host as root (Shell in the web UI):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/packaging/proxmox/sara.sh)"
#
# Settings (environment variables; the defaults are fine for most):
#   var_ctid        container id                (default: next free id)
#   var_hostname    host name                   (sara)
#   var_cpu         CPU cores                   (2)
#   var_ram         memory in MB                (2048)
#   var_disk        disk in GB                  (8)
#   var_storage     storage for the disk        (local-lvm)
#   var_tmpl_store  storage for the template    (local)
#   var_bridge      network bridge              (vmbr0)
#   var_net         ip=dhcp or ip=192.168.1.50/24,gw=192.168.1.1   (ip=dhcp)
#   var_port        Sara's port                 (7860)
#   var_access      lan | tailscale | local     (lan: plain HTTP on your home network)
#   var_ref         Sara branch or tag          (this script's release tag, v<SARA_VERSION>)
#   var_sha256      SHA256 of that get-sara.sh  (filled in for the release tag; from the release's
#                   SHA256SUMS when you pick another tag; empty = not checked, with a warning)
#   var_unprivileged 1 = unprivileged container (1, recommended)
set -Eeuo pipefail

# Filled in at release by scripts/update-packaging.ts (the release's version and the SHA256 of its
# get-sara.sh from SHA256SUMS).
SARA_VERSION="2.20.0"
GET_SARA_SHA256="45a0bcbed192b805e820222077e56585a250fc554df030300313dc9f5a18262f"

APP="Sara"
var_hostname="${var_hostname:-sara}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-2048}"
var_disk="${var_disk:-8}"
var_storage="${var_storage:-local-lvm}"
var_tmpl_store="${var_tmpl_store:-local}"
var_bridge="${var_bridge:-vmbr0}"
var_net="${var_net:-ip=dhcp}"
var_port="${var_port:-7860}"
var_access="${var_access:-lan}"
var_ref="${var_ref:-v${SARA_VERSION}}"
# The checksum filled in above belongs to the release tag's get-sara.sh only.
if [[ -z "${var_sha256:-}" && "$var_ref" == "v${SARA_VERSION}" ]]; then var_sha256="$GET_SARA_SHA256"; fi
var_sha256="${var_sha256:-}"
var_unprivileged="${var_unprivileged:-1}"
var_os="debian"
var_version="12"
GET_SARA="https://raw.githubusercontent.com/farena-ai/sara/${var_ref}/deploy/get-sara.sh"

YW=$'\033[33m' GN=$'\033[1;92m' RD=$'\033[01;31m' BL=$'\033[36m' CL=$'\033[m'
msg_info() { printf ' %s…%s %s\n' "$YW" "$CL" "$1"; }
msg_ok() { printf ' %s✔%s %s\n' "$GN" "$CL" "$1"; }
msg_error() { printf ' %s✖%s %s\n' "$RD" "$CL" "$1" >&2; }
die() { msg_error "$1"; exit 1; }
trap 'msg_error "Stopped at line $LINENO: $BASH_COMMAND"' ERR

header_info() {
  cat <<EOF
${BL}   ____
  / __/__ ________ _
 _\ \/ _ \`/ __/ _ \`/
/___/\_,_/_/  \_,_/   ${CL}self-hosted AI companion · Proxmox VE LXC

EOF
}

header_info
[[ $EUID -eq 0 ]] || die "Run this as root on the Proxmox VE host."
command -v pct >/dev/null && command -v pveam >/dev/null || die "This isn't a Proxmox VE host (no pct/pveam)."
case "$var_access" in lan|tailscale|local) ;; *) die "var_access must be lan, tailscale or local." ;; esac
[[ "$var_port" =~ ^[0-9]+$ ]] && (( var_port >= 1024 && var_port <= 65535 )) || die "var_port must be 1024-65535."
[[ "$var_ref" =~ ^[A-Za-z0-9._/-]+$ ]] || die "var_ref must be a branch or tag name (letters, digits, . _ / -)."
[[ -z "$var_sha256" || "$var_sha256" =~ ^[0-9a-fA-F]{64}$ ]] || die "var_sha256 must be 64 hex characters (from the release's SHA256SUMS)."
[[ "$(dpkg --print-architecture)" == amd64 ]] || die "Proxmox LXC templates for Debian are amd64; this host is $(dpkg --print-architecture)."

CTID="${var_ctid:-$(pvesh get /cluster/nextid)}"
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists; set var_ctid to a free id."

msg_info "Finding the Debian ${var_version} template"
pveam update >/dev/null || true
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E "^${var_os}-${var_version}-standard_.*_amd64\.tar\.zst$" | sort -V | tail -1)"
[[ -n "$TEMPLATE" ]] || die "No ${var_os}-${var_version}-standard template found (pveam available --section system)."
if ! pveam list "$var_tmpl_store" | grep -q "$TEMPLATE"; then
  pveam download "$var_tmpl_store" "$TEMPLATE" >/dev/null
fi
msg_ok "Template $TEMPLATE"

msg_info "Creating LXC container $CTID"
# nesting=1 lets systemd and Sara's command sandbox (bubblewrap) work in the container.
pct create "$CTID" "${var_tmpl_store}:vztmpl/${TEMPLATE}" \
  --hostname "$var_hostname" --cores "$var_cpu" --memory "$var_ram" --swap 512 \
  --rootfs "${var_storage}:${var_disk}" \
  --net0 "name=eth0,bridge=${var_bridge},${var_net}" \
  --unprivileged "$var_unprivileged" --features nesting=1,keyctl=1 \
  --onboot 1 --tags "ai;sara" \
  --description "Sara, a self-hosted AI companion: https://github.com/farena-ai/sara" >/dev/null
pct start "$CTID"
for _ in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done
pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 || die "Container $CTID has no network (check var_bridge/var_net)."
msg_ok "Created LXC container $CTID ($var_hostname)"

msg_info "Updating Debian and installing curl"
pct exec "$CTID" -- bash -c "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get -y -qq dist-upgrade >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null"
msg_ok "Debian is up to date"

msg_info "Downloading Sara's installer ($var_ref)"
# Downloaded and checked here on the host, then copied in: it runs as root in the container.
GET_TMP="$(mktemp)"
trap 'rm -f "$GET_TMP"' EXIT
curl -fsSL "$GET_SARA" -o "$GET_TMP" || die "Couldn't download $GET_SARA."
if [[ -n "$var_sha256" ]]; then
  echo "${var_sha256,,}  $GET_TMP" | sha256sum -c --status - || die "get-sara.sh doesn't match the expected SHA256 ($var_sha256). Nothing was installed."
  msg_ok "Downloaded get-sara.sh (SHA256 checked)"
else
  msg_error "get-sara.sh was not checked: no SHA256 for $var_ref (set var_sha256 from that release's SHA256SUMS)."
fi
pct push "$CTID" "$GET_TMP" /root/get-sara.sh --perms 0700

msg_info "Installing Sara (a few minutes)"
# Tailscale needs signing in first, so that choice installs as "local" and is switched after.
INSTALL_ACCESS="$var_access"; [[ "$var_access" == tailscale ]] && INSTALL_ACCESS=local
# Every value is quoted for the container's shell (printf %q), never pasted in as it is.
printf -v INSTALL_CMD 'SARA_REF=%q bash /root/get-sara.sh --yes --access %q --port %q' "$var_ref" "$INSTALL_ACCESS" "$var_port"
pct exec "$CTID" -- bash -c "$INSTALL_CMD"
msg_ok "Installed Sara"

IP="$(pct exec "$CTID" -- hostname -I | awk '{print $1}')"
echo
msg_ok "Completed successfully!"
case "$var_access" in
  lan) echo "  Open:  ${GN}http://${IP}:${var_port}${CL}  (plain HTTP; use it only on your home network)" ;;
  local) echo "  Sara listens on the container's localhost; reach her with: ssh -L ${var_port}:localhost:${var_port} root@${IP}" ;;
  tailscale) echo "  Install Tailscale in the container (https://tailscale.com/download/linux), sign in with: pct exec $CTID -- tailscale up"
             echo "  then switch: pct exec $CTID -- sara access tailscale   (unprivileged LXC also needs /dev/net/tun passed through)" ;;
esac
# The one-time owner token is not printed here (terminal scrollback and logs keep it): say where it is.
if pct exec "$CTID" -- test -s /var/lib/sara/first-token.txt 2>/dev/null; then
  echo "  Owner token: run ${YW}pct exec $CTID -- cat /var/lib/sara/first-token.txt${CL}, sign in with it once and keep it"
  echo "  in your password manager (the file is deleted after that first sign-in)."
else
  echo "  Owner token: pct exec $CTID -- journalctl -u sara --no-pager | grep -A1 'owner token'"
fi
echo "  Update later: pct exec $CTID -- sara update   ·   Status: pct exec $CTID -- sara status"
