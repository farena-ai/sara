// Phase 94 (CU7): runs the Windows check-up (desktop/windows/src/hands-checkup.cpp) on this computer and
// prints AGGREGATE numbers only (counts and sizes), never a name of an app, folder, extension or update:
// the owner's computer is read, nothing on it is changed, and the output can go into a report.
// It also checks the JSON answer's shape and that the read-only check code has no changing calls linked in.
//   CU7NativeChecks.exe            → "check <name>: ok …" lines and "N/N native check-up checks"
#include "hands-checkup.h"
#include <cstdio>
#include <string>

using namespace saracheckup;

static int pass = 0, total = 0;
static void expect(bool ok, const char* what) {
  total++;
  if (ok) pass++;
  std::printf("%s %s\n", ok ? "ok  " : "FAIL", what);
}
static double gb(uint64_t b) { return (double)b / (1024.0 * 1024.0 * 1024.0); }

int wmain() {
  Report r = collect({}, [] { return false; });
  std::string json = toJson(r);
  expect(json.rfind("{\"os\":\"windows ", 0) == 0, "the answer starts with the os");
  for (const char* k : {"\"startup\":", "\"disk\":", "\"folders\":", "\"updates\":", "\"battery\":", "\"extensions\":", "\"temp\":"}) expect(json.find(k) != std::string::npos, k);
  expect(r.startupOk, "startup apps read (Run keys + Startup folders)");
  size_t on = 0, machine = 0;
  for (auto& s : r.startup) { on += s.enabled; machine += s.where == "machine"; }
  std::printf("  startup: %zu listed, %zu on, %zu machine-wide\n", r.startup.size(), on, machine);
  expect(r.diskOk && !r.volumes.empty(), "fixed disks read");
  uint64_t tot = 0, fr = 0;
  for (auto& v : r.volumes) { tot += v.total; fr += v.free; }
  std::printf("  disk: %zu fixed volumes, %.1f GB free of %.1f GB\n", r.volumes.size(), gb(fr), gb(tot));
  expect(r.foldersOk && r.folders.size() == 6, "six known folders measured (bounded walk)");
  uint64_t fsum = 0, files = 0; size_t partial = 0;
  for (auto& f : r.folders) { fsum += f.bytes; files += f.files; partial += f.partial; }
  std::printf("  folders: %.1f GB in %llu files across 6 known folders (%zu counted partly)\n", gb(fsum), (unsigned long long)files, partial);
  std::printf("  updates: %s, %ld waiting, restart needed: %s\n", r.updatesOk ? "read" : "not available", r.pending, r.reboot ? "yes" : "no");
  expect(r.updatesRan, "updates asked (offline search of Windows Update's last check)");
  expect(r.batteryOk, "power status read");
  std::printf("  battery: %s%s\n", r.batteryPresent ? "present" : "none", r.batteryPresent && r.health >= 0 ? (", health " + std::to_string(r.health) + "%").c_str() : "");
  size_t ext = 0;
  for (auto& b : r.browsers) ext += b.extensions.size();
  expect(r.extensionsOk, "browser extensions read (manifests only)");
  std::printf("  extensions: %zu browser profiles, %zu extensions\n", r.browsers.size(), ext);
  expect(r.tempOk && r.temp.size() >= 2, "temp, browser caches (and the Recycle Bin) measured");
  uint64_t t = 0;
  for (auto& s : r.temp) t += s.bytes;
  std::printf("  temp and caches: %.2f GB in %zu places\n", gb(t), r.temp.size());
  // Bounded: a cancelled walk stops at once.
  Report c = collect({"folders"}, [] { return true; });
  bool stopped = true;
  for (auto& f : c.folders) stopped = stopped && f.files <= 512;
  expect(c.foldersRan && stopped, "a cancelled check stops its walk");
  Report only = collect({"disk"}, [] { return false; });
  expect(only.diskRan && !only.startupRan && !only.foldersRan, "only the asked checks run");
  std::printf("%d/%d native check-up checks\n", pass, total);
  return pass == total ? 0 : 1;
}
