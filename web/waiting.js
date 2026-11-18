// V1.2 (docs/WAITING.md): Waiting on you, one queue. Everything that waits on the person, from the
// places that already hold it (GET /api/waiting, read-only): her approvals, team steps, devices,
// board questions, errands, inbox cards, overdue to-dos, failed chats, mail to answer. Urgent first,
// then oldest. Each row opens its own card. On a phone: swipe right = the one-tap yes (only where
// the card already allows one, never money or passwords), swipe left = Later (until tomorrow).
import { t } from './naming.js';

/** @type {{ api: Function, el: Function, openConversation: Function, openCard: Function, openErrands: Function, openToday: Function, openPlanner: Function, ask: Function } | null} */
let ctx = null;
let items = [];
const $ = (s) => document.querySelector(s);
const SWIPE = 80;

export function initWaiting(c) {
  ctx = c;
}

const SOURCE_WORDS = () => ({ approval: t('Approval'), team: t('Team step'), device: t('Device'), question: t('Her question'), errand: t('Errand'), inbox: t('From your inbox'), overdue: t('Overdue'), failed: t('Failed'), followup: t('Mail to answer') });

const say = (msg) => {
  const s = $('#wq-status');
  if (s) s.textContent = msg;
};

function ago(at) {
  const ms = Date.now() - Date.parse(at);
  if (!at || !Number.isFinite(ms)) return '';
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || undefined, { numeric: 'auto' });
  const back = Math.abs(ms);
  const v = back < 3600_000 ? [Math.round(ms / 60_000), 'minute'] : back < 86_400_000 ? [Math.round(ms / 3600_000), 'hour'] : [Math.round(ms / 86_400_000), 'day'];
  return rtf.format(-v[0], v[1]);
}

export async function openWaiting() {
  if (!ctx) return;
  const d = $('#waiting');
  if (!d) return;
  if (!d.open) d.showModal();
  await loadWaiting();
}

export async function loadWaiting() {
  say(t('Loading…'));
  try {
    items = (await ctx.api('/waiting')).items ?? [];
    say('');
  } catch (err) {
    say(err.message);
    items = [];
  }
  draw();
}

function draw() {
  const list = $('#wq-list');
  if (!list) return;
  const n = $('#wq-count');
  if (n) n.textContent = items.length ? t('{n} waiting on you', { n: items.length }) : '';
  if (!items.length) {
    list.replaceChildren(ctx.el('li', 'wq-empty muted', t('Nothing is waiting on you right now.')));
    return;
  }
  list.replaceChildren(...items.map(row));
}

function close() {
  const d = $('#waiting');
  if (d?.open) d.close();
}

/** Opens the row's own card. */
function openItem(x) {
  const o = x.open ?? {};
  close();
  if (o.kind === 'chat') return void ctx.openConversation(o.conversationId);
  if (o.kind === 'card') return void ctx.openCard(o.boardId, o.cardId);
  if (o.kind === 'errand') return void ctx.openErrands(o.id);
  if (o.kind === 'task') return void ctx.openPlanner();
  if (o.kind === 'ask') return void ctx.ask(o.text);
  return void ctx.openToday();
}

async function act(x, action, li) {
  try {
    await ctx.api('/waiting/act', { method: 'POST', body: { key: x.key, action } });
    items = items.filter((y) => y.key !== x.key);
    li.remove();
    say(action === 'later' ? t('Put off until tomorrow.') : t('Done.'));
    if (!items.length) draw();
    else {
      const n = $('#wq-count');
      if (n) n.textContent = t('{n} waiting on you', { n: items.length });
    }
  } catch (err) {
    li.style.transform = '';
    say(err.message);
  }
}

function btn(label, cls, onClick) {
  const b = ctx.el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function row(x) {
  const li = ctx.el('li', `wq-row${x.urgent ? ' wq-urgent' : ''}`);
  li.dataset.key = x.key;
  li.dataset.source = x.source;
  const text = ctx.el('div', 'wq-text');
  const top = ctx.el('div', 'wq-top');
  top.append(ctx.el('span', 'wq-src', SOURCE_WORDS()[x.source] ?? x.source));
  if (x.at) top.append(ctx.el('span', 'wq-when muted small', ago(x.at)));
  text.append(top, ctx.el('strong', 'wq-title', x.title));
  if (x.why) text.append(ctx.el('span', 'wq-why muted small', x.why));
  if (!x.oneTap && x.noTap === 'money') text.append(ctx.el('span', 'wq-lock muted small', t('Money or a password: open it to answer.')));
  const acts = ctx.el('div', 'wq-acts');
  if (x.oneTap) acts.append(btn(x.source === 'errand' ? t('Send the draft') : x.source === 'inbox' ? t('Accept') : t('Approve'), 'small', () => void act(x, 'approve', li)));
  acts.append(btn(t('Open'), 'ghost small', () => openItem(x)), btn(t('Later'), 'ghost small', () => void act(x, 'later', li)));
  li.append(text, acts);
  swipe(li, x);
  return li;
}

/** Phones: swipe right = the one-tap yes (only a one-tap row), swipe left = Later. */
function swipe(li, x) {
  let start = null;
  let dx = 0;
  li.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('button')) return;
    start = { x: e.clientX, y: e.clientY };
    dx = 0;
  });
  li.addEventListener('pointermove', (e) => {
    if (!start) return;
    dx = e.clientX - start.x;
    if (Math.abs(e.clientY - start.y) > Math.abs(dx) + 10) {
      start = null;
      li.style.transform = '';
      return;
    }
    li.style.transform = `translateX(${Math.max(-120, Math.min(120, dx))}px)`;
    li.classList.toggle('wq-go-yes', dx > SWIPE && x.oneTap);
    li.classList.toggle('wq-go-later', dx < -SWIPE);
  });
  const end = () => {
    if (!start) return;
    start = null;
    li.classList.remove('wq-go-yes', 'wq-go-later');
    if (dx < -SWIPE) return void act(x, 'later', li);
    if (dx > SWIPE) {
      if (!x.oneTap) {
        li.style.transform = '';
        // The reason on the row itself (the status line may be scrolled away on a phone).
        const why = x.noTap === 'money' ? t('Money or a password: open it to answer.') : t('This one needs a look: open it to answer.');
        let hint = li.querySelector('.wq-hint, .wq-lock');
        hint?.classList.add('wq-hint');
        if (!hint) {
          hint = ctx.el('span', 'wq-hint small');
          hint.setAttribute('role', 'status');
          li.querySelector('.wq-text')?.append(hint);
        }
        hint.textContent = why;
        say(why);
        return;
      }
      return void act(x, 'approve', li);
    }
    li.style.transform = '';
  };
  li.addEventListener('pointerup', end);
  li.addEventListener('pointercancel', () => ((start = null), (li.style.transform = '')));
}
