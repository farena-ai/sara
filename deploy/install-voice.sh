#!/usr/bin/env bash
# Optional: local voice for Sara (speech-to-text + text-to-speech), CPU only, nothing leaves the
# server. Installs pinned, checksum-verified sherpa-onnx tools and models into $SARA_VOICE_DIR
# (default /opt/sara-voice) and points Sara at them. Does not install system packages.
#
#   sudo ./deploy/install-voice.sh            # ~650 MB download, ~1.3 GB on disk
#   sudo ./deploy/install-voice.sh --instance work   # another Sara on this server: the voice files
#                                             # are shared, only that instance's settings change
#   sudo ./deploy/install-voice.sh --streaming       # also words-as-you-speak hearing for Talk (V0.2,
#                                             # NeMo streaming FastConformer, ~105 MB more)
#   sudo ./deploy/install-voice.sh --languages       # words as you speak in Spanish, French, German,
#                                             # Portuguese and Italian too (W0.3, Nemotron 3.5, ~480 MB more)
#
# Engines: Parakeet 110M (English speech-to-text), Kokoro v0.19 (natural voices, ~0.7x real time
# on an 8-core Xeon), Piper "hfc_female" (fast fallback voice, ~15x real time).
set -euo pipefail

VOICE_DIR="${SARA_VOICE_DIR:-/opt/sara-voice}"
# Several Saras on one server: --instance NAME (or SARA_INSTANCE) picks whose settings to update.
INSTANCE="${SARA_INSTANCE:-sara}"
STREAMING=0
LANGUAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance) INSTANCE="${2:-}"; shift 2 ;;
    --instance=*) INSTANCE="${1#*=}"; shift ;;
    --streaming) STREAMING=1; shift ;;
    --languages) LANGUAGES=1; shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
# shellcheck source=deploy/lib-instance.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-instance.sh"
si_valid_name "$INSTANCE" || { printf 'Not an instance name: %s\n' "$INSTANCE" >&2; exit 2; }
ENV_FILE="/etc/$INSTANCE/$INSTANCE.env"
R=https://github.com/k2-fsa/sherpa-onnx/releases/download
SHERPA=sherpa-onnx-v1.13.8-linux-x64-shared

# file|sha256
ITEMS=(
  "v1.13.8/${SHERPA}.tar.bz2|c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4"
  "asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2|17f945007b52ccd8b7200ffc7c5652e9e8e961dfdf479cefcabd06cf5703630b"
  "tts-models/kokoro-en-v0_19.tar.bz2|912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7"
  "tts-models/vits-piper-en_US-hfc_female-medium.tar.bz2|3fffdceb0c65bd9415a085d09c3cb88cc82f9d74a6ca453f8ce7fc5eaee81ff8"
)
# V0.2: the optional streaming hearing model (same pin as src/voice-install.ts STREAM_MODEL).
STREAM_DIR=sherpa-onnx-nemo-streaming-fast-conformer-transducer-en-80ms-int8
[[ $STREAMING -eq 1 ]] && ITEMS+=("asr-models/$STREAM_DIR.tar.bz2|7bd33a914e93370a1ba9c2066d9e841bdcad8613fa2a00537c1ae15d851a14d8")
# W0.3: the optional multilingual streaming model (same pin as src/voice-install.ts MULTI_MODEL).
MULTI_DIR=sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11
[[ $LANGUAGES -eq 1 ]] && ITEMS+=("asr-models/$MULTI_DIR.tar.bz2|c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a")

log() { printf '\033[1;35m[sara-voice]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[sara-voice]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root."
[[ "$(uname -m)" == x86_64 ]] || die "The local voice bundle is x86_64 only for now. Use a cloud voice in Settings instead."
for cmd in curl tar bzip2 sha256sum; do command -v "$cmd" >/dev/null || die "Missing required command: $cmd (install it with your package manager, e.g. apt install $cmd or dnf install $cmd)"; done

mkdir -p "$VOICE_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for item in "${ITEMS[@]}"; do
  path="${item%%|*}"; sum="${item##*|}"; name="$(basename "$path")"; dir="${name%.tar.bz2}"
  if [[ -d "$VOICE_DIR/$dir" ]]; then log "Already installed: $dir"; continue; fi
  log "Downloading $name..."
  curl -fsSL "$R/$path" -o "$TMP/$name"
  echo "$sum  $TMP/$name" | sha256sum -c --quiet - || die "Checksum mismatch for $name"
  # Unpack next to the target and move it into place only when complete, so an interrupted run
  # never leaves a half-unpacked folder that the next run would take as installed.
  part="$VOICE_DIR/.partial"
  rm -rf "$part"; mkdir -p "$part"
  tar -xjf "$TMP/$name" -C "$part"
  [[ -d "$part/$dir" ]] || die "Unexpected contents in $name (no $dir folder)."
  rm -rf "${VOICE_DIR:?}/$dir"
  mv "$part/$dir" "$VOICE_DIR/$dir"
  rm -rf "$part" "$TMP/$name"
done

cat > "$VOICE_DIR/voice.json" <<EOF
{
  "sherpa": "${SHERPA}",
  "stt": { "kind": "nemo-ctc", "model": "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8/model.int8.onnx", "tokens": "sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8/tokens.txt" },
  "voices": [
$(i=0; for v in "1|Bella (US)" "3|Sarah (US)" "2|Nicole (US)" "4|Sky (US)" "0|Default (US)" "7|Emma (UK)" "8|Isabella (UK)"; do
    sid="${v%%|*}"; label="${v#*|}"; [[ $i -gt 0 ]] && echo ","; i=$((i+1))
    printf '    { "id": "kokoro:%s", "label": "%s, natural", "kind": "kokoro", "model": "kokoro-en-v0_19/model.onnx", "voices": "kokoro-en-v0_19/voices.bin", "tokens": "kokoro-en-v0_19/tokens.txt", "dataDir": "kokoro-en-v0_19/espeak-ng-data", "sid": %s }' "$sid" "$label" "$sid"
  done),
    { "id": "piper:hfc_female", "label": "Piper (US), fast", "kind": "vits", "model": "vits-piper-en_US-hfc_female-medium/en_US-hfc_female-medium.onnx", "tokens": "vits-piper-en_US-hfc_female-medium/tokens.txt", "dataDir": "vits-piper-en_US-hfc_female-medium/espeak-ng-data" }
  ]$([[ -d "$VOICE_DIR/$STREAM_DIR" ]] && printf ',\n  "online": { "kind": "transducer", "encoder": "%s/encoder.int8.onnx", "decoder": "%s/decoder.int8.onnx", "joiner": "%s/joiner.int8.onnx", "tokens": "%s/tokens.txt" }' "$STREAM_DIR" "$STREAM_DIR" "$STREAM_DIR" "$STREAM_DIR")$([[ -d "$VOICE_DIR/$MULTI_DIR" ]] && printf ',\n  "multi": { "kind": "transducer", "encoder": "%s/encoder.int8.onnx", "decoder": "%s/decoder.int8.onnx", "joiner": "%s/joiner.int8.onnx", "tokens": "%s/tokens.txt", "languages": ["en", "es", "fr", "de", "pt", "it"] }' "$MULTI_DIR" "$MULTI_DIR" "$MULTI_DIR" "$MULTI_DIR")
}
EOF
# U5: the loaded-engine helper (deploy/voice/sara-voice-worker.c) keeps hearing and her voice in
# memory between calls. Optional: without a C compiler Sara loads the model on every call instead.
WORKER_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/voice/sara-voice-worker.c"
if command -v cc >/dev/null 2>&1 && [[ -f "$WORKER_SRC" ]]; then
  if cc -O2 -o "$VOICE_DIR/$SHERPA/bin/sara-voice-worker" "$WORKER_SRC" -I"$VOICE_DIR/$SHERPA/include" -L"$VOICE_DIR/$SHERPA/lib" -lsherpa-onnx-c-api -Wl,-rpath,"$VOICE_DIR/$SHERPA/lib" 2>/dev/null; then
    log "Built the loaded-engine helper (faster voice replies)."
  else
    log "Could not build the loaded-engine helper; voice still works, a little slower."
  fi
fi
chown -R root:root "$VOICE_DIR"
chmod -R a+rX "$VOICE_DIR"

# Smoke test as that instance's user: speak a sentence, then transcribe it back.
if id "$INSTANCE" >/dev/null 2>&1; then
  T="$(runuser -u "$INSTANCE" -- mktemp -d "/var/lib/$INSTANCE/voice-check.XXXXXX" 2>/dev/null || mktemp -d)"
  chown "$INSTANCE:$INSTANCE" "$T" 2>/dev/null || true
  export LD_LIBRARY_PATH="$VOICE_DIR/$SHERPA/lib"
  K="$VOICE_DIR/kokoro-en-v0_19"
  runuser -u "$INSTANCE" -- env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" "$VOICE_DIR/$SHERPA/bin/sherpa-onnx-offline-tts" --kokoro-model="$K/model.onnx" --kokoro-voices="$K/voices.bin" --kokoro-tokens="$K/tokens.txt" --kokoro-data-dir="$K/espeak-ng-data" --sid=1 --num-threads=2 --output-filename="$T/check.wav" "Voice check for Sara." >/dev/null 2>&1 || die "Text-to-speech check failed."
  P="$VOICE_DIR/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8"
  OUT="$(runuser -u "$INSTANCE" -- env LD_LIBRARY_PATH="$LD_LIBRARY_PATH" "$VOICE_DIR/$SHERPA/bin/sherpa-onnx-offline" --nemo-ctc-model="$P/model.int8.onnx" --tokens="$P/tokens.txt" --num-threads=2 "$T/check.wav" 2>/dev/null | grep -o '"text": "[^"]*"' || true)"
  rm -rf "$T"
  [[ -n "$OUT" ]] || die "Speech-to-text check failed."
  log "Voice check heard: $OUT"
fi

if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^SARA_VOICE_DIR=' "$ENV_FILE"; then
    sed -i "s#^SARA_VOICE_DIR=.*#SARA_VOICE_DIR=$VOICE_DIR#" "$ENV_FILE"
  else
    echo "SARA_VOICE_DIR=$VOICE_DIR" >> "$ENV_FILE"
    log "Added SARA_VOICE_DIR to $ENV_FILE"
  fi
fi
if systemctl is-active --quiet "$INSTANCE" 2>/dev/null; then systemctl restart "$INSTANCE"; log "Restarted $INSTANCE."; fi
[[ $LANGUAGES -eq 1 ]] && log "Words as you speak in Spanish, French, German, Portuguese and Italian installed (Talk uses your language)."
[[ $STREAMING -eq 1 ]] && log "Streaming hearing installed: Settings → Sara → Voice → Talk with Sara → Hearing while you talk."
log "Done. Pick her voice in Settings → Voice."
