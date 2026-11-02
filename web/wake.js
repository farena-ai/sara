// Phase 126 (docs/design/WAKE.md §8.1, §8.2): Settings → Her → Hey Sara. The top block is this device
// and only exists inside the apps (the Windows app's window.SaraDesktop, the Android app's
// window.SaraPhone): the switch, the pack, the microphone, how easily she wakes, the chime, "just
// mine", the talk shortcut, Try it and Remove. Below: the words that wake her (each for one of your
// companions), where she answers, your devices (Stop listening on any of them), Turn off everywhere,
// and the owner's two server switches. A browser can't listen: it says so and points to the apps.
import { t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
const status = (text) => {
  $('#wk-status').textContent = text;
};

/** The app around the page, if any: the Windows app or the Android app. */
function native() {
  const d = window.SaraDesktop;
  if (d && d.platform === 'windows' && typeof d.call === 'function') return { kind: 'windows', call: (op, a = {}) => d.call('wake', { op, ...a }) };
  const p = window.SaraPhone;
  if (p && typeof p.wake === 'function') return { kind: 'android', call: async (op, a = {}) => JSON.parse(p.wake(op, JSON.stringify(a)) || 'null') };
  return null;
}

const PAUSE_WORDS = () => ({
  'server-off': t('Hey Sara is off on this server.'),
  'members-off': t('Hey Sara is off for members on this server.'),
  disclosure: t('Read and accept the AI notice in Sara first.'),
  'private-hearing': t('Paused while Nothing leaves this computer is on, because her hearing uses the internet. Install hearing on this computer (Settings → Voice) to keep it.'),
  'no-voice': t('Hey Sara needs her hearing and her voice: Settings → Voice.'),
  locked: t('Paused while the screen is locked.'),
  call: t('Paused during your call.'),
  battery: t('Paused to save battery.'),
  mic: t('Windows is blocking the microphone for desktop apps: Settings → Privacy & security → Microphone.'),
  hour: t('Paused for an hour.'),
  offline: t('Paused: Sara’s server isn’t answering.'),
  pack: t('Needs the download first.'),
});
const STATE_WORDS = () => ({ off: t('Off'), asleep: t('Listening for “Hey Sara”'), woken: t('Listening…'), hearing: t('Listening…'), thinking: t('Thinking…'), speaking: t('Speaking'), paused: t('Paused') });

let data = null;
let dev = null;
let wired = false;

function deviceLine(d) {
  const where = { windows: 'Windows', android: 'Android', mac: 'Mac', linux: 'Linux' }[d.platform] ?? d.platform;
  const state = d.on ? (d.paused ? `${t('paused')}: ${PAUSE_WORDS()[d.paused] ?? d.paused}` : t('listening')) : t('off');
  const last = d.lastWake ? ` · ${t('last woke {when}', { when: new Date(d.lastWake).toLocaleString() })}` : '';
  return `${d.label} (${where}) · ${state}${d.pack ? ` · ${t('pack')} ${d.pack.replace(/^wake-pack-/, '')}` : ''}${last}`;
}

function renderPhrases() {
  const box = $('#wk-phrases');
  box.replaceChildren();
  const names = new Map((data.companions ?? []).map((c) => [c.id, c.name]));
  for (const p of data.settings.phrases) {
    const row = el('div', 'wk-item');
    row.append(el('span', 'wk-item-main', `“${p.text}” → ${names.get(p.companionId) ?? p.companionId}`));
    if (data.settings.phrases.length > 1)
      row.append(
        btn(t('Remove'), 'ghost', async () => {
          await save({ phrases: data.settings.phrases.filter((x) => x.label !== p.label) });
        }),
      );
    box.append(row);
  }
  const forSel = $('#wk-new-for');
  forSel.replaceChildren(...(data.companions ?? []).map((c) => new Option(c.name, c.id)));
  $('#wk-add').disabled = data.settings.phrases.length >= 4;
  $('#wk-lex-row').hidden = data.lexicon.installed;
  $('#wk-lexicon').hidden = data.member;
  if (data.lexicon.state === 'downloading') $('#wk-lex-note').textContent = t('Downloading the word list…');
  else if (data.lexicon.error) $('#wk-lex-note').textContent = data.lexicon.error;
}

function renderDevices() {
  const box = $('#wk-devices');
  box.replaceChildren();
  if (!data.devices.length) box.append(el('p', 'muted small', t('No device listens yet. Switch it on in the Windows or Android app.')));
  for (const d of data.devices) {
    const row = el('div', 'wk-item');
    const dot = el('span', `wk-dot${d.on && !d.paused ? '' : ' wk-grey'}`);
    dot.setAttribute('aria-hidden', 'true');
    row.append(dot, el('span', 'wk-item-main', `${d.me ? `${t('This device')} · ` : ''}${deviceLine(d)}`));
    if (d.on)
      row.append(
        btn(t('Stop listening'), 'ghost', async () => {
          await api(`/wake/device/${encodeURIComponent(d.id)}/off`, { method: 'POST', body: {} });
          await loadWakePage();
        }),
      );
    else if (!d.me) row.append(el('span', 'muted small', t('switch it on on that device')));
    box.append(row);
  }
}

async function renderThis() {
  const n = native();
  $('#wk-app').hidden = !n;
  $('#wk-no-app').hidden = Boolean(n);
  $('#wk-browser').hidden = Boolean(n);
  if (!n) return;
  try {
    dev = await n.call('state');
  } catch {
    dev = null;
  }
  if (!dev || dev.available === false) {
    $('#wk-app').hidden = true;
    $('#wk-no-app').hidden = false;
    $('#wk-no-app').textContent = t('Update the Sara app on this device to use Hey Sara.');
    return;
  }
  const phone = n.kind === 'android';
  $('#wk-this-name').textContent = dev.label ?? '';
  $('#wk-on-label').textContent = phone ? t('Listen for “Hey Sara” on this phone') : t('Listen for “Hey Sara” on this computer');
  $('#wk-personal-label').textContent = phone ? t('This phone is just mine') : t('This computer is just mine');
  $('#wk-on').checked = Boolean(dev.on);
  $('#wk-pack').textContent = dev.pack?.installed ? t('The speech model is on this device (checked).') : t('Needs a {mb} MB download (speech model and engine, from the sherpa-onnx project).', { mb: String(dev.pack?.mb ?? 25) });
  const why = dev.reason ? (PAUSE_WORDS()[dev.reason] ?? dev.reason) : '';
  $('#wk-state').textContent = `${STATE_WORDS()[dev.state] ?? ''}${why ? ` · ${why}` : ''}`;
  const mic = $('#wk-mic');
  mic.closest('label').hidden = phone;
  mic.replaceChildren(new Option(t('System default'), ''), ...(dev.mics ?? []).map((m) => new Option(m.name, m.id)));
  mic.value = dev.mic ?? '';
  $('#wk-sens').value = dev.sensitivity ?? 'normal';
  $('#wk-chime').checked = dev.chime !== false;
  $('#wk-personal').checked = Boolean(dev.personal);
  $('#wk-locked-row').hidden = phone;
  $('#wk-locked').checked = dev.locked !== false;
  $('#wk-charging-row').hidden = !phone;
  $('#wk-charging').checked = Boolean(dev.onlyCharging);
  const sc = $('#wk-shortcut');
  sc.closest('label').hidden = phone;
  sc.replaceChildren(...(dev.shortcuts ?? []).map((s) => new Option(s.label, s.id)));
  sc.value = dev.shortcut ?? '';
  const mine = data.devices.find((d) => d.me);
  const today = mine?.today;
  $('#wk-today').textContent = today ? t('Today: woke {w} times · answered {a} · nothing said {n}', { w: String(today.wakes), a: String(today.answered), n: String(today.nothing) }) : '';
  $('#wk-hint').hidden = !today?.hint;
  $('#wk-hint').textContent = today?.hint ? t('She woke up {n} times today without being asked. Make her harder to wake?', { n: String(today.nothing + today.stopped) }) : '';
  $('#wk-remove').hidden = !dev.pack?.installed;
}

async function save(patch) {
  try {
    data.settings = (await api('/wake', { method: 'PUT', body: patch })).settings;
    renderPhrases();
    status(t('Saved.'));
  } catch (err) {
    status(err.message);
  }
}

async function devSet(key, value) {
  const n = native();
  if (!n) return;
  try {
    dev = await n.call('set', { key, value: String(value) });
    // The server keeps this device's record (on/off from this device only, counters, room or personal).
    if (dev) await api('/wake/device', { method: 'PUT', body: { on: Boolean(dev.on), platform: n.kind, label: dev.label, pack: dev.pack?.installed ? 'wake-pack-1' : '', sensitivity: dev.sensitivity, personal: Boolean(dev.personal), chime: dev.chime !== false } });
  } catch (err) {
    status(err.message);
  }
  await loadWakePage();
}

function wire() {
  if (wired) return;
  wired = true;
  $('#wk-on').addEventListener('change', async (e) => {
    const on = e.target.checked;
    if (on && !dev?.pack?.installed) {
      const ok = window.confirm(
        [
          t('Before Sara listens:'),
          t('While this is on, the microphone is open, and a small speech model on this device listens only for “Hey Sara” and “stop”.'),
          t('Nothing you say is sent anywhere until you say “Hey Sara”. Then what you say next goes to your Sara server to be heard and answered, like a voice message.'),
          t('You’ll see a dot on Sara’s icon whenever the microphone is open, and the system shows its microphone icon too.'),
          t('Say “stop”, press Esc, or choose Pause at any time.'),
          t('Download: {mb} MB from the sherpa-onnx project (Apache-2.0), checked before use.', { mb: String(dev?.pack?.mb ?? 25) }),
        ].join('\n\n'),
      );
      if (!ok) {
        e.target.checked = false;
        return;
      }
    }
    status(on ? t('Turning on…') : '');
    await devSet('on', on ? '1' : '0');
  });
  for (const [id, key] of [['#wk-mic', 'mic'], ['#wk-sens', 'sensitivity'], ['#wk-shortcut', 'shortcut']]) $(id).addEventListener('change', (e) => void devSet(key, e.target.value));
  for (const [id, key] of [['#wk-chime', 'chime'], ['#wk-personal', 'personal'], ['#wk-locked', 'locked'], ['#wk-charging', 'onlyCharging']]) $(id).addEventListener('change', (e) => void devSet(key, e.target.checked ? '1' : '0'));
  $('#wk-try').addEventListener('click', async () => {
    const n = native();
    if (!n) return;
    $('#wk-try-out').textContent = t('Listening for 20 seconds… say “Hey Sara”.');
    try {
      const r = await n.call('try');
      const hits = r?.hits ?? [];
      $('#wk-try-out').textContent = hits.length ? t('Heard: {list}', { list: hits.join(', ') }) : t('Nothing heard. Try “Wakes easily”, or another microphone.');
    } catch (err) {
      $('#wk-try-out').textContent = err.message;
    }
  });
  $('#wk-remove').addEventListener('click', async () => {
    if (!window.confirm(t('Remove Hey Sara from this device? The speech model is deleted and the microphone stays closed.'))) return;
    await devSet('remove', '1');
  });
  $('#wk-add').addEventListener('click', async () => {
    const text = $('#wk-new').value.trim();
    if (!text) return;
    const check = await api('/wake/phrase-check', { method: 'POST', body: { text } }).catch((err) => ({ ok: false, why: err.message }));
    if (!check.ok) {
      $('#wk-new-why').textContent = check.why;
      return;
    }
    $('#wk-new-why').textContent = '';
    $('#wk-new').value = '';
    await save({ phrases: [...data.settings.phrases, { text, companionId: $('#wk-new-for').value }] });
  });
  $('#wk-lexicon').addEventListener('click', async () => {
    try {
      await api('/wake/lexicon', { method: 'POST', body: {} });
      $('#wk-lex-note').textContent = t('Downloading the word list…');
    } catch (err) {
      $('#wk-lex-note').textContent = err.message;
    }
  });
  $('#wk-talks').addEventListener('change', (e) => void save({ talksIn: e.target.value }));
  $('#wk-starts').addEventListener('change', (e) => void save({ starts: e.target.value }));
  $('#wk-follow').addEventListener('change', (e) => void save({ followUpSeconds: Number(e.target.value) }));
  $('#wk-off-all').addEventListener('click', async () => {
    await api('/wake/off', { method: 'POST', body: {} });
    if (data.server && !data.member && window.confirm(t('Also turn Hey Sara off for everyone on this server?'))) await api('/wake/server', { method: 'PUT', body: { allowed: false } });
    await loadWakePage();
  });
  for (const [id, key] of [['#wk-allow', 'allowed'], ['#wk-members', 'members']]) $(id).addEventListener('change', async (e) => {
    await api('/wake/server', { method: 'PUT', body: { [key]: e.target.checked } }).catch((err) => status(err.message));
  });
}

/** Opens the page (Settings → Her → Hey Sara). */
export async function loadWakePage() {
  wire();
  try {
    data = await api('/wake');
  } catch (err) {
    status(err.message);
    return;
  }
  $('#wk-talks').value = data.settings.talksIn;
  $('#wk-starts').value = data.settings.starts;
  $('#wk-starts').querySelector('option[value="call"]').disabled = !data.liveCalls;
  $('#wk-follow').value = String(data.settings.followUpSeconds);
  $('#wk-server').hidden = !data.server;
  if (data.server) {
    $('#wk-allow').checked = data.server.allowed;
    $('#wk-members').checked = data.server.members;
  }
  renderPhrases();
  renderDevices();
  await renderThis();
  status(data.paused ? (PAUSE_WORDS()[data.paused] ?? '') : '');
}

/** A wake event from the server (a device switched on, off or paused): refresh if the page is open. */
export function wakeEvent() {
  const page = document.querySelector('.settings-page[data-page="her-hey"]');
  if (page && !page.hidden) void loadWakePage();
}

/** Settings → Voice: Install hearing and voices on this computer (part C, owner only). */
export function renderVoiceInstall(v) {
  const row = $('#v-install-row');
  if (!row) return;
  const inst = v?.install;
  row.hidden = !inst?.installable && inst?.job?.state !== 'running';
  const s = $('#v-install-status');
  const j = inst?.job;
  s.textContent = !j ? t('About {mb} MB.', { mb: String(inst?.mb ?? 650) }) : j.state === 'running' ? t('Installing… {n} of {of}: {pct} %', { n: String((j.progress?.index ?? 0) + 1), of: String(j.progress?.of ?? 4), pct: String(j.progress?.total ? Math.floor((j.progress.bytes / j.progress.total) * 100) : 0) }) : j.state === 'done' ? t('Installed. Choose “On this server” for hearing and her voice.') : (j.error ?? '');
  const b = $('#v-install');
  b.disabled = j?.state === 'running';
  if (!b.dataset.wired) {
    b.dataset.wired = '1';
    b.addEventListener('click', async () => {
      if (!window.confirm(t('Download her own hearing and voices (about {mb} MB)? Every file is checked before use.', { mb: String(inst?.mb ?? 650) }))) return;
      try {
        await api('/voice/install', { method: 'POST', body: {} });
      } catch (err) {
        s.textContent = err.message;
        return;
      }
      const poll = async () => {
        const nv = await api('/voice').catch(() => null);
        renderVoiceInstall(nv);
        if (nv?.install?.job?.state === 'running') setTimeout(poll, 2000);
      };
      void poll();
    });
  }
}
