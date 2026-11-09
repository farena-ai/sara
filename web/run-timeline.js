// V4b (docs/ops/V4_DESIGN.md → Live run timeline): the step line under her reply (web/steps.js)
// becomes a live run card in the new look. Same element, same events, same details per step (what
// ran, the output, Undo, Show the run); on top of it:
//   - a head: the step she is on (or how many steps, or "Waiting for your OK"), a progress bar and
//     Fold / Show steps (remembered per person on this device);
//   - the active step shimmers, finished steps get a done mark, and "verified" only when a sandbox
//     try or a clean checks run really checked that step (web/run-model.js);
//   - her approval cards for the run sit inside it (Allow / Deny / Always allow work as before);
//   - a footer from real records: tokens and cost of the run (GET /api/runs/:id once the run is
//     known), sandbox tries, verified steps.
// Sara Classic keeps the old one-line look (CSS); reduced motion stops the shimmer and the bar.
import { t } from './naming.js';
import { runTotals, timelineModel, verification } from './run-model.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let who = 'owner';
const FOLD_KEY = () => `sara.v4.runFold.${who}`;
/** Whose fold choice applies (the owner, or a household member by id). */
export function setRunUser(key) {
  who = String(key || 'owner').replace(/[^\w:-]/g, '').slice(0, 40) || 'owner';
}
/** V4d: Settings → Appearance → Show run details on this device: folded (the default) or open. */
function foldPref() {
  try {
    return localStorage.getItem('sara.runDetails') === 'open' ? 'open' : 'folded';
  } catch {
    return 'folded';
  }
}
/** V4d: a card's own open/folded choice, for this session (per person, per run). */
const cardKey = (box) => (box._runId ? `sara.v4.runFold.${who}.${box._runId}` : '');
function cardPref(box) {
  try {
    const k = cardKey(box);
    const v = k ? sessionStorage.getItem(k) : '';
    return v === 'open' || v === 'folded' ? v : '';
  } catch {
    return '';
  }
}
function saveFold(box) {
  try {
    const k = cardKey(box);
    if (k) sessionStorage.setItem(k, box.open ? 'open' : 'folded');
  } catch {
    /* private mode */
  }
}
/**
 * V4d: whether a run card shows its steps. Folded unless the setting says open or the person opened
 * this card; always open while it runs, waits for an approval or has a failed or denied step, so
 * nothing that needs the person is hidden.
 */
export function foldStart({ pref = 'folded', card = '', live = false, waiting = false, errors = 0 } = {}) {
  if (live || waiting || errors > 0) return true;
  if (card) return card === 'open';
  return pref === 'open';
}

function setOpen(box, open) {
  if (box.open === open) return;
  box._quiet = true;
  box.open = open;
  queueMicrotask(() => (box._quiet = false));
}

const money = (usd) => (usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`);

function headText(m) {
  if (m.waiting) return t('Waiting for your OK');
  if (m.live) return t('Step {n}', { n: m.active + 1 });
  return m.total === 1 ? t('1 step') : t('{n} steps', { n: m.total });
}

function footBits(box, m) {
  const bits = [];
  const tot = runTotals(box._run);
  if (tot && tot.tokens) bits.push(t('{n} tokens', { n: tot.tokens.toLocaleString() }));
  if (tot) bits.push(tot.incomplete ? t('{cost} (some calls have no price)', { cost: money(tot.usd) }) : money(tot.usd));
  if (m.sandboxTries) bits.push(m.sandboxTries === 1 ? t('Sandbox: 1 try') : t('Sandbox: {n} tries', { n: m.sandboxTries }));
  if (m.verified) bits.push(m.verified === 1 ? t('1 verified') : t('{n} verified', { n: m.verified }));
  return bits;
}

function update(box) {
  const ev = box._evidence;
  const m = timelineModel(box._steps, ev);
  box.classList.toggle('v4-waiting', m.waiting);
  box.querySelector('.v4-run-count').textContent = headText(m);
  const bar = box.querySelector('.v4-run-prog');
  bar.classList.toggle('live', m.live);
  bar.classList.toggle('bad', !m.live && m.errors > 0);
  bar.style.setProperty('--p', m.progress === null ? '0' : String(m.progress));
  // Something needs the person (live, an approval, a failure): open once when it starts to.
  const need = m.live || m.waiting || m.errors > 0 || m.timedOut > 0 ? `${m.waiting ? 'w' : ''}${m.errors}${m.live ? 'l' : ''}${m.timedOut ? `t${m.timedOut}` : ''}` : '';
  if (need && need !== box._need) setOpen(box, foldStart({ pref: foldPref(), card: cardPref(box), live: m.live, waiting: m.waiting, errors: m.errors + m.timedOut }));
  box._need = need;
  foldWords(box);
  // Marks: verified only from the evidence; everything else stays a plain done.
  for (const s of box._steps) {
    if (!s.li) continue;
    const v = verification(s, ev);
    s.li.classList.toggle('v4-verified', Boolean(v));
    const head = s.li.querySelector('.step-head');
    let mark = s.li.querySelector('.v4-rcpt');
    if (v && head && !mark) {
      mark = el('span', 'v4-rcpt', t('verified'));
      head.querySelector('.step-verb')?.after(mark);
    }
    if (mark && !v) mark.remove();
    if (mark && v) mark.title = v.by === 'sandbox' ? t('Tried in an isolated sandbox copy first: it finished without errors.') : t('Checked by {checker}: no problems left in this file.', { checker: v.checker || t('the project checker') });
  }
  const bits = footBits(box, m);
  const foot = box.querySelector('.v4-run-foot');
  foot.replaceChildren(...bits.map((b) => el('span', 'num', b)));
  foot.hidden = !bits.length;
  // The run record (tokens, cost) once the run is known and finished; fetched once.
  if (box._runId && !m.live && !box._runAsked && box._api) {
    box._runAsked = true;
    void box._api(`/runs/${box._runId}`).then((r) => {
      box._run = r?.run ?? r;
      update(box);
    }, () => {});
  }
}

/**
 * Turns a step line into a run timeline (idempotent). `api` fetches the run record for the footer;
 * `live` opens it while she works (unless the person folded runs before).
 */
export function runTimeline(box, { api, live = false } = {}) {
  if (!box || box._timeline) return box;
  box._timeline = true;
  box._api = api;
  box._evidence = { sandbox: new Map(), checks: null };
  box.classList.add('v4-run');
  const sum = box.querySelector('.steps-sum');
  const head = el('span', 'v4-run-head');
  const prog = el('span', 'v4-run-prog');
  prog.setAttribute('aria-hidden', 'true');
  prog.append(el('i'));
  const chev = el('span', 'v4-run-chev');
  chev.setAttribute('aria-hidden', 'true');
  head.append(el('span', 'v4-run-count num'), prog, el('span', 'v4-run-fold'), chev);
  sum?.append(head);
  const foot = el('div', 'v4-run-foot');
  foot.hidden = true;
  box.append(foot);
  setOpen(box, foldStart({ pref: foldPref(), live }));
  box.addEventListener('toggle', () => {
    if (!box._quiet) saveFold(box);
    foldWords(box);
  });
  box._after = update;
  update(box);
  return box;
}

/** The newest run of a chat: its own choice this session, else the setting (folded by default). */
export function runLatest(box) {
  if (!box?._timeline) return;
  const m = timelineModel(box._steps, box._evidence);
  setOpen(box, foldStart({ pref: foldPref(), card: cardPref(box), live: m.live, waiting: m.waiting, errors: m.errors + m.timedOut }));
  update(box);
}

/** The fold words and the summary's expanded state (the whole one-line head is the button). */
function foldWords(box) {
  box.querySelector('.v4-run-fold').textContent = box.open ? t('Fold') : t('Show steps');
  const sum = box.querySelector('.steps-sum');
  if (sum) sum.setAttribute('aria-expanded', String(box.open));
}

/** Evidence for the marks: a sandbox record for a call, or the turn's checks chip. */
export function runEvidence(box, kind, data, id) {
  if (!box?._timeline || !data) return;
  if (kind === 'sandbox' && id) box._evidence.sandbox.set(id, data);
  if (kind === 'checks') box._evidence.checks = data;
  update(box);
}

/** Puts her approval card inside the run (opened, so it is seen); false when there is no run. */
export function runApproval(box, card) {
  if (!box?._timeline || !box.isConnected || !card) return false;
  card.classList.add('v4-run-approval');
  box.querySelector('.v4-run-foot').before(card);
  setOpen(box, true);
  update(box);
  return true;
}
