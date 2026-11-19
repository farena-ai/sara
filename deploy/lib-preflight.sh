# shellcheck shell=bash
# W2.1: the install preflight for Linux (one-command install, install.sh, Raspberry Pi, Proxmox LXC).
# Checks disk, memory, port, OS version, CPU, an existing install, permissions and the network
# before anything is changed; each problem is a fix-it card with the exact next step. The same
# checks and limits are in src/preflight.ts (Docker, a plain `node src/main.ts`) and the Windows
# Setup (desktop/windows/installer/sara.iss); test/w2-install.test.ts keeps the limits equal.
#
# deploy/get-sara.sh is downloaded alone, so it carries a copy of everything below "# ---- body"
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
