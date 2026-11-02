// Phase 123 (docs/design/LEAN.md §4.10, §5.10): the short tool list and Tidy this chat.
//
// The ring's sheet gets a tools line ("Tools: 23 of 141 offered · ≈ 2.9k tokens a step"), What she has
// (offered by group with reason chips, the deferred groups, Always offer here), and Tidy this chat /
// New session. A `compact` notice in the thread is the divider: "✂ 46 earlier messages tidied" with
// Show summary and Undo; the messages it stands in for stay where they are, dimmed. Settings →
// Abilities → Tools and approvals holds the Short tool list card; Settings → Models → Default model →
// Long conversations holds Tidy long chats. Every button is a 44 px target with a text label.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, state: any, el: (tag: string, cls?: string, text?: string) => HTMLElement, reload: () => void, newSession: () => void } | null} */
let ctx = null;
let settings = null;

export function initLean(c) {
  ctx = c;
  $('#ctx-tidy')?.addEventListener('click', () => void tidyNow());
  $('#ctx-new')?.addEventListener('click', () => ctx.newSession());
  $('#ctx-what')?.addEventListener('click', () => void toggleWhat());
  for (const id of ['lean-mode', 'lean-above', 'lean-sticky', 'lean-localcore', 'compact-auto', 'compact-at', 'compact-keep', 'compact-model', 'compact-runs', 'compact-tokens', 'compact-crisis']) $(`#${id}`)?.addEventListener('change', () => void saveLean());
}

const el = (tag, cls, text) => ctx.el(tag, cls, text);
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const button = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

/** The ring's sheet: the tools line and the tidy buttons (from GET /fill). */
export function paintSheet(fill) {
  const line = $('#ctx-tools');
  const tidy = $('#ctx-tidy');
  const note = $('#ctx-tidy-note');
  if (!line || !tidy) return;
  const tl = fill?.tools;
  line.hidden = !tl || !tl.eligible;
  $('#ctx-what').hidden = line.hidden || !tl?.lean;
  if (tl && tl.eligible) {
    line.textContent = tl.lean
      ? t('Tools: {n} of {total} offered · ≈ {tokens} tokens a step', { n: tl.offered, total: tl.eligible, tokens: k(tl.offeredTokens) })
      : t('Tools: all {total} offered · ≈ {tokens} tokens a step', { total: tl.eligible, tokens: k(tl.eligibleTokens) });
  }
  const pct = Number(fill?.percent ?? 0);
  const can = pct >= 50 || Number(fill?.dropped ?? 0) > 0;
  tidy.disabled = !can || Boolean(ctx.state.busy?.has?.(ctx.state.currentId));
  if (note) note.textContent = fill?.fold ? t('Tidied {n} messages · Undo is on the divider', { n: fill.fold.folded }) : can ? '' : t('Nothing to tidy yet');
}

async function tidyNow() {
  const id = ctx.state.currentId;
  if (!id) return;
  const note = $('#ctx-tidy-note');
  $('#ctx-tidy').disabled = true;
  if (note) note.textContent = t('Tidying… (on this computer)');
  try {
    const r = await ctx.api(`/conversations/${id}/compact`, { method: 'POST', body: { button: true } });
    if (note) note.textContent = r.fold ? t('Tidied {n} messages · Undo is on the divider', { n: r.fold.folded }) : r.skipped === 'short' ? t('This chat is already short; nothing to tidy.') : t("I don't tidy this kind of chat.");
    if (r.fold) ctx.reload();
  } catch (err) {
    if (note) note.textContent = err?.message ? t(err.message) : t("She's working; I'll tidy when she's done.");
  } finally {
    $('#ctx-tidy').disabled = false;
  }
}

/** What she has: offered tools by group with reason chips, then the deferred groups. */
async function toggleWhat() {
  const box = $('#ctx-what-list');
  if (!box) return;
  if (!box.hidden) return void (box.hidden = true);
  const id = ctx.state.currentId;
  const v = await ctx.api(`/conversations/${id}/tools`).catch(() => null);
  box.replaceChildren();
  box.hidden = false;
  if (!v) return;
  const WHY = { core: t('core'), safety: t('safety'), pinned: t('you pinned'), asked: t('you asked'), ref: t('you asked'), recent: t('used lately'), goal: t('used lately'), skill: t('a skill uses it'), find: t('looked up'), used: t('looked up') };
  const groups = new Map();
  for (const o of v.offered) groups.set(o.family, [...(groups.get(o.family) ?? []), o]);
  for (const [fam, list] of groups) {
    const row = el('div', 'lean-row');
    row.append(el('span', 'lean-fam', fam), el('span', 'lean-chip', WHY[list[0].why] ?? list[0].why), el('span', 'muted small', String(list.length)));
    box.append(row);
  }
  if (v.deferred.length) box.append(el('p', 'muted small', t('Ready when she needs them:')));
  for (const d of v.deferred.slice(0, 20)) {
    const row = el('div', 'lean-row');
    const pinned = v.pins.includes(d.id);
    row.append(el('span', 'lean-fam', `${d.label} (${d.count})`), button(pinned ? t('Offered here') : t('Always offer here'), 'ghost small lean-pin', async () => {
      await ctx.api(`/conversations/${id}/tools`, { method: 'PUT', body: pinned ? { unpin: d.id } : { pin: d.id } }).catch(() => null);
      box.hidden = true;
      void toggleWhat();
    }));
    box.append(row);
  }
}

/** The divider a `compact` notice draws (with Show summary and Undo). Null for other notices. */
export function compactNotice(m, messages) {
  if (m.role !== 'notice' || m.kind !== 'compact') return null;
  const meta = m.meta ?? {};
  const wrap = el('div', 'fold-divider');
  wrap.dataset.id = m.id;
  if (!meta.fold || meta.undone || meta.autoOff) {
    wrap.classList.add('fold-muted');
    wrap.append(el('p', 'fold-line muted small', meta.undone ? t('Tidy undone') : m.content));
    return wrap;
  }
  const current = !messages.some((x) => x.role === 'notice' && x.kind === 'compact' && x.id > m.id && x.meta?.fold);
  const undone = messages.some((x) => x.role === 'notice' && x.kind === 'compact' && x.meta?.fold === meta.fold && x.meta?.undone);
  const where = meta.kind === 'plain' ? t('as a plain list') : meta.local ? t('written on this computer') : t('written by the quick model');
  wrap.append(el('p', 'fold-line', `✂ ${t('{n} earlier messages tidied', { n: meta.folded ?? 0 })} · ${where}${meta.model ? ` (${meta.model})` : ''}`));
  if (undone || !current) {
    wrap.classList.add('fold-muted');
    return wrap;
  }
  wrap.append(el('p', 'fold-sub muted small', t('Not sent to her right now: she reads the summary instead.')));
  const card = el('div', 'fold-card');
  card.hidden = true;
  const acts = el('div', 'fold-acts');
  acts.append(
    button(t('Show summary'), 'ghost small', async () => {
      if (!card.hidden) return void (card.hidden = true);
      const r = await ctx.api(`/conversations/${ctx.state.currentId}/compactions`).catch(() => null);
      const f = r?.folds?.find((x) => x.id === meta.fold);
      card.replaceChildren(el('p', 'fold-summary', f?.summary ?? t('Nothing is tidied in this chat.')));
      if (f?.focus) card.append(el('p', 'muted small', `${t('Focus')}: ${f.focus}`));
      if (f) card.append(el('p', 'muted small', t('{chars} characters · {tokens} tokens read', { chars: (f.summary ?? '').length, tokens: f.tokens })));
      card.hidden = false;
    }),
    button(t('Undo'), 'ghost small', async () => {
      await ctx.api(`/compactions/${meta.fold}/undo`, { method: 'POST', body: {} }).catch(() => null);
      ctx.reload();
    }),
  );
  wrap.append(acts, card);
  return wrap;
}

/** Dims the messages the current fold stands in for (they stay in place, readable). */
export function dimFolded(container, messages) {
  const folds = messages.filter((x) => x.role === 'notice' && x.kind === 'compact' && x.meta?.fold && !x.meta?.undone);
  const last = folds.at(-1);
  if (!last || messages.some((x) => x.role === 'notice' && x.kind === 'compact' && x.meta?.fold === last.meta.fold && x.meta?.undone)) return;
  const through = Number(last.meta.throughId ?? 0);
  for (const node of container.querySelectorAll('.msg[data-id]')) if (Number(node.dataset.id) <= through && !node.classList.contains('notice')) node.classList.add('folded');
}

// ---------- Settings ----------

export async function loadLean() {
  const r = await ctx.api('/lean').catch(() => null);
  if (!r) return;
  settings = r.settings;
  const set = (id, v) => {
    const e = $(`#${id}`);
    if (!e) return;
    if (e.type === 'checkbox') e.checked = Boolean(v);
    else e.value = String(v);
  };
  set('lean-mode', settings.tools.mode);
  set('lean-above', settings.tools.aboveTokens);
  set('lean-sticky', settings.tools.stickyTurns);
  set('lean-localcore', settings.tools.localCore);
  set('compact-auto', settings.compact.auto);
  set('compact-at', settings.compact.at);
  set('compact-keep', settings.compact.keepTurns);
  set('compact-model', settings.compact.model);
  set('compact-runs', settings.compact.dailyCap.runs);
  set('compact-tokens', settings.compact.dailyCap.tokens);
  set('compact-crisis', settings.compact.crisisKeepHours);
  const m = await ctx.api('/lean/measure').catch(() => null);
  const line = $('#lean-measure');
  // PL2c (N24): in words first; the token numbers go under the ?.
  if (line && m) {
    const saves = m.chat.tokens > 0 ? Math.max(0, Math.round((1 - m.chat.offeredTokens / m.chat.tokens) * 100)) : 0;
    line.textContent = saves >= 5 ? t('She gets the tools that fit each step (saves about {pct}%).', { pct: saves }) : t('She gets all her tools each step.');
    const q = el('button', 'tip', '?');
    q.type = 'button';
    q.dataset.tip = t('Right now: {n} tools ≈ {tokens} tokens each step; short list ≈ {short}.', { n: m.chat.tools, tokens: k(m.chat.tokens), short: k(m.chat.offeredTokens) });
    line.append(' ', q);
  }
}

async function saveLean() {
  const v = (id) => $(`#${id}`);
  const body = {
    tools: { mode: v('lean-mode').value, aboveTokens: Number(v('lean-above').value), stickyTurns: Number(v('lean-sticky').value), localCore: v('lean-localcore').checked },
    compact: { auto: v('compact-auto').checked, at: Number(v('compact-at').value), keepTurns: Number(v('compact-keep').value), model: v('compact-model').value, crisisKeepHours: Number(v('compact-crisis').value), dailyCap: { runs: Number(v('compact-runs').value), tokens: Number(v('compact-tokens').value) } },
  };
  const r = await ctx.api('/lean', { method: 'PUT', body }).catch(() => null);
  if (r) settings = r.settings;
}
