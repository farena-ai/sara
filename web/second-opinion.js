// D8 "Get a second opinion" (docs/design/D8SECOND.md): on any of her replies, two other connected
// models answer the same question; the panel shows the three answers side by side with what only
// one of them says (or says with other numbers) highlighted. The spend is shown before anything is
// sent, and private chats only offer models on this computer. Server: src/second-opinion.ts.
import { locale, serverText, t } from './naming.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const btn = (cls, text, onClick) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
async function call(path, body) {
  const res = await fetch(`/api${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
const usd = (n) => new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n < 0.1 ? 3 : 2 }).format(n);
const keyOf = (m) => `${m.providerId}/${m.model}`;

/** The spend line for the picked models. */
function spendLine(picked) {
  const total = picked.reduce((n, m) => n + (m.estUsd ?? 0), 0);
  const unknown = picked.some((m) => m.estUsd === null);
  const one = picked.length === 1;
  if (!total && !unknown) return picked.every((m) => m.local) ? (one ? t('Free: it runs on this computer.') : t('Free: both run on this computer.')) : t('No extra cost: on this computer or in a subscription you have.');
  const head = total ? (total < 0.001 ? t('Costs less than {usd}.', { usd: usd(0.001) }) : one ? t('Costs about {usd}.', { usd: usd(total) }) : t('Costs about {usd} for both answers.', { usd: usd(total) })) : '';
  return [head, unknown ? t('One price is not known, so it may cost more.') : ''].filter(Boolean).join(' ');
}
const costTag = (m) => (m.local ? t('free, on this computer') : m.estUsd === 0 ? t('in your subscription') : m.estUsd === null ? t('price not known') : `≈ ${usd(m.estUsd)}`);

/** The panel under one reply (made once, reused). */
function panelFor(div) {
  if (div._sop?.isConnected) return div._sop;
  const p = el('details', 'sop-panel');
  p.open = true;
  p.append(el('summary', 'sop-sum', t('Second opinion')), el('div', 'sop-body'));
  div.after(p);
  div._sop = p;
  return p;
}
const bodyOf = (p) => p.querySelector('.sop-body');

/** Step 1: which two models, and what it costs. Nothing is sent before "Ask them". */
async function showPlan(div, m) {
  const p = panelFor(div);
  p.open = true;
  p.querySelector('.sop-sum').textContent = t('Second opinion');
  const body = bodyOf(p);
  body.replaceChildren(el('p', 'muted small', t('Looking at which models can answer…')));
  let plan;
  try {
    plan = await call(`/conversations/${encodeURIComponent(div._sopConv)}/second-opinion?message=${m.id}`);
  } catch (err) {
    body.replaceChildren(el('p', 'sop-err', err.message), btn('ghost small', t('Not now'), () => p.remove()));
    return;
  }
  const form = el('div', 'sop-plan');
  form.append(el('p', 'small', t('Two other models answer your question on their own, without seeing her reply. Then you see where they differ.')));
  if (plan.private) form.append(el('p', 'small sop-note', t('This chat is private: only models on this computer are asked.')));
  if (plan.spendHit) form.append(el('p', 'small sop-note', t('Your spend limit is reached, so only free models are offered.')));
  const picks = [];
  const row = el('div', 'sop-picks');
  const labels = [t('First other model'), t('Second other model')];
  for (let i = 0; i < Math.min(2, plan.choices.length); i++) {
    const sel = el('select', 'sop-pick');
    sel.setAttribute('aria-label', labels[i]);
    for (const c of plan.choices) {
      const o = el('option', '', `${c.model} · ${c.provider} (${costTag(c)})`);
      o.value = keyOf(c);
      sel.append(o);
    }
    sel.value = keyOf(plan.models[i] ?? plan.choices[i]);
    picks.push(sel);
    row.append(sel);
  }
  const spend = el('p', 'sop-spend');
  const picked = () => [...new Set(picks.map((s) => s.value))].map((k) => plan.choices.find((c) => keyOf(c) === k)).filter(Boolean);
  const paint = () => void (spend.textContent = spendLine(picked()));
  for (const s of picks) s.addEventListener('change', paint);
  paint();
  if (plan.choices.length < 2) form.append(el('p', 'small muted', t('Only one other model can answer here.')));
  const go = btn('sop-go', t('Ask them'), () => void ask(div, m, picked()));
  form.append(row, spend, el('div', 'sop-actions'));
  form.lastChild.append(go, btn('ghost small', t('Not now'), () => p.remove()));
  body.replaceChildren(form);
}

/** Step 2: ask, then show the answers side by side. */
async function ask(div, m, models) {
  const p = panelFor(div);
  const body = bodyOf(p);
  body.replaceChildren(el('p', 'muted small', t('Asking {models}…', { models: models.map((x) => x.model).join(', ') })));
  body.setAttribute('aria-busy', 'true');
  try {
    const r = await call(`/conversations/${encodeURIComponent(div._sopConv)}/second-opinion`, { message: m.id, models: models.map((x) => ({ providerId: x.providerId, model: x.model })) });
    m.meta = { ...(m.meta ?? {}), secondOpinion: r };
    showResult(div, m, r, true);
  } catch (err) {
    body.replaceChildren(el('p', 'sop-err', err.message), btn('ghost small', t('Try again'), () => void showPlan(div, m)));
  } finally {
    body.removeAttribute('aria-busy');
  }
}

/** The three answers, differences marked. */
function showResult(div, m, r, open) {
  const p = panelFor(div);
  p.open = open;
  const answered = r.answers.filter((a) => a.text);
  p.querySelector('.sop-sum').textContent = r.differ ? t('Second opinion: {n} points differ', { n: r.differ }) : t('Second opinion: they agree');
  const body = bodyOf(p);
  const cols = el('div', 'sop-cols');
  for (const a of r.answers) {
    const col = el('section', `sop-col${a.mine ? ' mine' : ''}`);
    const head = el('div', 'sop-head');
    head.append(el('strong', '', a.mine ? t('Her reply') : a.model), el('span', 'muted small', a.mine ? a.model : a.local ? t('{provider}, on this computer', { provider: a.provider }) : a.provider));
    const text = el('div', 'sop-text');
    if (a.error) text.append(el('p', 'sop-err', t('No answer: {why}', { why: t(a.error) })));
    for (const part of a.parts ?? []) {
      if (part.kind === 'same') text.append(document.createTextNode(part.text));
      else {
        const mark = el('mark', part.kind === 'number' ? 'sop-num' : 'sop-only', part.text);
        mark.title = part.kind === 'number' ? t('Other numbers than the other answers') : t('Only this answer says this');
        text.append(mark);
      }
    }
    col.append(head, text);
    cols.append(col);
  }
  const legend = el('p', 'small muted sop-legend');
  legend.append(el('mark', 'sop-only', t('only this answer')), ' ', el('mark', 'sop-num', t('other numbers')));
  const summary = el('p', 'sop-verdict', answered.length < 2 ? t('No other model answered.') : r.differ ? t('Where they differ is highlighted. Check those points before you rely on them.') : t('All the answers say the same things.'));
  body.replaceChildren(summary, legend, cols, el('div', 'sop-actions'));
  body.lastChild.append(btn('ghost small', t('Ask again'), () => void showPlan(div, m)));
}

/** The message action (one per reply of hers), or null where it doesn't fit. */
export function secondOpinionButton(div, m, act, conversationId) {
  if (!conversationId || m.role !== 'assistant' || !m.id || !String(m.content ?? '').trim() || m.meta?.blocked || m.meta?.secondOpinionOffer) return null;
  div._sopConv = conversationId;
  const b = act('group', t('Get a second opinion from two other models'));
  b.addEventListener('click', () => void showPlan(div, m));
  // A kept second opinion comes back folded under the reply.
  if (m.meta?.secondOpinion?.answers && !div._sop?.isConnected) queueMicrotask(() => div.isConnected && showResult(div, m, m.meta.secondOpinion, false));
  return b;
}

/**
 * fixreceipts: the owner asked in chat ("get a second opinion"); her reply carries
 * `meta.secondOpinionOffer = { message }` and shows the same plan card for that earlier reply of hers
 * (models, cost, Ask them / Not now). Nothing is sent before Ask them. Once asked, the answers live on
 * that reply (they come back folded under it), so an old offer shows no card again.
 */
export function secondOpinionOffer(div, m, conversationId) {
  const id = m.meta?.secondOpinionOffer?.message;
  if (!conversationId || m.role !== 'assistant' || !Number.isInteger(id) || div._sopOffer) return;
  div._sopOffer = true;
  div._sopConv = conversationId;
  const target = { id, meta: {} };
  queueMicrotask(async () => {
    if (!div.isConnected) return;
    const p = panelFor(div);
    p.classList.add('sop-offer');
    try {
      const plan = await call(`/conversations/${encodeURIComponent(conversationId)}/second-opinion?message=${id}`);
      if (plan.asked) return void p.remove();
    } catch {
      // showPlan says why (no other model, reply gone).
    }
    void showPlan(div, target);
  });
}
