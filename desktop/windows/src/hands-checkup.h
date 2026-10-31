// Phase 94 (computer use CU7, docs/design/COMPUTER_USE.md §11 "Phase 94"; the rules are
// src/hands-checkup.ts): the READ-ONLY computer check-up on Windows (op s.check). A fixed list of
// checks through documented OS APIs only: no shell command, nothing from the server is run, nothing
// is written, deleted or launched. Startup apps (the Run keys and the Startup folders, with
// Explorer's own StartupApproved on/off state), fixed disks (GetDiskFreeSpaceExW), the sizes of the
// person's known folders (a bounded walk: entries and time limits, reparse points never followed),
// updates waiting from Windows Update's last check (Windows Update Agent, offline search: no new
// scan, no download), battery (GetSystemPowerStatus + the battery driver's design / full-charge
// capacity), the extensions installed in the person's own Edge / Chrome / Brave profiles (names from
// their manifests; shown, never changed) and temporary files, browser caches and the Recycle Bin.
// This build answers s.apply with "unsupported": check-up changes are made by the person (Sara says
// where), see the Phase 94 deviations in COMPUTER_USE.md.
#pragma once
#include <windows.h>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace saracheckup {

constexpr size_t kWalkEntries = 200000;  // per folder walk
constexpr DWORD kWalkMs = 4000;          // per folder walk
constexpr size_t kItems = 100;

struct Startup { std::string id, name, where; bool enabled = true; };
struct Volume { std::string name; uint64_t total = 0, free = 0; };
struct Size { std::string id, name; uint64_t bytes = 0, files = 0; bool partial = false; };
struct Extension { std::string id, name; };
struct Browser { std::string browser, profile; std::vector<Extension> extensions; };

struct Report {
  std::string os;
  // Each check: ran (asked for), ok, why (when not ok).
  bool startupRan = false, startupOk = false; std::string startupWhy; std::vector<Startup> startup;
  bool diskRan = false, diskOk = false; std::string diskWhy; std::vector<Volume> volumes;
  bool foldersRan = false, foldersOk = false; std::string foldersWhy; std::vector<Size> folders;
  bool updatesRan = false, updatesOk = false; std::string updatesWhy; long pending = 0; bool reboot = false; std::vector<std::string> updateNames;
  bool batteryRan = false, batteryOk = false; std::string batteryWhy; bool batteryPresent = false; int percent = -1; bool charging = false; int health = -1; long cycles = -1;
  bool extensionsRan = false, extensionsOk = false; std::string extensionsWhy; std::vector<Browser> browsers;
  bool tempRan = false, tempOk = false; std::string tempWhy; std::vector<Size> temp;
};

/** Runs the asked checks (empty: all of them). `cancelled` is polled during folder walks. */
Report collect(const std::vector<std::string>& checks, const std::function<bool()>& cancelled);
/** The s.check answer: {"os", "at", "checks": {…}} (UTF-8 JSON, the shape of src/hands-checkup.ts CheckData). */
std::string toJson(const Report& r);

}  // namespace saracheckup
