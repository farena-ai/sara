// C8 (docs/ops/C8_DESIGN.md, docs/COSTS.md): spend control in the web app. The price line on an
// approval card and a tool step, the Spend limits and Token Saver section of Settings → Data &
// health → Usage and costs, and the small "Token Saver" badge under the chat while it is on.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, isMember: () => boolean } | null} */
let ctx = null;
let data = null;

/** "about $0.07" or "cost unknown". */
export function priceText(p) {
  if (!p) return '';
  if (p.usd === null || p.usd === undefined) return t('cost unknown');
  const usd = p.usd < 0.1 ? p.usd.toFixed(3).replace(/0$/, '') : p.usd.toFixed(2);
  return t('about {usd}', { usd: `$${usd}` });
}

/** The card's lines: what this call costs, and the limit it reached (with the one-call override). */
export function spendLines(ev) {
  const out = [];
  if (ev.spend) {
    out.push(Object.assign(document.createElement('p'), { className: 'skl-warn small sp-stop', textContent: `${ev.spend.message} ${t('Allow lets this one call run anyway.')}` }));
  }
  if (ev.price) out.push(Object.assign(document.createElement('p'), { className: 'muted small sp-price', textContent: ev.price.usd === null ? t('This step costs money; its price is unknown.') : t('This step costs {price}.', { price: priceText(ev.price) }) }));
  return out;
}

export function initSpend(c) {
  ctx = c;
  $('#sp-save')?.addEventListener('click', () => void save());
  $('#sp-saver')?.addEventListener('change', () => syncSaverRow());
  const page = document.querySelector('.settings-page[data-page="dh-usage"]');
  if (page) new MutationObserver(() => !page.hidden && void load()).observe(page, { attributes: true, attributeFilter: ['hidden'] });
  void refreshSaverBadge();
  setInterval(() => void refreshSaverBadge(), 120_000);
}

/** The badge under the chat (owner only; members never see it). */
export async function refreshSaverBadge() {
  const b = $('#saver-badge');
  if (!b || ctx?.isMember()) return;
  const r = await ctx.api('/spend').catch(() => null);
  if (!r) return void (b.hidden = true);
  b.hidden = !r.saver.on;
  b.textContent = r.saver.why === 'auto' ? t('Token Saver (auto)') : t('Token Saver');
  b.title = t('Shorter replies, a smaller history and fewer tool steps. Send /saver off to turn it off.');
}

const money = (n) => `$${(n ?? 0).toFixed(2)}`;

async function load() {
  if (!ctx || ctx.isMember()) return;
  data = await ctx.api('/spend').catch(() => null);
  if (!data) return;
  $('#sp-day').value = data.spend.dayUsd || '';
  $('#sp-month').value = data.spend.monthUsd || '';
  $('#sp-now').textContent = t('Spent today: {day} · this month: {month}', { day: money(data.spent.day), month: money(data.spent.month) });
  const cap = $('#sp-cap');
  cap.hidden = !data.cap;
  if (data.cap) cap.textContent = t('Your admin set a hard daily cap of {usd}: past it, paid tools stop and can’t be allowed.', { usd: money(data.cap) });
  const list = $('#sp-tools');
  list.replaceChildren();
  if (!data.priced.length) list.append(ctx.el('li', 'muted small', t('None of her tools cost money right now.')));
  for (const p of data.priced) {
    const li = ctx.el('li', 'sp-tool');
    const lim = data.spend.perTool[p.name]?.dayUsd;
    const input = Object.assign(document.createElement('input'), { type: 'number', min: '0', step: '0.5', className: 'num-narrow sp-tool-day', placeholder: t('none'), value: lim ? String(lim) : '' });
    input.dataset.tool = p.name;
    input.setAttribute('aria-label', t('Daily limit for {tool}', { tool: p.name }));
    const lab = ctx.el('label', 'sp-tool-label', `${t('Each day')} $ `);
    lab.append(input);
    li.append(ctx.el('span', '', `${p.name} · ${priceText(p)}`), ' ', lab);
    list.append(li);
  }
  $('#sp-saver').value = data.tokenSaver.mode;
  const sel = $('#sp-saver-tokens');
  sel.replaceChildren(...data.tokenChoices.map((n) => Object.assign(document.createElement('option'), { value: String(n), textContent: n ? t('{n} tokens a day', { n: n.toLocaleString() }) : t('Only the daily $ limit') })));
  sel.value = String(data.tokenSaver.dailyTokens);
  if (sel.value !== String(data.tokenSaver.dailyTokens)) sel.value = '0';
  syncSaverRow();
}

function syncSaverRow() {
  const mode = $('#sp-saver').value;
  $('#sp-saver-line-row').hidden = mode !== 'auto';
  const st = data?.saver;
  $('#sp-saver-state').textContent = !st ? '' : st.on ? (st.why === 'auto' ? t('On by itself today (near your daily line). It goes off again at the daily reset.') : t('On now.')) : mode === 'auto' ? t('Off now; it turns on by itself at 80% of the daily line.') : t('Off.');
}

async function save() {
  const err = $('#sp-error');
  err.textContent = '';
  const perTool = {};
  for (const i of document.querySelectorAll('#sp-tools .sp-tool-day')) if (i.value) perTool[i.dataset.tool] = { dayUsd: Number(i.value) };
  try {
    data = await ctx.api('/spend', { method: 'PUT', body: { spend: { dayUsd: Number($('#sp-day').value) || 0, monthUsd: Number($('#sp-month').value) || 0, perTool }, tokenSaver: { mode: $('#sp-saver').value, dailyTokens: Number($('#sp-saver-tokens').value) || 0 } } });
    $('#sp-now').textContent = t('Saved.');
    syncSaverRow();
    void refreshSaverBadge();
  } catch (e) {
    err.textContent = e.message;
  }
}
