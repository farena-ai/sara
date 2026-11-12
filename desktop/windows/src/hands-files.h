// 3.4.x (computer use, the person's own files): f.list / f.read on Windows, READ ONLY, only with
// "Files" on in the app (Settings → Computer use; off by default). The rules are src/hands-files.ts's,
// done here before anything is sent: only inside Desktop, Documents and Downloads (their real paths,
// links and junctions resolved and checked); no "..", drives, colons, UNC or "~"; hidden, system and
// secret-shaped names left out and never read; 200 entries a list; text files up to 1 MB, 32,000
// characters back, binary refused, key-shaped text masked. Nothing is ever written, moved or deleted.
#pragma once
#include <string>
#include <vector>

namespace sarafiles {

struct Reply {
  std::string json;           // the result object, when ok
  std::string code, message;  // the error, when not
};

/** Test runs only: Desktop / Documents / Downloads are folders inside this one (never the person's real ones). */
void setTestRoot(const std::wstring& dir);
/** 3.5.x: "Which folders" (0 Desktop/Documents/Downloads, 1 those and the folders picked, 2 the whole user folder,
    3 all fixed drives; always read only). Picked folders are full paths the person chose with the folder picker.
    Whatever the scope, system folders, other people's user folders and key/credential places stay out. */
void setRoots(int scope, const std::vector<std::wstring>& picked);
/** The hello's and optin's fragment: ,"fileRoots":[names…],"fileScope":"…" (names only, never paths). */
std::string rootsJson();
/** Whether a folder the person picked may be a root (not a system folder, another person's folder or a key store). */
bool pickable(const std::wstring& path, std::string& why);
/** f.list {folder, path} */
Reply list(const std::string& folder, const std::string& path);
/** f.read {folder, path, max} */
Reply read(const std::string& folder, const std::string& path, int maxChars);

}  // namespace sarafiles
