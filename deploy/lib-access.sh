# shellcheck shell=bash
# How Sara is reached: shared by deploy/get-sara.sh, deploy/install.sh and `sara access`.
# Sourced, never run. Defines functions only (plus a few defaults); it changes nothing by itself.
#
# Modes (written to /etc/sara/sara.env as SARA_ACCESS, with SARA_PUBLIC_URL):
#   local      just this computer (127.0.0.1; from elsewhere through an SSH tunnel)
#   tailscale  private HTTPS address on your tailnet (`tailscale serve` proxies to 127.0.0.1)
#   domain     your own web address; Caddy gets the certificate and proxies to 127.0.0.1
#   lan        your home network, plain HTTP on this machine's network address
#
# Callers set SA_INTERACTIVE=1 when a person can answer questions on /dev/tty.

# Several Saras on one server (deploy/lib-instance.sh): SI_NAME is this instance ("sara" by
# default). Each one gets her own settings file, her own Caddy block (# BEGIN <name>), her own
# Tailscale HTTPS port (443 for the default, another port for the others: one machine has one
# Tailscale name) and her own proxy secret; nothing here touches another instance's.
: "${SI_NAME:=sara}"
: "${ENV_FILE:=/etc/$SI_NAME/$SI_NAME.env}"
: "${SA_INTERACTIVE:=0}"
SA_CMD="$SI_NAME"
SA_CADDYFILE="${SARA_CADDYFILE:-/etc/caddy/Caddyfile}"
# Security review (L7): Caddy adds this per-install secret header; Sara trusts X-Forwarded-For
# only on requests that carry it (any local program can connect to 127.0.0.1 and send its own).
# Kept in her data folder, which sandboxed commands can't read.
SA_DATA_DIR="${SARA_DATA_DIR:-/var/lib/$SI_NAME}"
SA_PROXY_SECRET_FILE="$SA_DATA_DIR/proxy-secret"
SA_MODES="local tailscale domain lan"

if ! declare -F log >/dev/null; then log() { printf '\033[1;35m[sara]\033[0m %s\n' "$*"; }; fi
if ! declare -F warn >/dev/null; then warn() { printf '\033[1;33m[sara]\033[0m %s\n' "$*" >&2; }; fi
if ! declare -F die >/dev/null; then die() { printf '\033[1;31m[sara]\033[0m %s\n' "$*" >&2; exit 1; }; fi

# ---- Questions -------------------------------------------------------------
# Every question shows its default in [brackets]; Enter accepts it. Answers come from /dev/tty, so
# `curl … | sudo bash` still works. Without a person (SA_INTERACTIVE=0) the default is taken.
sa_say() { if [[ $SA_INTERACTIVE == 1 ]]; then printf '%s\n' "$*" >/dev/tty; else printf '%s\n' "$*"; fi; }
# sa_ask VAR "Question" default
sa_ask() {
  local __var=$1 __q=$2 __def=${3-} __ans=""
  if [[ $SA_INTERACTIVE == 1 ]]; then
    printf '%s [%s] ' "$__q" "$__def" >/dev/tty
    IFS= read -r __ans </dev/tty || __ans=""
    __ans="${__ans#"${__ans%%[![:space:]]*}"}"
    __ans="${__ans%"${__ans##*[![:space:]]}"}"
  fi
  [[ -n $__ans ]] || __ans=$__def
  printf -v "$__var" '%s' "$__ans"
}
# sa_yes "Question" y|n   (exit status 0 = yes)
sa_yes() {
  local a shown
  if [[ $2 == y ]]; then shown=Y/n; else shown=y/N; fi
  while :; do
    sa_ask a "$1" "$shown"
    [[ $a == "$shown" ]] && a=$2
    case "${a,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) sa_say "Please answer y or n." ;;
    esac
  done
}

# ---- sara.env --------------------------------------------------------------
sa_env_get() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
# Values written here are checked first (addresses, numbers, mode words), so they never hold '#'.
sa_env_set() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s#^$1=.*#$1=$2#" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}

# ---- System helpers ----------------------------------------------------------
sa_pkg_mgr() {
  local m
  for m in apt-get dnf zypper pacman; do
    if command -v "$m" >/dev/null; then echo "$m"; return 0; fi
  done
  return 1
}
SA_APT_UPDATED=0
# Install packages with the distribution's own package manager (quietly, never asking).
sa_pkg_install() {
  local m
  m="$(sa_pkg_mgr)" || return 1
  case "$m" in
    apt-get)
      if [[ $SA_APT_UPDATED == 0 ]]; then DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null >/dev/null || return 1; SA_APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" </dev/null >/dev/null ;;
    dnf) dnf install -y -q "$@" </dev/null >/dev/null ;;
    zypper) zypper --non-interactive --quiet install "$@" </dev/null >/dev/null ;;
    pacman) pacman -S --needed --noconfirm "$@" </dev/null >/dev/null ;;
  esac
}
sa_pkg_hint() {
  case "$(sa_pkg_mgr 2>/dev/null || true)" in
    apt-get) echo "sudo apt install $*" ;;
    dnf) echo "sudo dnf install $*" ;;
    zypper) echo "sudo zypper install $*" ;;
    pacman) echo "sudo pacman -S $*" ;;
    *) echo "install these packages: $*" ;;
  esac
}

# Is something listening on TCP port $1 (IPv4 or IPv6)?
sa_port_busy() {
  local hex
  hex="$(printf '%04X' "$1")"
  local f files=()
  # (only files that exist: awk fails on a missing one, e.g. tcp6 with IPv6 off)
  for f in /proc/net/tcp /proc/net/tcp6; do [[ -r $f ]] && files+=("$f"); done
  [[ ${#files[@]} -gt 0 ]] || return 1
  awk -v p=":$hex" '$4 == "0A" && toupper(substr($2, length($2) - 4)) == p { found = 1 } END { exit !found }' "${files[@]}" 2>/dev/null
}
sa_valid_port() { [[ $1 =~ ^[0-9]+$ ]] && (( 10#$1 >= 1024 && 10#$1 <= 65535 )); }

# This machine's own addresses (one per line).
sa_local_ips() {
  {
    hostname -I 2>/dev/null | tr ' ' '\n'
    ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1
    awk '/32 host LOCAL/ { print p } { p = $2 }' /proc/net/fib_trie 2>/dev/null
  } | sed '/^$/d' | sort -u
}
# The address other devices on the home network use for this machine (the one with the default
# route), or nothing.
sa_lan_ip() {
  local ip=""
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1 || true)"
  [[ -n $ip ]] || ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | head -1 || true)"
  [[ -n $ip ]] || ip="$(sa_local_ips | grep -E '^[0-9]+(\.[0-9]+){3}$' | grep -v '^127\.' | head -1 || true)"
  printf '%s' "$ip"
}

# ---- Tailscale ---------------------------------------------------------------
sa_ts_json() { tailscale status --json 2>/dev/null || true; }
sa_ts_installed() { command -v tailscale >/dev/null; }
sa_ts_running() {
  sa_ts_installed || return 1
  local j
  j="$(sa_ts_json)"
  [[ $j =~ \"BackendState\":[[:space:]]*\"Running\" ]]
}
# MagicDNS name of this machine (Self.DNSName without the trailing dot).
sa_ts_dnsname() {
  sa_ts_json | awk '/"Self":[[:space:]]*\{/ { s = 1 } s && /"DNSName"/ { sub(/.*"DNSName":[[:space:]]*"/, ""); sub(/".*/, ""); sub(/\.$/, ""); print; exit }'
}
# HTTPS certificates are on for the tailnet when CertDomains lists at least one name.
sa_ts_certs_on() {
  local j
  j="$(sa_ts_json | tr -d '\n')"
  [[ $j =~ \"CertDomains\":[[:space:]]*\[[[:space:]]*\" ]]
}
# Tailscale 1.52+ uses `tailscale serve --bg --https=443 <target>`; older versions used
# `tailscale serve https:443 / <target>`.
sa_ts_new_cli() {
  local h
  h="$(tailscale serve --help 2>&1 || true)"
  [[ $h == *--bg* ]]
}
# This instance's HTTPS port on the machine's Tailscale name: SARA_TS_HTTPS_PORT when set, else
# 443 for the default instance and 8443 + (her port - 7860) for any other (ports are unique, so
# these are too).
sa_ts_https_port() {
  local p port=${1:-}
  p="$(sa_env_get SARA_TS_HTTPS_PORT)"
  if [[ $p =~ ^[0-9]+$ ]]; then echo "$p"; return; fi
  if [[ $SI_NAME == sara ]]; then echo 443; return; fi
  [[ $port =~ ^[0-9]+$ ]] || port="$(sa_env_get SARA_PORT)"
  [[ $port =~ ^[0-9]+$ ]] || port=7860
  if (( port >= 7860 && port < 8860 )); then echo $((8443 + port - 7860)); else echo $((port + 1000)); fi
}
sa_ts_url() {
  local hp=$1
  if [[ $hp == 443 ]]; then echo "https://$(sa_ts_dnsname)"; else echo "https://$(sa_ts_dnsname):$hp"; fi
}
sa_ts_serve_on() {
  local target="http://127.0.0.1:$1" hp=${2:-443} out
  if sa_ts_new_cli; then
    out="$(timeout 90 tailscale serve --bg --https="$hp" "$target" </dev/null 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
  else
    out="$(timeout 90 tailscale serve "https:$hp" / "$target" </dev/null 2>&1)" || { printf '%s\n' "$out" >&2; return 1; }
  fi
}
sa_ts_serve_off() {
  local hp
  sa_ts_installed || return 0
  hp="$(sa_ts_https_port)"
  if sa_ts_new_cli; then
    timeout 60 tailscale serve --https="$hp" off </dev/null >/dev/null 2>&1 || true
  else
    timeout 60 tailscale serve "https:$hp" / off </dev/null >/dev/null 2>&1 || true
  fi
}
sa_ts_explain_certs() {
  sa_say ""
  sa_say "  Your Tailscale network hasn't turned on HTTPS certificates yet. It's one switch:"
  sa_say "    1. Open https://login.tailscale.com/admin/dns (sign in with your Tailscale account)."
  sa_say "    2. Make sure MagicDNS is on, then press 'Enable HTTPS' under HTTPS Certificates."
  sa_say ""
}

# ---- Caddy (own web address) -------------------------------------------------
SA_CADDY_BEGIN="# BEGIN $SI_NAME (managed by \"$SA_CMD access\"; this block is replaced when it changes)"
SA_CADDY_END="# END $SI_NAME"
sa_valid_domain() { [[ ${#1} -le 253 && $1 =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9]$ ]]; }
sa_valid_email() { [[ -z $1 || $1 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
sa_resolve() { getent ahosts "$1" 2>/dev/null | awk '{print $1}' | sort -u || true; }
# 0: points at this machine. 1: doesn't resolve at all. 2: resolves, but somewhere else.
SA_DNS_IPS=""
sa_dns_check() {
  local ips mine ip
  ips="$(sa_resolve "$1")"
  SA_DNS_IPS="$(echo "$ips" | tr '\n' ' ' | sed 's/ *$//')"
  [[ -n $ips ]] || return 1
  mine="$(sa_local_ips)"
  for ip in $ips; do
    if grep -qxF "$ip" <<<"$mine"; then return 0; fi
  done
  return 2
}
sa_caddy_remove_block() {
  [[ -f $SA_CADDYFILE ]] || return 0
  # Not `sed -i` (GNU and BSD/macOS disagree on its argument); writing in place keeps the file's
  # owner and mode. The trailing "." keeps the file's final newlines through $(…).
  local out
  out="$(sed "/^# BEGIN $SI_NAME /,/^# END $SI_NAME\$/d" "$SA_CADDYFILE" && echo .)" || return 1
  printf '%s' "${out%.}" > "$SA_CADDYFILE"
}
# Is the Caddyfile just the placeholder page the distribution ships (":80 { root … file_server }")?
sa_caddy_is_stock() {
  [[ -f $SA_CADDYFILE ]] || return 0
  local body
  body="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' "$SA_CADDYFILE" | tr -d '\n')"
  [[ -z $body || $body == ':80{root*/usr/share/caddyfile_server}' ]]
}
# The proxy secret (made once; 64 hex characters), printed for the Caddyfile.
sa_proxy_secret() {
  local secret=""
  [[ -f $SA_PROXY_SECRET_FILE && ! -L $SA_PROXY_SECRET_FILE ]] && secret="$(tr -dc '0-9a-f' < "$SA_PROXY_SECRET_FILE" | head -c 64)"
  if [[ ${#secret} -ne 64 ]]; then
    secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -dc '0-9a-f')"
    mkdir -p "$SA_DATA_DIR"
    rm -f "$SA_PROXY_SECRET_FILE"
    ( umask 077; printf '%s\n' "$secret" > "$SA_PROXY_SECRET_FILE" )
    if id "$SI_NAME" >/dev/null 2>&1; then chown "$SI_NAME:$SI_NAME" "$SA_PROXY_SECRET_FILE"; fi
    chmod 600 "$SA_PROXY_SECRET_FILE"
  fi
  printf '%s' "$secret"
}
sa_caddy_add() {
  local domain=$1 email=$2 port=$3 backup err secret
  secret="$(sa_proxy_secret)"
  mkdir -p "$(dirname "$SA_CADDYFILE")"
  backup="$SA_CADDYFILE.before-$SI_NAME"
  [[ -f $SA_CADDYFILE ]] && cp -p "$SA_CADDYFILE" "$backup"
  if sa_caddy_is_stock; then
    # Replace the placeholder page (kept in $backup): its catch-all :80 site would also stop the
    # automatic http:// → https:// redirect for her address.
    : > "$SA_CADDYFILE"
  else
    sa_caddy_remove_block
    if grep -qE "(^|[[:space:],])(https?://)?${domain//./\\.}(:[0-9]+)?([[:space:],{]|$)" "$SA_CADDYFILE"; then
      [[ -f $backup ]] && cp -p "$backup" "$SA_CADDYFILE"
      die "Your Caddyfile ($SA_CADDYFILE) already has a site for $domain. Remove it (or point it at 127.0.0.1:$port yourself), then try again. Nothing was changed."
    fi
  fi
  {
    echo "$SA_CADDY_BEGIN"
    echo "$domain {"
    [[ -n $email ]] && echo "    tls $email"
    echo "    reverse_proxy 127.0.0.1:$port {"
    echo "        # live replies arrive as they're written; live voice (WebSocket) passes through"
    echo "        flush_interval -1"
    echo "        # tells Sara this request really came through Caddy (keep this file private)"
    echo "        header_up X-Sara-Proxy $secret"
    echo "    }"
    echo "}"
    echo "$SA_CADDY_END"
  } >> "$SA_CADDYFILE"
  err="$(caddy validate --config "$SA_CADDYFILE" --adapter caddyfile 2>&1)" || {
    if [[ -f $backup ]]; then cp -p "$backup" "$SA_CADDYFILE"; else sa_caddy_remove_block; fi
    printf '%s\n' "$err" | tail -5 >&2
    die "Caddy didn't accept the new settings, so they were taken back out. Nothing else was changed."
  }
  # The Caddyfile now holds the proxy secret: readable by root and Caddy only.
  if getent group caddy >/dev/null 2>&1; then chgrp caddy "$SA_CADDYFILE" && chmod 640 "$SA_CADDYFILE"; fi
  systemctl enable caddy >/dev/null 2>&1 || true
  systemctl reload-or-restart caddy || die "Caddy didn't start. Check: journalctl -u caddy -n 30"
}
sa_caddy_remove() {
  [[ -f $SA_CADDYFILE ]] && grep -q "^# BEGIN $SI_NAME " "$SA_CADDYFILE" || return 0
  sa_caddy_remove_block
  if command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
    systemctl reload caddy >/dev/null 2>&1 || warn "Caddy didn't reload; check: journalctl -u caddy -n 30"
  fi
  rm -f "$SA_PROXY_SECRET_FILE"
  log "Removed Sara's site from $SA_CADDYFILE (Caddy itself stays installed)."
}

# ---- Modes -------------------------------------------------------------------
sa_valid_mode() { [[ " $SA_MODES " == *" $1 "* ]]; }
sa_mode_label() {
  case "$1" in
    tailscale) echo "Tailscale (private to your own devices, HTTPS)" ;;
    local) echo "Just this computer" ;;
    domain) echo "Your own web address (HTTPS through Caddy)" ;;
    lan) echo "Your home network (plain HTTP)" ;;
    proxy) echo "Your own HTTPS reverse proxy (set up by hand)" ;;
    *) echo "$1" ;;
  esac
}
# Current mode: SARA_ACCESS, or worked out from older settings that don't have it.
sa_current_mode() {
  local m host
  m="$(sa_env_get SARA_ACCESS)"
  if [[ -n $m ]]; then echo "$m"; return; fi
  host="$(sa_env_get SARA_HOST)"
  if [[ "$(sa_env_get SARA_TRUST_PROXY)" == 1 ]]; then echo proxy
  elif [[ -n $host && ! $host =~ ^(127\.|::1$|localhost$) ]]; then echo lan
  else echo local; fi
}

# sa_check MODE: can MODE work here? Changes nothing (except, when a person agrees, running
# `tailscale up`). Asks for what's missing when interactive. Sets SARA_DOMAIN / SARA_EMAIL.
# Returns 1 with the reason already printed.
sa_check() {
  local mode=$1 port=${2:-7860} ans rc
  case "$mode" in
    local) return 0 ;;
    lan)
      SA_LAN_IP="$(sa_lan_ip)"
      [[ -n $SA_LAN_IP ]] || { warn "Couldn't find this machine's home-network address."; return 1; }
      return 0 ;;
    tailscale)
      if ! sa_ts_installed; then
        warn "Tailscale isn't installed on this machine. Install it from https://tailscale.com/download (one command), sign in with 'sudo tailscale up', then choose Tailscale again."
        return 1
      fi
      if ! sa_ts_running; then
        if [[ $SA_INTERACTIVE == 1 ]] && sa_yes "Tailscale is installed but not signed in. Sign in now? (it shows a link to open)" y; then
          tailscale up </dev/tty >/dev/tty 2>&1 || true
        fi
        sa_ts_running || { warn "Tailscale isn't signed in. Run 'sudo tailscale up', sign in, then try again."; return 1; }
      fi
      while ! sa_ts_certs_on; do
        sa_ts_explain_certs
        if [[ $SA_INTERACTIVE != 1 ]]; then
          warn "Tailscale HTTPS certificates are off for your tailnet (see the steps above), so Tailscale can't give Sara an https:// address yet."
          return 1
        fi
        sa_ask ans "Press Enter once it's on (or type 'skip' to choose something else)" ""
        [[ ${ans,,} == skip ]] && return 1
      done
      [[ -n "$(sa_ts_dnsname)" ]] || { warn "Couldn't read this machine's Tailscale name (tailscale status --json)."; return 1; }
      return 0 ;;
    domain)
      while :; do
        if [[ -z ${SARA_DOMAIN:-} && $SA_INTERACTIVE == 1 ]]; then
          sa_ask SARA_DOMAIN "Your web address for Sara (for example sara.example.com)" ""
        fi
        [[ -n ${SARA_DOMAIN:-} ]] || { warn "A web address is needed (--domain sara.example.com)."; return 1; }
        SARA_DOMAIN="${SARA_DOMAIN,,}"; SARA_DOMAIN="${SARA_DOMAIN#https://}"; SARA_DOMAIN="${SARA_DOMAIN#http://}"; SARA_DOMAIN="${SARA_DOMAIN%/}"
        if sa_valid_domain "$SARA_DOMAIN"; then break; fi
        warn "'$SARA_DOMAIN' doesn't look like a web address (like sara.example.com)."
        [[ $SA_INTERACTIVE == 1 ]] || return 1
        SARA_DOMAIN=""
      done
      if [[ -z ${SARA_EMAIL:-} && $SA_INTERACTIVE == 1 ]]; then
        sa_ask SARA_EMAIL "Your email, for certificate notices from Let's Encrypt (Enter to skip)" ""
      fi
      while ! sa_valid_email "${SARA_EMAIL:-}"; do
        warn "'$SARA_EMAIL' doesn't look like an email address."
        [[ $SA_INTERACTIVE == 1 ]] || return 1
        sa_ask SARA_EMAIL "Your email (Enter to skip)" ""
      done
      rc=0; sa_dns_check "$SARA_DOMAIN" || rc=$?
      if [[ $rc == 1 ]]; then
        warn "$SARA_DOMAIN doesn't point anywhere yet (no DNS record found), so no certificate can be issued for it."
        warn "At your domain provider, add an 'A' record for $SARA_DOMAIN with this server's public IP address, wait a few minutes, then try again."
        return 1
      elif [[ $rc == 2 ]]; then
        warn "$SARA_DOMAIN points at $SA_DNS_IPS, which isn't an address of this machine."
        warn "That's fine if your router forwards ports 80 and 443 to this machine; otherwise fix the DNS record first, or the certificate can't be issued."
        if [[ $SA_INTERACTIVE == 1 ]] && ! sa_yes "Use $SARA_DOMAIN anyway?" n; then return 1; fi
      fi
      if ! command -v caddy >/dev/null || ! systemctl is-active --quiet caddy; then
        for p in 80 443; do
          if sa_port_busy "$p"; then
            warn "Another web server is already using port $p here, so Caddy can't. Add Sara to that one instead (docs/INSTALL.md, section 2) and choose 'just this computer' here."
            return 1
          fi
        done
      fi
      if ! command -v caddy >/dev/null; then
        sa_pkg_mgr >/dev/null || { warn "Caddy isn't installed and there's no package manager I know here. Install it (https://caddyserver.com/docs/install), then try again."; return 1; }
        if [[ $SA_INTERACTIVE == 1 ]] && ! sa_yes "Install Caddy (it gets and renews the HTTPS certificate) from your distribution's packages?" y; then
          return 1
        fi
        SA_NEED_CADDY=1
      fi
      return 0 ;;
    *) warn "Unknown way to reach her: '$mode' (choose: $SA_MODES)."; return 1 ;;
  esac
}

# Install what sa_check found missing (Caddy). Run after the person confirmed.
sa_prepare() {
  if [[ $1 == domain && ${SA_NEED_CADDY:-0} == 1 ]]; then
    log "Installing Caddy from your distribution's packages..."
    sa_pkg_install caddy || die "Couldn't install Caddy with $(sa_pkg_mgr). Install it from the official instructions (https://caddyserver.com/docs/install), then run: sudo $SA_CMD access domain. Nothing else was changed."
    SA_NEED_CADDY=0
  fi
}

# Undo what MODE set up outside sara.env.
sa_unconfigure() {
  case "$1" in
    tailscale) sa_ts_serve_off; log "Stopped serving Sara through Tailscale." ;;
    domain) sa_caddy_remove ;;
  esac
}

# sa_apply MODE PORT: set up MODE (Tailscale serve / Caddy site) and write sara.env. Does not
# restart Sara. Run sa_check (and sa_prepare) first.
sa_apply() {
  local mode=$1 port=$2 old host secure url name tshp=""
  old="$(sa_current_mode)"
  case "$mode" in
    local) host=127.0.0.1; secure=0; url="http://127.0.0.1:$port" ;;
    lan)
      host="${SA_LAN_IP:-$(sa_lan_ip)}"
      [[ -n $host ]] || die "Couldn't find this machine's home-network address."
      secure=0; url="http://$host:$port" ;;
    tailscale)
      name="$(sa_ts_dnsname)"
      [[ -n $name ]] || die "Couldn't read this machine's Tailscale name."
      tshp="$(sa_ts_https_port "$port")"
      # Another instance whose HTTPS port moves (her port changed): take the old one down first.
      if [[ $old == tailscale && "$(sa_ts_https_port)" != "$tshp" ]]; then sa_ts_serve_off; fi
      sa_ts_serve_on "$port" "$tshp" || die "'tailscale serve' didn't work (see above). Nothing else was changed."
      host=127.0.0.1; secure=1; url="$(sa_ts_url "$tshp")" ;;
    domain)
      [[ -n ${SARA_DOMAIN:-} ]] || die "No web address given."
      sa_caddy_add "$SARA_DOMAIN" "${SARA_EMAIL:-}" "$port"
      host=127.0.0.1; secure=1; url="https://$SARA_DOMAIN" ;;
    *) die "Unknown way to reach her: '$mode'." ;;
  esac
  sa_env_set SARA_HOST "$host"
  sa_env_set SARA_PORT "$port"
  # Both proxies (tailscale serve, Caddy) run on this machine and set X-Forwarded-For to the real
  # client and X-Forwarded-Proto to https; Sara trusts them only when they're on.
  sa_env_set SARA_SECURE_COOKIES "$secure"
  sa_env_set SARA_TRUST_PROXY "$secure"
  sa_env_set SARA_ACCESS "$mode"
  sa_env_set SARA_PUBLIC_URL "$url"
  if [[ $old != "$mode" ]]; then sa_unconfigure "$old"; fi
  # Other instances remember their Tailscale port (so it's the same one to take down later).
  if [[ -n $tshp && $SI_NAME != sara ]]; then sa_env_set SARA_TS_HTTPS_PORT "$tshp"; fi
  if [[ $old == proxy && $mode != proxy ]]; then
    warn "Sara no longer trusts a hand-made reverse proxy. If you still use one, take its site out (or run: sudo SARA_BEHIND_PROXY=1 /opt/sara-src/deploy/install.sh$([[ $SI_NAME == sara ]] || echo " --instance $SI_NAME") to go back)."
  fi
}

# What to open, in plain words.
sa_print_next() {
  local mode url port
  mode="$(sa_current_mode)"; url="$(sa_env_get SARA_PUBLIC_URL)"; port="$(sa_env_get SARA_PORT)"; port="${port:-7860}"
  case "$mode" in
    local)
      log "Reach her:"
      log "  On this machine:     open http://127.0.0.1:${port}"
      log "  From your computer:  ssh -L ${port}:127.0.0.1:${port} ${SUDO_USER:-you}@<this-server's-address>"
      log "                       then open http://localhost:${port}"
      ;;
    tailscale)
      log "Reach her at:  $url"
      log "  from any device signed in to your Tailscale (on your phone: install the Tailscale app and"
      log "  sign in with the same account). The first visit can take a few seconds while the"
      log "  certificate is made."
      ;;
    domain)
      log "Reach her at:  $url"
      log "  The certificate arrives within a minute or two, once $(sa_env_get SARA_PUBLIC_URL | sed 's#https://##') points at this"
      log "  server and ports 80 and 443 are open (with ufw: sudo ufw allow 80,443/tcp)."
      ;;
    lan)
      log "Reach her at:  $url  (from devices on your home network)"
      warn "This is plain HTTP: anyone on that network can see your sign-in. Use it only on a network you trust."
      log "  If this machine has a firewall, let port ${port} in from your home network (ufw: sudo ufw allow ${port}/tcp)."
      ;;
    proxy)
      log "Reach her through the HTTPS reverse proxy you set up (docs/INSTALL.md, section 2)."
      ;;
  esac
  log "Change how you reach her any time: sudo $SA_CMD access"
}

sa_show() {
  local mode url
  mode="$(sa_current_mode)"; url="$(sa_env_get SARA_PUBLIC_URL)"
  log "How you reach her: $(sa_mode_label "$mode")"
  [[ -n $url ]] && log "Address: $url"
  log "Listening on: $(sa_env_get SARA_HOST):$(sa_env_get SARA_PORT)"
  log "Change it: sudo $SA_CMD access tailscale | local | domain --domain <name> [--email <you@…>] | lan"
}
