// Phase 126 (docs/design/WAKE.md §4, §6.1): Hey Sara on Windows. See wake.h.
// - The pack: the files and SHA-256s below are the same as src/wake-pack.ts (one list, checked by
//   test/phase126.test.ts against this file). The engine DLL is loaded by full path only after every
//   file matched, with the pack folder as the only extra DLL folder (never the PATH).
// - Capture: WASAPI shared mode with Windows converting to 16 kHz mono float. The device is opened only
//   while listening and closed on stop (Windows' microphone-in-use icon follows it).
// - Nothing before the phrase is kept: samples go to the detector and are dropped; the recording
//   starts after the detection.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "wake.h"

#include <audioclient.h>
#include <bcrypt.h>
#include <propidl.h>
#include <propkeydef.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <mmsystem.h>
#include <shlobj.h>
#include <winhttp.h>
#include <wrl/client.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <mutex>
#include <thread>

#include "sherpa-onnx/c-api/c-api.h"

#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "winhttp.lib")

using Microsoft::WRL::ComPtr;

namespace sarawake {

struct PackFile {
  const wchar_t* name;
  long long size;
  const char* sha256;
  const char* inTar;
  int tar;  // 0: model, 1: engine
};
#define MODEL_DIR "sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20/"
#define ENGINE_DIR "sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts/lib/"
static const PackFile kFiles[] = {
    {L"encoder.int8.onnx", 4599656, "408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48", MODEL_DIR "encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx", 0},
    {L"decoder.onnx", 759829, "63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21", MODEL_DIR "decoder-epoch-13-avg-2-chunk-16-left-64.onnx", 0},
    {L"joiner.int8.onnx", 86629, "190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1", MODEL_DIR "joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx", 0},
    {L"tokens.txt", 1928, "2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0", MODEL_DIR "tokens.txt", 0},
    {L"sherpa-onnx-c-api.dll", 2882048, "5616605dc07ffbcf1cd6a001c2c76e826b9e1710e0fe17dfc3412de3a28df6a5", ENGINE_DIR "sherpa-onnx-c-api.dll", 1},
    {L"onnxruntime.dll", 17136128, "422d776ab0e3218260f7f628fcb84606aaa5c21116f720c8619a6da5e0b2e0f9", ENGINE_DIR "onnxruntime.dll", 1},
    {L"onnxruntime_providers_shared.dll", 10752, "0190137dee4933261c065c5d030c3568a68c7aa43cad942b4726a07011738bc2", ENGINE_DIR "onnxruntime_providers_shared.dll", 1},
};
struct Tarball {
  const wchar_t* host;
  const wchar_t* path;
  long long size;
  const char* sha256;
};
static const Tarball kTars[] = {
    {L"github.com", L"/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2", 32885699, "68447f4fbc67e70eee3a93961f36e81e98f47aef73ce7e7ca00885c6cd3616a6"},
    {L"github.com", L"/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release-no-tts.tar.bz2", 19164933, "876e6b89b8cf84a3a1b375a397507f2cfe9c227c2a945411a11a668475fcb5d3"},
};

long long packDownloadBytes() { return kTars[0].size + kTars[1].size; }

std::wstring packDir() {
  wchar_t* p = nullptr;
  std::wstring out;
  if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &p))) out = std::wstring(p) + L"\\Sara\\wake\\1";
  CoTaskMemFree(p);
  return out;
}

static std::string sha256File(const std::wstring& path) {
  HANDLE f = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, nullptr);
  if (f == INVALID_HANDLE_VALUE) return "";
  BCRYPT_ALG_HANDLE alg = nullptr;
  BCRYPT_HASH_HANDLE h = nullptr;
  std::string hex;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0 && BCryptCreateHash(alg, &h, nullptr, 0, nullptr, 0, 0) == 0) {
    std::vector<unsigned char> buf(1 << 20);
    DWORD n = 0;
    while (ReadFile(f, buf.data(), (DWORD)buf.size(), &n, nullptr) && n) BCryptHashData(h, buf.data(), n, 0);
    unsigned char d[32];
    if (BCryptFinishHash(h, d, 32, 0) == 0) {
      static const char* x = "0123456789abcdef";
      for (unsigned char c : d) {
        hex += x[c >> 4];
        hex += x[c & 15];
      }
    }
  }
  if (h) BCryptDestroyHash(h);
  if (alg) BCryptCloseAlgorithmProvider(alg, 0);
  CloseHandle(f);
  return hex;
}

bool packReady(const std::wstring& dir, std::wstring* why) {
  for (const auto& f : kFiles) {
    std::wstring p = dir + L"\\" + f.name;
    if (sha256File(p) != f.sha256) {
      if (why) *why = std::wstring(L"pack file missing or changed: ") + f.name;
      return false;
    }
  }
  return true;
}

static bool download(const Tarball& t, const std::wstring& dest, const std::function<void(long long)>& got, std::wstring& error) {
  HINTERNET s = WinHttpOpen(L"Sara/2.59 (Hey Sara pack)", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) return error = L"no network", false;
  DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
  WinHttpSetOption(s, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));
  std::wstring host = t.host, path = t.path;
  bool ok = false;
  for (int hop = 0; hop < 5 && !ok; hop++) {
    HINTERNET c = WinHttpConnect(s, host.c_str(), INTERNET_DEFAULT_HTTPS_PORT, 0);
    HINTERNET r = c ? WinHttpOpenRequest(c, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE) : nullptr;
    if (r && WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) && WinHttpReceiveResponse(r, nullptr)) {
      DWORD status = 0, len = sizeof(status);
      WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &len, WINHTTP_NO_HEADER_INDEX);
      if (status == 200) {
        std::ofstream out(dest, std::ios::binary);
        std::vector<char> buf(1 << 16);
        long long total = 0;
        DWORD n = 0;
        while (WinHttpReadData(r, buf.data(), (DWORD)buf.size(), &n) && n) {
          out.write(buf.data(), n);
          total += n;
          got(total);
        }
        ok = out.good() && total == t.size;
        if (!ok) error = L"the download was cut short";
      } else error = L"HTTP " + std::to_wstring(status);
    } else error = L"no connection to " + host;
    if (r) WinHttpCloseHandle(r);
    if (c) WinHttpCloseHandle(c);
    break;
  }
  WinHttpCloseHandle(s);
  return ok;
}

static bool runTar(const std::wstring& tarFile, const std::wstring& into, const std::vector<std::string>& members) {
  wchar_t sys[MAX_PATH];
  GetSystemDirectoryW(sys, MAX_PATH);
  std::wstring cmd = L"\"" + std::wstring(sys) + L"\\tar.exe\" -xjf \"" + tarFile + L"\" -C \"" + into + L"\"";
  for (const auto& m : members) cmd += L" \"" + std::wstring(m.begin(), m.end()) + L"\"";
  STARTUPINFOW si{sizeof(si)};
  PROCESS_INFORMATION pi{};
  if (!CreateProcessW(nullptr, cmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) return false;
  WaitForSingleObject(pi.hProcess, 120000);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return code == 0;
}

static void removeTree(const std::wstring& dir) {
  std::wstring from = dir + L'\0';
  SHFILEOPSTRUCTW op{};
  op.wFunc = FO_DELETE;
  op.pFrom = from.c_str();
  op.fFlags = FOF_NO_UI;
  SHFileOperationW(&op);
}

bool installPack(std::wstring& error, const std::function<void(int)>& progress) {
  std::wstring dir = packDir();
  if (dir.empty()) return error = L"no app data folder", false;
  if (packReady(dir)) return true;
  SHCreateDirectoryExW(nullptr, dir.c_str(), nullptr);
  std::wstring tmp = dir + L"\\.download";
  removeTree(tmp);
  CreateDirectoryW(tmp.c_str(), nullptr);
  long long done = 0, all = packDownloadBytes();
  bool ok = true;
  for (int i = 0; i < 2 && ok; i++) {
    std::wstring file = tmp + (i ? L"\\engine.tar.bz2" : L"\\model.tar.bz2");
    long long before = done;
    ok = download(kTars[i], file, [&](long long n) { progress((int)((before + n) * 90 / all)); }, error);
    done += kTars[i].size;
    if (ok && sha256File(file) != kTars[i].sha256) {
      ok = false;
      error = L"The download didn't match what Sara expects, so it wasn't kept. Try again later.";
    }
    if (ok) {
      std::vector<std::string> members;
      for (const auto& f : kFiles) if (f.tar == i) members.push_back(f.inTar);
      ok = runTar(file, tmp, members);
      if (!ok) error = L"unpacking failed (tar.exe)";
    }
    DeleteFileW(file.c_str());
  }
  if (ok) {
    for (const auto& f : kFiles) {
      std::string in = f.inTar;
      std::wstring src = tmp + L"\\" + std::wstring(in.begin(), in.end());
      for (auto& ch : src) if (ch == L'/') ch = L'\\';
      std::wstring dst = dir + L"\\" + f.name;
      if (sha256File(src) != f.sha256 || !MoveFileExW(src.c_str(), dst.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        ok = false;
        error = L"The download didn't match what Sara expects, so it wasn't kept. Try again later.";
        break;
      }
    }
  }
  removeTree(tmp);
  if (!ok) {
    for (const auto& f : kFiles) DeleteFileW((dir + L"\\" + f.name).c_str());
    return false;
  }
  progress(100);
  return packReady(dir, &error);
}

void removePack() {
  stop();
  std::wstring dir = packDir();
  if (!dir.empty()) removeTree(dir);
}

// ---------------- the engine ----------------

struct Api {
  HMODULE dll = nullptr;
  decltype(&SherpaOnnxCreateKeywordSpotter) create = nullptr;
  decltype(&SherpaOnnxDestroyKeywordSpotter) destroy = nullptr;
  decltype(&SherpaOnnxCreateKeywordStream) stream = nullptr;
  decltype(&SherpaOnnxDestroyOnlineStream) destroyStream = nullptr;
  decltype(&SherpaOnnxOnlineStreamAcceptWaveform) accept = nullptr;
  decltype(&SherpaOnnxIsKeywordStreamReady) ready = nullptr;
  decltype(&SherpaOnnxDecodeKeywordStream) decode = nullptr;
  decltype(&SherpaOnnxGetKeywordResult) result = nullptr;
  decltype(&SherpaOnnxDestroyKeywordResult) destroyResult = nullptr;
  decltype(&SherpaOnnxResetKeywordStream) reset = nullptr;
};
static Api g_api;

static bool loadEngine(const std::wstring& dir, std::wstring& error) {
  if (g_api.dll) return true;
  if (!packReady(dir, &error)) return false;  // every file checked before anything loads
  SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
  DLL_DIRECTORY_COOKIE cookie = AddDllDirectory(dir.c_str());
  HMODULE m = LoadLibraryExW((dir + L"\\sherpa-onnx-c-api.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (cookie) RemoveDllDirectory(cookie);
  if (!m) return error = L"the engine didn't load (" + std::to_wstring(GetLastError()) + L")", false;
#define GET(field, name) g_api.field = reinterpret_cast<decltype(g_api.field)>(GetProcAddress(m, name))
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
    FreeLibrary(m);
    g_api = {};
    return error = L"the engine is missing a function", false;
  }
  g_api.dll = m;
  return true;
}

struct Spotter {
  const SherpaOnnxKeywordSpotter* kws = nullptr;
  const SherpaOnnxOnlineStream* stream = nullptr;
  std::string enc, dec, join, tok, keywords;
};

static bool makeSpotter(Spotter& sp, const std::wstring& dir, const std::string& keywords) {
  auto u8 = [](const std::wstring& w) {
    std::string s(WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), -1, s.data(), (int)s.size(), nullptr, nullptr);
    if (!s.empty() && s.back() == '\0') s.pop_back();
    return s;
  };
  sp.enc = u8(dir + L"\\encoder.int8.onnx");
  sp.dec = u8(dir + L"\\decoder.onnx");
  sp.join = u8(dir + L"\\joiner.int8.onnx");
  sp.tok = u8(dir + L"\\tokens.txt");
  sp.keywords = keywords;
  SherpaOnnxKeywordSpotterConfig c;
  memset(&c, 0, sizeof(c));
  c.feat_config.sample_rate = 16000;
  c.feat_config.feature_dim = 80;
  c.model_config.transducer.encoder = sp.enc.c_str();
  c.model_config.transducer.decoder = sp.dec.c_str();
  c.model_config.transducer.joiner = sp.join.c_str();
  c.model_config.tokens = sp.tok.c_str();
  c.model_config.num_threads = 1;
  c.model_config.provider = "cpu";
  c.max_active_paths = 4;
  c.num_trailing_blanks = 1;
  c.keywords_score = 1.5f;
  c.keywords_threshold = 0.25f;
  c.keywords_buf = sp.keywords.c_str();
  c.keywords_buf_size = (int32_t)sp.keywords.size();
  sp.kws = g_api.create(&c);
  if (!sp.kws) return false;
  sp.stream = g_api.stream(sp.kws);
  return sp.stream != nullptr;
}
static void freeSpotter(Spotter& sp) {
  if (sp.stream) g_api.destroyStream(sp.stream);
  if (sp.kws) g_api.destroy(sp.kws);
  sp.stream = nullptr;
  sp.kws = nullptr;
}
/** Feeds samples; returns the label of a detection ("" when none). */
static std::string feed(Spotter& sp, const float* s, int n) {
  std::string label;
  g_api.accept(sp.stream, 16000, s, n);
  while (g_api.ready(sp.kws, sp.stream)) {
    g_api.decode(sp.kws, sp.stream);
    const SherpaOnnxKeywordResult* r = g_api.result(sp.kws, sp.stream);
    if (r && r->keyword && r->keyword[0]) {
      label = r->keyword;
      g_api.reset(sp.kws, sp.stream);
    }
    if (r) g_api.destroyResult(r);
  }
  return label;
}

// ---------------- capture ----------------

static std::thread g_thread;
static std::atomic<bool> g_run{false};
static std::atomic<Mode> g_mode{Mode::Off};
static std::mutex g_kwLock;
static std::string g_pendingKeywords;
static bool g_kwChanged = false;

bool running() { return g_run.load(); }
void setMode(Mode m) { g_mode = m; }
Mode mode() { return g_mode.load(); }
void setKeywords(const std::string& keywords) {
  std::lock_guard<std::mutex> l(g_kwLock);
  g_pendingKeywords = keywords;
  g_kwChanged = true;
}

static void captureLoop(std::wstring dir, std::string keywords, std::wstring micId, Events ev) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDevice> dev;
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> cap;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  if (SUCCEEDED(hr)) hr = micId.empty() ? en->GetDefaultAudioEndpoint(eCapture, eCommunications, &dev) : en->GetDevice(micId.c_str(), &dev);
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf()));
  WAVEFORMATEX fmt{};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = 1;
  fmt.nSamplesPerSec = 16000;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = 4;
  fmt.nAvgBytesPerSec = 64000;
  if (SUCCEEDED(hr)) hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 2000000, 0, &fmt, nullptr);
  if (SUCCEEDED(hr)) hr = client->GetService(IID_PPV_ARGS(&cap));
  if (SUCCEEDED(hr)) hr = client->Start();
  Spotter sp;
  if (FAILED(hr) || !makeSpotter(sp, dir, keywords)) {
    g_run = false;
    if (ev.failed) ev.failed(hr == E_ACCESSDENIED ? L"mic" : FAILED(hr) ? L"mic" : L"engine");
    freeSpotter(sp);
    CoUninitialize();
    return;
  }
  std::vector<short> rec;
  float floor = 0.006f;
  bool spoke = false;
  int quietMs = 0, recMs = 0;
  Mode last = g_mode.load();
  while (g_run) {
    Sleep(20);
    {
      std::lock_guard<std::mutex> l(g_kwLock);
      if (g_kwChanged) {
        g_kwChanged = false;
        freeSpotter(sp);
        makeSpotter(sp, dir, g_pendingKeywords);
      }
    }
    UINT32 packet = 0;
    while (g_run && SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      std::vector<float> s(frames, 0.f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) memcpy(s.data(), data, frames * sizeof(float));
      cap->ReleaseBuffer(frames);
      Mode m = g_mode.load();
      if (m != last) {
        // A new state: nothing carries over (the recording starts empty, after the phrase).
        if (m == Mode::Recording) {
          rec.clear();
          spoke = false;
          quietMs = recMs = 0;
        }
        if (sp.stream) g_api.reset(sp.kws, sp.stream);
        last = m;
      }
      if (m == Mode::Asleep || m == Mode::Speaking) {
        std::string label = feed(sp, s.data(), (int)s.size());
        if (!label.empty() && ((m == Mode::Asleep && label != "STOP") || (m == Mode::Speaking && label == "STOP")) && ev.detected) ev.detected(label);
      } else if (m == Mode::Recording) {
        double sum = 0;
        for (float x : s) sum += x * x;
        float rms = (float)std::sqrt(sum / std::max<size_t>(1, s.size()));
        int ms = (int)(s.size() / 16);
        recMs += ms;
        if (rms > floor * 3) {
          spoke = true;
          quietMs = 0;
        } else {
          floor = floor * 0.98f + rms * 0.02f;
          if (spoke) quietMs += ms;
        }
        for (float x : s) rec.push_back((short)std::max(-32768.f, std::min(32767.f, x * 32767.f)));
        if ((spoke && quietMs > 800) || recMs > 15000 || (!spoke && recMs > 5000)) {
          g_mode = Mode::Off;  // the caller sets the next state
          last = Mode::Off;
          if (ev.recorded) ev.recorded(spoke ? rec : std::vector<short>{});
          rec.clear();
        }
      }
    }
  }
  client->Stop();
  freeSpotter(sp);
  CoUninitialize();
}

bool start(const std::wstring& dir, const std::string& keywords, const std::wstring& micId, const Events& ev, std::wstring& error) {
  stop();
  if (!loadEngine(dir, error)) return false;
  g_run = true;
  g_mode = Mode::Asleep;
  g_thread = std::thread(captureLoop, dir, keywords, micId, ev);
  return true;
}

void stop() {
  g_run = false;
  g_mode = Mode::Off;
  if (g_thread.joinable()) g_thread.join();
}

// ---------------- chime, microphones, WAV ----------------

std::string wavBytes(const std::vector<short>& s) {
  std::string b(44 + s.size() * 2, '\0');
  auto u32 = [&](size_t p, uint32_t v) { memcpy(&b[p], &v, 4); };
  auto u16 = [&](size_t p, uint16_t v) { memcpy(&b[p], &v, 2); };
  memcpy(&b[0], "RIFF", 4);
  u32(4, (uint32_t)(36 + s.size() * 2));
  memcpy(&b[8], "WAVEfmt ", 8);
  u32(16, 16);
  u16(20, 1);
  u16(22, 1);
  u32(24, 16000);
  u32(28, 32000);
  u16(32, 2);
  u16(34, 16);
  memcpy(&b[36], "data", 4);
  u32(40, (uint32_t)(s.size() * 2));
  if (!s.empty()) memcpy(&b[44], s.data(), s.size() * 2);
  return b;
}

void chime(bool rising) {
  static std::string buf;
  std::vector<short> s;
  const double amp = 0.125 * 32767;  // about −18 dB
  for (int k = 0; k < 2; k++) {
    double f = rising ? (k ? 880.0 : 660.0) : (k ? 523.25 : 784.0);
    for (int i = 0; i < 1920; i++) {  // 120 ms at 16 kHz
      double env = std::min(1.0, std::min(i / 160.0, (1920 - i) / 320.0));
      s.push_back((short)(amp * env * std::sin(2 * 3.14159265358979 * f * i / 16000.0)));
    }
  }
  buf = wavBytes(s);
  PlaySoundW(reinterpret_cast<LPCWSTR>(buf.data()), nullptr, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
}

std::vector<std::pair<std::wstring, std::wstring>> microphones() {
  std::vector<std::pair<std::wstring, std::wstring>> out;
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDeviceCollection> list;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en))) || FAILED(en->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &list))) return out;
  UINT n = 0;
  list->GetCount(&n);
  for (UINT i = 0; i < n; i++) {
    ComPtr<IMMDevice> d;
    ComPtr<IPropertyStore> ps;
    LPWSTR id = nullptr;
    if (FAILED(list->Item(i, &d)) || FAILED(d->GetId(&id))) continue;
    std::wstring name = id;
    if (SUCCEEDED(d->OpenPropertyStore(STGM_READ, &ps))) {
      PROPVARIANT v;
      PropVariantInit(&v);
      if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = v.pwszVal;
      PropVariantClear(&v);
    }
    out.push_back({id, name});
    CoTaskMemFree(id);
  }
  return out;
}

// ---------------- --test-wake ----------------

static void outLine(const std::string& s) {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD n = 0;
  std::string l = s + "\n";
  if (h && h != INVALID_HANDLE_VALUE) WriteFile(h, l.data(), (DWORD)l.size(), &n, nullptr);
}

int testWake(const std::wstring& folder, const std::wstring& wav, const std::wstring& keywordsFile) {
  std::wstring error;
  if (!loadEngine(folder, error)) {
    outLine("refused: " + std::string(error.begin(), error.end()));
    return 2;
  }
  std::string keywords = "HH EY1 S EH1 R AH0 :1.5 #0.25 @W1\nHH EY1 S AA1 R AH0 :1.5 #0.25 @W1\nS T AA1 P :1.5 #0.25 @STOP\nS EH1 R AH0 S T AA1 P :1.5 #0.25 @STOP";
  if (!keywordsFile.empty()) {
    std::ifstream k(keywordsFile, std::ios::binary);
    keywords.assign(std::istreambuf_iterator<char>(k), {});
  }
  std::ifstream f(wav, std::ios::binary);
  std::string b((std::istreambuf_iterator<char>(f)), {});
  if (b.size() < 44 || b.compare(0, 4, "RIFF") != 0) {
    outLine("not a WAV");
    return 3;
  }
  size_t p = 12, data = 0, len = 0;
  while (p + 8 <= b.size()) {
    uint32_t size;
    memcpy(&size, &b[p + 4], 4);
    if (b.compare(p, 4, "data") == 0) {
      data = p + 8;
      len = std::min<size_t>(size, b.size() - data);
      break;
    }
    p += 8 + size + (size & 1);
  }
  Spotter sp;
  if (!makeSpotter(sp, folder, keywords)) {
    outLine("the detector didn't start");
    return 4;
  }
  std::vector<float> s(len / 2);
  for (size_t i = 0; i < s.size(); i++) {
    short v;
    memcpy(&v, &b[data + i * 2], 2);
    s[i] = v / 32768.f;
  }
  int hits = 0;
  for (size_t i = 0; i < s.size(); i += 320) {
    int n = (int)std::min<size_t>(320, s.size() - i);
    std::string label = feed(sp, s.data() + i, n);
    if (!label.empty()) {
      char t[64];
      sprintf_s(t, " at %.2f s", (i + n) / 16000.0);
      outLine(label + t);
      hits++;
    }
  }
  std::vector<float> tail(16000 * 2, 0.f);  // let the last words finish decoding
  for (size_t i = 0; i < tail.size(); i += 320) {
    std::string label = feed(sp, tail.data() + i, 320);
    if (!label.empty()) {
      outLine(label + " at end");
      hits++;
    }
  }
  if (!hits) outLine("nothing");
  freeSpotter(sp);
  return 0;
}

}  // namespace sarawake
