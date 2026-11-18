// T3 (docs/SELF_CODE.md): Settings → Privacy & system → Updates → Code changes. Her own code changes:
// ask for a fix, the one approval card per change (plain summary, the diff folded, the checks), Approve,
// Undo, Discard, and the optional "Send this fix to the Sara developers" with the exact preview.
// The server decides, refuses and audits (src/self-code.ts); this page only shows what it says.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {((path: string, o?: object) => Promise<any>) | null} */
let api = null;
let timer = 0;
/** U5.30: app.js's passkey / two-step / token prompt (confirmProof). */
let proof = null;
let swTimer = 0;

const STATUS = {
  working: 'Being prepared',
  proposed: 'Ready for your OK',
  refused: 'Refused',
  stopped: 'Stopped',
  failed: "Didn't pass its checks",
  discarded: 'Discarded',
  applying: 'Applying and restarting',
  applied: 'Applied',
  rolledback: 'Went back',
  undoing: 'Being undone',
  undone: 'Undone',
  parked: 'Parked after an update',
};
const STEP = { typecheck: 'Typecheck', related: 'Related tests', full: 'Full test suite', smoke: 'Test start' };
const BUSY = new Set(['working', 'applying', 'undoing']);

export function initSelfCode(c) {
  api = c.api;
  $('#cc-go')?.addEventListener('click', () => void prepare());
  for (const id of ['#cc-cap', '#cc-minutes']) $(id)?.addEventListener('change', () => void saveCaps());
  proof = c.proof ?? null;
  $('#cc-sw-on')?.addEventListener('change', () => void flip($('#cc-sw-on').checked));
  $('#cc-sw-go')?.addEventListener('click', () => void flip(true, { typed: $('#cc-sw-typed').value }));
  $('#cc-sw-typed')?.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), void flip(true, { typed: $('#cc-sw-typed').value })));
  $('#cc-sw-cancel')?.addEventListener('click', () => {
    $('#cc-sw-confirm').hidden = true;
    void loadSelfCode();
  });
  const page = document.querySelector('.settings-page[data-page="dh-updates"]');
  if (page) new MutationObserver(() => !page.hidden && void loadSelfCode()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
function options(sel, values, label, current) {
  if (!sel) return;
  sel.replaceChildren(...values.map((v) => Object.assign(el('option', '', label(v)), { value: String(v), selected: v === current })));
}

export async function loadSelfCode() {
  const host = $('#cc-host');
  if (!host || !api) return;
  let st;
  try {
    st = await api('/self-code');
  } catch {
    // Members, kid mode and the demo: owner only (the page itself is owner-only too).
    host.hidden = true;
    $('#cc-head')?.toggleAttribute('hidden', true);
    return;
  }
  host.hidden = false;
  drawSwitch(st.helper);
  const why = $('#cc-why');
  why.hidden = st.available;
  if (!st.available) why.textContent = `${t(st.why ?? 'She cannot change her own code on this install.')} ${t('To tell the developers about a problem: Settings → Privacy & system → Reports.')}`;
  // rootapply: on a Linux server the root helper applies an approved change (docs/SELF_CODE.md).
  if (st.available && st.mode === 'root-helper') {
    why.hidden = false;
    why.textContent = t("On this server a locked-down helper run by the system applies a change after you approve it. The server's administrator can turn it off.");
  }
  $('#cc-new').hidden = !st.available;
  options($('#cc-cap'), [1, 2, 5, 10], (v) => `$${v}`, st.cap);
  options($('#cc-minutes'), [10, 20, 40, 60], (v) => t('{n} minutes', { n: v }), st.minutes);
  const list = $('#cc-list');
  const shown = st.changes.filter((c) => c.status !== 'discarded').slice(0, 20);
  list.replaceChildren(...(shown.length ? shown.map(card) : [el('p', 'muted small', t('No code changes yet.'))]));
  clearTimeout(timer);
  if (shown.some((c) => BUSY.has(c.status))) timer = setTimeout(() => void loadSelfCode(), 5000);
}

// U5.30: the switch for the root helper. She only writes a request; root re-checks it and answers.
const WHO = () => ({ owner: t('you, from this page'), admin: t("the server's administrator"), install: t('the installer') });
function drawSwitch(h) {
  const box = $('#cc-switch');
  if (!box) return;
  box.hidden = !h;
  clearTimeout(swTimer);
  if (!h) return;
  $('#cc-sw-state').textContent = h.on ? t('Code changes on this server: on.') : t('Code changes on this server: off.');
  const who = h.locked ? t("Only the server's administrator can turn them on: they locked this switch. Turning them off still works.") : t("You can turn them on or off here; the server's administrator can too, or lock this switch.");
  const when = h.by && h.at ? ` ${t('Last changed by {who} on {date}.', { who: WHO()[h.by] ?? h.by, date: new Date(h.at).toLocaleString() })}` : '';
  $('#cc-sw-who').textContent = who + when;
  const tick = $('#cc-sw-on');
  tick.checked = h.pending ? h.pending === 'on' : h.on;
  tick.disabled = Boolean(h.pending) || (!h.on && h.locked);
  const msg = $('#cc-sw-msg');
  if (h.pending) {
    msg.textContent = t("Waiting for the server's helper to take it…");
    swTimer = setTimeout(() => void loadSelfCode(), 3000);
  } else if (h.last?.state === 'refused') msg.textContent = t('The helper refused the last request: {message}', { message: h.last.message });
  else msg.textContent = '';
}

async function flip(on, extra = {}) {
  const box = $('#cc-sw-confirm');
  const send = (body) => api('/self-code/helper', { method: 'POST', body: { on, ...body } });
  try {
    try {
      await send(extra);
    } catch (e) {
      if (!on || e.status !== 403 || !e.data?.confirm) throw e;
      if (e.data.confirm === 'typed') {
        // No passkey or two-step sign-in here: she asks you to type ON.
        box.hidden = false;
        if (extra.typed !== undefined) $('#cc-sw-msg').textContent = t('Type ON to confirm.');
        $('#cc-sw-typed').focus();
        return;
      }
      if (!proof) throw e;
      await send(await proof());
    }
    box.hidden = true;
    $('#cc-sw-typed').value = '';
  } catch (e) {
    if (e?.name !== t('Cancelled')) alert(e.message);
  }
  await loadSelfCode();
}

async function saveCaps() {
  await api('/self-code/settings', { method: 'PUT', body: { capUsd: Number($('#cc-cap').value), minutes: Number($('#cc-minutes').value) } }).catch((e) => alert(e.message));
}

async function prepare() {
  const text = $('#cc-request').value.trim();
  if (!text) return $('#cc-request').focus();
  $('#cc-go').disabled = true;
  try {
    await api('/self-code', { method: 'POST', body: { request: text } });
    $('#cc-request').value = '';
    await loadSelfCode();
  } catch (e) {
    alert(e.message);
  } finally {
    $('#cc-go').disabled = false;
  }
}

async function act(id, what, ask) {
  if (ask && !confirm(ask)) return;
  try {
    await api(`/self-code/${id}/${what}`, { method: 'POST', body: {} });
  } catch (e) {
    alert(e.message);
  }
  await loadSelfCode();
}

function card(c) {
  const box = el('div', 'cc-card');
  box.dataset.status = c.status;
  box.append(el('strong', 'cc-title', c.summary || c.request));
  const meta = [t(STATUS[c.status] ?? c.status), t('Spent {usd}', { usd: `$${(c.costUsd ?? 0).toFixed(2)}` }), `#${c.id}`];
  box.append(el('p', 'muted small cc-meta', meta.join(' · ')));
  if (c.summary && c.summary !== c.request) box.append(el('p', 'small cc-asked', t('You asked: {text}', { text: c.request })));
  if (c.noteKey) box.append(el('p', 'small cc-note', t(c.noteKey, c.noteParams ?? undefined)));
  if (c.checks?.steps?.length) {
    const ul = el('ul', 'small cc-checks');
    for (const s of c.checks.steps) ul.append(el('li', s.skipped ? 'muted' : s.ok ? 'cc-ok' : 'cc-bad', `${t(STEP[s.name] ?? s.name)}: ${t(s.skipped ? 'skipped' : s.ok ? 'passed' : 'failed')}`));
    box.append(ul);
  }
  if (c.files?.length) {
    const d = el('details', 'cc-diff');
    d.append(el('summary', '', `${t('Show the change')} (${c.files.join(', ')})`));
    const pre = el('pre', '', '…');
    d.append(pre);
    d.addEventListener('toggle', () => {
      if (!d.open || pre.dataset.done) return;
      void api(`/self-code/${c.id}`).then((r) => {
        const diff = r.change.diff || c.files.join('\n');
        // Added lines green, removed lines red (the file headers stay plain).
        pre.replaceChildren(...diff.split('\n').map((l) => el('span', /^\+(?!\+\+ )/.test(l) ? 'cc-add' : /^-(?!-- )/.test(l) ? 'cc-del' : '', `${l}\n`)));
        pre.dataset.done = '1';
      });
    });
    box.append(d);
  }
  const row = el('p', 'actions-left cc-actions');
  if (c.status === 'proposed') {
    row.append(button(t('Approve and apply'), '', () => void act(c.id, 'apply', t('Apply this change and restart Sara? She checks that she starts properly and goes back by herself if not.'))), ' ');
    row.append(button(t('Discard'), 'ghost', () => void act(c.id, 'discard')));
  } else if (c.status === 'applied') {
    row.append(button(t('Undo'), 'ghost', () => void act(c.id, 'undo', t('Take this change out and restart Sara?'))));
  } else if (['failed', 'refused', 'stopped', 'parked', 'rolledback'].includes(c.status)) {
    row.append(button(t('Discard'), 'ghost', () => void act(c.id, 'discard')));
  } else if (BUSY.has(c.status)) row.append(el('span', 'muted small', t('Working on it…')));
  box.append(row);
  if ((c.status === 'proposed' || c.status === 'applied') && c.files?.length) box.append(reportBox(c));
  return box;
}

function reportBox(c) {
  const wrap = el('div', 'cc-report');
  if (c.ticket) {
    wrap.append(el('p', 'muted small', t('Sent to the Sara developers ({ticket}).', { ticket: c.ticket })));
    return wrap;
  }
  const label = el('label', 'cc-tick');
  const tick = el('input');
  tick.type = 'checkbox';
  label.append(tick, ' ', t('Send this fix to the Sara developers'));
  const out = el('div', 'cc-preview');
  out.hidden = true;
  tick.addEventListener('change', async () => {
    out.hidden = !tick.checked;
    if (!tick.checked) return;
    out.replaceChildren(el('p', 'muted small', '…'));
    try {
      const r = await api(`/self-code/${c.id}/report`);
      const send = button(t('Send'), '', async () => {
        send.disabled = true;
        try {
          await api(`/self-code/${c.id}/report`, { method: 'POST', body: { send: true } });
          await loadSelfCode();
        } catch (e) {
          alert(e.message);
          send.disabled = false;
        }
      });
      out.replaceChildren(el('p', 'muted small', t('Exactly this is sent (private details removed):')), el('pre', 'cc-sent', JSON.stringify(r.preview, null, 2)), send);
    } catch (e) {
      out.replaceChildren(el('p', 'small', e.message));
    }
  });
  wrap.append(label, out);
  return wrap;
}
