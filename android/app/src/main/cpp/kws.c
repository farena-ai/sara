// C17: Hey Sara on Android, the keyword spotter. A tiny JNI shim (Sara's own) over sherpa-onnx's
// C API, the same calls and settings as the Windows app (desktop/windows/src/wake.cpp): int8
// zipformer transducer, 16 kHz, 80 features, one thread, the keyword lines from the server. The
// engine library is part of the signed APK (Google Play forbids downloaded native code) and opened
// with dlopen, so a build without it still runs (Talk only). Audio never leaves this file: samples
// are decoded and dropped; only a label ("W1".."W4", "STOP") goes back to Java.
#include <jni.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

#ifdef SARA_NO_KWS

JNIEXPORT jboolean JNICALL Java_com_backstagecoding_sara_Kws_nativeAvailable(JNIEnv* env, jclass cls) { return JNI_FALSE; }
JNIEXPORT jlong JNICALL Java_com_backstagecoding_sara_Kws_nativeOpen(JNIEnv* env, jclass cls, jstring dir, jstring keywords) { return 0; }
JNIEXPORT jstring JNICALL Java_com_backstagecoding_sara_Kws_nativeFeed(JNIEnv* env, jclass cls, jlong h, jfloatArray samples, jint n) { return NULL; }
JNIEXPORT void JNICALL Java_com_backstagecoding_sara_Kws_nativeClose(JNIEnv* env, jclass cls, jlong h) {}

#else
#include "sherpa-onnx/c-api/c-api.h"

typedef struct {
  void* lib;
  __typeof__(&SherpaOnnxCreateKeywordSpotter) create;
  __typeof__(&SherpaOnnxDestroyKeywordSpotter) destroy;
  __typeof__(&SherpaOnnxCreateKeywordStream) stream;
  __typeof__(&SherpaOnnxDestroyOnlineStream) destroyStream;
  __typeof__(&SherpaOnnxOnlineStreamAcceptWaveform) accept;
  __typeof__(&SherpaOnnxIsKeywordStreamReady) ready;
  __typeof__(&SherpaOnnxDecodeKeywordStream) decode;
  __typeof__(&SherpaOnnxGetKeywordResult) result;
  __typeof__(&SherpaOnnxDestroyKeywordResult) destroyResult;
  __typeof__(&SherpaOnnxResetKeywordStream) reset;
} Api;
static Api g_api;

static int load(void) {
  if (g_api.lib) return 1;
  void* m = dlopen("libsherpa-onnx-c-api.so", RTLD_NOW | RTLD_LOCAL);
  if (!m) return 0;
#define GET(f, name) g_api.f = (__typeof__(g_api.f))dlsym(m, name)
  GET(create, "SherpaOnnxCreateKeywordSpotter");
  GET(destroy, "SherpaOnnxDestroyKeywordSpotter");
  GET(stream, "SherpaOnnxCreateKeywordStream");
  GET(destroyStream, "SherpaOnnxDestroyOnlineStream");
  GET(accept, "SherpaOnnxOnlineStreamAcceptWaveform");
  GET(ready, "SherpaOnnxIsKeywordStreamReady");
  GET(decode, "SherpaOnnxDecodeKeywordStream");
  GET(result, "SherpaOnnxGetKeywordResult");
  GET(destroyResult, "SherpaOnnxDestroyKeywordResult");
  GET(reset, "SherpaOnnxResetKeywordStream");
#undef GET
  if (!g_api.create || !g_api.destroy || !g_api.stream || !g_api.destroyStream || !g_api.accept || !g_api.ready || !g_api.decode || !g_api.result || !g_api.destroyResult || !g_api.reset) {
    dlclose(m);
    memset(&g_api, 0, sizeof(g_api));
    return 0;
  }
  g_api.lib = m;
  return 1;
}

typedef struct {
  const SherpaOnnxKeywordSpotter* kws;
  const SherpaOnnxOnlineStream* stream;
  char *enc, *dec, *join, *tok, *keywords;
} Spotter;

static char* joinPath(const char* dir, const char* name) {
  size_t n = strlen(dir) + strlen(name) + 2;
  char* s = (char*)malloc(n);
  if (s) {
    strcpy(s, dir);
    strcat(s, "/");
    strcat(s, name);
  }
  return s;
}

static void freeSpotter(Spotter* sp) {
  if (!sp) return;
  if (sp->stream) g_api.destroyStream(sp->stream);
  if (sp->kws) g_api.destroy(sp->kws);
  free(sp->enc);
  free(sp->dec);
  free(sp->join);
  free(sp->tok);
  free(sp->keywords);
  free(sp);
}

JNIEXPORT jboolean JNICALL Java_com_backstagecoding_sara_Kws_nativeAvailable(JNIEnv* env, jclass cls) { return load() ? JNI_TRUE : JNI_FALSE; }

JNIEXPORT jlong JNICALL Java_com_backstagecoding_sara_Kws_nativeOpen(JNIEnv* env, jclass cls, jstring jdir, jstring jkeywords) {
  if (!load() || !jdir || !jkeywords) return 0;
  Spotter* sp = (Spotter*)calloc(1, sizeof(Spotter));
  if (!sp) return 0;
  const char* dir = (*env)->GetStringUTFChars(env, jdir, NULL);
  const char* kw = (*env)->GetStringUTFChars(env, jkeywords, NULL);
  sp->enc = joinPath(dir, "encoder.int8.onnx");
  sp->dec = joinPath(dir, "decoder.onnx");
  sp->join = joinPath(dir, "joiner.int8.onnx");
  sp->tok = joinPath(dir, "tokens.txt");
  sp->keywords = strdup(kw);
  (*env)->ReleaseStringUTFChars(env, jdir, dir);
  (*env)->ReleaseStringUTFChars(env, jkeywords, kw);
  if (!sp->enc || !sp->dec || !sp->join || !sp->tok || !sp->keywords) {
    freeSpotter(sp);
    return 0;
  }
  SherpaOnnxKeywordSpotterConfig c;
  memset(&c, 0, sizeof(c));
  c.feat_config.sample_rate = 16000;
  c.feat_config.feature_dim = 80;
  c.model_config.transducer.encoder = sp->enc;
  c.model_config.transducer.decoder = sp->dec;
  c.model_config.transducer.joiner = sp->join;
  c.model_config.tokens = sp->tok;
  c.model_config.num_threads = 1;
  c.model_config.provider = "cpu";
  c.max_active_paths = 4;
  c.num_trailing_blanks = 1;
  c.keywords_score = 1.5f;
  c.keywords_threshold = 0.25f;
  c.keywords_buf = sp->keywords;
  c.keywords_buf_size = (int32_t)strlen(sp->keywords);
  sp->kws = g_api.create(&c);
  if (sp->kws) sp->stream = g_api.stream(sp->kws);
  if (!sp->kws || !sp->stream) {
    freeSpotter(sp);
    return 0;
  }
  return (jlong)(intptr_t)sp;
}

/** Feeds 16 kHz mono samples in [-1, 1]; returns the label heard ("W1".."W4", "STOP") or null. */
JNIEXPORT jstring JNICALL Java_com_backstagecoding_sara_Kws_nativeFeed(JNIEnv* env, jclass cls, jlong h, jfloatArray samples, jint n) {
  Spotter* sp = (Spotter*)(intptr_t)h;
  if (!sp || !samples || n <= 0) return NULL;
  jfloat* s = (*env)->GetFloatArrayElements(env, samples, NULL);
  if (!s) return NULL;
  g_api.accept(sp->stream, 16000, s, n);
  (*env)->ReleaseFloatArrayElements(env, samples, s, JNI_ABORT);
  char label[16] = {0};
  while (g_api.ready(sp->kws, sp->stream)) {
    g_api.decode(sp->kws, sp->stream);
    const SherpaOnnxKeywordResult* r = g_api.result(sp->kws, sp->stream);
    if (r && r->keyword && r->keyword[0]) {
      strncpy(label, r->keyword, sizeof(label) - 1);
      g_api.reset(sp->kws, sp->stream);
    }
    if (r) g_api.destroyResult(r);
  }
  return label[0] ? (*env)->NewStringUTF(env, label) : NULL;
}

JNIEXPORT void JNICALL Java_com_backstagecoding_sara_Kws_nativeClose(JNIEnv* env, jclass cls, jlong h) { freeSpotter((Spotter*)(intptr_t)h); }
#endif
