// V5.6 (docs/design/V5_PHONE_MODEL.md): short answers from a small model on the phone while the
// server is away. Sara's own tiny JNI shim over llama.cpp's C API (MIT, pinned b12528 by
// ../../../../fetch-llm-libs.sh). The engine libraries are part of the signed APK (Google Play
// forbids downloaded native code) and opened with dlopen, so a build without them still runs: the
// feature then says "not on this phone". Only the model file (data) is downloaded, by LocalModel.java.
#include <jni.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

#ifdef SARA_NO_LLM

JNIEXPORT jboolean JNICALL Java_com_backstagecoding_sara_LocalModel_nativeAvailable(JNIEnv* env, jclass cls, jstring libDir) { return JNI_FALSE; }
JNIEXPORT jlong JNICALL Java_com_backstagecoding_sara_LocalModel_nativeOpen(JNIEnv* env, jclass cls, jstring path, jint nCtx, jint threads) { return 0; }
JNIEXPORT jbyteArray JNICALL Java_com_backstagecoding_sara_LocalModel_nativeAsk(JNIEnv* env, jclass cls, jlong h, jobjectArray roles, jobjectArray texts, jint maxTokens) { return NULL; }
JNIEXPORT void JNICALL Java_com_backstagecoding_sara_LocalModel_nativeCancel(JNIEnv* env, jclass cls, jlong h) {}
JNIEXPORT void JNICALL Java_com_backstagecoding_sara_LocalModel_nativeClose(JNIEnv* env, jclass cls, jlong h) {}

#else
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#include "llama.h"
#include "ggml-backend.h"

typedef struct {
  void* lib;
  __typeof__(&llama_backend_init) backend_init;
  __typeof__(&llama_model_default_params) model_params;
  __typeof__(&llama_model_load_from_file) load;
  __typeof__(&llama_model_free) model_free;
  __typeof__(&llama_context_default_params) ctx_params;
  __typeof__(&llama_init_from_model) init;
  __typeof__(&llama_free) free_ctx;
  __typeof__(&llama_get_memory) memory;
  __typeof__(&llama_memory_clear) memory_clear;
  __typeof__(&llama_model_get_vocab) vocab;
  __typeof__(&llama_model_chat_template) template_of;
  __typeof__(&llama_chat_apply_template) apply_template;
  __typeof__(&llama_tokenize) tokenize;
  __typeof__(&llama_batch_get_one) batch_one;
  __typeof__(&llama_decode) decode;
  __typeof__(&llama_n_ctx) n_ctx;
  __typeof__(&llama_sampler_chain_default_params) chain_params;
  __typeof__(&llama_sampler_chain_init) chain;
  __typeof__(&llama_sampler_chain_add) chain_add;
  __typeof__(&llama_sampler_init_min_p) min_p;
  __typeof__(&llama_sampler_init_temp) temp;
  __typeof__(&llama_sampler_init_dist) dist;
  __typeof__(&llama_sampler_sample) sample;
  __typeof__(&llama_sampler_free) sampler_free;
  __typeof__(&llama_vocab_is_eog) is_eog;
  __typeof__(&llama_token_to_piece) piece;
} Api;
static Api g;

typedef struct {
  struct llama_model* model;
  struct llama_context* ctx;
  volatile int cancel;
} Handle;

static int load(const char* libDir) {
  if (g.lib) return 1;
  void* m = dlopen("libllama.so", RTLD_NOW | RTLD_LOCAL);
  if (!m) return 0;
#define GET(f, name) g.f = (__typeof__(g.f))dlsym(m, name)
  GET(backend_init, "llama_backend_init");
  GET(model_params, "llama_model_default_params");
  GET(load, "llama_model_load_from_file");
  GET(model_free, "llama_model_free");
  GET(ctx_params, "llama_context_default_params");
  GET(init, "llama_init_from_model");
  GET(free_ctx, "llama_free");
  GET(memory, "llama_get_memory");
  GET(memory_clear, "llama_memory_clear");
  GET(vocab, "llama_model_get_vocab");
  GET(template_of, "llama_model_chat_template");
  GET(apply_template, "llama_chat_apply_template");
  GET(tokenize, "llama_tokenize");
  GET(batch_one, "llama_batch_get_one");
  GET(decode, "llama_decode");
  GET(n_ctx, "llama_n_ctx");
  GET(chain_params, "llama_sampler_chain_default_params");
  GET(chain, "llama_sampler_chain_init");
  GET(chain_add, "llama_sampler_chain_add");
  GET(min_p, "llama_sampler_init_min_p");
  GET(temp, "llama_sampler_init_temp");
  GET(dist, "llama_sampler_init_dist");
  GET(sample, "llama_sampler_sample");
  GET(sampler_free, "llama_sampler_free");
  GET(is_eog, "llama_vocab_is_eog");
  GET(piece, "llama_token_to_piece");
#undef GET
  void** all = (void**)&g.backend_init;
  for (size_t i = 0; i < (sizeof(Api) - sizeof(void*)) / sizeof(void*); i++)
    if (!all[i]) return 0;
  // The official Android build picks its CPU variant at run time (libggml-cpu-android_*.so next to
  // the app's other libraries); an x86_64 emulator build has the CPU code inside libggml.
  void* gg = dlopen("libggml.so", RTLD_NOW | RTLD_LOCAL);
  void (*load_all)(const char*) = gg ? (void (*)(const char*))dlsym(gg, "ggml_backend_load_all_from_path") : NULL;
  if (load_all && libDir) load_all(libDir);
  g.backend_init();
  g.lib = m;
  return 1;
}

JNIEXPORT jboolean JNICALL Java_com_backstagecoding_sara_LocalModel_nativeAvailable(JNIEnv* env, jclass cls, jstring libDir) {
  const char* d = libDir ? (*env)->GetStringUTFChars(env, libDir, NULL) : NULL;
  int ok = load(d);
  if (d) (*env)->ReleaseStringUTFChars(env, libDir, d);
  return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jlong JNICALL Java_com_backstagecoding_sara_LocalModel_nativeOpen(JNIEnv* env, jclass cls, jstring path, jint nCtx, jint threads) {
  if (!g.lib) return 0;
  const char* p = (*env)->GetStringUTFChars(env, path, NULL);
  struct llama_model_params mp = g.model_params();
  mp.n_gpu_layers = 0;
  struct llama_model* model = g.load(p, mp);
  (*env)->ReleaseStringUTFChars(env, path, p);
  if (!model) return 0;
  struct llama_context_params cp = g.ctx_params();
  cp.n_ctx = (uint32_t)nCtx;
  cp.n_batch = (uint32_t)nCtx;
  cp.n_threads = threads;
  cp.n_threads_batch = threads;
  struct llama_context* ctx = g.init(model, cp);
  if (!ctx) {
    g.model_free(model);
    return 0;
  }
  Handle* h = calloc(1, sizeof(Handle));
  h->model = model;
  h->ctx = ctx;
  return (jlong)(intptr_t)h;
}

JNIEXPORT void JNICALL Java_com_backstagecoding_sara_LocalModel_nativeCancel(JNIEnv* env, jclass cls, jlong hp) {
  Handle* h = (Handle*)(intptr_t)hp;
  if (h) h->cancel = 1;
}

/** One answer (UTF-8 bytes): the chat through the model's own template, then up to maxTokens tokens. */
JNIEXPORT jbyteArray JNICALL Java_com_backstagecoding_sara_LocalModel_nativeAsk(JNIEnv* env, jclass cls, jlong hp, jobjectArray roles, jobjectArray texts, jint maxTokens) {
  Handle* h = (Handle*)(intptr_t)hp;
  if (!h) return NULL;
  h->cancel = 0;
  jsize n = (*env)->GetArrayLength(env, roles);
  llama_chat_message* msgs = calloc((size_t)n, sizeof(llama_chat_message));
  jstring* js = calloc((size_t)n * 2, sizeof(jstring));
  size_t total = 0;
  for (jsize i = 0; i < n; i++) {
    js[2 * i] = (jstring)(*env)->GetObjectArrayElement(env, roles, i);
    js[2 * i + 1] = (jstring)(*env)->GetObjectArrayElement(env, texts, i);
    msgs[i].role = (*env)->GetStringUTFChars(env, js[2 * i], NULL);
    msgs[i].content = (*env)->GetStringUTFChars(env, js[2 * i + 1], NULL);
    total += strlen(msgs[i].content) + 64;
  }
  const char* tmpl = g.template_of(h->model, NULL);
  int32_t cap = (int32_t)(total * 2 + 256);
  char* prompt = malloc((size_t)cap);
  int32_t len = g.apply_template(tmpl, msgs, (size_t)n, true, prompt, cap);
  if (len > cap) {
    prompt = realloc(prompt, (size_t)len + 1);
    len = g.apply_template(tmpl, msgs, (size_t)n, true, prompt, len + 1);
  }
  for (jsize i = 0; i < n; i++) {
    (*env)->ReleaseStringUTFChars(env, js[2 * i], msgs[i].role);
    (*env)->ReleaseStringUTFChars(env, js[2 * i + 1], msgs[i].content);
    (*env)->DeleteLocalRef(env, js[2 * i]);
    (*env)->DeleteLocalRef(env, js[2 * i + 1]);
  }
  free(js);
  free(msgs);
  if (len < 0) {
    free(prompt);
    return NULL;
  }
  const struct llama_vocab* vocab = g.vocab(h->model);
  int32_t room = (int32_t)g.n_ctx(h->ctx);
  llama_token* toks = malloc(sizeof(llama_token) * (size_t)room);
  int32_t nt = g.tokenize(vocab, prompt, len, toks, room, true, true);
  free(prompt);
  if (nt < 0 || nt + maxTokens > room) {
    free(toks);
    return NULL;
  }
  g.memory_clear(g.memory(h->ctx), true);
  struct llama_sampler* s = g.chain(g.chain_params());
  g.chain_add(s, g.min_p(0.05f, 1));
  g.chain_add(s, g.temp(0.6f));
  g.chain_add(s, g.dist(0xFFFFFFFFu));
  size_t outCap = 4096, outLen = 0;
  char* out = malloc(outCap);
  int ok = g.decode(h->ctx, g.batch_one(toks, nt)) == 0;
  for (int i = 0; ok && i < maxTokens && !h->cancel; i++) {
    llama_token t = g.sample(s, h->ctx, -1);
    if (g.is_eog(vocab, t)) break;
    char buf[256];
    int32_t pn = g.piece(vocab, t, buf, sizeof buf, 0, false);
    if (pn > 0) {
      if (outLen + (size_t)pn + 1 > outCap) out = realloc(out, outCap *= 2);
      memcpy(out + outLen, buf, (size_t)pn);
      outLen += (size_t)pn;
    }
    ok = g.decode(h->ctx, g.batch_one(&t, 1)) == 0;
  }
  g.sampler_free(s);
  free(toks);
  out[outLen] = 0;
  // Bytes, not NewStringUTF: the model may write any UTF-8 (emoji), which JNI's modified UTF-8 refuses.
  jbyteArray r = NULL;
  if ((ok || outLen) && !h->cancel) {
    r = (*env)->NewByteArray(env, (jsize)outLen);
    if (r) (*env)->SetByteArrayRegion(env, r, 0, (jsize)outLen, (const jbyte*)out);
  }
  free(out);
  return r;
}

JNIEXPORT void JNICALL Java_com_backstagecoding_sara_LocalModel_nativeClose(JNIEnv* env, jclass cls, jlong hp) {
  Handle* h = (Handle*)(intptr_t)hp;
  if (!h) return;
  g.free_ctx(h->ctx);
  g.model_free(h->model);
  free(h);
}
#endif
