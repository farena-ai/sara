#!/usr/bin/env bash
# R1: signs Windows files with Azure Artifact Signing (formerly Trusted Signing): signtool + Microsoft's
# Azure.CodeSigning.Dlib.dll and a metadata.json {Endpoint, CodeSigningAccountName, CertificateProfileName}.
# Sign-in is the owner's `az login` (the dlib's DefaultAzureCredential uses the Azure CLI credential).
# Owner setup: docs/ops/WINDOWS_SIGNING.md.
#
#   bash desktop/windows/sign.sh [--dry-run] FILE...   sign each file (RFC 3161 timestamp, SHA-256), then
#                                                      `signtool verify /pa`; no metadata.json → unsigned, exit 0
#   bash desktop/windows/sign.sh --check               exit 0 when signing is set up, 1 when not
#
# SARA_SIGN_DIR    folder with metadata.json and dlib/ (default: <repo>/.secrets/azure-signing, gitignored)
# SARA_SIGN_DLIB   Azure.CodeSigning.Dlib.dll (default: $SARA_SIGN_DIR/dlib/bin/x64/Azure.CodeSigning.Dlib.dll)
# SARA_SIGNTOOL    signtool.exe (default: the newest x64 one in the Windows 10/11 SDK)
# SARA_SIGN=off    build unsigned even when metadata.json exists
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DIR="${SARA_SIGN_DIR:-$ROOT/.secrets/azure-signing}"
META="$DIR/metadata.json"
TS=http://timestamp.acs.microsoft.com
HOWTO="see docs/ops/WINDOWS_SIGNING.md"
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
die() { echo "signing: $*" >&2; exit 1; }

DRY=0
CHECK=0
FILES=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --check) CHECK=1 ;;
    *) FILES+=("$a") ;;
  esac
done

if [[ "${SARA_SIGN:-}" == off || ! -f "$META" ]]; then
  [[ $CHECK == 1 ]] && { echo "unsigned (no Azure signing set up)"; exit 1; }
  for f in "${FILES[@]}"; do echo "unsigned (no Azure signing set up): $(basename "$f")"; done
  exit 0
fi

# metadata.json: the three values Microsoft's dlib reads (flat JSON, so sed is enough).
field() { tr -d '\r\n' < "$META" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p"; }
EP="$(field Endpoint)"
ACC="$(field CodeSigningAccountName)"
PROF="$(field CertificateProfileName)"
[[ "$EP" =~ ^https://[a-z0-9]+\.codesigning\.azure\.net/?$ ]] || die "metadata.json Endpoint must be your account's region URI, like https://eus.codesigning.azure.net ($HOWTO)"
[[ -n "$ACC" ]] || die "metadata.json has no CodeSigningAccountName ($HOWTO)"
[[ -n "$PROF" ]] || die "metadata.json has no CertificateProfileName ($HOWTO)"

DLIB="${SARA_SIGN_DLIB:-$DIR/dlib/bin/x64/Azure.CodeSigning.Dlib.dll}"
[[ -f "$DLIB" ]] || die "no Azure.CodeSigning.Dlib.dll at $DLIB: unpack the NuGet package Microsoft.ArtifactSigning.Client into $DIR/dlib ($HOWTO)"

TOOL="${SARA_SIGNTOOL:-}"
if [[ -z "$TOOL" ]]; then
  while IFS= read -r d; do
    [[ -f "$d/x64/signtool.exe" ]] && { TOOL="$d/x64/signtool.exe"; break; }
  done < <(ls -d "/c/Program Files (x86)/Windows Kits/10/bin/10."* 2>/dev/null | sort -rV)
fi
[[ -n "$TOOL" && -f "$TOOL" ]] || die "no signtool.exe: install the Windows SDK signing tools ($HOWTO)"

if [[ "${SARA_SIGN_SKIP_AZ:-}" != 1 && -z "${AZURE_CLIENT_ID:-}" ]]; then
  command -v az >/dev/null || die "the Azure CLI (az) is not installed, so there is no sign-in for the dlib ($HOWTO)"
  az account show >/dev/null 2>&1 || die "not signed in to Azure: run az login ($HOWTO)"
fi

[[ $CHECK == 1 ]] && { echo "signing set up: account $ACC, profile $PROF, $EP"; exit 0; }

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || die "no file $f"
  args=(sign /v /debug /fd SHA256 /tr "$TS" /td SHA256 /dlib "$(winpath "$DLIB")" /dmdf "$(winpath "$META")" "$(winpath "$f")")
  if [[ $DRY == 1 ]]; then
    echo "would sign: \"$TOOL\" ${args[*]}"
    echo "would verify: \"$TOOL\" verify /pa /v $(winpath "$f")"
    continue
  fi
  "$TOOL" "${args[@]}" > /dev/null || die "signtool could not sign $(basename "$f") (az login expired? $HOWTO)"
  "$TOOL" verify /pa /v "$(winpath "$f")" > /dev/null || die "$(basename "$f") does not verify after signing"
  echo "signed: $(basename "$f") (account $ACC, profile $PROF)"
done
