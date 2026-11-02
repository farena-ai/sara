// Phase 126 (docs/design/WAKE.md §6.1): Hey Sara on Windows. The pack (the keyword model and the
// sherpa-onnx engine, pinned by SHA-256 and checked on every load), the microphone (WASAPI, shared
// mode, 16 kHz mono), the keyword spotter, the recording after the phrase, and the chime. Nothing
// before the phrase is kept: the detector's samples are dropped as soon as they are decoded.
#pragma once
#include <windows.h>
#include <functional>
#include <string>
#include <vector>

namespace sarawake {

/** %LOCALAPPDATA%\Sara\wake\1 */
std::wstring packDir();
/** All pack files there and every SHA-256 matches (checked each time). */
bool packReady(const std::wstring& dir, std::wstring* why = nullptr);
/** Downloads the pinned upstream tarballs (WinHTTP), checks them, unpacks the files with Windows' tar.exe. */
bool installPack(std::wstring& error, const std::function<void(int percent)>& progress);
void removePack();
/** Bytes the pack download takes. */
long long packDownloadBytes();

enum class Mode { Off, Asleep, Recording, Speaking };

struct Events {
  /** A phrase was heard (label W1…W4) or STOP while she speaks. Called on the capture thread. */
  std::function<void(const std::string& label)> detected;
  /** The recording after the phrase is done (16 kHz mono 16-bit samples; empty: nothing said). */
  std::function<void(std::vector<short> samples)> recorded;
  /** The microphone failed or Windows denied it ("mic"). */
  std::function<void(const std::wstring& reason)> failed;
};

/** Loads the verified engine, opens the microphone and starts the detector with these keyword lines. */
bool start(const std::wstring& dir, const std::string& keywords, const std::wstring& micId, const Events& ev, std::wstring& error);
/** Closes the microphone (the OS indicator goes away) and stops the detector. */
void stop();
bool running();
void setMode(Mode m);
Mode mode();
/** New keyword lines (the detector is made again with them). */
void setKeywords(const std::string& keywords);

/** Two soft tones (rising: listening; falling: back to sleep). */
void chime(bool rising);
/** The capture devices: id, friendly name. */
std::vector<std::pair<std::wstring, std::wstring>> microphones();
/** A WAV file (16 kHz mono 16-bit) from samples. */
std::string wavBytes(const std::vector<short>& s);

/** Sara.exe --test-wake <folder> <wav> [keywords file]: prints each detection (label and time). Exit code. */
int testWake(const std::wstring& folder, const std::wstring& wav, const std::wstring& keywordsFile);

}  // namespace sarawake
