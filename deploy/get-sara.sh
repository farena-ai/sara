#!/usr/bin/env bash
# Sara's one-command installer for Linux servers with systemd (Debian/Ubuntu, Fedora/RHEL/Alma/
# Rocky, Arch, openSUSE; x86_64 or arm64).
#
#   curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
#   sudo bash get-sara.sh [options]
#
# It downloads Sara into /opt/sara-src (root's own copy, which `sara update` uses later), checks
# it, asks a few questions (Enter takes the answer in [brackets]), then runs deploy/install.sh.
#
# Options for installs without questions: bash get-sara.sh --help
#
# The only system packages it installs are git, curl and ca-certificates (if missing), plus what
# you choose: bubblewrap, caddy (for your own web address) and bzip2 (for voice). It asks first
# whenever someone is there to answer.

main() {
set -euo pipefail

REPO="${SARA_REPO:-https://github.com/farena-ai/sara.git}"
REF="${SARA_REF:-main}"
# One source copy for every Sara on this server (each instance installs her own copy of the
# program from it into /opt/<name>, and updates only herself).
SRC=/opt/sara-src
INSTANCE="${SARA_INSTANCE:-sara}"

log() { printf '\033[1;35m[sara]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[sara]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[sara]\033[0m %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Install Sara (asks a few questions; Enter takes the answer in [brackets]):
  curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash
  sudo bash get-sara.sh [options]

Options (for installs without questions):
  --yes                    ask nothing, take the suggested answers (and the options given)
  --access HOW             how you'll reach her: tailscale | local | domain | lan
  --domain NAME            your web address, for --access domain (sara.example.com)
  --email ADDRESS          email for Let's Encrypt certificate notices (--access domain)
  --port N                 her port on this machine (default 7860)
  --sandbox | --no-sandbox install bubblewrap, a safer shell for her coding tools (default: yes)
  --voice | --no-voice     local voice on this server, about 650 MB download (default: no)
  --source PATH            install from a local folder or .tar(.gz) instead of downloading
  --preflight              only check this server (disk, memory, port, system, network) and
                           show what to fix; changes nothing, needs no root
  --instance NAME          another, separate Sara next to an existing one (e.g. work): her own
                           user, data, settings, port, service and admin command, all named NAME
  --help                   this text

Environment: SARA_REPO (git URL or path; default the GitHub repository), SARA_REF (branch or
tag; default main). Change how you reach her later with: sudo sara access
EOF
}

# ---- Preflight (W2.1): every check explained, with the exact next step -------------
# >>> lib-preflight.sh (a copy of deploy/lib-preflight.sh: node scripts/sync-preflight.ts)
# ---- body"
# between its "# >>> lib-preflight.sh" markers: after editing this file run
#   node scripts/sync-preflight.ts
#
# Tests swap in facts with PF_ROOT (a folder holding etc/os-release, proc/meminfo, etc/<name>/)
# and PF_FAKE_ARCH, PF_FAKE_EUID, PF_FAKE_SYSTEMD (0|1), PF_FAKE_GLIBC ('' = musl),
# PF_FAKE_DF_KB, PF_FAKE_BUSY_PORTS, PF_FAKE_NET (up|down), PF_FAKE_NET_DOWN_HOSTS.
# ---- body
PF_DISK_FAIL_MB=1024
PF_DISK_WARN_MB=3072
PF_RAM_FAIL_MB=450
PF_RAM_WARN_MB=1536
PF_MIN_GLIBC=2.28

pf_arch() { printf '%s' "${PF_FAKE_ARCH:-$(uname -m)}"; }
pf_euid() { printf '%s' "${PF_FAKE_EUID:-$EUID}"; }
pf_systemd() {
  if [[ -n "${PF_FAKE_SYSTEMD:-}" ]]; then [[ "$PF_FAKE_SYSTEMD" == 1 ]]; return; fi
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]
}
# The glibc version, '' for musl, '?' when unknown.
pf_glibc() {
  if [[ -n "${PF_FAKE_GLIBC+x}" ]]; then printf '%s' "$PF_FAKE_GLIBC"; return; fi
  local v
  if v="$(getconf GNU_LIBC_VERSION 2>/dev/null)"; then printf '%s' "${v##* }"
  elif ldd --version 2>&1 | grep -qi musl; then printf ''
  else printf '?'; fi
}
# Free kB where path $1 (or its nearest existing parent) lives.
pf_df_kb() {
  if [[ -n "${PF_FAKE_DF_KB:-}" ]]; then printf '%s' "$PF_FAKE_DF_KB"; return; fi
  local p="$1"
  while [[ ! -e "$p" && "$p" != / ]]; do p="$(dirname "$p")"; done
  { df -Pk "$p" 2>/dev/null || true; } | awk 'NR==2 {print $4}'
}
pf_port_busy() {
  if [[ -n "${PF_FAKE_BUSY_PORTS+x}" ]]; then [[ " $PF_FAKE_BUSY_PORTS " == *" $1 "* ]]; return; fi
  if command -v ss >/dev/null 2>&1; then ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; return; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}
pf_reach() {
  [[ " ${PF_FAKE_NET_DOWN_HOSTS:-} " == *" $1 "* ]] && return 1
  case "${PF_FAKE_NET:-}" in up) return 0 ;; down) return 1 ;; esac
  curl -sS -I --max-time 8 -o /dev/null "https://$1/" 2>/dev/null
}
pf_os_get() { { sed -n "s/^$1=//p" "${PF_ROOT:-}/etc/os-release" 2>/dev/null || true; } | head -1 | tr -d '"'; }
pf_lt() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a + 0 < b + 0) }'; }
pf_ver_lt() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" == "$1" ]]; }

PF_OK=0 PF_WARN=0 PF_FAIL=0 PF_LINES=()
pf_card() {
  # pf_card ok|warn|fail "title" ["why" "next step"]
  case "$1" in
    ok) PF_OK=$((PF_OK + 1)); PF_LINES+=("  OK   $2") ;;
    warn) PF_WARN=$((PF_WARN + 1)); PF_LINES+=("  LOOK $2" "       $3" "       Next step: $4") ;;
    fail) PF_FAIL=$((PF_FAIL + 1)); PF_LINES+=("  FIX  $2" "       $3" "       Next step: $4") ;;
  esac
}

# pf_run INSTANCE PORT "HOSTS" CHECK_ONLY(0|1): prints the cards; 1 when anything must be fixed.
pf_run() {
  local inst="$1" port="$2" hosts="$3" only="${4:-0}"
  local root="${PF_ROOT:-}" arch id ver name glibc min mem_kb mem_mb kb mb envf down h
  PF_OK=0 PF_WARN=0 PF_FAIL=0 PF_LINES=()

  # CPU
  arch="$(pf_arch)"
  case "$arch" in
    x86_64|aarch64|arm64) pf_card ok "CPU: $arch" ;;
    armv6l|armv7l|armhf|arm)
      pf_card fail "This is a 32-bit system ($arch)" "Sara needs a 64-bit system (Node.js 24 has no 32-bit ARM build). A Raspberry Pi 3, 4 or 5 can run 64-bit." \
        "Write \"Raspberry Pi OS (64-bit)\" to the card with Raspberry Pi Imager (Choose OS -> Raspberry Pi OS (other)), boot it, then run this again." ;;
    *) pf_card fail "Unsupported CPU: $arch" "Sara runs on 64-bit Intel/AMD (x86_64) and 64-bit ARM computers." \
        "Install her on a 64-bit computer or server instead (a Raspberry Pi 4/5 with 64-bit Raspberry Pi OS, any recent PC, or a small cloud server)." ;;
  esac

  # OS version (and systemd, which the service needs)
  id="$(pf_os_get ID)"; ver="$(pf_os_get VERSION_ID)"; name="$(pf_os_get PRETTY_NAME)"; name="${name:-${id:-Linux} $ver}"
  glibc="$(pf_glibc)"
  case "$id" in
    ubuntu) min=22.04 ;; debian|raspbian) min=12 ;; fedora) min=39 ;; almalinux|rocky|rhel|centos|ol) min=9 ;; opensuse-leap) min=15.5 ;; *) min="" ;;
  esac
  if [[ -z "$glibc" ]]; then
    pf_card fail "$name isn't supported by the native installer" "It uses musl instead of glibc, and Sara's Node.js build needs glibc." \
      "Use Docker Compose on this machine (docs/INSTALL.md, 'Docker Compose'), or a Debian/Ubuntu/Fedora system."
  elif [[ "$glibc" != '?' ]] && pf_ver_lt "$glibc" "$PF_MIN_GLIBC"; then
    pf_card fail "$name is too old" "Its C library (glibc $glibc) is older than the $PF_MIN_GLIBC that Node.js 24 needs." \
      "Upgrade the system (Ubuntu: sudo do-release-upgrade) or use a current release (Ubuntu 24.04, Debian 12), then run this again."
  elif ! pf_systemd; then
    pf_card fail "$name isn't running systemd" "Sara is installed as a systemd service; containers, WSL without systemd and some minimal images don't have it." \
      "Use Docker Compose instead (docs/INSTALL.md, 'Docker Compose'). On WSL: add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown, then run this again."
  elif [[ -n "$min" && -n "$ver" ]] && pf_lt "$ver" "$min"; then
    pf_card warn "$name is older than the tested releases" "Sara is tested on $id $min and newer; older ones usually work but aren't checked." \
      "If something fails, upgrade the system or use Docker Compose."
  else
    pf_card ok "System: $name"
  fi

  # Memory
  mem_kb="$(awk '/^MemTotal:/ {print $2}' "$root/proc/meminfo" 2>/dev/null || true)"
  if [[ -z "$mem_kb" ]]; then
    pf_card warn "Memory unknown" "Couldn't read $root/proc/meminfo." "Check by hand that the machine has at least 1 GB of memory (free -h)."
  else
    mem_mb=$((mem_kb / 1024))
    if (( mem_mb < PF_RAM_FAIL_MB )); then
      pf_card fail "Not enough memory" "This machine has $mem_mb MB of memory; Sara needs at least $PF_RAM_FAIL_MB MB (2 GB or more is comfortable)." \
        "Use a machine with at least 1 GB of memory (a Raspberry Pi 4/5 with 2 GB or more, or a bigger cloud plan)."
    elif (( mem_mb < PF_RAM_WARN_MB )); then
      pf_card warn "Memory is tight ($mem_mb MB)" "Sara runs, but big imports and local voice may be slow or stop." \
        "Add 2 GB of swap: sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile (and add '/swapfile none swap sw 0 0' to /etc/fstab)."
    else
      pf_card ok "Memory: $((mem_mb / 1024)) GB"
    fi
  fi

  # Disk: the program goes to /opt, her data to /var/lib (the smaller free space counts).
  kb="$(pf_df_kb "$root/opt")"; h="$(pf_df_kb "$root/var/lib")"
  [[ -n "$h" && -n "$kb" ]] && (( h < kb )) && kb="$h"
  if [[ -z "$kb" ]]; then
    pf_card warn "Free disk space unknown" "Couldn't read the free space of /opt and /var/lib." "Check by hand that at least 1 GB is free there (df -h /opt /var/lib)."
  else
    mb=$((kb / 1024))
    if (( mb < PF_DISK_FAIL_MB )); then
      pf_card fail "Not enough free disk space" "/opt and /var/lib have $mb MB free; Sara needs at least $PF_DISK_FAIL_MB MB ($((PF_DISK_WARN_MB / 1024)) GB with local voice and backups)." \
        "Free some space (sudo apt clean or sudo dnf clean all; sudo journalctl --vacuum-size=200M), or use a bigger disk, then run this again."
    elif (( mb < PF_DISK_WARN_MB )); then
      pf_card warn "Disk space is low ($mb MB free)" "Enough to start, but backups and local voice need about $((PF_DISK_WARN_MB / 1024)) GB." \
        "Free some space (sudo apt clean or sudo dnf clean all; sudo journalctl --vacuum-size=200M)."
    else
      pf_card ok "Disk: $((mb / 1024)) GB free"
    fi
  fi

  # Existing install, then the port (her own port is no clash on an update)
  envf="$root/etc/$inst/$inst.env"
  local cur=""
  if [[ -f "$envf" ]]; then
    cur="$(sed -n 's/^SARA_PORT=//p' "$envf" | tail -1 | tr -d "\"'")"
    pf_card ok "Sara ($inst) is already installed here: this updates her; her data stays"
  else
    pf_card ok "No earlier install of '$inst' found"
  fi
  [[ -n "$port" ]] || port="$cur"
  [[ -n "$port" || "$inst" != sara ]] || port=7860
  if [[ -z "$port" ]]; then
    pf_card ok "Port: the next free one from 7860 is picked"
  elif [[ -n "$cur" && "$port" == "$cur" ]]; then
    pf_card ok "Port $port is hers"
  elif pf_port_busy "$port"; then
    pf_card fail "Port $port is already in use" "Another program (maybe another Sara) is listening on port $port." \
      "See what uses it: sudo ss -ltnp 'sport = :$port'. Stop that program, or install on another port: --port $((port + 1))."
  else
    pf_card ok "Port $port is free"
  fi

  # Permissions
  if [[ "$(pf_euid)" != 0 ]]; then
    if [[ "$only" == 1 ]]; then
      pf_card warn "Needs administrator rights" "Installing a service writes to /opt, /etc and /var/lib." "Run the real install with sudo: sudo bash get-sara.sh (or: curl -fsSL <address of get-sara.sh> | sudo bash)."
    else
      pf_card fail "Needs administrator rights" "Installing a service writes to /opt, /etc and /var/lib." "Run it with sudo: sudo bash get-sara.sh (or: curl -fsSL <address of get-sara.sh> | sudo bash)."
    fi
  else
    pf_card ok "Running as root"
  fi

  # Network
  down=""
  for h in $hosts; do pf_reach "$h" || down="$down $h"; done
  if [[ -z "$hosts" ]]; then pf_card ok "Network: nothing to download"
  elif [[ -n "$down" ]]; then
    pf_card fail "Can't reach the internet:${down}" "The installer downloads Node.js and Sara's parts from there." \
      "Check the connection and DNS (try: curl -I https://registry.npmjs.org). Behind a proxy: export https_proxy=http://<proxy>:<port>, then sudo -E bash get-sara.sh."
  else
    pf_card ok "Internet reachable"
  fi

  printf '[%s] Preflight: %s OK, %s to look at, %s to fix\n' "$inst" "$PF_OK" "$PF_WARN" "$PF_FAIL"
  printf '%s\n' "${PF_LINES[@]}"
  if (( PF_FAIL > 0 )); then
    printf '[%s] Nothing was changed. Fix the items marked FIX, then run this again.\n' "$inst"
    return 1
  fi
  return 0
}
# <<< lib-preflight.sh

# ---- Options -----------------------------------------------------------------
PREFLIGHT=0 YES=0 ACCESS="" PORT="" SANDBOX="" VOICE="" SOURCE=""
SARA_DOMAIN="" SARA_EMAIL=""
need_val() { [[ -n "${2:-}" && "${2:0:2}" != -- ]] || die "$1 needs a value (see --help)."; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes|-y) YES=1; shift ;;
    --preflight) PREFLIGHT=1; shift ;;
    --access) need_val "$@"; ACCESS="$2"; shift 2 ;;
    --access=*) ACCESS="${1#*=}"; shift ;;
    --domain) need_val "$@"; SARA_DOMAIN="$2"; shift 2 ;;
    --domain=*) SARA_DOMAIN="${1#*=}"; shift ;;
    --email) need_val "$@"; SARA_EMAIL="$2"; shift 2 ;;
    --email=*) SARA_EMAIL="${1#*=}"; shift ;;
    --port) need_val "$@"; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --sandbox) SANDBOX=y; shift ;;
    --no-sandbox) SANDBOX=n; shift ;;
    --voice) VOICE=y; shift ;;
    --no-voice) VOICE=n; shift ;;
    --source) need_val "$@"; SOURCE="$2"; shift 2 ;;
    --source=*) SOURCE="${1#*=}"; shift ;;
    --instance) need_val "$@"; INSTANCE="$2"; shift 2 ;;
    --instance=*) INSTANCE="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done
# (the full checks, such as reserved names and existing accounts, run once Sara is downloaded)
if ! [[ ${#INSTANCE} -ge 2 && ${#INSTANCE} -le 32 && "$INSTANCE" =~ ^[a-z][a-z0-9-]*$ && "$INSTANCE" != *- ]]; then
  die "--instance must be 2 to 32 lowercase letters, digits or dashes, starting with a letter (for example: work)."
fi
ENV_FILE="/etc/$INSTANCE/$INSTANCE.env"
# The admin command (and the name in messages) is the instance name.
CMD="$INSTANCE"
ACCESS="${ACCESS,,}"
case "$ACCESS" in ''|tailscale|local|domain|lan) ;; *) die "--access must be tailscale, local, domain or lan." ;; esac
if [[ -n "$PORT" ]] && ! { [[ "$PORT" =~ ^[0-9]+$ ]] && (( 10#$PORT >= 1024 && 10#$PORT <= 65535 )); }; then
  die "--port must be a number from 1024 to 65535."
fi
if [[ -n "$SARA_DOMAIN" && -z "$ACCESS" ]]; then ACCESS=domain; fi
if [[ -n "$SOURCE" ]]; then
  [[ -e "$SOURCE" ]] || die "--source $SOURCE doesn't exist."
  SOURCE="$(realpath "$SOURCE")"
fi

# Questions go to the terminal (/dev/tty), so `curl … | sudo bash` can still ask them.
SA_INTERACTIVE=0
if [[ $YES -eq 0 ]] && (exec </dev/tty) 2>/dev/null; then SA_INTERACTIVE=1; fi
# Nothing below reads the script's own input (with `curl | bash` that is this script).
exec </dev/null

# ---- Checks (nothing is changed before these pass) -----------------------------
# Disk, memory, port, system (and systemd), CPU, an earlier install, root and the network.
PF_HOSTS="nodejs.org registry.npmjs.org"
[[ -n "$SOURCE" ]] || PF_HOSTS="github.com $PF_HOSTS"
pf_run "$INSTANCE" "$PORT" "$PF_HOSTS" "$PREFLIGHT" || exit 1
[[ $PREFLIGHT -eq 0 ]] || exit 0
if id "$INSTANCE" >/dev/null 2>&1 && [[ "$(id -u "$INSTANCE")" -ge 1000 ]]; then
  if [[ "$INSTANCE" == sara ]]; then
    die "An ordinary account named 'sara' already exists here (uid $(id -u sara)). Sara needs that name for her own service account; rename the existing account first. Nothing was changed."
  fi
  die "An ordinary account named '$INSTANCE' already exists here (uid $(id -u "$INSTANCE")). Pick another --instance name. Nothing was changed."
fi

# Quick checks of what was asked for on the command line, before anything is downloaded.
if [[ $SA_INTERACTIVE -ne 1 && "$ACCESS" == domain ]]; then
  [[ -n "$SARA_DOMAIN" ]] || die "--access domain needs --domain <your web address>. Nothing was changed."
  if [[ -z "$(getent ahosts "$SARA_DOMAIN" 2>/dev/null || true)" ]]; then
    die "$SARA_DOMAIN doesn't point anywhere yet (no DNS record found), so no HTTPS certificate can be issued for it. At your domain provider, add an 'A' record for it with this server's public IP address, wait a few minutes, then run this again. Nothing was changed."
  fi
fi
if [[ $SA_INTERACTIVE -ne 1 && "$ACCESS" == tailscale ]]; then
  command -v tailscale >/dev/null || die "--access tailscale, but Tailscale isn't installed. Install it (https://tailscale.com/download), sign in with 'sudo tailscale up', then run this again. Nothing was changed."
  [[ "$(tailscale status --json 2>/dev/null || true)" =~ \"BackendState\":[[:space:]]*\"Running\" ]] || die "--access tailscale, but Tailscale isn't signed in. Run 'sudo tailscale up', then run this again. Nothing was changed."
fi

if [[ $SA_INTERACTIVE -eq 1 ]]; then
  log "Welcome! This installs Sara on this server. A few questions follow; just press Enter to"
  log "take the suggestion in [brackets]."
elif [[ $YES -eq 0 ]]; then
  log "No terminal to ask questions on, so the suggested answers are used (add --yes to skip this note)."
fi

ask_yn() {
  # ask_yn "Question" default(y|n): 0 = yes. Uses sa_yes once the library is loaded.
  local a shown
  if [[ $SA_INTERACTIVE -ne 1 ]]; then [[ $2 == y ]]; return; fi
  if [[ $2 == y ]]; then shown=Y/n; else shown=y/N; fi
  while :; do
    printf '%s [%s] ' "$1" "$shown" >/dev/tty
    IFS= read -r a </dev/tty || a=""
    [[ -n "$a" ]] || a=$2
    case "${a,,}" in y|yes) return 0 ;; n|no) return 1 ;; *) printf 'Please answer y or n.\n' >/dev/tty ;; esac
  done
}

# ---- 1. Basic tools (git, curl, CA certificates) ----------------------------------
PM=""
for m in apt-get dnf zypper pacman; do if command -v "$m" >/dev/null; then PM=$m; break; fi; done
pkg_install() {
  case "$PM" in
    apt-get)
      if [[ "${APT_UPDATED:-0}" == 0 ]]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null || return 1; APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null ;;
    dnf) dnf install -y -q "$@" >/dev/null ;;
    zypper) zypper --non-interactive --quiet install "$@" >/dev/null ;;
    pacman) pacman -S --needed --noconfirm "$@" >/dev/null ;;
    *) return 1 ;;
  esac
}
have_ca() {
  local f
  for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    [[ -s "$f" ]] && return 0
  done
  return 1
}
MISSING=()
command -v git >/dev/null || MISSING+=(git)
command -v curl >/dev/null || MISSING+=(curl)
have_ca || MISSING+=(ca-certificates)
if [[ ${#MISSING[@]} -gt 0 ]]; then
  [[ -n "$PM" ]] || die "Please install ${MISSING[*]} with your package manager, then run this again."
  if ! ask_yn "Sara needs ${MISSING[*]}, which this server doesn't have yet. Install them now (with $PM)?" y; then
    die "Install them yourself, then run this again: $PM install ${MISSING[*]}. Nothing was changed."
  fi
  log "Installing ${MISSING[*]}..."
  pkg_install "${MISSING[@]}" || die "Couldn't install ${MISSING[*]} with $PM. Check this server's internet connection, install them by hand, then run this again."
fi

# ---- 2. Download Sara into /opt/sara-src, and check it ------------------------------
# A copy from --source is unpacked next to the old one and swapped in only when complete.
put_in_place() {
  local new=$1
  [[ -f "$new/src/main.ts" && -f "$new/deploy/install.sh" && -f "$new/deploy/lib-access.sh" ]] || { rm -rf "$new"; die "That doesn't look like a complete copy of Sara (deploy/install.sh or deploy/lib-access.sh missing). Nothing was changed."; }
  chown -R root:root "$new"
  if [[ -e "$SRC" ]]; then
    local old
    old="$SRC.old-$(date +%Y%m%d-%H%M%S)"
    mv "$SRC" "$old"
    log "Kept the previous copy in $old"
  fi
  mv "$new" "$SRC"
}
export GIT_TERMINAL_PROMPT=0
if [[ -n "$SOURCE" ]]; then
  NEW="$SRC.new"
  rm -rf "$NEW"; mkdir -p "$NEW"
  if [[ -f "$SOURCE" ]]; then
    log "Unpacking Sara from $SOURCE..."
    tar -xf "$SOURCE" -C "$NEW" || { rm -rf "$NEW"; die "Couldn't unpack $SOURCE. Nothing was changed."; }
    # A tarball with one top folder (sara-main/…): use that folder.
    if [[ ! -f "$NEW/deploy/install.sh" ]]; then
      mapfile -t TOP < <(find "$NEW" -mindepth 1 -maxdepth 1)
      if [[ ${#TOP[@]} -eq 1 && -f "${TOP[0]}/deploy/install.sh" ]]; then
        mv "${TOP[0]}" "$NEW.inner" && rm -rf "$NEW" && mv "$NEW.inner" "$NEW"
      fi
    fi
  elif [[ -d "$SOURCE/.git" ]]; then
    log "Copying Sara from the git checkout in $SOURCE..."
    rm -rf "$NEW"
    git -c safe.directory="$SOURCE" -c safe.directory="$SOURCE/.git" clone -q --no-hardlinks "$SOURCE" "$NEW" || die "Couldn't copy $SOURCE with git. Nothing was changed."
  else
    log "Copying Sara from $SOURCE..."
    cp -a "$SOURCE/." "$NEW/"
  fi
  put_in_place "$NEW"
elif [[ -d "$SRC/.git" ]]; then
  [[ "$(stat -c %u "$SRC")" == 0 ]] || die "$SRC isn't owned by root, so it can't be used safely for updates. Fix it: sudo chown -R root:root $SRC, then run this again."
  log "Getting the latest Sara into $SRC..."
  git -C "$SRC" fetch -q --tags origin || die "Couldn't reach $(git -C "$SRC" remote get-url origin 2>/dev/null || echo the repository). Check the internet connection, then run this again."
  git -C "$SRC" checkout -q "$REF" || die "Couldn't switch $SRC to '$REF' (local changes there?)."
  if git -C "$SRC" symbolic-ref -q HEAD >/dev/null; then
    git -C "$SRC" merge -q --ff-only '@{u}' 2>/dev/null || die "$SRC has changes of its own, so it can't be updated automatically. Look at: git -C $SRC status"
  fi
elif [[ -e "$SRC" ]]; then
  die "$SRC already exists but isn't a git copy of Sara. Move it away (sudo mv $SRC $SRC.old) or use --source, then run this again."
else
  log "Downloading Sara from $REPO..."
  if ! git clone -q --branch "$REF" "$REPO" "$SRC.new"; then
    rm -rf "$SRC.new"
    die "Couldn't download Sara from $REPO. Check this server's internet connection. (If the repository isn't public yet, copy it to this server and use: --source <folder or .tar>.) Nothing was changed."
  fi
  put_in_place "$SRC.new"
fi
[[ -f "$SRC/src/main.ts" && -f "$SRC/deploy/install.sh" && -f "$SRC/deploy/lib-access.sh" ]] || die "The copy in $SRC is incomplete (deploy/install.sh missing)."
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -1)"
log "Sara ${VERSION:-?}$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null | sed 's/^/ (/;s/$/)/' || true) is ready to install."

if [[ -f "$SRC/deploy/lib-instance.sh" ]]; then
  # shellcheck source=deploy/lib-instance.sh
  . "$SRC/deploy/lib-instance.sh"
  si_set "$INSTANCE"
  if [[ "$INSTANCE" != sara ]]; then
    WHY="$(si_check_name "$INSTANCE" 2>&1)" || die "$WHY"
  fi
else
  [[ "$INSTANCE" == sara ]] || die "This copy of Sara ($SRC) is too old to install a second Sara (--instance). Update it first. Nothing was installed."
  SI_NAME=sara
fi
# shellcheck source=deploy/lib-access.sh
. "$SRC/deploy/lib-access.sh"
# Is port $1 used by another Sara here (her settings), when the library knows?
port_of_other() { declare -F si_port_assigned >/dev/null && si_port_assigned "$1"; }

# ---- 3. Questions ----------------------------------------------------------------
CUR_PORT="$(sa_env_get SARA_PORT)"
SARA_RUNNING=0
systemctl is-active --quiet "$INSTANCE" 2>/dev/null && SARA_RUNNING=1
# The suggested port: the one she has, else 7860 for the default Sara, else the next free one.
DEF_PORT="${CUR_PORT:-}"
if [[ -z "$DEF_PORT" ]]; then
  if [[ "$INSTANCE" == sara ]]; then DEF_PORT=7860; else DEF_PORT="$(si_pick_port)" || die "No free port from 7860 up."; fi
fi

# (a) How will you reach her?
if sa_ts_running; then DEF_ACCESS=tailscale; else DEF_ACCESS=local; fi
if [[ -f "$ENV_FILE" ]] && grep -q '^SARA_ACCESS=' "$ENV_FILE"; then DEF_ACCESS="$(sa_env_get SARA_ACCESS)"; fi
while :; do
  if [[ -z "$ACCESS" ]]; then
    if [[ $SA_INTERACTIVE -eq 1 ]]; then
      sa_say ""
      sa_say "How will you reach her?"
      sa_say "  1) Tailscale: private to your own devices, works from your phone anywhere, HTTPS done for you$(sa_ts_installed || echo ' (install Tailscale first)')"
      sa_say "  2) Just this computer (from another computer: through an SSH tunnel)"
      sa_say "  3) My own web address, with HTTPS set up for you"
      sa_say "  4) My home network (plain HTTP: only on a network you trust)"
      case "$DEF_ACCESS" in tailscale) d=1 ;; domain) d=3 ;; lan) d=4 ;; *) d=2 ;; esac
      sa_ask a "Choose 1-4" "$d"
      case "$a" in 1|tailscale) ACCESS=tailscale ;; 2|local) ACCESS=local ;; 3|domain) ACCESS=domain ;; 4|lan) ACCESS=lan ;; *) sa_say "Please type 1, 2, 3 or 4."; continue ;; esac
    else
      ACCESS="$DEF_ACCESS"
    fi
  fi
  if sa_check "$ACCESS" "${PORT:-$DEF_PORT}"; then break; fi
  [[ $SA_INTERACTIVE -eq 1 ]] || die "Can't set up '$ACCESS' (see above). Nothing was installed or changed: run this again once that's fixed, or choose another way (--access local)."
  sa_say "Let's pick another way (you can change it later with: sudo $CMD access)."
  ACCESS="" SARA_DOMAIN="" SARA_EMAIL="" DEF_ACCESS=local
done

# (b) Safer shell for her coding tools.
HAVE_BWRAP=0; command -v bwrap >/dev/null && HAVE_BWRAP=1
if [[ $HAVE_BWRAP -eq 1 ]]; then
  SANDBOX=y
elif [[ -z "$SANDBOX" ]]; then
  if sa_yes "Safer shell for her coding tools (installs bubblewrap, recommended)?" y; then SANDBOX=y; else SANDBOX=n; fi
fi

# (c) Voice on this server.
# Local voice lives in /opt/sara-voice and is shared by every Sara here; install-voice.sh
# --instance points this instance at it (and only downloads what is missing).
if [[ "$(uname -m)" != x86_64 ]]; then
  [[ "$VOICE" == y ]] && warn "Local voice is x86_64 only for now; skipping it (cloud voices work in Settings → Voice)."
  VOICE=n
elif [[ -z "$VOICE" ]]; then
  if [[ -x /opt/sara-voice/voice.json || -f /opt/sara-voice/voice.json ]]; then
    VOICE=n
  elif sa_yes "Voice on this server, so speech never leaves it (downloads about 650 MB)?" n; then VOICE=y; else VOICE=n; fi
fi

# (d) Port.
while :; do
  if [[ -z "$PORT" ]]; then sa_ask PORT "Port on this machine" "$DEF_PORT"; fi
  if ! sa_valid_port "$PORT"; then
    warn "The port must be a number from 1024 to 65535."
  elif sa_port_busy "$PORT" && ! [[ $SARA_RUNNING -eq 1 && "$PORT" == "$DEF_PORT" ]]; then
    warn "Something else is already using port $PORT."
  elif [[ "$PORT" != "${CUR_PORT:-}" ]] && port_of_other "$PORT"; then
    warn "Port $PORT belongs to another Sara on this server."
  else
    break
  fi
  [[ $SA_INTERACTIVE -eq 1 ]] || die "Pick another port with --port N. Nothing was installed or changed."
  PORT=""
done

# ---- 4. Summary --------------------------------------------------------------------
PKGS=()
[[ "$SANDBOX" == y && $HAVE_BWRAP -eq 0 ]] && PKGS+=(bubblewrap)
[[ "$VOICE" == y ]] && ! command -v bzip2 >/dev/null && PKGS+=(bzip2)
sa_say ""
log "About to install Sara ${VERSION:-}$([[ "$INSTANCE" == sara ]] || echo " as '$INSTANCE'") with:"
log "  Reach her:      $(sa_mode_label "$ACCESS")$([[ $ACCESS == domain ]] && echo " at https://$SARA_DOMAIN")$([[ $ACCESS == tailscale ]] && echo " at $(sa_ts_url "$(sa_ts_https_port "$PORT")")")"
log "  Safer shell:    $([[ $SANDBOX == y ]] && echo yes || echo no)"
log "  Local voice:    $([[ $VOICE == y ]] && echo 'yes (about 650 MB)' || echo no)"
log "  Port:           $PORT"
log "  Files:          program in /opt/$INSTANCE, your data in /var/lib/$INSTANCE, settings in /etc/$INSTANCE"
[[ "$INSTANCE" == sara ]] || log "  Admin command:  sudo $CMD (service $INSTANCE.service)"
[[ ${#PKGS[@]} -gt 0 || "${SA_NEED_CADDY:-0}" == 1 ]] && log "  Also installs:  ${PKGS[*]}$([[ "${SA_NEED_CADDY:-0}" == 1 ]] && echo ' caddy') (from $PM)"
if [[ $SA_INTERACTIVE -eq 1 ]] && ! sa_yes "Go ahead?" y; then
  die "Stopped. Nothing was installed (the downloaded copy stays in $SRC; run this again any time)."
fi

# ---- 5. Install -----------------------------------------------------------------------
if [[ ${#PKGS[@]} -gt 0 ]]; then
  log "Installing ${PKGS[*]}..."
  if ! pkg_install "${PKGS[@]}"; then
    warn "Couldn't install ${PKGS[*]}; going on without. Later: $(sa_pkg_hint "${PKGS[@]}")"
    [[ " ${PKGS[*]} " == *" bzip2 "* ]] && VOICE=n
  fi
fi
# Ubuntu 23.10+ only lets programs with an AppArmor profile use the sandboxing feature bubblewrap
# needs. A profile for bubblewrap alone (not the system-wide switch) fixes that.
if [[ "$SANDBOX" == y ]] && command -v bwrap >/dev/null && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == 1 ]] \
   && command -v apparmor_parser >/dev/null && [[ ! -f /etc/apparmor.d/bwrap ]]; then
  BWRAP_PATH="$(command -v bwrap)"
  cat > /etc/apparmor.d/bwrap <<EOF
abi <abi/4.0>,
include <tunables/global>
profile bwrap ${BWRAP_PATH} flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  if apparmor_parser -r /etc/apparmor.d/bwrap 2>/dev/null; then
    log "Allowed bubblewrap its sandbox under Ubuntu's AppArmor rules (/etc/apparmor.d/bwrap)."
  else
    warn "Couldn't load /etc/apparmor.d/bwrap now; it takes effect after a reboot."
  fi
fi
sa_prepare "$ACCESS"

log "Installing Sara (about a minute)..."
INSTANCE_ENV=()
[[ "$INSTANCE" == sara ]] || INSTANCE_ENV=(SARA_INSTANCE="$INSTANCE")
env ${INSTANCE_ENV[@]+"${INSTANCE_ENV[@]}"} SARA_PREFLIGHT_DONE=1 SARA_ACCESS="$ACCESS" SARA_ACCESS_CHECKED=1 SARA_PORT="$PORT" SARA_DOMAIN="$SARA_DOMAIN" SARA_EMAIL="$SARA_EMAIL" \
  bash "$SRC/deploy/install.sh" || die "The install didn't finish (see above). Fix that and run this again; your data, if any, is untouched."

if [[ "$VOICE" == y ]]; then
  log "Installing local voice (about 650 MB; this takes a while)..."
  bash "$SRC/deploy/install-voice.sh" --instance "$INSTANCE" || warn "Local voice didn't install (see above). Sara works without it; try again later: sudo $SRC/deploy/install-voice.sh --instance $INSTANCE"
fi
log "All done. Sign in with the owner token above, then the setup guide takes you through the rest."
}

main "$@"
