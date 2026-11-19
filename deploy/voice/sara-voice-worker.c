// U5 (docs/VOICE_FIRST.md "Engines stay loaded"): one long-lived sherpa-onnx process per model, so
// hearing and her voice skip the ~0.7-1 s model load on every call. Built against the sherpa-onnx C
// API of the SAME release the voice bundle ships (the config structs change between releases):
//   cc -O2 -o sara-voice-worker sara-voice-worker.c -I<sherpa>/include -L<sherpa>/lib -lsherpa-onnx-c-api
// Protocol (one line per job; Sara's src/voice-warm.ts is the only client; nothing on the network):
//   sara-voice-worker stt <model.onnx> <tokens.txt> <threads>
//     stdin  "<file.wav>\n"                              stdout "ok <text>\n" | "err <why>\n"
//   sara-voice-worker tts <vits|kokoro> <model> <tokens> <dataDir> <voices|-> <threads>
//     stdin  "<sid>\t<speed>\t<out.wav>\t<text>\n"        stdout "ok <samples>\n" | "err <why>\n"
//   sara-voice-worker online <encoder> <decoder> <joiner> <tokens> <threads> <trailingSilenceSec>
//     V0.2 streaming hearing (a sherpa-onnx online transducer): words while you speak. Up to 8 streams.
//     stdin  "a <id> <base64 PCM16 16 kHz mono>\n"  stdout "ok <endpoint 0|1> <text so far>\n"
//     stdin  "e <id> <base64|->\n" (last piece)    stdout "ok 1 <final text>\n" (the stream is freed)
//     stdin  "x <id>\n" (drop it)                  stdout "ok 0 \n"
//     W0.3: "<id>@<lang>" (e.g. s1@es, s1@auto) sets a NEW stream's language for prompt-conditioned
//     multilingual models (Nemotron 3.5 streaming); later lines may send the same form or just <id>.
//   After loading it prints "ready\n" (or "fail <why>\n" and exits 2). EOF on stdin ends it.
// Release builds (V0.1): desktop/windows/build-voice-helper.sh (MSVC), desktop/mac/build.sh (clang,
// universal); Linux servers build it in deploy/install-voice.sh. Each against the pinned sherpa-onnx.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

#define LINE 262144

static void reply(const char *kind, const char *msg) {
  fputs(kind, stdout);
  fputc(' ', stdout);
  for (const char *p = msg; p && *p; ++p) fputc(*p == '\n' || *p == '\r' ? ' ' : *p, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static char *chomp(char *s) {
  size_t n = strlen(s);
  while (n && (s[n - 1] == '\n' || s[n - 1] == '\r')) s[--n] = 0;
  return s;
}

static int stt(int argc, char **argv) {
  if (argc < 5) { reply("fail", "usage: stt model tokens threads"); return 2; }
  SherpaOnnxOfflineRecognizerConfig c;
  memset(&c, 0, sizeof(c));
  c.feat_config.sample_rate = 16000;
  c.feat_config.feature_dim = 80;
  c.model_config.nemo_ctc.model = argv[2];
  c.model_config.tokens = argv[3];
  c.model_config.num_threads = atoi(argv[4]);
  c.model_config.provider = "cpu";
  c.decoding_method = "greedy_search";
  const SherpaOnnxOfflineRecognizer *r = SherpaOnnxCreateOfflineRecognizer(&c);
  if (!r) { reply("fail", "model did not load"); return 2; }
  fputs("ready\n", stdout);
  fflush(stdout);
  static char line[LINE];
  while (fgets(line, sizeof(line), stdin)) {
    chomp(line);
    if (!*line) continue;
    const SherpaOnnxWave *w = SherpaOnnxReadWave(line);
    if (!w) { reply("err", "could not read the wav"); continue; }
    const SherpaOnnxOfflineStream *s = SherpaOnnxCreateOfflineStream(r);
    SherpaOnnxAcceptWaveformOffline(s, w->sample_rate, w->samples, w->num_samples);
    SherpaOnnxDecodeOfflineStream(r, s);
    const SherpaOnnxOfflineRecognizerResult *res = SherpaOnnxGetOfflineStreamResult(s);
    reply("ok", res && res->text ? res->text : "");
    if (res) SherpaOnnxDestroyOfflineRecognizerResult(res);
    SherpaOnnxDestroyOfflineStream(s);
    SherpaOnnxFreeWave(w);
  }
  SherpaOnnxDestroyOfflineRecognizer(r);
  return 0;
}

static int tts(int argc, char **argv) {
  if (argc < 8) { reply("fail", "usage: tts kind model tokens dataDir voices threads"); return 2; }
  SherpaOnnxOfflineTtsConfig c;
  memset(&c, 0, sizeof(c));
  int kokoro = strcmp(argv[2], "kokoro") == 0;
  if (kokoro) {
    c.model.kokoro.model = argv[3];
    c.model.kokoro.tokens = argv[4];
    c.model.kokoro.data_dir = argv[5];
    c.model.kokoro.voices = argv[6];
    c.model.kokoro.length_scale = 1.0f;
  } else {
    c.model.vits.model = argv[3];
    c.model.vits.tokens = argv[4];
    c.model.vits.data_dir = argv[5];
    c.model.vits.noise_scale = 0.667f;
    c.model.vits.noise_scale_w = 0.8f;
    c.model.vits.length_scale = 1.0f;
  }
  c.model.num_threads = atoi(argv[7]);
  c.model.provider = "cpu";
  c.max_num_sentences = 1;
  const SherpaOnnxOfflineTts *t = SherpaOnnxCreateOfflineTts(&c);
  if (!t) { reply("fail", "voice did not load"); return 2; }
  fputs("ready\n", stdout);
  fflush(stdout);
  static char line[LINE];
  while (fgets(line, sizeof(line), stdin)) {
    chomp(line);
    char *sid = line, *speed = strchr(sid, '\t'), *out = speed ? strchr(speed + 1, '\t') : NULL, *text = out ? strchr(out + 1, '\t') : NULL;
    if (!text) { reply("err", "bad request"); continue; }
    *speed++ = 0; *out++ = 0; *text++ = 0;
    const SherpaOnnxGeneratedAudio *a = SherpaOnnxOfflineTtsGenerate(t, text, atoi(sid), (float)atof(speed));
    if (!a || a->n <= 0) { reply("err", "no audio"); if (a) SherpaOnnxDestroyOfflineTtsGeneratedAudio(a); continue; }
    if (!SherpaOnnxWriteWave(a->samples, a->n, a->sample_rate, out)) reply("err", "could not write the wav");
    else { char n[32]; snprintf(n, sizeof(n), "%d", a->n); reply("ok", n); }
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(a);
  }
  SherpaOnnxDestroyOfflineTts(t);
  return 0;
}

// ---- V0.2: streaming (online) hearing ----

static int b64v(int c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

// Decodes base64 PCM16 into floats; returns the sample count.
static int pcm16(const char *b64, float *out, int max) {
  int bits = 0, nbits = 0, lo = -1, n = 0;
  for (const char *p = b64; *p && n < max; ++p) {
    int v = b64v((unsigned char)*p);
    if (v < 0) continue;
    bits = (bits << 6) | v;
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      int byte = (bits >> nbits) & 0xff;
      if (lo < 0) lo = byte;
      else {
        short s = (short)(lo | (byte << 8));
        out[n++] = s / 32768.0f;
        lo = -1;
      }
    }
  }
  return n;
}

#define STREAMS 8
static struct { char id[48]; const SherpaOnnxOnlineStream *s; unsigned long used; } slots[STREAMS];
static unsigned long tick = 0;

static int slot(const SherpaOnnxOnlineRecognizer *r, const char *id, const char *lang, int create) {
  int free = -1, old = 0;
  for (int i = 0; i < STREAMS; ++i) {
    if (slots[i].s && strcmp(slots[i].id, id) == 0) return slots[i].used = ++tick, i;
    if (!slots[i].s && free < 0) free = i;
    if (slots[i].used < slots[old].used) old = i;
  }
  if (!create) return -1;
  if (free < 0) { SherpaOnnxDestroyOnlineStream(slots[old].s); slots[old].s = NULL; free = old; }
  snprintf(slots[free].id, sizeof(slots[free].id), "%s", id);
  slots[free].s = SherpaOnnxCreateOnlineStream(r);
  if (slots[free].s && lang && *lang) {
    SherpaOnnxOnlineStreamSetOption(slots[free].s, "language", lang);
    // W0.3 (measured): the multilingual model drops the first word or two unless ~0.6 s of quiet comes
    // first; the page's pre-roll is shorter, so every language-tagged stream starts with 1 s of it.
    static float lead[16000];
    SherpaOnnxOnlineStreamAcceptWaveform(slots[free].s, 16000, lead, 16000);
  }
  slots[free].used = ++tick;
  return slots[free].s ? free : -1;
}

static void answer(const SherpaOnnxOnlineRecognizer *r, const SherpaOnnxOnlineStream *s, int ended) {
  while (SherpaOnnxIsOnlineStreamReady(r, s)) SherpaOnnxDecodeOnlineStream(r, s);
  const SherpaOnnxOnlineRecognizerResult *res = SherpaOnnxGetOnlineStreamResult(r, s);
  const char *text = res && res->text ? res->text : "";
  size_t n = strlen(text) + 4;
  char *msg = (char *)malloc(n);
  if (!msg) { reply("err", "out of memory"); return; }
  snprintf(msg, n, "%d %s", ended || SherpaOnnxOnlineStreamIsEndpoint(r, s) ? 1 : 0, text);
  reply("ok", msg);
  free(msg);
  if (res) SherpaOnnxDestroyOnlineRecognizerResult(res);
}

static int online(int argc, char **argv) {
  if (argc < 8) { reply("fail", "usage: online encoder decoder joiner tokens threads silence"); return 2; }
  SherpaOnnxOnlineRecognizerConfig c;
  memset(&c, 0, sizeof(c));
  c.feat_config.sample_rate = 16000;
  c.feat_config.feature_dim = 80;
  c.model_config.transducer.encoder = argv[2];
  c.model_config.transducer.decoder = argv[3];
  c.model_config.transducer.joiner = argv[4];
  c.model_config.tokens = argv[5];
  c.model_config.num_threads = atoi(argv[6]);
  c.model_config.provider = "cpu";
  c.decoding_method = "greedy_search";
  c.enable_endpoint = 1;
  c.rule1_min_trailing_silence = 2.4f;
  c.rule2_min_trailing_silence = (float)atof(argv[7]);
  c.rule3_min_utterance_length = 30.0f;
  const SherpaOnnxOnlineRecognizer *r = SherpaOnnxCreateOnlineRecognizer(&c);
  if (!r) { reply("fail", "model did not load"); return 2; }
  fputs("ready\n", stdout);
  fflush(stdout);
  static char line[LINE];
  static float samples[LINE];
  while (fgets(line, sizeof(line), stdin)) {
    chomp(line);
    char *id = strchr(line, ' ');
    if (!id || (line[0] != 'a' && line[0] != 'e' && line[0] != 'x')) { reply("err", "bad request"); continue; }
    *id++ = 0;
    char *b64 = strchr(id, ' ');
    if (b64) *b64++ = 0;
    char *lang = strchr(id, '@');
    if (lang) *lang++ = 0;
    if (!*id || strlen(id) > 40 || (lang && strlen(lang) > 15)) { reply("err", "bad request"); continue; }
    if (line[0] == 'x') {
      int i = slot(r, id, NULL, 0);
      if (i >= 0) { SherpaOnnxDestroyOnlineStream(slots[i].s); slots[i].s = NULL; }
      reply("ok", "0 ");
      continue;
    }
    int i = slot(r, id, lang, 1);
    if (i < 0) { reply("err", "no stream"); continue; }
    const SherpaOnnxOnlineStream *s = slots[i].s;
    int n = b64 && strcmp(b64, "-") ? pcm16(b64, samples, LINE) : 0;
    if (n > 0) SherpaOnnxOnlineStreamAcceptWaveform(s, 16000, samples, n);
    if (line[0] == 'e') {
      // A little silence lets the last word out of the model's look-ahead before the stream ends.
      static float tail[4800];
      SherpaOnnxOnlineStreamAcceptWaveform(s, 16000, tail, 4800);
      SherpaOnnxOnlineStreamInputFinished(s);
      answer(r, s, 1);
      SherpaOnnxDestroyOnlineStream(s);
      slots[i].s = NULL;
    } else answer(r, s, 0);
  }
  for (int i = 0; i < STREAMS; ++i) if (slots[i].s) SherpaOnnxDestroyOnlineStream(slots[i].s);
  SherpaOnnxDestroyOnlineRecognizer(r);
  return 0;
}

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "stt") == 0) return stt(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "tts") == 0) return tts(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "online") == 0) return online(argc, argv);
  reply("fail", "usage: sara-voice-worker stt|tts|online ...");
  return 2;
}
