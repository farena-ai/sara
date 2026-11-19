// W5.4 (docs/design/W5KIDS.md): kid mode v2 on top of R8's kid-safe member mode (src/family.ts).
//  - Requests: a kid asks a parent for more time, a kid tool that is off for them, or something else;
//    every parent gets a push with Approve / Decline (phone action kind `kid`, src/routes/phone.ts)
//    and the dashboard lists them. Grown-up content, money, computer use, Always allow and public
//    records can never become a request (not kid tools; asks in words are refused here).
//  - The parent dashboard: time today (limit, extra, left), a week of minutes and topics (topic ids
//    the page words plainly), flagged moments (kinds and counts, never words) and requests.
//  - Transcript view: only while a parent turned it on in the kid's profile; the kid's bar says so
//    and shows when a parent last looked (V5.4 consent pattern: built per request, off hides at once).
// Same household store (family.db); nothing here calls a model.
import { BAND_DEFAULTS, bandOf, EXTRA_MINUTES, FamilyError, familyRuntime, inBedtime, KID_TOOLS, kidLeft, kidOffLimits, kidToolsFor, type ChildProfile, type FamilyAccess, type FamilyStore } from './family.ts';
import { en, tr } from './i18n.ts';

export type KidRequestKind = 'time' | 'tool' | 'other';
export interface KidRequest {
  id: number;
  kid: string;
  kind: KidRequestKind;
  tool: string | null;
  what: string;
  status: 'pending' | 'approved' | 'declined';
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kid_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, kid TEXT NOT NULL, kind TEXT NOT NULL, tool TEXT, what TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT);
CREATE TABLE IF NOT EXISTS kid_seen (kid TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
const ready = new WeakSet<FamilyStore>();
function db(store: FamilyStore) {
  if (!ready.has(store)) {
    store.db.exec(SCHEMA);
    ready.add(store);
  }
  return store.db;
}
const now = () => familyRuntime().now();
const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const STAYS_OFF = en('That one stays off. A parent can’t turn it on here.');
/** Asks in words that never become a request (on top of the kid-safe off-limits list). */
const NEVER = /\b(buy|pay|paying|money|credit card|debit card|card number|robux|v-?bucks|gift card|computer|always allow|public records?|look (up|for) (someone|people|my|his|her|their)|background check|adult mode|grown-?up mode)\b/i;
/** Plain words for the tools a kid may ask for (the push and the dashboard). */
export const KID_TOOL_WORDS: Record<string, string> = {
  kid_search: en('safe web search'), make_document: en('making documents'), library: en('their Library'), humanize_text: en('rewriting text'), ask_everything: en('searching their own things'), study_make: en('making study sets'), household_lists: en('family lists'), remind: en('reminders'), scrapbook: en('the scrapbook'), compare: en('comparing things'),
};

const row = (r: Record<string, unknown>): KidRequest => ({ id: Number(r.id), kid: String(r.kid), kind: String(r.kind) as KidRequestKind, tool: r.tool ? String(r.tool) : null, what: String(r.what ?? ''), status: String(r.status) as KidRequest['status'], createdAt: String(r.created_at), decidedBy: r.decided_by ? String(r.decided_by) : null, decidedAt: r.decided_at ? String(r.decided_at) : null });
export function kidRequests(store: FamilyStore, kid: string, limit = 20): KidRequest[] {
  return (db(store).prepare('SELECT * FROM kid_requests WHERE kid = ? ORDER BY id DESC LIMIT ?').all(kid, limit) as Record<string, unknown>[]).map(row);
}
function request(store: FamilyStore, id: number): KidRequest | undefined {
  const r = db(store).prepare('SELECT * FROM kid_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? row(r) : undefined;
}
const childOf = (f: FamilyAccess, id: string): { name: string; child?: ChildProfile } | undefined => f.people().find((p) => p.id === id);
const mustParent = (f: FamilyAccess) => {
  if (!f.store.isParent(f.person)) throw new FamilyError(403, en('Only a parent can do that.'));
};

/** A kid asks the parents (the bar's button, or her kid_ask_parent tool). One waiting request per kind and tool. */
export function askParent(f: FamilyAccess, b: { kind?: unknown; tool?: unknown; what?: unknown }): KidRequest {
  const me = childOf(f, f.person);
  if (!me?.child) throw new FamilyError(403, en('Requests are for kids in kid-safe mode.'));
  const kind = String(b.kind ?? 'other') as KidRequestKind;
  if (!['time', 'tool', 'other'].includes(kind)) throw new FamilyError(400, en('Pick what to ask for.'));
  const what = clip(b.what, 140);
  let tool: string | null = null;
  if (kind === 'tool') {
    tool = String(b.tool ?? '');
    if (!KID_TOOLS.has(tool) || tool === 'kid_ask_parent') throw new FamilyError(403, STAYS_OFF);
    if (kidToolsFor(me.child).has(tool)) throw new FamilyError(409, en('That is already on for you.'));
  }
  if (kind === 'other' && !what) throw new FamilyError(400, en('Say what you would like to ask.'));
  if (what && (kidOffLimits(what, 'standard') || NEVER.test(what))) throw new FamilyError(403, STAYS_OFF);
  const d = db(f.store);
  const open = d.prepare("SELECT * FROM kid_requests WHERE kid = ? AND kind = ? AND IFNULL(tool, '') = ? AND status = 'pending'" + (kind === 'other' ? ' AND what = ?' : '')).get(...([f.person, kind, tool ?? '', ...(kind === 'other' ? [what] : [])] as string[])) as Record<string, unknown> | undefined;
  if (open) return row(open);
  const at = now().toISOString();
  const id = Number(d.prepare('INSERT INTO kid_requests (kid, kind, tool, what, created_at) VALUES (?, ?, ?, ?, ?)').run(f.person, kind, tool, what, at).lastInsertRowid);
  const params = { name: me.name, n: EXTRA_MINUTES, tool: tool ? (KID_TOOL_WORDS[tool] ?? tool) : '', what };
  const body = kind === 'time' ? en('{name} asks for {n} more minutes today.') : kind === 'tool' ? (what ? en('{name} asks to use {tool}: {what}') : en('{name} asks to use {tool}.')) : en('{name} asks: {what}');
  f.notifyParents?.(tr(en('A request from {name}'), 'en', params), tr(body, 'en', params), { kind: 'kid', id: String(id), acts: ['approve', 'decline'] });
  return request(f.store, id)!;
}

/** A parent answers (the dashboard, or Approve/Decline on the phone notification). */
export function decideKidRequest(f: FamilyAccess, id: number, approve: boolean): KidRequest {
  mustParent(f);
  const q = request(f.store, id);
  if (!q) throw new FamilyError(404, en('That request is gone.'));
  if (q.status !== 'pending') throw new FamilyError(409, en('That request was already answered.'));
  const kid = childOf(f, q.kid);
  if (approve && q.kind === 'tool') {
    if (!kid?.child || !q.tool || !KID_TOOLS.has(q.tool)) throw new FamilyError(409, en('That request is gone.'));
    if (!f.setChild) throw new FamilyError(403, en('Only the owner can turn on a tool for a kid.'));
    f.setChild(q.kid, { tools: [...(kid.child.tools ?? [...KID_TOOLS]), q.tool] });
  }
  if (approve && q.kind === 'time') f.store.addExtra(f.person, q.kid, EXTRA_MINUTES, now(), f.tz());
  db(f.store).prepare('UPDATE kid_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'declined', f.person, now().toISOString(), id);
  f.notifyPerson?.(q.kid, approve ? en('A parent said yes') : en('A parent said not this time'), q.kind === 'time' ? (approve ? tr(en('You have {n} more minutes today.'), 'en', { n: EXTRA_MINUTES }) : en('Time is up for today.')) : q.what || (q.tool ? (KID_TOOL_WORDS[q.tool] ?? q.tool) : ''));
  for (const fn of f.store.listeners) {
    try {
      fn({ people: [q.kid, ...f.store.parents()], what: 'kid' });
    } catch {
      /* a listener never breaks a change */
    }
  }
  return request(f.store, id)!;
}

const seenAt = (store: FamilyStore, kid: string): string | null => (db(store).prepare('SELECT at FROM kid_seen WHERE kid = ?').get(kid) as { at: string } | undefined)?.at ?? null;

/** What a kid's own bar shows (undefined for anyone who isn't a kid). */
export function kidStatus(f: FamilyAccess) {
  const me = childOf(f, f.person);
  const p = me?.child;
  if (!p) return undefined;
  const at = now();
  const tz = f.tz();
  return {
    band: bandOf(p.band),
    limit: p.minutesPerDay,
    used: f.store.minutesToday(f.person, at, tz),
    extra: f.store.extraToday(f.person, at, tz),
    left: kidLeft(f.person, p, at) ?? null,
    bedtime: p.bedtime,
    inBedtime: inBedtime(p, at, tz),
    transcripts: { on: Boolean(p.transcripts?.on), since: p.transcripts?.since ?? null, lastViewed: p.transcripts?.on ? seenAt(f.store, f.person) : null },
    requests: kidRequests(f.store, f.person, 5),
  };
}

/** The parent dashboard for one kid: time, a week of topics, flagged moments, requests; never their words. */
export function kidDashboard(f: FamilyAccess, kid: string) {
  mustParent(f);
  const k = childOf(f, kid);
  if (!k?.child) throw new FamilyError(404, en('Kid-safe mode is not on for them.'));
  const at = now();
  const tz = f.tz();
  const p = k.child;
  const band = bandOf(p.band);
  const flagDays = f.store.flags(f.person, kid, at, tz);
  const totals = new Map<string, number>();
  for (const x of flagDays) totals.set(x.kind, (totals.get(x.kind) ?? 0) + x.n);
  return {
    kid: { id: kid, name: k.name },
    band,
    profile: p,
    defaults: BAND_DEFAULTS[band],
    today: { used: f.store.minutesToday(kid, at, tz), limit: p.minutesPerDay, extra: f.store.extraToday(kid, at, tz), left: kidLeft(kid, p, at) ?? null, inBedtime: inBedtime(p, at, tz) },
    days: f.store.activity(f.person, kid, at, tz).days.map((d) => ({ ...d, limit: p.minutesPerDay })),
    flags: [...totals].map(([kind, n]) => ({ kind, n })),
    flagDays,
    requests: kidRequests(f.store, kid, 20),
    transcripts: { on: Boolean(p.transcripts?.on), since: p.transcripts?.since ?? null, lastViewed: seenAt(f.store, kid) },
    toolWords: KID_TOOL_WORDS,
  };
}

/** Transcript view: only while it is on (the kid is told); records when a parent looked. */
export function kidChats(f: FamilyAccess, kid: string, conversationId?: string): { chats: { id: string; title: string; updatedAt: string }[]; messages?: { role: string; content: string; at?: string }[] } {
  mustParent(f);
  const k = childOf(f, kid);
  if (!k?.child?.transcripts?.on) throw new FamilyError(403, en('Turn on transcript view first: they see a notice that a parent can read their chats.'));
  const store = f.appOf?.(kid)?.store;
  if (!store) throw new FamilyError(404, en('Their chats are not available here.'));
  const chats = store.listConversations().slice(0, 30).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
  db(f.store).prepare('INSERT INTO kid_seen (kid, at) VALUES (?, ?) ON CONFLICT(kid) DO UPDATE SET at = excluded.at').run(kid, now().toISOString());
  if (!conversationId) return { chats };
  if (!store.getConversation(conversationId)) throw new FamilyError(404, en('That chat is gone.'));
  const messages = store.messages(conversationId).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-200).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000), ...('createdAt' in m && m.createdAt ? { at: String(m.createdAt) } : {}) }));
  return { chats, messages };
}
