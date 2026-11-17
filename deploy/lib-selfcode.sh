# shellcheck shell=bash
# rootapply (docs/SELF_CODE.md "On a Linux server"): the root helper that applies the owner's approved
# code changes to this instance's read-only copy (/opt/<name>). Sourced by /usr/local/bin/<name>
# (deploy/sara), never run by itself. Started only by <name>-updater.service (the request word
# "selfcode" in <data>/update-request) or by the admin (sudo <name> selfcode ...).
#
# It trusts nothing the service user wrote: the request and the patch are read AS that user (no
# symlink can make root read another file), then src/self-code-root.ts from the root-owned source
# checkout checks every rule again (this instance only, an owner approval id, the approved patch's
# hash, protected paths, test weakening, no path outside the folders the installer copies). It never
# runs anything from the request. A snapshot of the changed files is kept; when she doesn't come back
# healthy the old files go back and she restarts. `sudo <name> selfcode off` turns all of it off.
#
# Needs from the caller: NAME SVC APP_DIR DATA_DIR STATUS_DIR NODE_BIN SRC_FILE, log/warn/die,
# healthy and app_version. Tests replace sc_read_user, sc_user_rm, sc_restart, sc_root_owned, sc_mkdir
# and sc_p.

SC_DIR="$STATUS_DIR/selfcode"
SC_MARK="$STATUS_DIR/selfcode.json"
SC_OFF="${SC_OFF:-/etc/$NAME/selfcode-off}"

sc_p() { printf '%s' "$1"; }
sc_read_user() { runuser -u "$NAME" -- head -c "$2" -- "$1"; }
sc_user_rm() { runuser -u "$NAME" -- rm -f -- "$1" 2>/dev/null || true; }
sc_restart() { systemctl restart "$SVC"; }
sc_mkdir() { install -d -m "$@"; }
sc_root_owned() { [[ "$(stat -c %u "$1" 2>/dev/null)" == 0 ]]; }
sc_json() { printf '%s' "$1" | tr -d '\000-\037' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# The root-owned source checkout this instance was installed from (its rules, never patched).
sc_src() {
  local d
  d="$(cat "$SRC_FILE" 2>/dev/null || true)"
  [[ -n "$d" && -f "$d/src/self-code-root.ts" && -f "$d/src/self-code-rules.ts" ]] && sc_root_owned "$d" || return 1
  printf '%s' "$d"
}
sc_node() {
  local src=$1
  shift
  "$NODE_BIN" --disable-warning=ExperimentalWarning "$(sc_p "$src/src/self-code-root.ts")" "$@"
}
sc_on() { [[ ! -e "$SC_OFF" ]]; }
# The reason in the node part's JSON answer (or the start of whatever it printed).
sc_reason() {
  local r
  r="$(printf '%s' "$1" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' | head -1)"
  [[ -n "$r" ]] || r="$(printf '%s' "$1" | tr -d '\000-\037' | head -c 200)"
  printf '%s' "$r"
}

sc_dirs() {
  sc_mkdir 750 "$SC_DIR" "$SC_DIR/queue" "$SC_DIR/parked" "$SC_DIR/results"
  sc_mkdir 700 "$SC_DIR/snap" "$SC_DIR/tmp"
  chgrp "$NAME" "$SC_DIR" "$SC_DIR/queue" "$SC_DIR/parked" "$SC_DIR/results" 2>/dev/null || true
}

# What Sara reads to know the helper is here and on (written by install.sh, `selfcode on|off`).
sc_marker() {
  local src on=true tmp
  src="$(sc_src || true)"
  sc_on || on=false
  [[ -n "$src" ]] || on=false
  sc_mkdir 750 "$STATUS_DIR"
  chgrp "$NAME" "$STATUS_DIR" 2>/dev/null || true
  sc_dirs
  tmp="$(mktemp "$STATUS_DIR/.selfcode.XXXXXX")"
  printf '{"helper":1,"on":%s,"src":"%s"}\n' "$on" "$(sc_json "$src")" > "$tmp"
  chgrp "$NAME" "$tmp" 2>/dev/null || true
  chmod 640 "$tmp"
  mv -f "$tmp" "$SC_MARK"
}

# sc_result ID KIND STATE MESSAGE [APPROVAL]: the outcome Sara shows on the card.
sc_result() {
  local tmp
  sc_dirs
  tmp="$(mktemp "$SC_DIR/results/.r.XXXXXX")"
  printf '{"id":%s,"kind":"%s","state":"%s","message":"%s","approval":"%s","at":"%s"}\n' "$1" "$2" "$3" "$(sc_json "$4")" "$(sc_json "${5:-}")" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$tmp"
  chgrp "$NAME" "$tmp" 2>/dev/null || true
  chmod 640 "$tmp"
  mv -f "$tmp" "$SC_DIR/results/$1.json"
  log "Code change #$1 ($2): $3. $4"
}

sc_lock() {
  command -v flock >/dev/null || return 0
  exec 8>"$SC_DIR/.lock"
  flock -w 900 8 || die "Another code change is still being applied; try again in a few minutes."
}

# Restart and wait for /api/health; the version must be the one she had (package.json is protected).
sc_restart_ok() {
  local before=$1
  sc_restart || return 1
  healthy || return 1
  [[ "$(app_version)" == "$before" ]]
}

# Started by <name>-updater.service: one request from Settings (apply or undo one change).
sc_web_request() {
  local rq="$DATA_DIR/self-code/root-request.json" tmp id src out kind approval
  sc_dirs
  tmp="$(mktemp -d "$SC_DIR/tmp/req.XXXXXX")"
  sc_read_user "$rq" 4097 > "$tmp/request.json" 2>/dev/null || true
  sc_user_rm "$rq"
  id="$(grep -o '"id"[[:space:]]*:[[:space:]]*[0-9]\{1,9\}' "$tmp/request.json" | head -1 | grep -o '[0-9]*$' || true)"
  if [[ -z "$id" ]]; then rm -rf -- "$tmp"; log "Ignored a code-change request without a change number."; return 1; fi
  if ! sc_on; then rm -rf -- "$tmp"; sc_result "$id" apply refused "The server's administrator turned code changes off (sudo $NAME selfcode on turns them back on)."; return 1; fi
  if ! src="$(sc_src)"; then rm -rf -- "$tmp"; sc_result "$id" apply refused "This server has no root-owned source checkout to check the change with."; return 1; fi
  sc_read_user "$DATA_DIR/self-code/patches/$id.patch" 1048577 > "$tmp/patch" 2>/dev/null || true
  out="$(sc_node "$src" check --instance "$NAME" --request "$(sc_p "$tmp/request.json")" --patch "$(sc_p "$tmp/patch")" --app "$(sc_p "$APP_DIR")" --src "$(sc_p "$src")" 2>&1)" || {
    rm -rf -- "$tmp"
    sc_result "$id" apply refused "The helper refused it: $(sc_reason "$out")"
    return 1
  }
  if [[ "$(printf '%s' "$out" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')" != "$id" ]]; then rm -rf -- "$tmp"; sc_result "$id" apply refused "The request did not match its change number."; return 1; fi
  kind="$(printf '%s' "$out" | sed -n 's/.*"kind":"\([a-z]*\)".*/\1/p')"
  approval="$(printf '%s' "$out" | sed -n 's/.*"approval":"\([A-Za-z0-9_-]*\)".*/\1/p')"
  log "Owner-approved code change #$id ($kind, approval $approval)."
  if [[ "$kind" == undo ]]; then
    rm -rf -- "$tmp"
    sc_undo "$id" "$approval" || return 1
    return 0
  fi
  local rc=0
  sc_apply "$id" "$tmp/patch" "$src" "$approval" || rc=1
  rm -rf -- "$tmp"
  return $rc
}

# sc_apply ID PATCH SRC APPROVAL: snapshot, apply to /opt/<name>, restart, health; back when not healthy.
sc_apply() {
  local id=$1 patch=$2 src=$3 approval=${4:-} before snap out
  sc_lock
  before="$(app_version)"
  snap="$SC_DIR/snap/$id"
  if ! out="$(sc_node "$src" apply --patch "$(sc_p "$patch")" --app "$(sc_p "$APP_DIR")" --snap "$(sc_p "$snap")" 2>&1)"; then
    sc_result "$id" apply refused "It could not be applied: $(sc_reason "$out")" "$approval"
    return 1
  fi
  install -m 640 "$patch" "$SC_DIR/queue/$id.patch"
  chgrp "$NAME" "$SC_DIR/queue/$id.patch" 2>/dev/null || true
  if sc_restart_ok "$before"; then
    sc_result "$id" apply applied "Applied and she came back healthy." "$approval"
    return 0
  fi
  sc_node "$src" restore --snap "$(sc_p "$snap")" --app "$(sc_p "$APP_DIR")" >/dev/null 2>&1 || true
  rm -f -- "$SC_DIR/queue/$id.patch"
  if sc_restart_ok "$before"; then
    sc_result "$id" apply rolledback "She didn't come back healthy with this change, so the helper put the old code back and restarted her." "$approval"
  else
    sc_result "$id" apply failed "She didn't come back healthy, and not after going back either. On the server: sudo $NAME status" "$approval"
  fi
  return 1
}

# sc_undo ID [APPROVAL]: takes an applied change out (root's own copy of it), same snapshot and health.
sc_undo() {
  local id=$1 approval=${2:-} src before snap out
  [[ -f "$SC_DIR/queue/$id.patch" ]] || { sc_result "$id" undo refused "This change is not applied on this server." "$approval"; return 1; }
  src="$(sc_src)" || { sc_result "$id" undo refused "This server has no root-owned source checkout." "$approval"; return 1; }
  sc_lock
  before="$(app_version)"
  snap="$SC_DIR/snap/$id-undo"
  if ! out="$(sc_node "$src" reverse --patch "$(sc_p "$SC_DIR/queue/$id.patch")" --app "$(sc_p "$APP_DIR")" --snap "$(sc_p "$snap")" 2>&1)"; then
    sc_result "$id" undo failed "It could not be taken out: $(sc_reason "$out")" "$approval"
    return 1
  fi
  if sc_restart_ok "$before"; then
    rm -f -- "$SC_DIR/queue/$id.patch"
    sc_result "$id" undo undone "Taken out; she came back healthy." "$approval"
    return 0
  fi
  sc_node "$src" restore --snap "$(sc_p "$snap")" --app "$(sc_p "$APP_DIR")" >/dev/null 2>&1 || true
  sc_restart_ok "$before" || true
  sc_result "$id" undo failed "She didn't come back healthy without it, so the change stays in." "$approval"
  return 1
}

# After `sara update` reinstalled a fresh copy: the queued changes go back in, in order. One that no
# longer fits or breaks a rule is parked; when she isn't healthy with them, all of them are parked.
sc_reapply() {
  local src before f id out applied=() snaps=()
  [[ -d "$SC_DIR/queue" ]] || return 0
  compgen -G "$SC_DIR/queue/*.patch" >/dev/null || return 0
  src="$(sc_src)" || { warn "No root-owned source checkout: the local code changes were not put back."; return 1; }
  sc_lock
  before="$(app_version)"
  while read -r id; do
    f="$SC_DIR/queue/$id.patch"
    if ! out="$(sc_node "$src" recheck --patch "$(sc_p "$f")" --app "$(sc_p "$APP_DIR")" --src "$(sc_p "$src")" 2>&1)" ||
      ! out="$(sc_node "$src" apply --patch "$(sc_p "$f")" --app "$(sc_p "$APP_DIR")" --snap "$(sc_p "$SC_DIR/snap/reapply-$id")" 2>&1)"; then
      mv -f -- "$f" "$SC_DIR/parked/$id.patch"
      sc_result "$id" reapply parked "Parked after the update to $before: $(sc_reason "$out")."
      continue
    fi
    applied+=("$id")
    snaps=("$SC_DIR/snap/reapply-$id" "${snaps[@]}")
  done < <(find "$SC_DIR/queue" -maxdepth 1 -name '*.patch' -printf '%f\n' 2>/dev/null | sed -n 's/^\([0-9]\{1,9\}\)\.patch$/\1/p' | sort -n)
  [[ ${#applied[@]} -gt 0 ]] || return 0
  if sc_restart_ok "$before"; then
    for id in "${applied[@]}"; do sc_result "$id" reapply applied "Put back after the update to $before."; done
    return 0
  fi
  for f in "${snaps[@]}"; do sc_node "$src" restore --snap "$(sc_p "$f")" --app "$(sc_p "$APP_DIR")" >/dev/null 2>&1 || true; done
  for id in "${applied[@]}"; do
    mv -f -- "$SC_DIR/queue/$id.patch" "$SC_DIR/parked/$id.patch"
    sc_result "$id" reapply parked "Parked: after the update to $before she did not start properly with the local code changes, so they were taken out."
  done
  sc_restart_ok "$before" || warn "She isn't healthy after the update even without the local code changes. Check: sudo $NAME logs"
  return 1
}

# sudo <name> selfcode list | revert <id> | off | on
sc_cmd() {
  case "${1:-list}" in
    list)
      log "Code changes from Sara on this server: $(sc_on && echo on || echo "off (sudo $NAME selfcode on)")"
      local f any=0
      for f in "$SC_DIR"/queue/*.patch "$SC_DIR"/parked/*.patch; do
        [[ -f "$f" ]] || continue
        any=1
        printf '  #%-6s %-8s %s\n' "$(basename "$f" .patch)" "$([[ $f == */queue/* ]] && echo applied || echo parked)" "$(grep -E '^\+\+\+ b/|^--- a/' "$f" | sed 's/^... [ab]\///' | sort -u | tr '\n' ' ')"
      done
      [[ $any -eq 1 ]] || log "None applied or parked."
      ;;
    revert)
      [[ "${2:-}" =~ ^[0-9]{1,9}$ ]] || die "Usage: sudo $NAME selfcode revert <id>"
      sc_undo "$2" admin
      ;;
    off)
      sc_mkdir 755 "$(dirname "$SC_OFF")"
      : > "$SC_OFF"
      sc_marker
      log "Code changes from Sara are off: the helper refuses every request. Applied ones stay (sudo $NAME selfcode revert <id> takes one out)."
      ;;
    on)
      rm -f -- "$SC_OFF"
      sc_marker
      if sc_src >/dev/null; then log "Code changes from Sara are on (she still asks you on every change)."; else warn "Turned on, but there is no root-owned source checkout, so she can't use it."; fi
      ;;
    *) die "Usage: sudo $NAME selfcode list | revert <id> | off | on" ;;
  esac
}
