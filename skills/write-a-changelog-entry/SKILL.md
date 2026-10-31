---
name: write-a-changelog-entry
description: "Writes a changelog entry for a release or a change, in plain words for the people who use the software, grouped as Added, Changed, Fixed, Removed and Security. Use when the owner asks for release notes, a changelog line or what changed in a version."
license: MIT
metadata:
  "sara-version": "1"
---

# Write a changelog entry

## 1. Find what changed
- Read the commits since the last release: `git log --oneline <last-tag>..HEAD` (find the tag with
  `git describe --tags --abbrev=0`). Read the diff of anything whose commit message is unclear.
- Open the existing `CHANGELOG.md` and copy its style (headings, dates, link format). If there is
  none, use the layout below.

## 2. Sort it
Group the changes people will notice:
- **Added**: new features.
- **Changed**: things that work differently now.
- **Fixed**: bugs that are gone.
- **Removed**: things that are gone.
- **Security**: fixes people should update for.
Leave out internal work nobody notices (refactors, test-only changes) unless the project lists them.

## 3. Write each line
- One line per change, starting with what the user gets: "You can now export a skill as a zip",
  not "Refactored export module".
- Plain words, present tense, no internal names. Link the issue or PR when the project does.
- Say clearly when someone must do something (a setting to change, a migration to run).

## 4. Layout (when the project has none)
```
## [1.4.0] - 2026-10-31
### Added
- ...
### Fixed
- ...
```
Use the version the owner gives you; if none, ask, or suggest one (new features: minor, fixes only:
patch, breaking changes: major).

## 5. Show it
Show the entry to the owner before writing it into the file, then add it at the top of the
changelog (newest first) when they agree.
