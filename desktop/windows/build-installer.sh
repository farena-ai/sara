#!/usr/bin/env bash
# Builds Sara-Setup-<version>.exe (Phase 46c): ONE Windows installer with Sara's server, her own
# Node.js, the Sara desktop app and the service host. Output: outputs/windows/Sara-Setup-<version>.exe
#
# Needs what build.sh needs (Visual Studio Build Tools with C++, CMake), plus curl and unzip.
# Downloads once into desktop/windows/third_party/ (not committed), each pinned and SHA-256 checked:
#   - Node.js (the same version deploy/install.sh pins), node.exe only
#   - Inno Setup 6 (build time only; unpacked in portable mode, nothing is installed on this PC)
# R1: Sara.exe, SaraService.exe and the installer are signed with Azure Artifact Signing (sign.sh) when
# .secrets/azure-signing/metadata.json exists (or SARA_SIGN_DIR points at one); otherwise the build says
# "unsigned (no Azure signing set up)" and SmartScreen says "More info → Run anyway". docs/ops/WINDOWS_SIGNING.md
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$HERE"

NODE_VER=24.22.1
NODE_SHA=d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5   # node-v24.22.1-win-x64.zip (nodejs.org SHASUMS256.txt)
INNO_VER=6.7.3
INNO_SHA=9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732   # innosetup-6.7.3.exe (GitHub release jrsoftware/issrc is-6_7_3)

# Windows-style path for native tools (MSYS path conversion is off on the dev PC).
winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# 1. Sara.exe and SaraService.exe
bash "$HERE/build.sh"

# 2. Node.js for Windows (node.exe only)
mkdir -p third_party
NODE_DIR="third_party/node-v$NODE_VER-win-x64"
if [[ ! -f "$NODE_DIR/node.exe" ]]; then
  zip="third_party/node-v$NODE_VER-win-x64.zip"
  [[ -f "$zip" ]] || curl -fsSL -o "$zip" "https://nodejs.org/dist/v$NODE_VER/node-v$NODE_VER-win-x64.zip"
  echo "$NODE_SHA *$zip" | sha256sum -c - || { rm -f "$zip"; echo "Node.js download didn't match its checksum" >&2; exit 1; }
  rm -rf "$NODE_DIR"
  (cd third_party && unzip -q "node-v$NODE_VER-win-x64.zip" "node-v$NODE_VER-win-x64/node.exe" "node-v$NODE_VER-win-x64/LICENSE")
fi

# 3. Inno Setup (portable: its own setup unpacks into third_party/innosetup, no registry entries)
ISCC="third_party/innosetup/ISCC.exe"
if [[ ! -f "$ISCC" ]]; then
  exe="third_party/innosetup-$INNO_VER.exe"
  [[ -f "$exe" ]] || curl -fsSL -o "$exe" "https://github.com/jrsoftware/issrc/releases/download/is-${INNO_VER//./_}/innosetup-$INNO_VER.exe"
  echo "$INNO_SHA *$exe" | sha256sum -c - || { rm -f "$exe"; echo "Inno Setup download didn't match its checksum" >&2; exit 1; }
  "./$exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER /PORTABLE=1 "/DIR=$(winpath "$HERE/third_party/innosetup")"
  [[ -f "$ISCC" ]] || { echo "Inno Setup didn't unpack" >&2; exit 1; }
fi

# 4. Stage the payload
VERSION="${SARA_APP_VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)}"
OUT="$ROOT/outputs/windows"
BUILD=build
ISS_EXTRA=()
# The app's update test (docs/desktop.md): a test-hooks app in an installer of its own (TestInstall:
# its own AppId, folder and data folder), in outputs/windows-updtest. Never published.
if [[ "${SARA_TEST_INSTALL:-}" == 1 ]]; then OUT="$ROOT/outputs/windows-updtest"; BUILD=build-test; ISS_EXTRA+=(/DTestInstall); fi
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/server" "$STAGE/node" "$STAGE/bin"
cp "$BUILD/Release/Sara.exe" "$BUILD/Release/SaraService.exe" "$STAGE/"
cp "$NODE_DIR/node.exe" "$STAGE/node/"
cp "$NODE_DIR/LICENSE" "$STAGE/node/LICENSE.txt"
cp -r "$ROOT/src" "$ROOT/web" "$ROOT/persona" "$ROOT/templates" "$ROOT/skills" "$ROOT/plugins" "$STAGE/server/"
# W2.5: the how-to clips the help plays (served at /docs/media/, src/help-media.ts).
mkdir -p "$STAGE/server/docs" && cp -r "$ROOT/docs/media" "$STAGE/server/docs/"
# V4e: the move-in collector Sara serves (Settings → Data & health → Move in from another agent).
mkdir -p "$STAGE/server/scripts" && cp "$ROOT/scripts/sara-movein.py" "$STAGE/server/scripts/" && cp "$ROOT/scripts/sara-movein.mjs" "$STAGE/server/scripts/"
# Local workflow candidates remain untrusted packages, reviewed separately before installation.
CANDIDATE_PLUGINS=(
  daily-briefing meeting-assistant document-desk research-notebook project-handoff weekly-review
  inbox-triage content-studio image-workshop spreadsheet-assistant travel-planner home-dashboard
  secret-scanner license-auditor sbom-builder artifact-provenance-verifier coverage-explorer
  log-explorer incident-workbench environment-config-doctor database-fixture-studio
  data-contract-validator change-impact-analyzer architecture-guard sql-migration-reviewer
  visual-regression localization-qa accessibility-auditor build-cache-inspector api-contract-guard
  http-webhook-workbench
  performance-regression-lab code-migration-studio build-reproducibility-inspector
  test-doctor flaky-test-lab documentation-doctor release-readiness repository-onboarding
)
mkdir -p "$STAGE/server/store/plugins"
for id in "${CANDIDATE_PLUGINS[@]}"; do
  cp -r "$ROOT/store/plugins/$id" "$STAGE/server/store/plugins/"
done
# Phase 87: the shared page agent (her testing browser reads pages with it too).
mkdir -p "$STAGE/server/desktop/shared" && cp "$ROOT/desktop/shared/page-agent.js" "$STAGE/server/desktop/shared/"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$STAGE/server/"
mkdir -p "$STAGE/server/docs"
cp "$ROOT/docs/INSTALL.md" "$ROOT/docs/desktop.md" "$STAGE/server/docs/"
# A source archive has no .git; never inherit a containing repository's revision.
if [[ -d "$ROOT/.git" || -f "$ROOT/.git" ]]; then
  REV="$(git -C "$(winpath "$ROOT")" rev-parse --short HEAD)"
  printf '%s\n' "$REV" > "$STAGE/server/REVISION"
fi
# V0.1: the loaded-engine voice helper, prebuilt (Windows servers have no compiler); the voice install
# copies it next to the sherpa tools. A failed build only costs speed: voice then loads per call.
if bash "$HERE/build-voice-helper.sh" "$STAGE/server/voice-helper"; then HELPER=("$STAGE"/server/voice-helper/*/win32-x64/sara-voice-worker.exe); else HELPER=(); echo "(voice helper not built: voice loads per call)" >&2; fi
# R1: sign the app and the service host before Inno Setup packs them (node.exe is already signed by OpenJS).
bash "$HERE/sign.sh" "$STAGE/Sara.exe" "$STAGE/SaraService.exe" "${HELPER[@]}"
# Batch files want Windows line endings.
sed 's/\r$//; s/$/\r/' "$HERE/installer/sara.cmd" > "$STAGE/bin/sara.cmd"

# 5. The installer
# V0.6: with Azure signing set up, Inno Setup signs Setup AND its uninstaller (unins000.exe, which it
# writes itself and can only sign while compiling) through the same sign.sh; $f is the file, $q a quote.
# Without signing ISCC gets no sign tool and builds unsigned exactly as before (sign.sh says so below).
ISS_SIGN=()
if bash "$HERE/sign.sh" --check >/dev/null 2>&1; then
  ISS_SIGN=(/DSignTool=sarasign "/Ssarasign=\$q$(winpath "$(command -v bash)")\$q \$q$(winpath "$HERE/sign.sh")\$q \$f")
fi
"$ISCC" /Q "/DAppVersion=$VERSION" "/DStage=$(winpath "$STAGE")" "${ISS_EXTRA[@]}" "${ISS_SIGN[@]}" "/O$(winpath "$OUT")" "$(winpath "$HERE/installer/sara.iss")"
if [[ ${#ISS_SIGN[@]} == 0 ]]; then bash "$HERE/sign.sh" "$OUT/Sara-Setup-$VERSION.exe"; fi
ls -la "$OUT/Sara-Setup-$VERSION.exe"
sha256sum "$OUT/Sara-Setup-$VERSION.exe"
