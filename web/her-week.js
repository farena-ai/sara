// W1.5 (docs/HER_WEEK.md): her weekly "how am I doing" check-in. The card under her message (what
// she did, what didn't work, what cost money, three ideas with one-tap Accept + Undo) and
// Settings → You → Briefing → Her weekly check-in (on/off, day, time, Show me now).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
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
const money = (usd) => new Intl.NumberFormat(document.documentElement.lang || 'en', { style: 'currency', currency: 'USD' }).format(usd || 0);

function stat(label, value, warn) {
  const li = el('li', warn ? 'hw-warn' : '');
  li.append(el('span', 'hw-label', label), el('strong', 'hw-value', value));
  return li;
}

function tipRow(tip, ctx) {
  const row = el('li', 'hw-tip');
  const text = el('div', 'hw-tip-text');
  text.append(el('span', '', t(tip.text)));
  if (tip.why?.key) text.append(el('span', 'muted small hw-why', t(tip.why.key, tip.why.params || {})));
  const acts = el('div', 'hw-acts');
  const state = el('span', 'muted small hw-state');
  state.setAttribute('role', 'status');
  const draw = () => {
    acts.replaceChildren();
    if (tip.done) {
      state.textContent = t('Done.');
      const undo = button(t('Undo'), 'ghost small hw-undo', async () => {
        undo.disabled = true;
        try {
          await ctx.api(`/timeline/${tip.done}/revert`, { method: 'POST', body: {} });
          tip.done = undefined;
          draw();
          state.textContent = t('Put back.');
          acts.append(state);
        } catch (err) {
          undo.disabled = false;
          state.textContent = err.message;
        }
      });
      acts.append(state, undo);
      return;
    }
    if (tip.no) {
      state.textContent = t('Not now. I won’t suggest it again for a while.');
      acts.append(state);
      return;
    }
    const accept = button(t('Accept'), 'small hw-accept', async () => {
        accept.disabled = true;
        try {
          const r = await ctx.api('/automations/her-week/accept', { method: 'POST', body: { id: tip.id, ...(ctx.messageId ? { message: ctx.messageId } : {}) } });
          tip.done = r.row?.id;
          draw();
        } catch (err) {
          accept.disabled = false;
          state.textContent = err.message;
          acts.append(state);
        }
      });
    acts.append(
      accept,
      button(t('Not now'), 'ghost small hw-skip', async () => {
        await ctx.api('/automations/her-week/skip', { method: 'POST', body: { id: tip.id, ...(ctx.messageId ? { message: ctx.messageId } : {}) } }).catch(() => {});
        tip.no = true;
        draw();
      }),
    );
  };
  draw();
  row.append(text, acts);
  return row;
}

/** The check-in card under her message (`m.meta.herWeek`). */
export function herWeekCard(w, api, messageId) {
  const box = el('section', 'lean-card hw-card');
  box.setAttribute('aria-label', t('Her weekly check-in'));
  box.append(el('strong', 'hw-title', t('Her weekly check-in')));
  const failed = (w.failed?.failedCalls || 0) + (w.failed?.claims || 0) + (w.failed?.errors || 0);
  const list = el('ul', 'hw-stats');
  list.append(
    stat(t('What I did'), t('{n} changes · {tools} tool runs', { n: w.did?.actions || 0, tools: w.did?.toolCalls || 0 })),
    stat(t('What didn’t work'), failed ? t('{failed} failed · {claims} not backed up · {errors} errors', { failed: w.failed.failedCalls || 0, claims: w.failed.claims || 0, errors: w.failed.errors || 0 }) : t('Nothing'), failed > 0),
    stat(t('What cost money'), w.cost?.usd > 0 ? money(w.cost.usd) : t('Nothing on paid models')),
  );
  box.append(list);
  if (w.failed?.tools?.length) box.append(el('p', 'muted small hw-failed', t('Failed most: {list}', { list: w.failed.tools.map((x) => `${x.name} × ${x.n}`).join(', ') })));
  if (w.tips?.length) {
    box.append(el('p', 'small hw-ideas', t('Three ideas for next week')));
    const ol = el('ol', 'hw-tips');
    for (const tip of w.tips) ol.append(tipRow(tip, { api, messageId }));
    box.append(ol);
  }
  return box;
}

let api;
/** Settings loader (called with the Weekly review section). */
export async function loadHerWeek(apiFn) {
  if (apiFn) api = apiFn;
  if (!api || !$('#hw-on')) return;
  const p = await api('/automations/her-week').catch(() => null);
  if (!p) return;
  $('#hw-on').checked = p.on;
  $('#hw-day').value = String(p.day);
  $('#hw-time').value = p.time;
}
async function saveHerWeek() {
  $('#hw-status').textContent = '';
  try {
    await api('/automations/her-week', { method: 'PUT', body: { on: $('#hw-on').checked, day: Number($('#hw-day').value), time: $('#hw-time').value || '17:00' } });
    $('#hw-status').textContent = t('Saved.');
  } catch (err) {
    $('#hw-status').textContent = err.message;
  }
}
export function initHerWeek(apiFn) {
  api = apiFn;
  for (const id of ['#hw-on', '#hw-day', '#hw-time']) $(id)?.addEventListener('change', () => void saveHerWeek());
  const now = $('#hw-now');
  now?.addEventListener('click', async () => {
    now.disabled = true;
    try {
      await api('/automations/her-week/now', { method: 'POST', body: {} });
      $('#hw-status').textContent = t('Sent to your chat.');
    } catch (err) {
      $('#hw-status').textContent = err.message;
    } finally {
      now.disabled = false;
    }
  });
}
