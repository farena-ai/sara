// ALERTDEST (docs/ALERTS_DESTINATIONS.md): where her alerts and other results she posts on her own go.
// One destination shape for every producer (live watches, product watches, automations, research,
// S3 goals, S6 travel, the inbox helper, reminders, the morning briefing) and for her own pictures
// (src/own-photos.ts keeps its stored `photos.own.dest` and uses the chat placing below):
//   origin    where it goes today (the chat it was made in, or the producer's own chat); if that chat
//             is gone, a chat named after the feed (never whichever chat happens to be first)
//   chat      one of the owner's own 1:1 chats here (never a group, room, partner or private chat)
//   project   a chat named after the feed ("Stock alerts") inside that project, made on first use
//   dedicated a chat just for this feed, made on first use
//   apps      no new message here (Telegram/Discord and the notification only)
// plus Telegram/Discord switches (the owner's own DM there, only once the app is connected).
// Each household member's space has its own settings and store, so destinations never cross spaces.
// Per feed default in settings.alerts.feeds, per item override in settings.alerts.items (keys are the
// Automations page keys: live:12, product:3, auto:5, goal:2), chats made in settings.alerts.made.
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { ownerEvidenceConversation } from './owner-evidence.ts';
import type { Conversation } from './store.ts';
import { ToolError, type Tool } from './tools/types.ts';

export type Feed = 'stocks' | 'sports' | 'mail' | 'products' | 'automations' | 'research' | 'goals' | 'travel' | 'inbox' | 'reminders' | 'briefing';
export type Where = 'origin' | 'chat' | 'project' | 'dedicated' | 'apps';
export const WHERES: readonly Where[] = ['origin', 'chat', 'project', 'dedicated', 'apps'];
export type AppKind = 'telegram' | 'discord';

export interface Dest {
  where: Where;
  conversationId?: string;
  projectId?: number;
  telegram?: boolean;
  discord?: boolean;
}
export interface AlertSettings {
  feeds?: Partial<Record<Feed, Dest>>;
  items?: Record<string, Dest>;
  made?: Record<string, string>;
}
/** One place something went (or would go), for status lines. */
export interface Target {
  kind: 'chat' | 'project' | 'telegram' | 'discord';
  name?: string;
}

/** Feeds in the order Settings lists them; titles are the chat names (and the i18n keys). */
/** `origin`: what "as now" means for the feed, in the picker and the status line. */
export const FEEDS: readonly { id: Feed; title: string; words: RegExp; items: boolean; keepsChat?: true; origin?: string }[] = [
  { id: 'stocks', title: en('Stock alerts'), words: /\b(stocks?|shares?|tickers?|prices? alerts?|market)\b/i, items: true },
  { id: 'sports', title: en('Sports and odds'), words: /\b(sports?|games?|scores?|odds|teams?|betting)\b/i, items: true },
  { id: 'mail', title: en('Mail watches'), words: /\b(e-?mail|mail|inbox watch)\w*/i, items: true },
  { id: 'products', title: en('Product watches'), words: /\b(products?|shopping|deals?|restock)\b/i, items: true },
  { id: 'automations', title: en('Automations'), words: /\bautomations?\b/i, items: true, origin: en('Its own chat') },
  { id: 'research', title: en('Research'), words: /\bresearch\b/i, items: false, origin: en('Only the notification') },
  { id: 'goals', title: en('Goals'), words: /\bgoals?\b/i, items: true, origin: en('Its own chat') },
  { id: 'travel', title: en('Travel'), words: /\b(travel|trips?|flights?)\b/i, items: false, origin: en('Its own chat') },
  { id: 'inbox', title: en('From your inbox'), words: /\b(inbox helper|from (my|your) inbox|bills?|packages?)\b/i, items: false, origin: en('Its own chat') },
  { id: 'reminders', title: en('Reminders'), words: /\breminders?\b/i, items: false, keepsChat: true },
  { id: 'briefing', title: en('Morning briefing'), words: /\b(briefing|mornings?)\b/i, items: false, keepsChat: true, origin: en('Your latest chat') },
];
const FEED_IDS = new Set<string>(FEEDS.map((f) => f.id));
export const isFeed = (x: unknown): x is Feed => FEED_IDS.has(String(x));

/** The feed a live watch belongs to. */
export const liveFeed = (kind: string): Feed => (kind === 'price' ? 'stocks' : kind === 'mail' ? 'mail' : 'sports');

export function alertSettings(app: Pick<AppContext, 'settings'>): AlertSettings {
  return app.settings.get().alerts ?? {};
}
function saveAlerts(app: AppContext, next: AlertSettings): void {
  app.settings.update({ alerts: next });
}

/** "As now" for this feed, in the owner's language. */
export function originLabel(app: AppContext, feed: Feed): string {
  return trOwner(FEEDS.find((f) => f.id === feed)?.origin ?? en('Where it was set up'), app.settings.get());
}

export function feedTitle(app: AppContext, feed: Feed): string {
  return trOwner(FEEDS.find((f) => f.id === feed)?.title ?? feed, app.settings.get());
}

/** Clean a destination from outside (a route body, a tool). Unknown → undefined. */
export function cleanDest(x: unknown): Dest | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const d = x as Record<string, unknown>;
  if (!WHERES.includes(d.where as Where)) return undefined;
  const out: Dest = { where: d.where as Where };
  if (out.where === 'chat' && typeof d.conversationId === 'string') out.conversationId = d.conversationId.slice(0, 80);
  if (out.where === 'project' && Number.isInteger(Number(d.projectId))) out.projectId = Number(d.projectId);
  if (d.telegram === true) out.telegram = true;
  if (d.discord === true) out.discord = true;
  return out;
}

/** The destination in force: the item's own, else the feed's default, else where it goes today. */
export function destFor(app: AppContext, feed: Feed, item?: string): Dest {
  const a = alertSettings(app);
  return (item && a.items?.[item]) || a.feeds?.[feed] || { where: 'origin' };
}

// ------------------------------------------------------------ the owner's chats (shared with own-photos)

/** One of the owner's own 1:1 chats here (never a group, room, partner or private chat). */
export function ownerWebChat(app: AppContext, id: string | undefined): Conversation | undefined {
  if (!id) return undefined;
  const c = ownerEvidenceConversation(app, id);
  return c && c.channel === 'web' && c.mode === 'chat' && !c.private && !c.partner ? c : undefined;
}
export function ownerWebChats(app: AppContext, limit = 60): { id: string; title: string }[] {
  return app.store.listConversations().filter((c) => c.channel === 'web' && c.mode === 'chat' && !c.private && !c.partner && !c.archivedAt && ownerWebChat(app, c.id)).slice(0, limit).map((c) => ({ id: c.id, title: c.title }));
}
/** The owner's own projects (not a chat app's built-in project). */
export function ownerProjects(app: AppContext): { id: number; name: string }[] {
  return (app.planner?.projects() ?? []).filter((p) => !p.builtin).map((p) => ({ id: p.id, name: p.name }));
}
/** Telegram/Discord: the bridge runs and knows the owner. */
export function appReady(app: AppContext, kind: AppKind): boolean {
  const st = app.bridges?.[kind]?.status();
  return Boolean(st?.running && st.linked);
}

/**
 * A chat made for something (her pictures, a feed): a dedicated chat, a project's chat, or one of the
 * owner's own chats. Made chats are remembered under `key` (+ ':project:<id>') through `made`/`save`;
 * nothing is made unless `create`.
 */
export function placeChat(app: AppContext, o: { here: 'dedicated' | 'project' | 'chat'; chatId?: string; projectId?: number; key: string; projectKey?: (id: number) => string; title: string; made: Record<string, string> | undefined; save: (key: string, id: string) => void; create: boolean }): { conv?: Conversation; target?: Target; skipped?: string } {
  if (o.here === 'chat') {
    const conv = ownerWebChat(app, o.chatId);
    return conv ? { conv, target: { kind: 'chat', name: conv.title } } : { skipped: 'no chat' };
  }
  let key = o.key;
  let projectId: number | null = null;
  let target: Target = { kind: 'chat', name: o.title };
  if (o.here === 'project') {
    const project = app.planner?.projects().find((x) => x.id === o.projectId);
    if (!project) return { skipped: 'no project' };
    key = o.projectKey ? o.projectKey(project.id) : `${o.key}:project:${project.id}`;
    projectId = project.id;
    target = { kind: 'project', name: project.name };
  }
  const was = ownerWebChat(app, o.made?.[key]);
  if (was && (projectId === null || was.projectId === projectId)) return { conv: was, target };
  if (!o.create) return { target };
  const conv = app.store.createConversation({ title: o.title, titleSource: 'placeholder', channel: 'web', mode: 'chat', projectId });
  o.save(key, conv.id);
  return { conv, target };
}

// ------------------------------------------------------------ placing one alert

export interface AlertPlace {
  /** The chat here it goes to (none for apps only). */
  conversationId?: string;
  apps: AppKind[];
  to: Target[];
}

/**
 * Where one alert of `feed` goes. `origin` is the producer's own choice (today's behavior); it may
 * return undefined (the chat it was made in is gone), then a chat named after the feed is used.
 */
export function alertPlace(app: AppContext, feed: Feed, o: { item?: string; origin?: () => string | undefined; create?: boolean } = {}): AlertPlace {
  const create = o.create !== false;
  const d = destFor(app, feed, o.item);
  const apps = (['telegram', 'discord'] as const).filter((k) => d[k] && appReady(app, k));
  const to: Target[] = [];
  let conversationId: string | undefined;
  const feedChat = (here: 'dedicated' | 'project' | 'chat') => {
    const p = placeChat(app, { here, chatId: d.conversationId, projectId: d.projectId, key: feed, title: feedTitle(app, feed), made: alertSettings(app).made, save: (k, id) => saveAlerts(app, { ...alertSettings(app), made: { ...alertSettings(app).made, [k]: id } }), create });
    return p;
  };
  if (d.where !== 'apps') {
    let p: ReturnType<typeof feedChat> | undefined;
    if (d.where === 'origin') {
      const id = o.origin?.();
      const c = id ? app.store.getConversation(id) : undefined;
      if (c) {
        conversationId = c.id;
        to.push({ kind: 'chat', name: c.title });
      } else p = feedChat('dedicated');
    } else {
      p = feedChat(d.where);
      // A chosen chat or project that is gone: the feed's own chat, so nothing is lost.
      if (p.skipped) p = feedChat('dedicated');
    }
    if (p) {
      conversationId = p.conv?.id;
      if (p.target) to.push(p.target.kind === 'project' ? { kind: 'project', name: `${p.target.name} › ${feedTitle(app, feed)}` } : p.target);
    }
  }
  for (const k of apps) to.push({ kind: k });
  return { ...(conversationId ? { conversationId } : {}), apps, to };
}

/** The app mirrors her own messages there already (so a message would arrive twice). */
function mirrors(app: AppContext, kind: AppKind): boolean {
  const s = app.settings.get() as { telegram?: { mirror?: boolean }; discord?: { mirror?: boolean } };
  return kind === 'telegram' ? s.telegram?.mirror !== false : s.discord?.mirror === true;
}

/** Sends the alert text to the chosen chat apps (notices are never mirrored, messages may be). */
export function alertApps(app: AppContext, place: AlertPlace, text: string, notice: boolean): void {
  for (const k of place.apps) {
    if (!notice && place.conversationId && mirrors(app, k)) continue;
    const b = app.bridges?.[k] as { sendOwnText?: (t: string) => Promise<unknown> } | undefined;
    void b?.sendOwnText?.(text.slice(0, 1800)).catch(() => undefined);
  }
}

/** Posts one alert where it belongs; returns the chat id here (undefined for apps only). */
export function postAlert(app: AppContext, feed: Feed, o: { item?: string; origin?: () => string | undefined; role: 'assistant' | 'notice'; content: string; meta?: Record<string, unknown>; reason?: 'reply' | 'reminder' | 'proactive'; appText?: string }): string | undefined {
  const place = alertPlace(app, feed, o);
  if (place.conversationId) {
    const msg = app.store.addMessage(place.conversationId, o.role, o.content, o.meta);
    app.events?.publish({ type: 'message', conversationId: place.conversationId, message: msg, reason: o.reason ?? 'reminder' });
  }
  alertApps(app, place, o.appText ?? o.content, o.role === 'notice');
  return place.conversationId;
}

/** "Stock Alerts › Stock alerts · Telegram", without making anything. */
export function describeDest(app: AppContext, feed: Feed, item?: string, origin?: () => string | undefined): string {
  const d = destFor(app, feed, item);
  const s = app.settings.get();
  const names: string[] = [];
  if (d.where === 'origin') {
    const id = origin?.();
    const c = id ? app.store.getConversation(id) : undefined;
    names.push(c ? c.title : originLabel(app, feed));
  } else if (d.where !== 'apps') names.push(...alertPlace(app, feed, { item, create: false }).to.filter((x) => x.kind === 'chat' || x.kind === 'project').map((x) => x.name ?? ''));
  for (const k of ['telegram', 'discord'] as const) if (d[k]) names.push(appReady(app, k) ? (k === 'telegram' ? 'Telegram' : 'Discord') : trOwner(en('{app} (not connected)'), s, { app: k === 'telegram' ? 'Telegram' : 'Discord' }));
  return names.filter(Boolean).join(' · ') || trOwner(en('Only the notification'), s);
}

// ------------------------------------------------------------ changing it

/** The items of a feed that exist now (Automations page keys). */
export function feedItems(app: AppContext, feed: Feed): { key: string; label: string; origin?: string | null }[] {
  if (feed === 'stocks' || feed === 'sports' || feed === 'mail') return (app.liveWatches?.list() ?? []).filter((w) => w.state !== 'done' && liveFeed(w.kind) === feed).map((w) => ({ key: `live:${w.id}`, label: w.label, origin: w.conversationId }));
  if (feed === 'products') return (app.productWatches?.list() ?? []).map((w) => ({ key: `product:${w.id}`, label: w.label, origin: w.conversationId }));
  if (feed === 'automations') return (app.automations?.list() ?? []).map((a) => ({ key: `auto:${a.id}`, label: a.name }));
  if (feed === 'goals') return (app.longGoals?.list({ open: true }) ?? []).map((g) => ({ key: `goal:${g.id}`, label: g.title }));
  return [];
}
/** The feed an item key belongs to. */
export function feedOfItem(app: AppContext, key: string): Feed | undefined {
  const [kind, id] = key.split(':');
  if (kind === 'live') {
    const w = app.liveWatches?.get(Number(id));
    return w ? liveFeed(w.kind) : undefined;
  }
  return kind === 'product' ? 'products' : kind === 'auto' ? 'automations' : kind === 'goal' ? 'goals' : undefined;
}

/**
 * Sets a feed's default. `alsoExisting`: the items it has now follow too (their own choices are
 * cleared); otherwise each keeps where it posts today (pinned to its current destination).
 */
export function setFeedDest(app: AppContext, feed: Feed, dest: Dest, alsoExisting: boolean): { moved: number } {
  const a = alertSettings(app);
  const items = { ...a.items };
  const list = feedItems(app, feed);
  for (const it of list) {
    if (alsoExisting) delete items[it.key];
    else items[it.key] ??= a.feeds?.[feed] ?? { where: 'origin' };
  }
  saveAlerts(app, { ...a, feeds: { ...a.feeds, [feed]: dest }, items });
  return { moved: alsoExisting ? list.length : 0 };
}
export function setItemDest(app: AppContext, key: string, dest: Dest | null): void {
  const a = alertSettings(app);
  const items = { ...a.items };
  if (dest) items[key] = dest;
  else delete items[key];
  saveAlerts(app, { ...a, items });
}

/** A destination is valid here: the chat is the owner's own, the project exists. */
export function checkDest(app: AppContext, d: Dest, feed?: Feed): string | undefined {
  // Reminders and the briefing always keep a message here (a call or the chat apps may also get it).
  if (d.where === 'apps' && FEEDS.find((f) => f.id === feed)?.keepsChat) return en('Reminders and the briefing always stay in a chat here too.');
  if (d.where === 'chat' && !ownerWebChat(app, d.conversationId)) return en('Pick one of your own chats here.');
  if (d.where === 'project' && !ownerProjects(app).some((p) => p.id === d.projectId)) return en('Pick a project.');
  if (d.where === 'apps' && !d.telegram && !d.discord) return en('Pick at least one place.');
  return undefined;
}

// ------------------------------------------------------------ words → feed / place (alerts_route)

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** Close enough: equal, one inside the other, or every word of the shorter one starts a word of the other. */
function similar(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 3;
  if (x.replace(/s\b/g, '') === y.replace(/s\b/g, '')) return 2.5;
  if (x.includes(y) || y.includes(x)) return 2;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const lw = long.split(' ');
  return short.split(' ').every((w) => lw.some((l) => l.startsWith(w.replace(/s$/, '')) || w.startsWith(l.replace(/s$/, '')))) ? 1 : 0;
}
export function matchFeed(words: string): Feed | undefined {
  const w = String(words ?? '').trim();
  if (isFeed(w)) return w;
  return FEEDS.find((f) => similar(f.title, w) >= 2)?.id ?? FEEDS.find((f) => f.words.test(w))?.id;
}
/** Best project by name (fuzzy), or undefined. */
export function matchProject(app: AppContext, name: string): { id: number; name: string } | undefined {
  const n = String(name ?? '').replace(/\b(the|my|project|folder)\b/gi, ' ').trim();
  let best: { id: number; name: string } | undefined;
  let score = 0;
  for (const p of ownerProjects(app)) {
    const s = similar(p.name, n);
    if (s > score) [best, score] = [p, s];
  }
  return best;
}

export type Resolved = { dest: Partial<Dest> & { where?: Where }; app?: AppKind } | { missingProject: string } | { error: string };

/** "Stock Alerts" / "here" / "telegram" / "a chat of its own" / "where I set it up" → a destination. */
export function resolveTo(app: AppContext, to: string, here?: string, o: { project?: boolean } = {}): Resolved {
  const w = fold(to);
  if (!w) return { error: 'Say where: a project, one of your chats, here, Telegram or Discord.' };
  if (/^(telegram|discord)$/.test(w)) return { dest: {}, app: w as AppKind };
  if (/^(here|this chat)$/.test(w)) return ownerWebChat(app, here) ? { dest: { where: 'chat', conversationId: here } } : { error: 'This chat can’t take alerts (only your own chats with her here).' };
  if (/^(origin|where (it was|they were|i) set (it |them )?up|where (it was|they were) made|as before|default)$/.test(w)) return { dest: { where: 'origin' } };
  if (/^(dedicated|(a |its |their )?(own )?chat (of|for) (its|their) own|a chat just for (it|them)|own chat)$/.test(w)) return { dest: { where: 'dedicated' } };
  if (/^(apps?( only)?|only (my )?(chat )?apps|nowhere|notifications? only)$/.test(w)) return { dest: { where: 'apps' } };
  // `o.project`: they already said yes to making a project (create_project), so a chat never wins.
  const project = o.project === true || /\bproject\b/.test(w);
  const p = matchProject(app, to);
  // The chat she is asked in is "here", never a by-name match: its title is often the request itself (U1.1).
  const chat = ownerWebChats(app, 200).filter((c) => c.id !== here).map((c) => ({ ...c, s: similar(c.title, to.replace(/\bchat\b/gi, ' ')) })).filter((c) => c.s >= 2).sort((a, b) => b.s - a.s)[0];
  if (p && (project || !chat || similar(p.name, to) >= chat.s)) return { dest: { where: 'project', projectId: p.id } };
  if (chat && !project) return { dest: { where: 'chat', conversationId: chat.id } };
  return { missingProject: String(to).replace(/\b(the|my)\b/gi, ' ').replace(/\bproject\b/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

/** The tool: "put my stock alerts in the Stock Alerts project". */
export function createAlertTools(getApp: () => AppContext): Tool[] {
  return [
    {
      defaultPermission: 'auto',
      asksFirst: (a) => a.create_project === true,
      isAvailable: () => !getApp().member || Boolean(getApp().planner),
      spec: {
        name: 'alerts_route',
        description: 'Choose where her alerts and results she posts on her own go: stock alerts, sports and odds, mail watches, product watches, automations, research, goals, travel, inbox finds, reminders, the morning briefing, or one item (e.g. live:12 from watch_list, auto:3). "to" is a project name, one of their chat titles, "here", "telegram", "discord", "a chat of its own", "apps only" or "where I set it up". Use it when they say "put my stock alerts in the Stock Alerts project", "send automation results here", "post research to Telegram". If the project does not exist, ask with ask_choice first, then call again with create_project true. Confirm in one sentence what changed.',
        parameters: {
          type: 'object',
          properties: {
            feed: { type: 'string', description: 'Which kind: stocks, sports, mail, products, automations, research, goals, travel, inbox, reminders, briefing (or their words for it).' },
            item: { type: 'string', description: 'Instead of a whole kind: one item, e.g. live:12, product:3, auto:5, goal:2.' },
            to: { type: 'string', description: 'A project name, a chat title, here, telegram, discord, a chat of its own, apps only, or where I set it up.' },
            also_existing: { type: 'boolean', description: 'Also move the ones they already have (default true).' },
            off: { type: 'boolean', description: 'With telegram/discord: stop sending there.' },
            create_project: { type: 'boolean', description: 'Make the project first (only after they said yes).' },
          },
          required: ['to'],
          additionalProperties: false,
        },
      },
      summarize: (a) => {
        const what = a.item ? String(a.item) : (FEEDS.find((f) => f.id === matchFeed(String(a.feed ?? '')))?.title ?? String(a.feed ?? 'alerts')).toLowerCase();
        const to = String(a.to ?? '').replace(/\bproject\b/gi, ' ').replace(/\s+/g, ' ').trim();
        return a.create_project ? `Make a new project “${to}” and post ${what} in a chat there` : `Post ${what} to ${to}`;
      },
      run: async (a, ctx) => {
        const app = getApp();
        const item = a.item ? String(a.item).trim() : '';
        const feed = item ? feedOfItem(app, item) : matchFeed(String(a.feed ?? ''));
        if (!feed) throw new ToolError(item ? `There is no item ${item}. Use watch_list or the Automations page keys (live:12, auto:3).` : `Which kind? One of: ${FEEDS.map((f) => f.id).join(', ')}.`);
        let r = resolveTo(app, String(a.to ?? ''), ctx.conversationId, { project: a.create_project === true });
        if ('missingProject' in r) {
          if (a.create_project !== true || !app.planner) return `There is no project called “${r.missingProject}”. Ask them with ask_choice: “Make a project “${r.missingProject}” for these?” (options: Make it, Pick another place). If they say yes, call alerts_route again with create_project true.`;
          const id = app.planner.projectId(r.missingProject)!;
          app.events?.publish({ type: 'planner', what: 'tasks' });
          r = { dest: { where: 'project', projectId: id } };
        }
        if ('error' in r) throw new ToolError(r.error);
        const was = destFor(app, feed, item || undefined);
        const next: Dest = r.app ? { ...was, [r.app]: a.off !== true } : { where: r.dest.where!, ...(r.dest.conversationId ? { conversationId: r.dest.conversationId } : {}), ...(r.dest.projectId ? { projectId: r.dest.projectId } : {}), ...(was.telegram ? { telegram: true } : {}), ...(was.discord ? { discord: true } : {}) };
        if (r.app && a.off !== true && !appReady(app, r.app)) return `${r.app === 'telegram' ? 'Telegram' : 'Discord'} isn't connected yet, so nothing changed. They can set it up in Settings → Apps and services.`;
        const bad = checkDest(app, next, feed);
        if (bad) throw new ToolError(bad);
        const title = feedTitle(app, feed);
        if (item) {
          setItemDest(app, item, next);
          return `Done: ${item} now posts to ${describeDest(app, feed, item)}. Confirm in one sentence.`;
        }
        const n = setFeedDest(app, feed, next, a.also_existing !== false).moved;
        const where = describeDest(app, feed);
        return `Done: ${title} now post to ${where}${n ? ` (${n} existing ${n === 1 ? 'one' : 'ones'} moved too)` : a.also_existing === false ? ' (new ones only; the ones they have keep their place)' : ''}. Confirm in one sentence, e.g. “Your ${n || ''} ${title.toLowerCase()} now post to ${where}.”`;
      },
    },
  ];
}
