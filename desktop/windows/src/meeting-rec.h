// S2 (docs/MEETINGS.md "Record this computer"): records a meeting on this PC with WASAPI: the
// default microphone (left channel) and the computer's own sound by loopback (right channel), as
// a 16 kHz 16-bit stereo WAV in the app's data folder. Started and stopped only by the owner's page
// (after its consent notice); the finished file goes to the page as a read-only file handle and is
// deleted once the page has sent it. Nothing is uploaded from here.
#pragma once
#include <string>

namespace sararec {
/** Starts recording into `folder`; false with `why` ("mic", "busy") when it can't. */
bool start(const std::wstring& folder, std::wstring& why);
/** Stops; the finished WAV's path (empty when nothing was recording). */
std::wstring stop();
bool recording();
/** Seconds recorded so far. */
double seconds();
/** Whether the computer's sound is being captured too (loopback opened). */
bool loopback();
/** Deletes a finished recording the page has sent (only files in `folder` named rec-*.wav). */
void discard(const std::wstring& folder, const std::wstring& path);
/** Old leftovers (a page that never sent them) are removed after a week. */
void sweep(const std::wstring& folder);
}  // namespace sararec
