// R2 (docs/GETTING_STARTED.md, /download): which installer fits this device. Pure functions, shared
// by the public download page (web/download.js) and the server's release mapping (src/download.ts),
// so the tests check both with the same code. No imports.

export const OSES = ['windows', 'mac', 'linux', 'android', 'iphone'];
export const PLAY_STORE = 'https://play.google.com/store/apps/details?id=com.backstagecoding.sara';
export const RELEASES_PAGE = 'https://github.com/farena-ai/sara/releases/latest';
export const LINUX_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/deploy/get-sara.sh | sudo bash';

/**
 * The device's system from its user agent. iPads ask for the desktop site and say "Macintosh":
 * a touch screen tells them apart (pass maxTouchPoints). Unknown → 'windows' (the most common).
 */
export function detectOs(ua, maxTouchPoints = 0) {
  const s = String(ua ?? '');
  if (/iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && maxTouchPoints > 1)) return 'iphone';
  if (/Android/i.test(s)) return 'android';
  if (/Windows/i.test(s)) return 'windows';
  if (/Mac OS X|Macintosh/.test(s)) return 'mac';
  if (/Linux|X11|CrOS/i.test(s)) return 'linux';
  return 'windows';
}

/**
 * The installers of a GitHub release (its `assets`: name + browser_download_url). Windows: the
 * Sara-Setup-<v>.exe; Mac: Sara-<v>.dmg; Android: an .apk when a release carries one, else Google
 * Play; Linux: get-sara.sh (the one-command installer); iPhone: none (Add to Home Screen).
 */
export function releaseAssets(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const find = (re) => {
    const a = assets.find((x) => re.test(String(x?.name ?? '')));
    return a ? { name: String(a.name), url: String(a.browser_download_url ?? ''), size: Number(a.size) || 0 } : null;
  };
  const version = String(release?.tag_name ?? '').replace(/^v/i, '');
  return {
    version,
    page: String(release?.html_url ?? RELEASES_PAGE),
    windows: find(/^Sara-Setup-[\d.]+.*\.exe$/i) ?? find(/\.exe$/i),
    mac: find(/^Sara-[\d.]+.*\.dmg$/i) ?? find(/\.dmg$/i),
    android: find(/\.apk$/i),
    linux: find(/^get-sara\.sh$/i),
    source: find(/^sara-[\d.]+\.tar\.gz$/i),
  };
}

/** The main link for one system: the file, Google Play, or the releases page. */
export function primaryLink(os, assets) {
  if (os === 'windows') return assets?.windows?.url || assets?.page || RELEASES_PAGE;
  if (os === 'mac') return assets?.mac?.url || assets?.page || RELEASES_PAGE;
  if (os === 'android') return PLAY_STORE;
  if (os === 'linux') return assets?.linux?.url || assets?.page || RELEASES_PAGE;
  return '';
}
