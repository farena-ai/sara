// U4.25 (docs/EXTENSION.md): shared by the popup and the background worker. The only network code of
// the extension lives here, and it only ever talks to the Sara server you paired (its device token,
// no cookies). The per-site off switch and the pairing are kept in the extension's own storage.

/** chrome.* in Chrome/Edge, browser.* in Firefox (both promise-based in MV3). */
export const B = globalThis.browser ?? globalThis.chrome;

/** A localized string from _locales (falls back to the key). */
export function t(key, subs) {
  try {
    return B?.i18n?.getMessage(key, subs) || key;
  } catch {
    return key;
  }
}

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)(:\d+)?$/i;

/** The server's origin from what the person typed ("sara.example.com/chat" → https://sara.example.com). */
export function normalizeServer(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `${LOCAL.test(s.split('/')[0]) ? 'http' : 'https'}://${s}`;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
  } catch {
    return '';
  }
}

/** The host permission asked for at pairing: only this server. */
export const originPattern = (server) => `${server}/*`;

/** The site a page belongs to, for the per-site off switch ("www." dropped). Empty for non-web pages. */
export function siteKey(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export const pageAllowed = (url) => siteKey(url) !== '';
export const isOff = (list, url) => Boolean(siteKey(url)) && (list ?? []).includes(siteKey(url));
export function toggleSite(list, url, off) {
  const k = siteKey(url);
  const set = new Set(list ?? []);
  if (k) off ? set.add(k) : set.delete(k);
  return [...set].sort();
}

/** What "Ask", "Summarize" and "Save" send: capped here, capped again by Sara. */
export function askBody(p) {
  const cut = (v, n) => String(v ?? '').slice(0, n);
  return { mode: p.mode === 'summarize' ? 'summarize' : 'ask', question: cut(p.question, 2000), url: cut(p.url, 2000), title: cut(p.title, 200), selection: cut(p.selection, 4000), text: cut(p.text, 20000) };
}

async function readJson(r) {
  try {
    return await r.json();
  } catch {
    return {};
  }
}

/** A call to the paired Sara (paths under /api/ only). Throws Error(message) with .status on failure. */
export async function saraCall(conf, path, body, fetchImpl = globalThis.fetch) {
  if (!conf?.server || !conf?.token) throw Object.assign(new Error(t('notPaired') === 'notPaired' ? 'Not paired with Sara yet.' : t('notPaired')), { status: 0 });
  if (!String(path).startsWith('/api/')) throw new Error('Only the paired Sara server is called.');
  const r = await fetchImpl(`${conf.server}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { authorization: `Bearer ${conf.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await readJson(r);
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

/** Pairing, step 1: Sara makes a short code the person approves in Settings → Devices and sign-in. */
export async function startPairing(server, name, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(`${server}/api/device/start`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, scope: 'extension' }) });
  const data = await readJson(r);
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

/** Pairing, step 2: asked every few seconds until approved (the token is handed out once). */
export async function pollPairing(server, pollToken, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(`${server}/api/device/poll`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollToken }) });
  const data = await readJson(r);
  if (r.status === 410) return { status: 'expired' };
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status });
  return data;
}

/** The extension's saved state: {server, token, deviceId, offSites}. */
export async function loadConf() {
  const s = await B.storage.local.get(['server', 'token', 'deviceId', 'offSites']);
  return { server: s.server || '', token: s.token || '', deviceId: s.deviceId || '', offSites: Array.isArray(s.offSites) ? s.offSites : [] };
}

/** "Sara for Chrome on Windows": the name shown under Devices and sign-in. */
export function deviceName(ua = globalThis.navigator?.userAgent ?? '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : 'Chrome';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '';
  return `Sara for ${browser}${os ? ` on ${os}` : ''}`;
}
