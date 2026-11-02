// Phase 122 part 2 (docs/design/BRIDGES4.md §7.3, §8.3): Settings → Connections → Matrix. Before it
// is added: what it is, what he needs, the terms box (a tick he must give) and Start. After that the
// WhatsApp stepper (web/whatsapp.js): one step open at a time, the exact Element screens as a
// numbered list, a check Sara runs; a step turns ✓ only when Sara checked it. Every failure is one
// plain sentence with the fix (DIAG, the same codes as plugins/matrix/diagnose.mjs). Connected: a
// summary, Test, her rooms (Answer here, Leave; encrypted ones under *Rooms she can't read*), Log
// her out. Her password is typed once for *Log her in*, sent once and forgotten.
import { t } from './naming.js';
import { addBuiltin } from './plugins.js';

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
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', text);
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
const enc = encodeURIComponent;
const ELEMENT = 'https://app.element.io';

/** Every diagnosis code (§7.4): the title, then the fix. */
export const DIAG = {
  HS_NOT_FOUND: () => [t("Couldn't find a Matrix server for her account."), t('Check the part after the colon in her Matrix ID.')],
  NO_PASSWORD_LOGIN: () => [t("Her server doesn't take passwords from apps."), t('Paste an access token instead (Advanced, below).')],
  LOGIN_WRONG: () => [t('Wrong Matrix ID or password for her account.'), t('Check both and try again.')],
  TOKEN_GONE: () => [t('Her login ended (someone logged that session out).'), t('Log her in again.')],
  ENCRYPTED_ROOM: () => [t("That room is encrypted, so she can't read it."), t('Make a new room with encryption off (step 3).')],
  NOT_INVITED: () => [t("She hasn't been invited yet."), t('In the room: Invite → her Matrix ID.')],
  RATE_LIMITED: () => [t('Her server asked her to slow down.'), t("She'll send the rest shortly.")],
  MEDIA_TOO_BIG: () => [t('That file is bigger than her server allows.'), t("It's in the app.")],
  TAILNET_OFF: () => [t("That's a Tailscale address, but this computer isn't on Tailscale."), t('Start Tailscale on this computer, then check again.')],
  PRIVATE_LOCAL: () => [t('Paused: "Nothing leaves this computer" is on.'), t('Her server keeps your messages; she reads them when it is off.')],
  NOT_SET: () => [t('Log her in first.'), t('Step 2.')],
  NOT_RUNNING: () => [t("The Matrix plugin isn't running."), t('Switch it on for her in Settings → Plugins.')],
  NOT_ON: () => [t('Matrix is added but switched off.'), t('Switch it on for her in Settings → Plugins.')],
  UNKNOWN: () => [t('Her Matrix server said something Sara does not know.'), t('Press Details, or try again.')],
};

/** The five steps (§7.3): title, the exact path (one click per line), the page to open. */
const STEPS = {
  account: () => [t('Make her a Matrix account'), t('app.element.io in a private browser window → Create account → server matrix.org (or Edit for your own) → a username, like sara-frank, and a password → the terms and the CAPTCHA → Sign out afterwards'), ELEMENT],
  login: () => [t('Log her in to Sara'), t('Type her Matrix ID and password, then press Log her in. The password is used once and not kept.'), null],
  room: () => [t('Make a room for the two of you, without encryption'), t('Element on the web or desktop, as yourself → + next to Rooms → New room → name it Sara → keep Private room → switch Enable end-to-end encryption off → Create room → Invite → her Matrix ID'), ELEMENT],
  hello: () => [t('Say hello'), t('In that room, send the code below. Element may ask Unknown command: press Send as message.'), null],
  test: () => [t('Test'), t('Checks every step and sends nothing to anyone.'), null],
};

let view = null;
let open = '';
let companion = 'main';
let code = '';

function diagLine(d) {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  if (!d) return box;
  const [title, fix] = (DIAG[d.code] ?? DIAG.UNKNOWN)();
  box.dataset.state = 'warn';
  box.append(el('strong', '', title), el('span', '', fix));
  if (d.detail) {
    const det = el('details', 'wa-details');
    det.append(el('summary', '', t('Details')), el('code', '', `${d.code} ${d.detail}`.trim()));
    box.append(det);
  }
  return box;
}
function okLine(text) {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  box.dataset.state = 'ok';
  box.textContent = `✓ ${text}`;
  return box;
}
function field(id, label, tipText, o = {}) {
  const row = el('label', 'plg-field');
  const head = el('span', 'plg-field-name');
  head.append(el('span', '', label), tip(tipText));
  const input = document.createElement('input');
  input.id = id;
  input.type = o.type ?? 'text';
  input.autocomplete = o.type === 'password' ? 'new-password' : 'off';
  input.spellcheck = false;
  input.dataset.nodirty = '';
  if (o.value) input.value = o.value;
  if (o.placeholder) input.placeholder = o.placeholder;
  row.append(head, input);
  return row;
}
function copyRow(label, value, tipText) {
  const row = el('div', 'wa-copy');
  const head = el('span', 'plg-field-name');
  head.append(el('span', '', label), tip(tipText));
  row.append(head, el('code', 'wa-mono', value || '—'), btn(t('Copy'), 'ghost', async (b) => {
    await navigator.clipboard?.writeText(value).catch(() => undefined);
    b.textContent = t('Copied');
  }));
  return row;
}

async function check(step, out) {
  out.replaceChildren(el('span', 'muted small', t('Checking…')));
  try {
    const r = await api('/plugins/matrix/check', { method: 'POST', body: { companion, step } });
    out.replaceChildren(r.ok ? okLine(t('Checked')) : diagLine(r.diagnosis));
    if (r.ok) await load();
  } catch (err) {
    out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
  }
}

async function expect() {
  if (code) return;
  const r = await api('/plugins/matrix/fix', { method: 'POST', body: { companion, fix: 'expect' } }).catch(() => null);
  code = r?.code ?? '';
}

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const st = view.steps.find((s) => s.id === id);
  const [, path] = STEPS[id]();
  const clicks = String(path).split(' → ').map((x) => x.trim()).filter(Boolean);
  const list = el('ol', 'wa-path');
  for (const c of clicks) list.append(el('li', '', c));
  body.append(clicks.length > 1 ? list : el('p', 'wa-path', path));
  if (id === 'account') body.append(el('p', 'muted small', t('Use a separate account for her, not your own.')));
  if (id === 'login') {
    if (view.me) body.append(okLine(t('Logged in as {mxid} (device {device})', { mxid: view.me, device: 'Sara (bot)' })));
    body.append(
      field('mx-id', t('Her Matrix ID'), t('Her own account, like @sara-frank:matrix.org. Make a separate account for her, not your own.'), { value: view.mxid, placeholder: '@sara-frank:matrix.org' }),
      field('mx-pass', t('Her password'), t("Typed once to log her in. Sara sends it to her server once and doesn't keep it anywhere."), { type: 'password' }),
      btn(t('Log her in'), '', async () => {
        out.replaceChildren(el('span', 'muted small', t('Checking…')));
        const pass = $('#mx-pass');
        try {
          const r = await api('/plugins/matrix/login', { method: 'POST', body: { companion, mxid: $('#mx-id').value.trim(), password: pass.value } });
          pass.value = '';
          if (!r.ok) return void out.replaceChildren(diagLine(r.diagnosis));
          out.replaceChildren(okLine(t('Logged in as {mxid} (device {device})', { mxid: r.userId, device: 'Sara (bot)' })));
          await load();
        } catch (err) {
          pass.value = '';
          out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
        }
      }),
    );
    if (view.homeserver) body.append(el('p', 'muted small', t('Her homeserver: {host}', { host: view.homeserver })));
    const adv = el('details', 'wa-details');
    adv.append(el('summary', '', t('Advanced: paste an access token')), el('p', 'small', t('From Element as her: Settings → Help & About → Advanced → Access Token. Logging out of that Element session ends the token.')));
    adv.append(field('mx-token', t('Access token'), t("Her login key, made when you pressed Log her in (her password isn't kept). Kept encrypted in Sara's vault."), { type: 'password' }), btn(t('Use this token'), 'ghost', async () => {
      const tok = $('#mx-token');
      try {
        const r = await api('/plugins/matrix/token', { method: 'POST', body: { companion, mxid: $('#mx-id').value.trim(), token: tok.value.trim() } });
        tok.value = '';
        out.replaceChildren(r.ok ? okLine(t('Checked')) : diagLine(r.diagnosis));
        if (r.ok) await load();
      } catch (err) {
        out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
      }
    }));
    body.append(adv);
  }
  if (id === 'room') {
    void expect();
    body.append(copyRow(t('Her Matrix ID'), view.me || view.mxid, t('Invite this account to your new room. She joins by herself.')), el('p', 'muted small', t("Easier on a computer: Element's mobile app may not let you switch encryption off.")));
    const joined = view.rooms.filter((r) => !r.encrypted);
    if (joined.length) body.append(okLine(t('She joined {room}', { room: joined[0].name })));
    body.append(btn(t('Check'), '', () => check('room', out)));
  }
  if (id === 'hello') {
    const row = el('div', 'add-row');
    row.append(btn(t('Link my Matrix'), '', async () => {
      code = '';
      await expect();
      render();
    }), tip(t("Gives a code for 10 minutes. Send it in your room with her. That's how she knows which room and which account are you.")));
    body.append(row);
    if (code) body.append(copyRow(t('Send this in your room'), `/link ${code}`, t('Element may ask Unknown command: press Send as message. Typing Sara link and the code works too.')));
  }
  if (id === 'test') {
    const row = el('div', 'add-row');
    row.append(btn(t('Test'), '', () => test(out)), tip(t('Checks her server, her login, the sync, your room (and that it is not encrypted) and the link. Sends nothing to anyone.')));
    body.append(row);
  }
  if (st?.diagnosis && !out.childNodes.length) out.append(diagLine(st.diagnosis));
  body.append(out);
  const nav = el('div', 'wa-nav');
  const ids = view.steps.map((s) => s.id);
  const i = ids.indexOf(id);
  if (i > 0) nav.append(btn(`← ${t('Back')}`, 'ghost', () => ((open = ids[i - 1]), render())));
  if (i < ids.length - 1) nav.append(btn(t('Next'), st?.ok || id === 'account' ? '' : 'ghost', () => ((open = ids[i + 1]), render())));
  body.append(nav);
  return body;
}

async function test(out) {
  out.replaceChildren(el('span', 'muted small', t('Checking…')));
  const r = await api('/plugins/matrix/check', { method: 'POST', body: { companion, step: 'test' } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
  const ul = el('ul', 'wa-test');
  let first = true;
  for (const s of r.steps ?? []) {
    const li = el('li', s.ok ? 'ok' : first ? 'bad' : 'grey', `${s.ok ? '✓' : '✕'} ${s.label}`);
    if (!s.ok && first && s.fix) li.append(el('span', 'muted small', ` ${s.fix}`));
    if (!s.ok) first = false;
    ul.append(li);
  }
  out.replaceChildren(ul);
  if (r.ok) await load();
}

function side() {
  const col = el('div', 'wa-side');
  const card = el('div', 'kit-card');
  const [, path, url] = STEPS[open]?.() ?? [];
  card.append(el('h3', '', t('The screen you need')), el('p', 'small', path ?? ''));
  if (url) {
    const a = el('a', 'button-link', t('Open Element ↗'));
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    card.append(a);
  }
  const diff = el('a', 'small', t('This screen looks different?'));
  diff.href = '/help#matrix';
  diff.target = '_blank';
  card.append(diff);
  const good = el('div', 'kit-card');
  good.append(el('h3', '', t('Good to know')), el('p', 'small', t('Rooms with her are not end-to-end encrypted: whoever runs the servers can read them. For private chats use Signal.')), el('p', 'small', t('Commands work with her name first too: Sara help, Sara new.')));
  col.append(card, good);
  return col;
}

function termsBox(onTick) {
  const box = el('div', 'kit-card wa-terms');
  box.append(el('h3', '', t('About Matrix')), el('p', 'small', t("Her room with you is not end-to-end encrypted, so whoever runs the servers (matrix.org, or yours) can read it. Use a separate account for her, and follow your server's rules.")));
  const row = el('label', 'row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'mx-terms-tick';
  cb.dataset.nodirty = '';
  cb.addEventListener('change', () => onTick(cb.checked));
  row.append(cb, el('span', '', t('I understand and want to continue.')));
  box.append(row);
  return box;
}

function intro(box, builtin) {
  const card = el('div', 'kit-card');
  card.append(el('h3', '', t('Set up Matrix')), el('p', '', t('Talk to her in Element or any Matrix app, through a Matrix account of her own. Free, about 15 minutes, once.')));
  const ul = el('ul', 'plg-setup');
  for (const x of [t('An email address for her new account (matrix.org asks for one)'), t('Your own Matrix account, in Element'), t('About 15 minutes at a computer')]) ul.append(el('li', '', x));
  card.append(el('h4', '', t('What you need')), ul);
  const start = btn(t('Start'), '', async () => {
    localStorage.setItem('mx-terms', new Date().toISOString());
    await addBuiltin('matrix');
  });
  start.disabled = true;
  if (!builtin) start.hidden = true;
  box.replaceChildren(card, termsBox((on) => (start.disabled = !on)), start, ...(builtin ? [] : [el('p', 'muted small', t("Matrix doesn't come with this copy of Sara."))]));
}

const placeWord = (p) => ({ 'owner-dm': t('your room with her'), dm: t('a private room'), room: t('a group room'), encrypted: t('encrypted') })[p] ?? p;

function roomsCard() {
  const card = el('div', 'kit-card');
  card.append(el('h3', '', t('Rooms')));
  const ul = el('ul', 'dev-list');
  const readable = view.rooms.filter((r) => !r.encrypted);
  for (const r of readable) {
    const li = el('li', '');
    li.append(el('span', '', `${r.name} · ${r.members === 1 ? t('1 member') : t('{n} members', { n: r.members })} · ${placeWord(r.place)}`));
    if (r.place === 'room') li.append(btn(t('Answer here'), 'ghost', async () => {
      await api('/plugins/matrix/group', { method: 'POST', body: { companion, chat: r.id, on: true } }).catch(() => undefined);
      await load();
    }));
    if (r.place !== 'owner-dm') li.append(btn(t('Leave'), 'ghost', async () => {
      await api('/plugins/matrix/fix', { method: 'POST', body: { companion, fix: 'leave', room: r.id } }).catch(() => undefined);
      await load();
    }));
    ul.append(li);
  }
  card.append(readable.length ? ul : el('p', 'muted small', t('No rooms yet.')));
  const locked = view.rooms.filter((r) => r.encrypted);
  if (locked.length) {
    card.append(el('h4', '', t("Rooms she can't read")));
    const ul2 = el('ul', 'dev-list muted');
    for (const r of locked) ul2.append(el('li', '', `${r.name} · ${t('encrypted')}`));
    card.append(ul2, el('p', 'muted small', t('Encrypted rooms stay encrypted. Make a new room with encryption off.')));
  }
  return card;
}

function summary() {
  const card = el('div', 'kit-card');
  const mine = view.rooms.find((r) => r.place === 'owner-dm');
  card.append(el('h3', '', t('Connected')), el('p', '', [view.me || view.mxid, view.syncing ? t('Connected') : '', mine ? t('linked to you in {room}', { room: mine.name }) : ''].filter(Boolean).join(' · ')));
  const out = el('div', 'wa-check');
  const row = el('div', 'add-row');
  row.append(
    btn(t('Test'), '', () => test(out)),
    btn(t('Set up again'), 'ghost', () => ((open = 'account'), (view.forceSteps = true), render())),
    btn(t('Log her out'), 'ghost', async (b) => {
      if (!confirm(t('Log her out of Matrix? Her login key is ended at her server and removed from Sara.'))) return;
      b.disabled = true;
      await api('/plugins/matrix/fix', { method: 'POST', body: { companion, fix: 'logout' } }).catch(() => undefined);
      await load();
    }),
  );
  card.append(row, out, el('p', 'muted small', t('Rooms with her are not end-to-end encrypted: whoever runs the servers can read them. For private chats use Signal.')));
  const who = el('div', 'kit-card');
  who.append(el('h3', '', t('Who can reach her')), el('p', 'small', view.others ? t('You and the Matrix IDs or servers on your list, as partners: no tools, nothing private, the AI notice first.') : t('Only you. Invites from anyone else are declined.')));
  return [card, roomsCard(), who];
}

function render() {
  const box = $('#mx-box');
  const chip = $('#mx-chip');
  if (!box || !view) return;
  const all = view.done === view.steps.length;
  chip.textContent = view.state === 'ok' && all ? t('Connected') : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.installed ? t('{n} of {total} done', { n: view.done, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = view.state === 'ok' && all ? 'ok' : view.state === 'error' || view.state === 'paused' ? 'warn' : '';
  if (!view.installed) return;
  if (all && !view.forceSteps) return void box.replaceChildren(...summary());
  if (!open || !view.steps.some((s) => s.id === open)) open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  const list = el('ol', 'wa-steps');
  for (const [i, s] of view.steps.entries()) {
    const [title] = STEPS[s.id]();
    const li = el('li', `wa-step${s.ok ? ' done' : ''}${s.id === open ? ' open' : ''}`);
    const head = btn(`${s.ok ? '✓' : s.id === open ? '●' : '○'} ${i + 1} ${title}`, 'wa-step-head', () => ((open = s.id), render()));
    head.setAttribute('aria-expanded', String(s.id === open));
    li.append(head);
    if (s.id === open) li.append(stepBody(s.id));
    list.append(li);
  }
  const left = el('div', 'kit-card wa-stepper');
  left.append(el('div', 'card-head', ''), list);
  left.firstChild.append(el('h3', '', t('Set up Matrix')), el('span', 'muted small', t('{n} of {total}', { n: view.done, total: view.steps.length })));
  const grid = el('div', 'wa-grid');
  grid.append(left, side());
  box.replaceChildren(grid);
}

async function load() {
  try {
    const { plugins } = await api('/plugins');
    const p = plugins.find((x) => x.id === 'matrix');
    companion = p?.companions.find((c) => c.on)?.id ?? companion;
    const keep = view?.forceSteps;
    view = await api(`/plugins/matrix/setup?companion=${enc(companion)}`);
    if (keep) view.forceSteps = true;
    if (view.installed && !view.terms && localStorage.getItem('mx-terms')) await api('/plugins/matrix/terms', { method: 'POST', body: { companion } }).catch(() => undefined);
    if (!view.installed) {
      const { builtin } = await api('/plugins/builtin');
      render();
      intro($('#mx-box'), builtin.some((b) => b.id === 'matrix'));
      return;
    }
    render();
  } catch (err) {
    $('#mx-box')?.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadMatrixPage() {
  await load();
}
