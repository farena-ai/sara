// W4.1 (docs/HANDLE_IT.md): the "Handle it" window. Pressed on a renewal, a return, a bill, a
// cancel suggestion or a Library form: her plan first (a plain list, each stop marked), Start, then a
// progress card that follows the run: the step she waits at with its OK button (I signed in, I paid,
// Send it, Go ahead), Pause/Resume, Stop, and the receipts as steps finish. Nothing here calls a model;
// the server runs the steps (src/handle-it.ts on the R3 errand runner).
import { t } from './naming.js';
import { api } from './setup-card.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const STOP = () => ({ signin: t('You sign in'), pay: t('You pay'), send: t('Asks before sending'), ok: t('Asks you first') });
const OK_LABEL = () => ({ signin: t('I signed in'), pay: t('I paid'), send: t('Send it'), ok: t('Go ahead') });
const MARK = { todo: '○', waiting_you: '!', waiting_others: '…', done: '✓', skipped: '–' };
const STATUS = () => ({ planning: t('Planning'), working: t('Working'), waiting_you: t('Waiting on you'), waiting_others: t('Waiting on others'), done: t('Done'), stopped: t('Stopped') });

let cur = null;
let timer = 0;
let busy = false;

function body() {
  return $('#hi-body');
}
function fail(err) {
  const s = $('#hi-status');
  if (s) s.textContent = err?.message || t('Something went wrong.');
}

/** "Handle it" pressed on a source row: shows her plan (nothing runs until Start). */
export async function handleIt(kind, ref) {
  const d = $('#handle-it');
  if (!d) return;
  cur = null;
  body().replaceChildren(el('p', 'muted small', t('Making a plan…')));
  if (!d.open) d.showModal();
  try {
    cur = (await api('/errands/handle', { method: 'POST', body: { kind, ref: String(ref) } })).handle;
    draw();
  } catch (err) {
    body().replaceChildren(el('p', 'small hi-error', err?.message || t('Something went wrong.')));
  }
}

/** The progress card of a Handle it run (from Errands). */
export async function openHandle(id) {
  const d = $('#handle-it');
  if (!d) return;
  if (!d.open) d.showModal();
  await refresh(id);
}

async function refresh(id = cur?.id) {
  if (!id) return;
  try {
    cur = (await api(`/errands/${id}/handle`)).handle;
    draw();
  } catch (err) {
    fail(err);
  }
}

async function act(what, extra) {
  if (!cur || busy) return;
  busy = true;
  try {
    cur = (await api(`/errands/${cur.id}/handle/${what}`, { method: 'POST', body: extra ?? {} })).handle;
    draw();
  } catch (err) {
    fail(err);
  } finally {
    busy = false;
  }
}

function stepList(steps, live) {
  const ol = el('ol', 'hi-steps');
  for (const s of steps) {
    const li = el('li', `hi-step hi-${s.status}`);
    if (live) li.append(el('span', 'hi-mark', MARK[s.status] ?? '○'));
    li.append(el('span', 'hi-text', s.text));
    if (s.stop) li.append(el('span', `er-chip hi-stop hi-stop-${s.stop}`, STOP()[s.stop]));
    ol.append(li);
  }
  return ol;
}

function draw() {
  clearTimeout(timer);
  const d = $('#handle-it');
  const h = cur;
  if (!h || !d) return;
  const out = [el('strong', 'hi-goal', h.goal)];
  if (h.status === 'planning') {
    out.push(el('p', 'small', t('Here’s her plan. Nothing happens until you press Start.')), stepList(h.steps, false));
    out.push(el('p', 'muted small hi-rule', t('She never pays and never types your passwords: you sign in and press Pay on the site yourself. Always allow does not skip those.')));
    const row = el('p', 'actions-left');
    row.append(btn(t('Start'), '', () => void act('start')), btn(t('Not now'), 'ghost', () => d.close()));
    out.push(row);
  } else {
    const top = el('div', 'hi-top');
    top.append(el('span', `er-chip er-${h.status}`, h.paused ? t('Paused') : (STATUS()[h.status] ?? h.status)), el('span', 'muted small', t('Step {n} of {total}', { n: Math.min(h.total, h.done + (h.status === 'done' ? 0 : 1)), total: h.total })));
    const bar = el('progress', 'hi-bar');
    bar.max = h.total || 1;
    bar.value = h.done;
    out.push(top, bar, stepList(h.steps, true));
    if (h.status === 'waiting_you' && h.ask) {
      const box = el('div', 'hi-ask');
      box.append(el('span', `er-chip hi-stop hi-stop-${h.stop}`, STOP()[h.stop] ?? STOP().ok), el('p', 'small hi-ask-text', h.ask));
      const row = el('p', 'actions-left');
      if (h.paused) row.append(el('span', 'muted small', t('Paused. Resume to go on.')));
      let amount = null;
      if (h.stop === 'pay' && !h.paused) {
        amount = el('input', 'hi-amount');
        amount.inputMode = 'decimal';
        amount.setAttribute('aria-label', t('Amount you paid'));
        amount.placeholder = t('Amount you paid');
        row.append(amount);
      }
      if (!h.paused) row.append(
        btn(OK_LABEL()[h.stop] ?? t('Go ahead'), '', () => {
          const n = amount ? Number(amount.value.replace(/[^\d.]/g, '')) : NaN;
          void act('ok', Number.isFinite(n) && n > 0 ? { amount: n } : {});
        }),
        btn(t('Skip'), 'ghost', () => void act('skip')),
      );
      box.append(row);
      out.push(box);
    }
    if (h.receipts.length) {
      const rc = el('details', 'hi-receipts');
      rc.open = h.status === 'done' || h.status === 'stopped';
      rc.append(el('summary', 'small', t('Receipts ({n})', { n: h.receipts.length })));
      const ul = el('ul', 'small');
      for (const r of h.receipts) {
        const li = el('li');
        li.append(el('strong', '', `${r.step}: `), el('span', 'muted', r.line));
        ul.append(li);
      }
      rc.append(ul);
      out.push(rc);
    }
    if (h.outcome) out.push(el('p', 'small hi-summary', h.outcome));
    const row = el('p', 'actions-left hi-actions');
    if (h.status !== 'done' && h.status !== 'stopped') {
      row.append(
        h.paused ? btn(t('Resume'), 'ghost', () => void act('resume')) : btn(t('Pause'), 'ghost', () => void act('pause')),
        btn(t('Stop'), 'ghost', () => {
          if (confirm(t('Stop handling this? What she already did stays done.'))) void act('stop');
        }),
      );
    }
    if (h.conversationId) {
      row.append(
        btn(t('Open the chat'), 'ghost', () => {
          d.close();
          location.hash = `#c=${h.conversationId}`;
        }),
      );
    }
    out.push(row);
  }
  out.push(el('p', 'muted small', ''));
  out.at(-1).id = 'hi-status';
  out.at(-1).setAttribute('role', 'status');
  body().replaceChildren(...out);
  // Follow the run while she works on her own.
  if (d.open && (h.status === 'working' || h.status === 'waiting_others') && !h.paused) timer = setTimeout(() => void refresh(), h.status === 'working' ? 2000 : 15000);
}

globalThis.document?.querySelector('#handle-it')?.addEventListener('close', () => clearTimeout(timer));
