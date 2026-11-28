// T63 (owner, 2026-11-28): the one model control, in the message box. Before, the model sat in two
// places at the top (the strip named her last reply's model and opened the server-wide "Which model
// does what"; the header chip opened the chat's settings), switching one didn't switch the other, and
// a new pick didn't show. Now:
//   - wide screens: a small chip in the composer's bottom row, next to +, with a short model name;
//   - phones (760 px and narrower): no chip, the first item of the + menu is "Model: <name>";
//   - both open the same picker: "Default (<name>)" (no model set for this chat), then the models of
//     the connected providers by service (recent picks first). A pick PATCHes this conversation at
//     once and says so in the chat. The server reads the conversation when a turn starts, so the very
//     next message uses it; a reply already being written finishes with the model it started with.
// The chip names what the NEXT message uses (GET /api/conversations/:id/model, the same decision a turn
// makes: her own model, Auto, the Talking route or the default), never the last reply's model; a reply
// that came from a fallback still says so on the reply itself. Hidden in group chats and the demo.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
const RECENT_KEY = 'sara.recentModels';
const RECENT_MAX = 4;
const FIND_FROM = 10;

/**
 * A short name for the chip: no "vendor/" path, no Ollama cloud tag (":cloud", "-cloud"), no
 * ":latest" and no release date ("-20250514", "-2024-08-06"). The full name stays in the title and the menu.
 */
export function shortModel(name) {
  let s = String(name ?? '').trim();
  if (!s) return '';
  s = s.slice(s.lastIndexOf('/') + 1) || s;
  s = s.replace(/:(cloud|latest)$/i, '').replace(/-cloud$/i, '');
  s = s.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return s || String(name);
}

const keyOf = (p) => `${p.providerId}\u0000${p.model}`;

/** The recent picks kept on this device (never needed: an empty list when storage is off). */
export function readRecent(store = globalThis.localStorage) {
  try {
    const v = JSON.parse(store?.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.providerId === 'string' && typeof x.model === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}
export function pushRecent(pick, store = globalThis.localStorage) {
  const next = [pick, ...readRecent(store).filter((x) => keyOf(x) !== keyOf(pick))].slice(0, RECENT_MAX);
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private window: no recent list */
  }
  return next;
}

/**
 * The picker's groups: Recent (picks still offered), then one group per service in Settings order.
 * `lists` maps providerId → model ids. The chat's own model is listed even when its list lacks it.
 */
export function pickerGroups(providers, lists, chosen, recent = []) {
  const offered = new Map();
  const groups = [];
  for (const p of providers) {
    const ids = [...(lists[p.id] ?? [])];
    if (chosen?.providerId === p.id && chosen.model && !ids.includes(chosen.model)) ids.unshift(chosen.model);
    const items = [...new Set(ids)].map((model) => ({ providerId: p.id, provider: p.label, model }));
    for (const it of items) offered.set(keyOf(it), it);
    if (items.length) groups.push({ label: p.label, items });
  }
  const rec = recent.map((r) => offered.get(keyOf(r))).filter(Boolean);
  return [...(rec.length ? [{ label: t('Recent'), items: rec, recent: true }] : []), ...groups];
}

/** Text that isn't a chat model (embeddings, speech, rerankers): never offered for talking. */
const NOT_CHAT = /embed|bge-|\be5-|gte-|minilm|whisper|tts|rerank/i;

export function initChatModel(ctx) {
  const chip = $('#cmp-model');
  const chipName = $('#cmp-model-name');
  const item = $('#cmp-model-item');
  const itemName = $('#cmp-model-item-name');
  const pop = $('#cmp-model-pop');
  if (!chip || !pop) return { sync() {}, refresh: async () => {}, view: () => null };
  const ui = { convId: null, view: null, opener: chip, req: 0, saving: false };

  const shown = () => {
    const c = ctx.conv();
    return Boolean(c) && !ctx.isGroup(c) && !ctx.demo() && Boolean(ctx.providers()?.providers?.length);
  };
  /** What the next message uses: the chat's own model the moment it is set, else what the server said. */
  function nextName() {
    const c = ctx.conv();
    if (c?.providerId && c.model) return { model: c.model, provider: ctx.providers()?.providers?.find((p) => p.id === c.providerId)?.label ?? '' };
    const v = ui.convId === c?.id ? ui.view : null;
    const n = v?.next ?? v?.default;
    return n ? { model: n.model, provider: n.provider, auto: n.from === 'auto' } : null;
  }
  function paint() {
    const on = shown();
    chip.hidden = !on;
    if (item) item.hidden = !on;
    if (!on) {
      close();
      return;
    }
    const n = nextName();
    const short = n ? shortModel(n.model) : '';
    const label = n ? (n.auto ? `${t('Auto')} · ${short}` : short) : ui.view ? t('No model yet') : '…';
    chipName.textContent = label;
    const full = n ? `${n.model}${n.provider ? ` · ${n.provider}` : ''}` : label;
    chip.title = t('Model for this chat: {model}', { model: full });
    chip.setAttribute('aria-label', chip.title);
    chip.classList.toggle('set', Boolean(ctx.conv()?.providerId));
    if (itemName) itemName.textContent = t('Model: {model}', { model: label });
  }
  async function refresh() {
    const c = ctx.conv();
    if (!c || !shown()) return paint();
    const req = ++ui.req;
    try {
      const v = await ctx.api(`/conversations/${c.id}/model`);
      if (req !== ui.req || ctx.conv()?.id !== c.id) return;
      ui.convId = c.id;
      ui.view = v;
      // A /model typed in the chat (or another device) changed it: this copy follows.
      const own = v.chosen ?? { providerId: null, model: null };
      if ((c.providerId ?? null) !== own.providerId || (c.model ?? null) !== (own.model ?? null)) ctx.setConv({ providerId: own.providerId, model: own.model ?? null });
    } catch {
      if (req === ui.req) ui.view = null;
    }
    paint();
    ctx.changed?.();
  }
  /** Called whenever the chat or its settings change: asks again when what decides the model changed. */
  function sync() {
    const c = ctx.conv();
    const sig = c ? [c.id, c.providerId, c.model, c.mode, Boolean(c.private)].join('\u0000') : '';
    if (c && c.id !== ui.convId) {
      ui.view = null;
      ui.convId = c.id;
    }
    if (c && sig !== ui.sig) {
      ui.sig = sig;
      void refresh();
    }
    paint();
  }

  // ---------- the picker ----------
  const items = () => [...pop.querySelectorAll('.cmp-model-find, .pop-item')].filter((b) => !b.hidden);
  function close(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    chip.classList.remove('on');
    if (focus) ui.opener?.focus({ preventScroll: true });
  }
  function row(pick, { checked, label, sub }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pop-item cmp-model-opt';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(checked));
    const name = document.createElement('span');
    name.className = 'cmp-model-opt-name';
    name.textContent = label;
    if (pick) name.dataset.raw = '';
    b.append(name);
    if (sub) {
      const s = document.createElement('span');
      s.className = 'cmp-model-opt-sub muted small';
      s.dataset.raw = '';
      s.textContent = sub;
      b.append(s);
    }
    b.dataset.find = `${label} ${sub ?? ''}`.toLowerCase();
    b.addEventListener('click', () => void choose(pick));
    return b;
  }
  async function lists(providers) {
    const out = {};
    await Promise.all(
      providers.map(async (p) => {
        try {
          const view = await ctx.modelViewFor(p.id);
          out[p.id] = (view.entries ?? view.models.map((id) => ({ id }))).filter((e) => !e.unpulled && !NOT_CHAT.test(e.id)).map((e) => e.id);
        } catch {
          out[p.id] = p.defaultModel ? [p.defaultModel] : [];
        }
      }),
    );
    return out;
  }
  async function build() {
    const c = ctx.conv();
    const all = ctx.providers()?.providers ?? [];
    // A private chat only uses models on her own hardware (the server refuses the rest).
    const providers = c?.private ? all.filter((p) => p.local) : all;
    const loading = document.createElement('p');
    loading.className = 'muted small cmp-model-note';
    loading.textContent = t('Loading…');
    pop.replaceChildren(loading);
    const [models] = await Promise.all([lists(providers), refresh()]);
    if (pop.hidden || ctx.conv()?.id !== c?.id) return;
    const chosen = c.providerId ? { providerId: c.providerId, model: c.model } : null;
    const def = ui.view?.default;
    const defName = def ? `${def.from === 'auto' ? `${t('Auto')} · ` : ''}${def.model}` : t('none');
    const groups = pickerGroups(providers, Object.fromEntries(Object.entries(models).map(([k, v]) => [k, c.private ? v.filter((m) => !/(:|-)cloud$/i.test(m)) : v])), chosen, readRecent());
    const count = groups.filter((g) => !g.recent).reduce((n, g) => n + g.items.length, 0);
    const list = document.createElement('div');
    list.className = 'cmp-model-list';
    list.append(row(null, { checked: !chosen, label: t('Default ({model})', { model: defName }), sub: def?.provider ?? '' }));
    for (const g of groups) {
      const h = document.createElement('div');
      h.className = 'cmp-model-group';
      h.setAttribute('role', 'presentation');
      if (!g.recent) h.dataset.raw = '';
      h.textContent = g.label;
      list.append(h, ...g.items.map((it) => row(it, { checked: Boolean(chosen) && keyOf(chosen) === keyOf(it), label: it.model, sub: g.recent ? it.provider : '' })));
    }
    const note = document.createElement('p');
    note.className = 'muted small cmp-model-note';
    note.textContent = t('Used from your next message. Each reply shows the model that wrote it.');
    const parts = [];
    if (count >= FIND_FROM) {
      const find = document.createElement('input');
      find.type = 'search';
      find.className = 'cmp-model-find';
      find.placeholder = t('Find a model');
      find.setAttribute('aria-label', t('Find a model'));
      find.addEventListener('input', () => {
        const q = find.value.trim().toLowerCase();
        for (const b of list.querySelectorAll('.cmp-model-opt')) b.hidden = Boolean(q) && !b.dataset.find.includes(q);
        // A service heading shows while one of its models does.
        for (const h of list.querySelectorAll('.cmp-model-group')) {
          let n = h.nextElementSibling;
          let any = false;
          while (n && !n.classList.contains('cmp-model-group')) {
            any ||= !n.hidden;
            n = n.nextElementSibling;
          }
          h.hidden = !any;
        }
      });
      parts.push(find);
    }
    pop.replaceChildren(...parts, list, note);
    (pop.querySelector('.cmp-model-opt[aria-checked="true"]') ?? items()[0])?.focus({ preventScroll: true });
    pop.querySelector('.cmp-model-opt[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  function open(opener) {
    if (!shown()) return;
    ui.opener = opener;
    ctx.closeOthers?.();
    pop.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
    chip.classList.add('on');
    void build();
  }
  async function choose(pick) {
    const c = ctx.conv();
    if (!c || ui.saving) return;
    const same = pick ? c.providerId === pick.providerId && c.model === pick.model : !c.providerId;
    close(true);
    if (same) return;
    ui.saving = true;
    const busy = ctx.streaming();
    try {
      const conv = await ctx.api(`/conversations/${c.id}`, { method: 'PATCH', body: { providerId: pick?.providerId ?? null, model: pick?.model ?? null } });
      ctx.setConv({ providerId: conv.providerId ?? null, model: conv.model ?? null });
      if (pick) pushRecent({ providerId: pick.providerId, model: pick.model });
      paint();
      const name = pick ? `${pick.model} (${pick.provider})` : '';
      ctx.notice(
        pick
          ? busy ? t('This chat now uses {model} from your next message. The reply she is writing finishes as it started.', { model: name }) : t('This chat now uses {model}.', { model: name })
          : busy ? t('Back to the default model from your next message. The reply she is writing finishes as it started.') : t('Back to the default model.'),
      );
      await refresh();
    } catch (err) {
      ctx.error(err.message);
    } finally {
      ui.saving = false;
    }
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop.hidden) open(chip);
    else close(true);
  });
  // A change in Settings (her own model, the default, Auto) shows when Settings closes.
  $('#settings')?.addEventListener('close', () => void refresh());
  // Phones: the + menu closes itself on the click; the picker opens right after.
  item?.addEventListener('click', () => setTimeout(() => open($('#composer-plus') ?? chip), 0));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) close(true);
  });
  document.addEventListener('click', (e) => {
    if (pop.hidden || !(e.target instanceof Node) || pop.contains(e.target) || chip.contains(e.target) || item?.contains(e.target)) return;
    close();
  });
  pop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const list = items();
    const i = list.indexOf(document.activeElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
  });
  return { sync, refresh, view: () => (ui.convId === ctx.conv()?.id ? ui.view : null), close };
}
