#!/usr/bin/env bash
# V5.6 (docs/design/V5_PHONE_MODEL.md): puts the phone fallback model's engine into the Android
# build. Downloads the pinned llama.cpp b12528 (MIT) Android arm64 release, checks it, and copies
# libllama.so, libggml*.so (with the CPU variants it picks at run time) into
# app/src/main/jniLibs/arm64-v8a/ (gitignored); the pinned source's headers go to
# app/src/main/cpp/include/llama/ so cpp/llm.c compiles against them. With --emulator it also builds
# an x86_64 copy from the same pinned source with the NDK (for the Android emulator). Run once before
# `./gradlew assembleDebug`; without it the app builds without the engine (the setting then says the
# app has no model engine). armeabi-v7a phones get no engine. Nothing here is signed or published.
# The model itself is data: the app downloads it only when the person asks (LocalModel.java).
set -euo pipefail
cd "$(dirname "$0")"
TAG=b12528
URL=https://github.com/ggml-org/llama.cpp/releases/download/$TAG/llama-$TAG-bin-android-arm64.tar.gz
SHA=4f5811ae227bf2e254d66cb914e1636382d1c7cccf1b7a0498ddfdd71f03c43a
SRC_URL=https://github.com/ggml-org/llama.cpp/archive/refs/tags/$TAG.tar.gz
SRC_SHA=569a2de042289f346dd053d205520967bc203c8438c0317e699f5772f40d36f4
LIBS="libllama.so libggml.so libggml-base.so"
sum() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
get() { # url sha file
  [ -f "$3" ] && [ "$(sum "$3")" = "$2" ] || { curl -fsSL "$1" -o "$3.part" && mv "$3.part" "$3"; }
  [ "$(sum "$3")" = "$2" ] || { rm -f "$3"; echo "$(basename "$3") didn't match its SHA-256: not used." >&2; exit 1; }
}
CACHE="${SARA_BUILD_CACHE:-${TMPDIR:-$HOME/.cache}/sara-build}"
mkdir -p "$CACHE"
T="$CACHE/llama-$TAG-bin-android-arm64.tar.gz"
S="$CACHE/llama.cpp-$TAG.tar.gz"
get "$URL" "$SHA" "$T"
get "$SRC_URL" "$SRC_SHA" "$S"
W="$CACHE/llm-unpack"
rm -rf "$W" && mkdir -p "$W"
# From stdin: Git Bash's tar would read "C:/…" as a remote host.
tar -xzf - -C "$W" <"$T"
OUT=app/src/main/jniLibs/arm64-v8a
mkdir -p "$OUT"
for f in $LIBS "$W/llama-$TAG"/libggml-cpu-android_*.so; do cp "$W/llama-$TAG/$(basename "$f")" "$OUT/"; done
tar -xzf - -C "$W" "llama.cpp-$TAG/include" "llama.cpp-$TAG/ggml/include" <"$S"
H=app/src/main/cpp/include/llama
rm -rf "$H" && mkdir -p "$H"
cp "$W/llama.cpp-$TAG/include/"*.h "$W/llama.cpp-$TAG/ggml/include/"*.h "$H/"
if [ "${1:-}" = "--emulator" ]; then
  SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-C:/Android/Sdk}}"
  NDK="${ANDROID_NDK:-$SDK/ndk/28.2.13676358}"
  CM="$(ls -d "$SDK"/cmake/*/bin | tail -1)"
  tar -xzf - -C "$W" <"$S"
  B="$W/build-x86_64"
  "$CM/cmake" -S "$W/llama.cpp-$TAG" -B "$B" -G Ninja -DCMAKE_MAKE_PROGRAM="$CM/ninja" \
    -DCMAKE_TOOLCHAIN_FILE="$NDK/build/cmake/android.toolchain.cmake" -DANDROID_ABI=x86_64 -DANDROID_PLATFORM=android-28 \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DLLAMA_CURL=OFF \
    -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_TOOLS=OFF -DLLAMA_BUILD_SERVER=OFF -DLLAMA_BUILD_COMMON=OFF >/dev/null
  "$CM/cmake" --build "$B" --target llama -j 8 >/dev/null
  mkdir -p app/src/main/jniLibs/x86_64
  find "$B" -name 'lib*.so' \( -name 'libllama.so' -o -name 'libggml*.so' \) -exec cp {} app/src/main/jniLibs/x86_64/ \;
fi
rm -rf "$W"
echo "llama.cpp $TAG is in app/src/main/jniLibs/ (and its headers in $H)."
