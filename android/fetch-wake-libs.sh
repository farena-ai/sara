#!/usr/bin/env bash
# C17 (docs/ops/C17_DESIGN.md): puts the Hey Sara engine into the Android build. Downloads the pinned
# sherpa-onnx v1.13.8 Android release (Apache-2.0), checks it, and copies libsherpa-onnx-c-api.so and
# libonnxruntime.so for three ABIs into app/src/main/jniLibs/<abi>/ (gitignored), each file checked;
# then sherpa-onnx's C header (pinned) into app/src/main/cpp/include/ so the shim compiles against
# it. Run once before `./gradlew assembleDebug` / `bundleRelease`; without it the app builds with
# Talk only. Nothing here is signed or published.
set -euo pipefail
cd "$(dirname "$0")"
URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-android.tar.bz2
SHA=2ff63469a71cb6009aa2e3ed5f4a670f8abdcbe4bb9ffd23776afc792a6b4f44
HDR_URL=https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/sherpa-onnx/c-api/c-api.h
HDR_SHA=2a1b95084be8fd1deb3228fcad2fd3f7f0258b64582f7402281ec174c7b7f4ce
# abi/file|sha256 (measured from the tarball above)
FILES=(
  "arm64-v8a/libsherpa-onnx-c-api.so|c85e2382e2ca12b0513826be926eaccfea896b4cbf568182e287671ba526f80d"
  "arm64-v8a/libonnxruntime.so|33847ad43bffe204699fd4a27f7f3603452a8cdaf2f9a44983a0bc31ffcf2da1"
  "armeabi-v7a/libsherpa-onnx-c-api.so|2294b9cc929ca0d22c5da52864ec8176f8fd119a739c9d594384763f6101d33f"
  "armeabi-v7a/libonnxruntime.so|7a8f17a707e52e0ac3a026be319272876d9eae61f4bb19585292772d785f7744"
  "x86_64/libsherpa-onnx-c-api.so|631ca2828e47b61d8afe4b3c75a157423cbafaba6f8c0db89c27d21f1b173d9a"
  "x86_64/libonnxruntime.so|087e84297cad64acb823c3d901d6e0cc934e91add7cdb20da802cd1c0bea5c3e"
)
sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
CACHE="${SARA_BUILD_CACHE:-${TMPDIR:-$HOME/.cache}/sara-build}"
mkdir -p "$CACHE"
T="$CACHE/sherpa-onnx-v1.13.8-android.tar.bz2"
[ -f "$T" ] && [ "$(sum "$T")" = "$SHA" ] || { curl -fsSL "$URL" -o "$T.part" && mv "$T.part" "$T"; }
[ "$(sum "$T")" = "$SHA" ] || { rm -f "$T"; echo "The engine download didn't match its SHA-256: not used." >&2; exit 1; }
W="$CACHE/android-unpack"
rm -rf "$W" && mkdir -p "$W"
# From stdin: Git Bash's tar would read "C:/…" as a remote host.
tar -xjf - -C "$W" $(for f in "${FILES[@]}"; do echo "./jniLibs/${f%%|*}"; done) <"$T"
for f in "${FILES[@]}"; do
  p="${f%%|*}"; want="${f##*|}"
  [ "$(sum "$W/jniLibs/$p")" = "$want" ] || { echo "$p didn't match its SHA-256: not used." >&2; exit 1; }
  mkdir -p "app/src/main/jniLibs/$(dirname "$p")"
  cp "$W/jniLibs/$p" "app/src/main/jniLibs/$p"
done
rm -rf "$W"
H=app/src/main/cpp/include/sherpa-onnx/c-api
mkdir -p "$H"
curl -fsSL "$HDR_URL" -o "$H/c-api.h.part"
[ "$(sum "$H/c-api.h.part")" = "$HDR_SHA" ] || { rm -f "$H/c-api.h.part"; echo "c-api.h didn't match its SHA-256." >&2; exit 1; }
mv "$H/c-api.h.part" "$H/c-api.h"
echo "Hey Sara engine ready: app/src/main/jniLibs (3 ABIs) and the C header."
