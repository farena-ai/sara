// S2 (docs/MEETINGS.md "Record this computer"): see meeting-rec.h. Both streams are opened in
// shared mode with their own mix format (float or 16-bit, any rate and channel count), mixed down
// to mono and resampled to 16 kHz here; the microphone is the clock (loopback sends no packets
// while nothing plays, so the right channel is padded with silence).
#include "meeting-rec.h"

#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace sararec {
namespace {
constexpr int kRate = 16000;
constexpr double kMaxSec = 3 * 3600;

std::thread g_thread;
std::atomic<bool> g_run{false};
std::atomic<bool> g_loop{false};
std::atomic<long long> g_frames{0};
std::mutex g_lock;
std::wstring g_path;
std::atomic<int> g_ok{0};  // 0 opening, 1 recording, 2 could not open

/** One capture stream turned into 16 kHz mono float. */
struct Stream {
  ComPtr<IAudioClient> client;
  ComPtr<IAudioCaptureClient> cap;
  int channels = 1;
  int rate = kRate;
  bool isFloat = true;
  int bits = 32;
  double pos = 0;    // resampler position in input samples
  float last = 0.f;  // the previous input sample (for interpolation across packets)

  bool open(IMMDevice* dev, bool loopback) {
    if (FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.GetAddressOf())))) return false;
    WAVEFORMATEX* mix = nullptr;
    if (FAILED(client->GetMixFormat(&mix)) || !mix) return false;
    channels = std::max<int>(1, mix->nChannels);
    rate = (int)mix->nSamplesPerSec;
    bits = mix->wBitsPerSample;
    isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
    if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mix->cbSize >= 22) isFloat = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mix)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0, 2000000, 0, mix, nullptr);
    CoTaskMemFree(mix);
    if (FAILED(hr) || (!isFloat && bits != 16) || (isFloat && bits != 32)) return false;
    return SUCCEEDED(client->GetService(IID_PPV_ARGS(&cap))) && SUCCEEDED(client->Start());
  }
  /** Reads every waiting packet into `out` (16 kHz mono). */
  bool drain(std::vector<float>& out) {
    UINT32 packet = 0;
    while (SUCCEEDED(cap->GetNextPacketSize(&packet)) && packet) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) return false;
      std::vector<float> mono(frames, 0.f);
      if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT))
        for (UINT32 i = 0; i < frames; i++) {
          float v = 0;
          for (int c = 0; c < channels; c++) v += isFloat ? reinterpret_cast<float*>(data)[i * channels + c] : reinterpret_cast<short*>(data)[i * channels + c] / 32768.f;
          mono[i] = v / channels;
        }
      cap->ReleaseBuffer(frames);
      // Linear resampling to 16 kHz (speech only needs this much).
      const double step = (double)rate / kRate;
      while (pos < frames) {
        int i = (int)pos;
        double f = pos - i;
        float a = i == 0 ? last : mono[i - 1];
        float b = mono[i];
        out.push_back((float)(a + (b - a) * f));
        pos += step;
      }
      pos -= frames;
      if (frames) last = mono[frames - 1];
    }
    return true;
  }
};

void writeHeader(FILE* f, long long frames) {
  const unsigned int bytes = (unsigned int)std::min<long long>(frames * 4, 0xFFFFFFF0LL);
  unsigned char h[44] = {'R', 'I', 'F', 'F', 0, 0, 0, 0, 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ', 16, 0, 0, 0, 1, 0, 2, 0};
  auto u32 = [&](int o, unsigned int v) { for (int i = 0; i < 4; i++) h[o + i] = (unsigned char)(v >> (8 * i)); };
  u32(4, 36 + bytes);
  u32(24, kRate);
  u32(28, kRate * 4);
  h[32] = 4;
  h[34] = 16;
  memcpy(h + 36, "data", 4);
  u32(40, bytes);
  fseek(f, 0, SEEK_SET);
  fwrite(h, 1, 44, f);
}

inline short pcm(float v) { return (short)std::max(-32768.f, std::min(32767.f, std::round(v * 32767.f))); }

void loop(std::wstring path, HANDLE ready) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDevice> micDev, outDev;
  Stream mic, sys;
  bool micOk = SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en))) &&
               SUCCEEDED(en->GetDefaultAudioEndpoint(eCapture, eCommunications, &micDev)) && mic.open(micDev.Get(), false);
  bool sysOk = micOk && SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &outDev)) && sys.open(outDev.Get(), true);
  FILE* f = nullptr;
  if (micOk && _wfopen_s(&f, path.c_str(), L"wb") != 0) f = nullptr;
  const bool ok = micOk && f;
  g_ok = ok ? 1 : 2;
  g_loop = sysOk;
  SetEvent(ready);
  if (!ok) {
    if (f) fclose(f);
    CoUninitialize();
    return;
  }
  writeHeader(f, 0);
  std::vector<float> m, s;
  std::vector<short> out;
  while (g_run) {
    Sleep(20);
    if (!mic.drain(m)) break;
    if (sysOk && !sys.drain(s)) sysOk = false;
    size_t n = m.size();
    out.resize(n * 2);
    for (size_t i = 0; i < n; i++) {
      out[i * 2] = pcm(m[i]);
      out[i * 2 + 1] = i < s.size() ? pcm(s[i]) : 0;
    }
    fwrite(out.data(), sizeof(short), out.size(), f);
    m.clear();
    s.erase(s.begin(), s.begin() + std::min(n, s.size()));
    if (s.size() > (size_t)kRate) s.erase(s.begin(), s.end() - kRate / 4);  // drifted: resync
    g_frames += (long long)n;
    if (g_frames >= (long long)(kMaxSec * kRate)) break;
  }
  mic.client->Stop();
  if (sys.client) sys.client->Stop();
  writeHeader(f, g_frames.load());
  fclose(f);
  CoUninitialize();
}
}  // namespace

bool start(const std::wstring& folder, std::wstring& why) {
  std::lock_guard<std::mutex> l(g_lock);
  if (g_run) {
    why = L"busy";
    return false;
  }
  if (g_thread.joinable()) g_thread.join();
  CreateDirectoryW(folder.c_str(), nullptr);
  SYSTEMTIME t;
  GetLocalTime(&t);
  wchar_t name[64];
  swprintf_s(name, L"\\rec-%04d%02d%02d-%02d%02d%02d.wav", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
  g_path = folder + name;
  g_frames = 0;
  g_run = true;
  HANDLE ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g_ok = 0;
  g_thread = std::thread(loop, g_path, ready);
  WaitForSingleObject(ready, 5000);
  CloseHandle(ready);
  if (g_ok.load() != 1) {
    g_run = false;
    if (g_thread.joinable()) g_thread.join();
    DeleteFileW(g_path.c_str());
    g_path.clear();
    why = L"mic";
    return false;
  }
  return true;
}

std::wstring stop() {
  std::lock_guard<std::mutex> l(g_lock);
  if (!g_thread.joinable()) return L"";
  g_run = false;
  g_thread.join();
  std::wstring p = g_path;
  g_path.clear();
  return p;
}

bool recording() { return g_run.load(); }
double seconds() { return (double)g_frames.load() / kRate; }
bool loopback() { return g_loop.load(); }

void discard(const std::wstring& folder, const std::wstring& path) {
  if (path.size() <= folder.size() + 1 || _wcsnicmp(path.c_str(), folder.c_str(), folder.size()) != 0) return;
  std::wstring name = path.substr(folder.size() + 1);
  if (name.find_first_of(L"\\/") != std::wstring::npos || name.rfind(L"rec-", 0) != 0 || name.size() < 8 || _wcsicmp(name.c_str() + name.size() - 4, L".wav") != 0) return;
  DeleteFileW(path.c_str());
}

void sweep(const std::wstring& folder) {
  WIN32_FIND_DATAW d;
  HANDLE h = FindFirstFileW((folder + L"\\rec-*.wav").c_str(), &d);
  if (h == INVALID_HANDLE_VALUE) return;
  FILETIME now;
  GetSystemTimeAsFileTime(&now);
  const ULONGLONG week = 7ULL * 24 * 3600 * 10000000ULL;
  do {
    ULONGLONG n = ((ULONGLONG)now.dwHighDateTime << 32) | now.dwLowDateTime;
    ULONGLONG w = ((ULONGLONG)d.ftLastWriteTime.dwHighDateTime << 32) | d.ftLastWriteTime.dwLowDateTime;
    if (n > w && n - w > week) DeleteFileW((folder + L"\\" + d.cFileName).c_str());
  } while (FindNextFileW(h, &d));
  FindClose(h);
}
}  // namespace sararec
