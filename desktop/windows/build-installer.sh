#!/usr/bin/env bash
# Builds Sara-Setup-<version>.exe (Phase 46c): ONE Windows installer with Sara's server, her own
# Node.js, the Sara desktop app and the service host. Output: outputs/windows/Sara-Setup-<version>.exe
#
# Needs what build.sh needs (Visual Studio Build Tools with C++, CMake), plus curl and unzip.
# Downloads once into desktop/windows/third_party/ (not committed), each pinned and SHA-256 checked:
#   - Node.js (the same version deploy/install.sh pins), node.exe only
#   - Inno Setup 6 (build time only; unpacked in portable mode, nothing is installed on this PC)
# The installer is not code-signed yet: Windows SmartScreen says "More info → Run anyway".
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
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
OUT="$ROOT/outputs/windows"
STAGE="$OUT/stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/server" "$STAGE/node" "$STAGE/bin"
cp build/Release/Sara.exe build/Release/SaraService.exe "$STAGE/"
cp "$NODE_DIR/node.exe" "$STAGE/node/"
cp "$NODE_DIR/LICENSE" "$STAGE/node/LICENSE.txt"
cp -r "$ROOT/src" "$ROOT/web" "$ROOT/persona" "$ROOT/templates" "$ROOT/skills" "$STAGE/server/"
# Phase 87: the shared page agent (her testing browser reads pages with it too).
mkdir -p "$STAGE/server/desktop/shared" && cp "$ROOT/desktop/shared/page-agent.js" "$STAGE/server/desktop/shared/"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$STAGE/server/"
mkdir -p "$STAGE/server/docs"
cp "$ROOT/docs/INSTALL.md" "$ROOT/docs/desktop.md" "$STAGE/server/docs/"
REV="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || true)"
[[ -n "$REV" ]] && printf '%s\n' "$REV" > "$STAGE/server/REVISION"
# Batch files want Windows line endings.
sed 's/\r$//; s/$/\r/' "$HERE/installer/sara.cmd" > "$STAGE/bin/sara.cmd"

# 5. The installer
"$ISCC" /Q "/DAppVersion=$VERSION" "/DStage=$(winpath "$STAGE")" "/O$(winpath "$OUT")" "$(winpath "$HERE/installer/sara.iss")"
ls -la "$OUT/Sara-Setup-$VERSION.exe"
sha256sum "$OUT/Sara-Setup-$VERSION.exe"
