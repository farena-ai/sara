// EC24 (docs/ops/EC24_DESIGN.md): this device as Sara's helper. Settings → Devices and sign-in →
// Phone as a helper switches this browser sign-in on or off. When she asks, a full-screen prompt
// shows what she wants and why; nothing is captured before Allow once. Camera: a live preview and
// Take picture; location: the browser's own permission, one fix; screen: the browser's own picker,
// one frame. The capture stops at once and nothing is kept on the device.
import { setIcon } from './icons.js';
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any> } | null} */
let ctx = null;
const $ = (s) => document.querySelector(s);
/** The request on screen, the ones waiting behind it, the open camera. */
let current = null;
const queue = [];
let stream = null;
let tick = 0;
/** A load asked for before init (the page's boot can run first). */
let loadWanted = false;
const MAX_EDGE = 1600;

const TITLES = {
  camera: () => t('Sara wants to use your camera'),
  location: () => t('Sara wants to know where you are'),
  screen: () => t('Sara wants to see your screen'),
};
const ICONS = { camera: 'camera', location: 'compass', screen: 'monitor' };

/** The line under her reason: exactly what Allow once gives her. */
export function whatLine(req) {
  if (req.kind === 'location') return req.precise ? t('Your exact location, once.') : t('Your approximate location (about 1 km), once.');
  if (req.kind === 'screen') return t('One picture of a screen or window you pick next.');
  return req.facing === 'front' ? t('One picture from your front camera. You see it before it is sent.') : t('One picture from your camera. You see it before it is sent.');
}
/** Seconds left on the prompt, in words. */
export function leftLine(expiresAt, now = Date.now()) {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return t('Closes in {n} s if you do nothing.', { n: s });
}

export function initPhoneHelper(c) {
  ctx = c;
  $('#hd-on')?.addEventListener('change', () => void save($('#hd-on').checked));
  $('#helper-allow')?.addEventListener('click', () => void allow());
  $('#helper-deny')?.addEventListener('click', () => void answer({ allow: false }));
  $('#helper-shoot')?.addEventListener('click', () => void shoot());
  // Escape is Deny, never a silent close.
  $('#helper-ask')?.addEventListener('cancel', (e) => {
    e.preventDefault();
    void answer({ allow: false });
  });
  if (loadWanted) void loadPhoneHelper();
}

export async function loadPhoneHelper() {
  if (!ctx) return void (loadWanted = true);
  loadWanted = false;
  if (!$('#hd-box')) return;
  let d;
  try {
    d = await ctx.api('/phone-helper');
  } catch {
    $('#hd-box').hidden = true;
    return;
  }
  render(d);
  for (const r of d.pending ?? []) helperEvent({ ...r, state: 'asking' });
}

function render(d) {
  $('#hd-box').hidden = false;
  $('#hd-on').checked = Boolean(d.thisDevice);
  $('#hd-on').disabled = !d.canOptIn || (d.pinned && !d.thisDevice);
  $('#hd-pinned').hidden = !d.pinned;
  const others = (d.devices ?? []).map((x) => (x.current ? t('{label} (this device)', { label: x.label }) : x.label));
  $('#hd-devices').textContent = others.length ? t('Helper devices: {list}', { list: others.join(', ') }) : t('No device is switched on.');
}

async function save(on) {
  $('#hd-status').textContent = '';
  try {
    render(await ctx.api('/phone-helper', { method: 'PUT', body: { helper: on } }));
    $('#hd-status').textContent = on ? t('This device can now be asked. Each time, you choose.') : t('Sara will not ask this device.');
  } catch (e) {
    $('#hd-on').checked = !on;
    $('#hd-status').textContent = e.message;
  }
}

/** An event from the server: a new ask, or one that ended (answered elsewhere, expired, cancelled). */
export function helperEvent(ev) {
  if (!ev?.id) return;
  if (ev.state === 'asking') {
    if (current?.id === ev.id || queue.some((q) => q.id === ev.id)) return;
    if (Date.parse(ev.expiresAt) <= Date.now()) return;
    queue.push(ev);
    if (!current) next();
    return;
  }
  const i = queue.findIndex((q) => q.id === ev.id);
  if (i >= 0) queue.splice(i, 1);
  if (current?.id === ev.id) close(ev.state === 'expired' ? t('The request ran out of time.') : '');
}

function next() {
  current = queue.shift() ?? null;
  if (!current) return;
  const d = $('#helper-ask');
  setIcon($('#helper-icon'), ICONS[current.kind] ?? 'camera');
  $('#helper-title').textContent = TITLES[current.kind]?.() ?? TITLES.camera();
  $('#helper-reason').textContent = current.reason || '';
  $('#helper-what').textContent = whatLine(current);
  $('#helper-status').textContent = '';
  $('#helper-video').hidden = true;
  $('#helper-shoot').hidden = true;
  $('#helper-allow').hidden = false;
  $('#helper-allow').disabled = false;
  $('#helper-deny').textContent = t('Deny');
  const left = () => {
    if (!current) return;
    $('#helper-left').textContent = leftLine(current.expiresAt);
  };
  left();
  clearInterval(tick);
  tick = setInterval(left, 1000);
  if (!d.open) d.showModal();
  window.SaraDesktop?.attention?.('ring');
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(TITLES[current.kind]?.() ?? TITLES.camera(), { body: current.reason || '' });
    } catch {
      /* no notifications here */
    }
  }
  $('#helper-allow').focus();
}

function stopCapture() {
  for (const tr of stream?.getTracks() ?? []) tr.stop();
  stream = null;
  const v = $('#helper-video');
  if (v) {
    v.srcObject = null;
    v.hidden = true;
  }
}

function close(note = '') {
  stopCapture();
  clearInterval(tick);
  current = null;
  $('#helper-left').textContent = '';
  if (note) $('#helper-status').textContent = note;
  const d = $('#helper-ask');
  if (d?.open) d.close();
  if (queue.length) next();
}

async function answer(body) {
  const req = current;
  if (!req) return;
  stopCapture();
  try {
    await ctx.api(`/phone-helper/requests/${encodeURIComponent(req.id)}`, { method: 'POST', body });
  } catch {
    /* already ended (expired or answered on another device): the prompt closes either way */
  }
  if (current?.id === req.id) close();
}

async function allow() {
  const req = current;
  if (!req) return;
  $('#helper-allow').disabled = true;
  $('#helper-status').textContent = t('Working…');
  try {
    if (req.kind === 'location') return void (await locate(req));
    if (req.kind === 'screen') return void (await screen(req));
    await openCamera(req);
  } catch (err) {
    // The browser said no (permission), or the device can't: she is told it didn't work.
    const unsupported = err?.message === 'unsupported';
    await answer({ allow: true, error: unsupported ? 'unsupported' : 'failed' });
  }
}

function locate(req) {
  // C18: the Android app (new build) takes the fix natively, because its web view gives
  // navigator.geolocation only to https pages and a server at home is often plain http.
  if (typeof window.SaraPhone?.helperLocate === 'function') return nativeLocate(req);
  if (!navigator.geolocation) throw new Error('unsupported');
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(answer({ allow: true, lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy })),
      (e) => reject(e),
      { enableHighAccuracy: Boolean(req.precise), timeout: 20_000, maximumAge: 60_000 },
    );
  });
}

/** One fix from the Android app: it answers window.saraHelperLocated once (20 s at most). */
function nativeLocate(req) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done({ error: 'failed' }), 20_000);
    function done(r) {
      clearTimeout(timer);
      window.saraHelperLocated = undefined;
      if (r && Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
        resolve(answer({ allow: true, lat: r.lat, lon: r.lon, accuracy: r.accuracy }));
      } else reject(new Error(r?.error === 'unsupported' ? 'unsupported' : 'failed'));
    }
    window.saraHelperLocated = done;
    window.SaraPhone.helperLocate(Boolean(req.precise));
  });
}

/** One frame from a playing video, scaled to MAX_EDGE, as a JPEG data URL. */
function frame(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error('no picture');
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function openCamera(req) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: req.facing === 'front' ? 'user' : 'environment', width: { ideal: 1600 } }, audio: false });
  const v = $('#helper-video');
  v.srcObject = stream;
  v.hidden = false;
  await v.play();
  $('#helper-status').textContent = t('Point the camera, then take the picture.');
  $('#helper-allow').hidden = true;
  $('#helper-shoot').hidden = false;
  $('#helper-deny').textContent = t('Cancel');
  $('#helper-shoot').focus();
}

async function shoot() {
  const v = $('#helper-video');
  try {
    const image = frame(v);
    await answer({ allow: true, image });
  } catch {
    await answer({ allow: true, error: 'failed' });
  }
}

async function screen() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('unsupported');
  stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  await v.play();
  await new Promise((r) => setTimeout(r, 300));
  const image = frame(v);
  await answer({ allow: true, image });
}
