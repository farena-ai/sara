// R5 (docs/PHONE_CALLS.md): the Phone calls section (Settings → Connections → Phone and
// notifications) and Discord's Voice channel section. Switched off by default; the test call stays
// disabled until everything is set up and on; the account SID and token go to the vault and are never
// shown again. Strangers are screened and every call she places asks first (on its own card).
import { t } from './naming.js';

/** @type {{ api: (path: string, o?: object) => Promise<any> } | null} */
let ctx = null;
let data = null;
const $ = (s) => document.querySelector(s);

export function initPhoneCalls(c) {
  ctx = c;
  const save = (body) => void put('/phone-calls', body);
  $('#tel-on')?.addEventListener('change', (e) => save({ on: e.target.checked }));
  $('#tel-record')?.addEventListener('change', (e) => save({ record: e.target.checked }));
  $('#tel-provider')?.addEventListener('change', (e) => save({ provider: e.target.value }));
  for (const [id, key] of [['#tel-number', 'number'], ['#tel-owner', 'ownerNumber'], ['#tel-url', 'publicUrl']]) $(id)?.addEventListener('change', (e) => save({ [key]: e.target.value.trim() }));
  $('#tel-max')?.addEventListener('change', (e) => save({ maxMinutes: Number(e.target.value) }));
  $('#tel-price')?.addEventListener('change', (e) => save({ pricePerMinute: e.target.value === '' ? null : Number(e.target.value) }));
  $('#tel-allow')?.addEventListener('change', (e) => save({ allow: parseAllow(e.target.value) }));
  $('#tel-creds-save')?.addEventListener('click', () => void saveCreds());
  $('#tel-creds-remove')?.addEventListener('click', () => void put('/phone-calls/credentials', null, 'DELETE'));
  $('#tel-test')?.addEventListener('click', () => void testCall());
  for (const id of ['#dcv-guild', '#dcv-channel']) $(id)?.addEventListener('change', () => void put('/phone-calls/discord', { guildId: $('#dcv-guild').value.trim(), channelId: $('#dcv-channel').value.trim() }));
  $('#dcv-join')?.addEventListener('click', () => void joinVoice());
}

/** "Mom, +15125550142" per line. */
export function parseAllow(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^(.*?)[,;:\t]\s*(\+?[\d\s().-]{7,})$/.exec(l);
      return m ? { name: m[1].trim(), number: m[2].trim() } : { name: '', number: l };
    });
}

async function put(path, body, method = 'PUT') {
  if (!ctx) return;
  try {
    data = await ctx.api(path, { method, ...(body ? { body } : {}) });
    render();
  } catch (err) {
    const st = $('#tel-test-state');
    if (st) st.textContent = err.message;
    await loadPhoneCalls();
  }
}

async function saveCreds() {
  const sid = $('#tel-sid').value.trim();
  const token = $('#tel-token').value.trim();
  const st = $('#tel-creds-state');
  if (!sid || !token) {
    st.textContent = t('Add the phone provider’s account SID and auth token.');
    return;
  }
  try {
    data = await ctx.api('/phone-calls/credentials', { method: 'PUT', body: { sid, token } });
    $('#tel-sid').value = '';
    $('#tel-token').value = '';
    st.textContent = t('Saved to the vault.');
    render();
  } catch (err) {
    st.textContent = err.message;
  }
}

async function testCall() {
  const st = $('#tel-test-state');
  st.textContent = t('Calling…');
  try {
    const r = await ctx.api('/phone-calls/test', { method: 'POST', body: {} });
    st.textContent = t('Calling {number} now. Say “stop” to hang up.', { number: r.call.number });
  } catch (err) {
    st.textContent = err.message;
  }
}

async function joinVoice() {
  const st = $('#dcv-state');
  try {
    await ctx.api('/phone-calls/discord/join', { method: 'POST', body: {} });
    st.textContent = t('Joined.');
  } catch (err) {
    st.textContent = err.message;
  }
}

/** Settings → Phone and notifications (and Discord) opened: read the state. */
export async function loadPhoneCalls() {
  if (!ctx || !$('#tel-card')) return;
  try {
    data = await ctx.api('/phone-calls');
  } catch {
    // Not the owner, or the demo: the sections stay hidden.
    $('#tel-card').hidden = true;
    const d = $('#dcv-card');
    if (d) d.hidden = true;
    return;
  }
  render();
}

function render() {
  if (!data) return;
  const s = data.settings;
  const st = data.status;
  const set = (id, v) => {
    const n = $(id);
    if (n && document.activeElement !== n) n.value = v ?? '';
  };
  $('#tel-on').checked = Boolean(s.on);
  $('#tel-record').checked = Boolean(s.record);
  $('#tel-provider').value = s.provider;
  set('#tel-number', s.number);
  set('#tel-owner', s.ownerNumber);
  set('#tel-url', s.publicUrl);
  set('#tel-max', String(s.maxMinutes));
  set('#tel-price', s.pricePerMinute === null ? '' : String(s.pricePerMinute));
  set('#tel-allow', s.allow.map((a) => (a.name ? `${a.name}, ${a.number}` : a.number)).join('\n'));
  $('#tel-sid').placeholder = st.hasCreds ? t('saved in the vault') : t('not set');
  $('#tel-token').placeholder = st.hasCreds ? t('saved in the vault') : t('not set');
  $('#tel-creds-remove').hidden = !st.hasCreds;
  const chip = $('#tel-chip');
  chip.textContent = st.ready ? t('On') : st.configured ? t('Ready, switched off') : t('Switched off');
  chip.dataset.state = st.ready ? 'ok' : 'off';
  $('#tel-estimate').textContent = data.estimate;
  $('#tel-missing').replaceChildren(...st.missing.map((m) => Object.assign(document.createElement('li'), { textContent: m })));
  $('#tel-urls').textContent = data.urls ? t('In your provider’s number settings, set “A call comes in” to {url} (POST).', { url: data.urls.voice }) : '';
  $('#tel-test').disabled = !st.ready || !s.ownerNumber;
  $('#tel-test').title = st.ready ? (s.ownerNumber ? '' : t('Add your own number first.')) : st.missing.join(' ');
  $('#tel-calls').replaceChildren(
    ...data.calls.slice(0, 8).map((c) => {
      const row = document.createElement('div');
      row.className = 'tel-call';
      const who = c.name && c.name !== c.number ? `${c.name} · ${c.number}` : c.number;
      const head = document.createElement('strong');
      head.textContent = `${c.direction === 'inbound' ? t('From') : t('To')} ${who}`;
      const sub = document.createElement('span');
      sub.className = 'muted small';
      sub.textContent = [new Date(c.createdAt).toLocaleString(), c.summary].filter(Boolean).join(' · ');
      row.append(head, sub);
      return row;
    }),
  );
  const d = data.discord;
  if (d && $('#dcv-card')) {
    set('#dcv-guild', d.settings.guildId);
    set('#dcv-channel', d.settings.channelId);
    $('#dcv-on').checked = Boolean(d.on);
    $('#dcv-chip').textContent = d.on ? t('On') : t('Off');
    $('#dcv-state').textContent = d.missing.join(' ');
  }
}
