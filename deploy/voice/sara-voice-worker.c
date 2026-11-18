// U5 (docs/VOICE_FIRST.md "Engines stay loaded"): one long-lived sherpa-onnx process per model, so
// hearing and her voice skip the ~0.7-1 s model load on every call. Built against the sherpa-onnx C
// API of the SAME release the voice bundle ships (the config structs change between releases):
//   cc -O2 -o sara-voice-worker sara-voice-worker.c -I<sherpa>/include -L<sherpa>/lib -lsherpa-onnx-c-api
// Protocol (one line per job; Sara's src/voice-warm.ts is the only client; nothing on the network):
//   sara-voice-worker stt <model.onnx> <tokens.txt> <threads>
//     stdin  "<file.wav>\n"                              stdout "ok <text>\n" | "err <why>\n"
//   sara-voice-worker tts <vits|kokoro> <model> <tokens> <dataDir> <voices|-> <threads>
//     stdin  "<sid>\t<speed>\t<out.wav>\t<text>\n"        stdout "ok <samples>\n" | "err <why>\n"
//   After loading it prints "ready\n" (or "fail <why>\n" and exits 2). EOF on stdin ends it.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "sherpa-onnx/c-api/c-api.h"

#define LINE 65536

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

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "stt") == 0) return stt(argc, argv);
  if (argc >= 2 && strcmp(argv[1], "tts") == 0) return tts(argc, argv);
  reply("fail", "usage: sara-voice-worker stt|tts ...");
  return 2;
}
