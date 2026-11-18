#!/usr/bin/env bash
# V0.1 (docs/VOICE_FIRST.md "Engines stay loaded"): builds the loaded-engine helper
# (deploy/voice/sara-voice-worker.c) for Windows servers, which have no compiler, so the installer
# can ship it. MSVC from the Build Tools build.sh already needs (found with vswhere), linked against
# the pinned sherpa-onnx C API: the SAME release and SHA-256 as src/voice-install.ts SHERPA_BUNDLES
# (the C config structs change between releases; bump both together).
#
#   bash desktop/windows/build-voice-helper.sh <out-dir>
#     -> <out-dir>/sherpa-onnx-v1.13.8/win32-x64/sara-voice-worker.exe
#
# Downloads the bundle once into desktop/windows/third_party/ (not committed). Sara's voice install
# (`sara voice install`, Settings → Voice) copies the helper next to the sherpa tools.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${1:?usage: build-voice-helper.sh <out-dir>}"

SHERPA_VER=v1.13.8
SHERPA=sherpa-onnx-$SHERPA_VER-win-x64-shared-MD-Release
SHERPA_SHA=3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22   # = SHERPA_BUNDLES['win32-x64']

winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

TP="$HERE/third_party"
mkdir -p "$TP"
if [[ ! -f "$TP/$SHERPA/include/sherpa-onnx/c-api/c-api.h" || ! -f "$TP/$SHERPA/lib/sherpa-onnx-c-api.lib" ]]; then
  tarball="$TP/$SHERPA.tar.bz2"
  if [[ ! -f "$tarball" ]]; then
    # Download into the temp folder first (some build PCs block curl from writing into the tree).
    dl="$(mktemp -d)"
    curl -fsSL -o "$dl/$SHERPA.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/$SHERPA_VER/$SHERPA.tar.bz2"
    mv "$dl/$SHERPA.tar.bz2" "$tarball" && rmdir "$dl"
  fi
  echo "$SHERPA_SHA  $tarball" | sha256sum -c --quiet - || { echo "sherpa-onnx bundle checksum mismatch" >&2; rm -f "$tarball"; exit 1; }
  # Only the header and the import library are needed to link; the DLLs come with the voice install.
  (cd "$TP" && "${SystemRoot:-C:/Windows}/System32/tar.exe" -xjf "$(winpath "$tarball")" "$SHERPA/include" "$SHERPA/lib/sherpa-onnx-c-api.lib")
fi

VSWHERE="${ProgramFiles_x86:-C:/Program Files (x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
[[ -f "$VSWHERE" ]] || VSWHERE="C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
VS="$("$VSWHERE" -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | tr -d '\r')"
[[ -n "$VS" ]] || { echo "No Visual Studio C++ build tools found (build.sh needs them too)." >&2; exit 1; }

DEST="$OUT/sherpa-onnx-$SHERPA_VER/win32-x64"
mkdir -p "$DEST"
OBJ="$(mktemp -d)"
trap 'rm -rf "$OBJ"' EXIT
BAT="$OBJ/build.bat"
# cmd.exe needs CRLF and native paths; /MD matches the "shared-MD" sherpa build.
printf '@echo off\r\ncall "%s\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul || exit /b 1\r\ncd /d "%s"\r\ncl /nologo /O2 /MD /W3 "%s" /I"%s" /Fe:"%s" /link /LIBPATH:"%s" sherpa-onnx-c-api.lib || exit /b 1\r\n' \
  "$(winpath "$VS")" "$(winpath "$OBJ")" "$(winpath "$ROOT/deploy/voice/sara-voice-worker.c")" "$(winpath "$TP/$SHERPA/include")" \
  "$(winpath "$DEST/sara-voice-worker.exe")" "$(winpath "$TP/$SHERPA/lib")" > "$BAT"
# MSYS2_ARG_CONV_EXCL keeps git-bash from turning /c into a path (`cmd //c` prints a banner and stops).
MSYS2_ARG_CONV_EXCL='*' "${SystemRoot:-C:/Windows}/System32/cmd.exe" /c "$(winpath "$BAT")"
[[ -f "$DEST/sara-voice-worker.exe" ]] || { echo "The voice helper did not build." >&2; exit 1; }
echo "Built $DEST/sara-voice-worker.exe"
