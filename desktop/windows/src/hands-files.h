// 3.4.x (computer use, the person's own files): f.list / f.read on Windows, READ ONLY, only with
// "Files" on in the app (Settings → Computer use; off by default). The rules are src/hands-files.ts's,
// done here before anything is sent: only inside Desktop, Documents and Downloads (their real paths,
// links and junctions resolved and checked); no "..", drives, colons, UNC or "~"; hidden, system and
// secret-shaped names left out and never read; 200 entries a list; text files up to 1 MB, 32,000
// characters back, binary refused, key-shaped text masked. Nothing is ever written, moved or deleted.
#pragma once
#include <string>

namespace sarafiles {

struct Reply {
  std::string json;           // the result object, when ok
  std::string code, message;  // the error, when not
};

/** Test runs only: Desktop / Documents / Downloads are folders inside this one (never the person's real ones). */
void setTestRoot(const std::wstring& dir);
/** f.list {folder, path} */
Reply list(const std::string& folder, const std::string& path);
/** f.read {folder, path, max} */
Reply read(const std::string& folder, const std::string& path, int maxChars);

}  // namespace sarafiles
