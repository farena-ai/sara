#!/usr/bin/env bash
# Builds Sara.app (Apple silicon + Intel) and Sara.dmg. Needs the Xcode command line tools.
# Phase 46d: the app carries Sara's server (Contents/Resources/server) and its own Node
# (Contents/Resources/node, one universal binary made with lipo from the two official builds,
# SHA-256 checked) so it can set the server up on the Mac it's opened on.
# Signs with a "Developer ID Application" identity if one is in the keychain (hardened runtime, Node
# signed first with the JIT entitlements it needs; then notarizes when NOTARY_PROFILE names a stored
# notarytool profile); otherwise signs ad hoc for this Mac.
# SARA_DEBUG=1 builds the test hooks in (SARA_TEST_JS, SARA_TEST_SETUP; never ship that build).
# SARA_NOTARIZE=0 skips notarizing (local test builds); without NOTARY_PROFILE (and without the
# signing keychain below) it isn't notarized either.
# Phase 55: only the LaunchAgent ("while you're signed in") is in the app (the "from startup" option was removed).
set -euo pipefail
cd "$(dirname "$0")"
ROOT=../..
NODE_VERSION=v24.22.1
# From https://nodejs.org/dist/v24.22.1/SHASUMS256.txt (bump together with NODE_VERSION).
NODE_SHA256_arm64=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7
NODE_SHA256_x64=d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035
CACHE="${SARA_BUILD_CACHE:-$HOME/Library/Caches/sara-build}"
VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)
[ -n "$VERSION" ] || { echo "No version in package.json" >&2; exit 1; }
SWIFT_FLAGS=(-O)
[ "${SARA_DEBUG:-0}" = 1 ] && SWIFT_FLAGS=(-Onone -D DEBUG)

rm -rf build && mkdir -p build/Sara.app/Contents/{MacOS,Resources,Library/LaunchAgents}
APP=build/Sara.app/Contents
for arch in arm64 x86_64; do
  swiftc "${SWIFT_FLAGS[@]}" -swift-version 5 -target "$arch-apple-macos13.0" -o "build/Sara-$arch" Sources/*.swift
done
lipo -create -output "$APP/MacOS/Sara" build/Sara-arm64 build/Sara-x86_64
cp Info.plist "$APP/Info.plist"
# The app's version is the server's (package.json), so an upgrade is one number.
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP/Info.plist"
cp LaunchAgent.plist "$APP/Library/LaunchAgents/com.backstagecoding.sara.server.plist"
plutil -lint "$APP/Info.plist" "$APP"/Library/LaunchAgents/*.plist >/dev/null
# App icon: AppIcon.png, the same picture as every other app in the macOS shape (a rounded square
# with the standard margin; made by scripts/make-app-icons.py).
mkdir -p build/Sara.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s AppIcon.png --out "build/Sara.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d AppIcon.png --out "build/Sara.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/Sara.iconset -o "$APP/Resources/Sara.icns"
# Phase 75 stage 2: the quick-ask page, shared with the Windows app (QuickAsk.swift loads it).
cp ../shared/quick-ask.html "$APP/Resources/quick-ask.html"
# Phase 87: the page agent the Sara browser reads pages with (the same file as the server's).
cp ../shared/page-agent.js "$APP/Resources/page-agent.js"

# Node: both official builds, checked, merged into one universal program (+ npm for her commands).
mkdir -p "$CACHE"
for a in arm64 x64; do
  f="node-$NODE_VERSION-darwin-$a.tar.gz"
  if [ ! -f "$CACHE/$f" ]; then curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$f" -o "$CACHE/$f.part" && mv "$CACHE/$f.part" "$CACHE/$f"; fi
  if [ $a = arm64 ]; then want=$NODE_SHA256_arm64; else want=$NODE_SHA256_x64; fi
  echo "$want  $CACHE/$f" | shasum -a 256 -c --quiet - || { rm -f "$CACHE/$f"; echo "Node $a checksum mismatch: the download was damaged or tampered with." >&2; exit 1; }
  rm -rf "build/node-$a" && mkdir -p "build/node-$a" && tar xzf "$CACHE/$f" -C "build/node-$a" --strip-components 1
done
N="$APP/Resources/node"
mkdir -p "$N/bin" "$N/lib/node_modules"
lipo -create -output "$N/bin/node" build/node-arm64/bin/node build/node-x64/bin/node
cp -R build/node-arm64/lib/node_modules/npm "$N/lib/node_modules/npm"
ln -s ../lib/node_modules/npm/bin/npm-cli.js "$N/bin/npm"
ln -s ../lib/node_modules/npm/bin/npx-cli.js "$N/bin/npx"
cp build/node-arm64/LICENSE "$N/LICENSE"
lipo -info "$N/bin/node"

# The server: what `node src/main.ts` needs, nothing else (no tests, docs or dev tools).
S="$APP/Resources/server"
mkdir -p "$S"
cp -R "$ROOT/src" "$ROOT/web" "$ROOT/persona" "$ROOT/templates" "$ROOT/skills" "$S/"
# Phase 87: the shared page agent (her testing browser reads pages with it too).
mkdir -p "$S/desktop/shared" && cp "$ROOT/desktop/shared/page-agent.js" "$S/desktop/shared/"
cp "$ROOT/package.json" "$ROOT/LICENSE" "$S/"
find "$S" -name '.DS_Store' -delete

# A signing keychain of its own (made once, see docs/desktop.md) is unlocked for the build.
KC="$HOME/Library/Keychains/sara-signing.keychain-db"
KC_PASS="${SARA_KEYCHAIN_PASS_FILE:-$HOME/sara-signing/keychain.pass}"
NOTARY_KC=()
if [ -f "$KC" ] && [ -f "$KC_PASS" ]; then
  security unlock-keychain -p "$(cat "$KC_PASS")" "$KC"
  NOTARY_KC=(--keychain "$KC")
  NOTARY_PROFILE="${NOTARY_PROFILE:-sara-notary}"
fi
ID=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application[^"]*"' | head -1 | tr -d '"' || true)
if [ -n "$ID" ]; then SIGN=(--force --options runtime --timestamp --sign "$ID"); else
  echo "No Developer ID found: signing ad hoc (runs on this Mac; other Macs need right-click → Open)."
  SIGN=(--force --sign -)
fi
# Inside out: any other program in npm, then Node (it compiles JavaScript, so it needs JIT), then the app.
while IFS= read -r f; do
  if file -b "$f" | grep -q Mach-O; then codesign "${SIGN[@]}" "$f"; fi
done < <(find "$N/lib" -type f -perm -u+x)
codesign "${SIGN[@]}" --entitlements node.entitlements "$N/bin/node"
codesign "${SIGN[@]}" --entitlements Sara.entitlements build/Sara.app
codesign --verify --deep --strict build/Sara.app
"$N/bin/node" -e 'if (!process.version) process.exit(1)'
arch -x86_64 "$N/bin/node" -e 'if (process.arch !== "x64") process.exit(1)' 2>/dev/null || echo "(Intel Node not checked: Rosetta isn't installed here)"

# The app gets its own notarization ticket too, so it opens without a network check after it's
# copied out of the disk image.
if [ -n "$ID" ] && [ -n "${NOTARY_PROFILE:-}" ] && [ "${SARA_NOTARIZE:-1}" = 1 ]; then
  ditto -c -k --keepParent build/Sara.app build/Sara-app.zip
  xcrun notarytool submit build/Sara-app.zip --keychain-profile "$NOTARY_PROFILE" "${NOTARY_KC[@]}" --wait | tee build/notary-app.log
  grep -q 'status: Accepted' build/notary-app.log || { echo "Notarizing the app failed (see build/notary-app.log)" >&2; exit 1; }
  xcrun stapler staple build/Sara.app
  rm -f build/Sara-app.zip
fi
# 2.18: the disk image opens as an install window: Sara on the left, an arrow, the Applications
# shortcut on the right, "Drag Sara to Applications" in the background (dmg/background*.png, made by
# dmg/make-background.py), 600 x 400, no toolbar or sidebar. Made read-write, laid out by Finder
# (dmg/layout.applescript), then compressed. Finder needs the logged-in Mac session (over SSH too:
# Finder's Automation permission) and no other volume called Sara mounted (an older Sara disk image
# still open: eject it). There is no saved-layout fallback: a Finder .DS_Store holds aliases with the
# building Mac's user folder, which must never ship. Without Finder the window is plain; a release build
# stops instead (SARA_DMG_PLAIN=1 allows the plain window).
# The read-write image lives outside the home folder: Finder's layout keeps an alias to the image
# file, and its path must not name this Mac's user.
RW=/tmp/sara-dmg-$$/Sara-rw.dmg
rm -rf build/dmg && mkdir -p build/dmg/.background "$(dirname "$RW")"
cp -R build/Sara.app build/dmg/ && ln -s /Applications build/dmg/Applications
tiffutil -cathidpicheck dmg/background.png dmg/background@2x.png -out build/dmg/.background/background.tiff >/dev/null
hdiutil create -quiet -volname Sara -srcfolder build/dmg -ov -fs HFS+ -format UDRW -size "$(( $(du -sm build/dmg | cut -f1) + 40 ))m" "$RW"
OTHER_SARA=0
for v in /Volumes/Sara*; do
  if [ -d "$v" ] && [ "$(diskutil info "$v" 2>/dev/null | sed -n 's/^ *Volume Name: *//p')" = Sara ]; then OTHER_SARA=1; fi
done
MNT=$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | grep -o '/Volumes/.*$' | head -1)
[ -d "$MNT" ] || { echo "The disk image didn't mount." >&2; exit 1; }
LAID_OUT=0
if [ "${SARA_DMG_TEMPLATE:-0}" != 1 ] && [ $OTHER_SARA = 0 ]; then
  if osascript dmg/layout.applescript Sara >/dev/null; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if grep -aq icvp "$MNT/.DS_Store" 2>/dev/null; then LAID_OUT=1; break; fi
      sleep 1
    done
  fi
fi
if [ $LAID_OUT = 1 ]; then
  echo "Disk image window laid out by Finder."
  # The layout must not name this Mac's user folder (Finder can store an alias path there).
  if LC_ALL=C grep -aq "$HOME" "$MNT/.DS_Store" || LC_ALL=C grep -aq ":Users:$(id -un):" "$MNT/.DS_Store"; then
    echo "The disk image layout names this Mac's user folder: not shipping it (a plain window)." >&2
    rm -f "$MNT/.DS_Store"; LAID_OUT=0
  fi
fi
if [ $LAID_OUT = 0 ] && [ "${SARA_DMG_PLAIN:-0}" != 1 ]; then
  if [ $OTHER_SARA = 1 ]; then echo "Another disk image called Sara is open: eject it and build again (or SARA_DMG_PLAIN=1)." >&2
  else echo "Finder couldn't lay out the disk image window (or SARA_DMG_PLAIN=1 for a plain one)." >&2; fi
  hdiutil detach -quiet "$MNT" || hdiutil detach -force -quiet "$MNT"
  exit 1
fi
rm -rf "$MNT/.fseventsd" "$MNT/.Trashes"
sync
hdiutil detach -quiet "$MNT" || { sleep 3; hdiutil detach -force -quiet "$MNT"; }
hdiutil convert -quiet "$RW" -ov -format UDZO -imagekey zlib-level=9 -o build/Sara.dmg
rm -rf "$(dirname "$RW")"
if [ -n "$ID" ]; then
  codesign --timestamp --sign "$ID" build/Sara.dmg
  if [ -n "${NOTARY_PROFILE:-}" ] && [ "${SARA_NOTARIZE:-1}" = 1 ]; then
    xcrun notarytool submit build/Sara.dmg --keychain-profile "$NOTARY_PROFILE" "${NOTARY_KC[@]}" --wait && xcrun stapler staple build/Sara.dmg
  fi
fi
cp build/Sara.dmg "build/Sara-$VERSION.dmg"
ls -la build/Sara.dmg "build/Sara-$VERSION.dmg"
