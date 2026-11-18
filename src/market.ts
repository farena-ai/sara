// U4.27 (docs/MARKETPLACE.md): a community marketplace between linked servers. In a community (kept by
// its host, the community's owner) or on a one-to-one link with a friend (kept by the friend who shares),
// people list shareable items: skills, prompt/workflow templates (both plain skill text), automations,
// team recipes and links to Sara Store add-ons. Nothing executable crosses: a skill is its SKILL.md text
// only (no files), an automation is its definition, a team recipe its plan, an add-on only its Store id.
// The receiving server checks every item itself before anything is installed (hash, size, secrets,
// hard-limit tools, protected settings, tools that exist here, safe automation shapes), shows exactly
// what installing does and installs only the hash the person reviewed: skills start on trial,
// automations start paused, team recipes go through the team-recipe importer. Updates notify subscribers
// and never apply themselves. Ratings, comments and reports are simple; the keeper removes listings.
//
// Wire (server to server, the S9a link's own Ed25519 keys, scope word 'market'):
//   POST /msg/v1/market/<op>  headers sara-mk-link, sara-mk-time, sara-mk-sig = sign(`market\n${link}\n${time}\n${op}\n${sha256(body)}`)
//   keeper ops: list, get, publish (community members only), withdraw, rate, report, subscribe
//   subscriber op: notice (a newer version is out)
// The place is never in the body: the keeper derives it from the calling link (a community member's link
// → that community; a direct link → the shelf shared with that friend).
import { createHash, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import type { Messenger } from './messages.ts';
import { privateLocalOn } from './net-guard.ts';
import { KEY_SHAPED, Redactor } from './redact.ts';
import { peerRate } from './support.ts';
import { HARD_LIMIT_TOOL } from './team-runs.ts';

export const MARKET = { titleChars: 80, descChars: 600, payloadChars: 32_000, bodyChars: 24_000, tools: 20, settings: 20, commentChars: 300, whyChars: 300, listings: 200, comments: 20, skewMs: 5 * 60_000 } as const;
export const KINDS = ['skill', 'template', 'automation', 'team', 'addon'] as const;
export type Kind = (typeof KINDS)[number];
const SAFE_TRIGGERS = new Set(['schedule', 'calendar', 'email']);
const SAFE_ACTIONS = new Set(['notify', 'task', 'draft_email']);
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class MarketError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface Listing {
  id: string;
  kind: Kind;
  title: string;
  description: string;
  version: string;
  /** The author's server name (set by the keeper from the link, never by the author's body). */
  author: string;
  permissions: { tools: string[]; settings: string[] };
  payload: Record<string, unknown>;
  hash: string;
  at: string;
}
export interface ListingView extends Omit<Listing, 'payload'> {
  payload?: Record<string, unknown>;
  updatedAt: string;
  mine: boolean;
  rating: { avg: number; n: number };
  comments: { who: string; text: string; stars: number; at: string }[];
}
export interface Line {
  t: string;
  p?: Record<string, string | number>;
}
export interface CheckResult {
  ok: boolean;
  problems: string[];
  does: string[];
  /** The same lines as keys + params for the web's t(). */
  problemLines: Line[];
  doesLines: Line[];
}
export interface CheckEnv {
  /** Tools on this server (undefined: the keeper, who only checks what doesn't depend on the server). */
  tools?: Set<string>;
  /** Tools that run commands here (always hard limits). */
  hard?: Set<string>;
  /** Item ids in this server's own signed Store list (undefined: not checked). */
  storeIds?: Set<string>;
}

/** Tools a shared item may never ask for: the team-run hard limits plus the computer, mail sending and the vault. */
export function HARD_TOOL(name: string): boolean {
  return HARD_LIMIT_TOOL(name) || /^(pc_|hands_|computer_|browser_|run_command|exec|mail_send|vault|secret|skill_save|alerts_route)/.test(name);
}
/** Settings a shared item may never ask for: keys, sign-ins, privacy, adult mode, household, policy, models, updates. */
export function PROTECTED_SETTING(path: string): boolean {
  return /(key|token|secret|passw|vault|adult|private|policy|household|member|kid|security|permission|sandbox|shell|computer|hands|approv|provider|auth|owner|backup|update|tunnel|access|login|pin|share|remote|support|repair|market|messages|mail)/i.test(path);
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** The content hash: everything the person reviews (id, kind, text, version, author, permissions, payload). */
export function hashListing(l: Omit<Listing, 'hash' | 'at'> & { hash?: string; at?: string }): string {
  return sha(JSON.stringify(stable({ id: l.id, kind: l.kind, title: l.title, description: l.description, version: l.version, author: l.author, permissions: l.permissions, payload: l.payload })));
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
const strings = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
};
const plainRedactor = new Redactor();
const fmt = (l: Line) => l.t.replace(/\{(\w+)\}/g, (_m, k: string) => String(l.p?.[k] ?? `{${k}}`));

/**
 * The receiving server's static checks on one listing, and the plain lines of what installing it does.
 * Pure: the caller passes this server's tools and Store ids.
 */
export function checkListing(l: Listing, env: CheckEnv = {}): CheckResult {
  const bad: Line[] = [];
  const does: Line[] = [];
  const no = (t: string, p?: Line['p']) => bad.push(p ? { t, p } : { t });
  if (!KINDS.includes(l.kind)) no(en('This kind of item can’t be shared.'));
  if (hashListing(l) !== l.hash) no(en('The content hash doesn’t match: the item changed on the way. Don’t install it.'));
  if (!clip(l.title, 200) || String(l.title).length > MARKET.titleChars) no(en('The name is missing or too long.'));
  if (String(l.description ?? '').length > MARKET.descChars) no(en('The description is too long.'));
  if (!/^\d{1,4}(\.\d{1,4}){0,2}$/.test(String(l.version ?? ''))) no(en('The version is not like 1.0.0.'));
  const payload = l.payload && typeof l.payload === 'object' && !Array.isArray(l.payload) ? l.payload : {};
  if (JSON.stringify(payload).length > MARKET.payloadChars) no(en('It is too big to share ({n} characters at most).'), { n: MARKET.payloadChars });
  const texts = [l.title, l.description, ...strings(payload)].map(String);
  if (texts.some((s) => KEY_SHAPED.some((re) => re.test(s)) || plainRedactor.redact(s) !== s)) no(en('Something in it looks like a password, key or token. Secrets are never shared.'));
  const perms = { tools: Array.isArray(l.permissions?.tools) ? l.permissions.tools.map(String) : [], settings: Array.isArray(l.permissions?.settings) ? l.permissions.settings.map(String) : [] };
  if (perms.tools.length > MARKET.tools || perms.settings.length > MARKET.settings) no(en('It asks for too many tools or settings.'));
  const hard = (n: string) => HARD_TOOL(n) || env.hard?.has(n) === true;
  const toolCheck = (names: string[]) => {
    for (const n of names) {
      if (hard(n)) no(en('It asks for {tool}, a tool shared items may never use.'), { tool: n });
      else if (env.tools && !env.tools.has(n)) no(en('It needs the tool {tool}, which this Sara doesn’t have.'), { tool: n });
    }
  };
  toolCheck(perms.tools);
  for (const s of perms.settings) if (!/^[\w.]{1,60}$/.test(s) || PROTECTED_SETTING(s)) no(en('It asks for the protected setting {setting}.'), { setting: s.slice(0, 60) });
  if (perms.tools.length) does.push({ t: en('She may use these tools for it (each still asks as usual): {tools}.'), p: { tools: perms.tools.join(', ') } });
  if (perms.settings.length) does.push({ t: en('It works best with these settings; installing changes none of them: {settings}.'), p: { settings: perms.settings.join(', ') } });
  const name = clip(payload.name, 80);
  switch (l.kind) {
    case 'skill':
    case 'template': {
      if (Object.keys(payload).some((k) => !['name', 'description', 'body'].includes(k))) no(en('Only the skill’s text can be shared: no files or code.'));
      if (!SKILL_NAME.test(name) || name.length > 64) no(en('The skill name is not valid.'));
      const body = String(payload.body ?? '');
      if (!body.trim() || body.length > MARKET.bodyChars) no(en('The skill text is empty or too long.'));
      if (env.tools) for (const t of env.tools) if (hard(t) && new RegExp(`\\b${t}\\b`).test(body)) no(en('It asks for {tool}, a tool shared items may never use.'), { tool: t });
      does.push({ t: l.kind === 'template' ? en('Adds the template “{name}” as a skill on trial: she uses it only when a request fits it well, and you can switch it off in Skills.') : en('Adds the skill “{name}” on trial: she uses it only when a request fits it well, and you can switch it off in Skills.'), p: { name } });
      break;
    }
    case 'automation': {
      const trig = (payload.trigger ?? {}) as Record<string, unknown>;
      const acts = Array.isArray(payload.actions) ? (payload.actions as Record<string, unknown>[]) : [];
      if (!SAFE_TRIGGERS.has(String(trig.kind))) no(en('That trigger can’t be shared (time, calendar or email triggers only).'));
      if (!acts.length || acts.length > 5) no(en('An automation needs one to five steps.'));
      for (const a of acts) {
        if (!SAFE_ACTIONS.has(String(a?.kind))) no(en('The step {step} can’t be shared (notify, a task or an email draft only).'), { step: clip(a?.kind, 30) });
        if (a?.kind === 'draft_email' && a.sendWithoutAsking === true) no(en('It would send email without asking. Shared automations only draft.'));
      }
      does.push({ t: en('Adds the automation “{name}”, paused: nothing runs until you turn it on.'), p: { name: clip(payload.name, 80) } });
      for (const a of acts.slice(0, 5)) does.push({ t: en('Step: {step}'), p: { step: `${clip(a?.kind, 30)}${a?.text || a?.prompt ? `: ${clip(a.text ?? a.prompt, 120)}` : ''}` } });
      break;
    }
    case 'team': {
      const plan = (payload.plan ?? {}) as { roles?: { name?: unknown; tools?: unknown; computer?: unknown }[] };
      if (payload.kind !== 'sara-team-recipe' || !Array.isArray(plan.roles) || !plan.roles.length) no(en('This is not a Sara team recipe.'));
      for (const r of plan.roles ?? []) {
        if (r?.computer === true) no(en('A helper would use the computer. Shared team recipes never do.'));
        toolCheck(Array.isArray(r?.tools) ? r.tools.map(String) : []);
      }
      does.push({ t: en('Adds the team recipe “{name}” with {n} helpers. A team run still shows its plan and asks before it starts.'), p: { name: clip(payload.name, 80), n: plan.roles?.length ?? 0 } });
      break;
    }
    case 'addon': {
      const id = String(payload.storeId ?? '');
      if (Object.keys(payload).some((k) => k !== 'storeId') || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) no(en('An add-on is shared only as a link to the Sara Store.'));
      else if (env.storeIds && !env.storeIds.has(id)) no(en('The add-on {id} isn’t in this Sara’s Store list. Check the Store first (Get more).'), { id });
      does.push({ t: en('Opens the add-on {id} in Get more, where the Store shows its own review card. Nothing is installed from here.'), p: { id } });
      break;
    }
  }
  return { ok: !bad.length, problems: bad.map(fmt), does: does.map(fmt), problemLines: bad, doesLines: does };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mk_listings (id TEXT PRIMARY KEY, place TEXT NOT NULL, author_link TEXT NOT NULL, listing TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mk_ratings (listing TEXT NOT NULL, who TEXT NOT NULL, name TEXT NOT NULL, stars INTEGER NOT NULL, comment TEXT NOT NULL DEFAULT '', at TEXT NOT NULL, PRIMARY KEY (listing, who));
CREATE TABLE IF NOT EXISTS mk_reports (id TEXT PRIMARY KEY, listing TEXT NOT NULL, place TEXT NOT NULL, who TEXT NOT NULL, why TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mk_subs (listing TEXT NOT NULL, link TEXT NOT NULL, PRIMARY KEY (listing, link));
CREATE TABLE IF NOT EXISTS mk_installs (id TEXT PRIMARY KEY, place TEXT NOT NULL, via TEXT NOT NULL, listing TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, ref TEXT, update_version TEXT, at TEXT NOT NULL, UNIQUE (via, listing));
CREATE TABLE IF NOT EXISTS mk_seen (id TEXT PRIMARY KEY, at TEXT NOT NULL);
`;
type Row = Record<string, unknown>;
type Caller = { link: string; name: string };

export interface MarketDeps {
  tools(): { names: Set<string>; hard: Set<string> };
  storeIds(): Set<string>;
  /** Installers on this server (the owner's own stores). */
  install: {
    skill(p: { name: string; description: string; body: string }, o: { ref?: string; author: string }): string;
    automation(p: Record<string, unknown>, o: { ref?: string }): string;
    team(p: Record<string, unknown>, o: { ref?: string }): string;
  };
  /** Builds the payload of one of the owner's own items. */
  item(kind: Kind, ref: string, o: { title: string; text: string; description: string }): { title: string; payload: Record<string, unknown>; tools: string[] };
  notify(title: string, body: string, chatId: string): void;
}

export interface Place {
  id: string;
  kind: 'community' | 'friend';
  title: string;
  host: boolean;
}

export class Market {
  readonly #db: DatabaseSync;
  readonly #rate = new Map<string, { min: number; n: number }>();
  readonly #m: Messenger;
  readonly #now: () => Date;
  readonly deps: MarketDeps;
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;

  constructor(o: { dataDir: string; messenger: Messenger; now: () => Date; deps: MarketDeps }) {
    this.#db = new DatabaseSync(join(o.dataDir, 'market.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#m = o.messenger;
    this.#now = o.now;
    this.deps = o.deps;
    o.messenger.whenClosed(() => this.close());
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
  async idle(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }
  #track(p: Promise<unknown>): void {
    this.#pending.add(p);
    void p.catch((err: Error) => console.warn(`market: ${err.message}`)).finally(() => this.#pending.delete(p));
  }
  #iso(): string {
    return this.#now().toISOString();
  }

  // ---- places -------------------------------------------------------------------------------------
  /** Communities this server is in (or hosts) and one-to-one friends. */
  places(): Place[] {
    const out: Place[] = [];
    for (const c of this.#m.chats()) {
      if (c.status !== 'active') continue;
      if (c.kind === 'community') out.push({ id: `c:${c.id}`, kind: 'community', title: c.title, host: c.role === 'host' });
      else if (c.linkId && this.#m.linkInfo(c.linkId)?.kind === 'direct') out.push({ id: `f:${c.linkId}`, kind: 'friend', title: c.title, host: false });
    }
    return out;
  }
  /** Where a place's shelf is kept: here (`local` = the stored place) or on the other end of a link. */
  #where(place: string): { local?: string; link?: string; title: string } {
    const [k, id = ''] = [place.slice(0, 2), place.slice(2)];
    if (k === 'c:') {
      const c = this.#m.chat(id);
      if (!c || c.kind !== 'community' || c.status !== 'active') throw new MarketError(404, en('Not found'));
      return c.role === 'host' ? { local: place, title: c.title } : { link: c.linkId ?? '', title: c.title };
    }
    if (k === 'f:') {
      const l = this.#m.linkInfo(id);
      if (!l || l.kind !== 'direct') throw new MarketError(404, en('Not found'));
      return { link: id, title: l.name };
    }
    throw new MarketError(404, en('Not found'));
  }
  /** The keeper's view of a calling link: its community, or the shelf shared with that friend. */
  #placeOf(link: string): string | undefined {
    const l = this.#m.linkInfo(link);
    if (l?.kind === 'host' && l.community) return `c:${l.community}`;
    if (l?.kind === 'direct') return `f:${link}`;
    return undefined;
  }
  #remoteOk(): void {
    if (privateLocalOn()) throw new MarketError(409, en('Private local mode is on: nothing is shared with other servers.'));
  }

  // ---- the keeper's shelf ------------------------------------------------------------------------------
  #row(id: string): Row | undefined {
    return this.#db.prepare('SELECT * FROM mk_listings WHERE id = ?').get(id) as Row | undefined;
  }
  #view(row: Row, who: string, full = false): ListingView {
    const l = JSON.parse(String(row.listing)) as Listing;
    const r = this.#db.prepare('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM mk_ratings WHERE listing = ?').get(l.id) as { avg: number | null; n: number };
    const comments = (this.#db.prepare("SELECT name, comment, stars, at FROM mk_ratings WHERE listing = ? AND comment <> '' ORDER BY at DESC LIMIT ?").all(l.id, MARKET.comments) as Row[]).map((c) => ({ who: String(c.name), text: String(c.comment), stars: Number(c.stars), at: String(c.at) }));
    const { payload, ...rest } = l;
    return { ...rest, ...(full ? { payload } : {}), updatedAt: String(row.updated_at), mine: String(row.author_link) === who, rating: { avg: r.n ? Math.round(Number(r.avg) * 10) / 10 : 0, n: r.n }, comments };
  }
  #live(place: string, id: string): Row {
    const row = this.#row(id);
    if (!row || row.place !== place || row.status !== 'live') throw new MarketError(404, en('That listing is gone.'));
    return row;
  }
  /** Keeper: the live listings of a place, as seen by a caller ('' = this server's owner). */
  shelf(place: string, who: string): ListingView[] {
    return (this.#db.prepare("SELECT * FROM mk_listings WHERE place = ? AND status = 'live' ORDER BY updated_at DESC LIMIT ?").all(place, MARKET.listings) as Row[]).map((r) => this.#view(r, who));
  }
  /** Keeper: stores a new listing or a new version of the caller's own one; tells subscribers of a new version. */
  keep(place: string, who: Caller, input: Listing): ListingView {
    const id = clip(input.id, 64) || randomUUID();
    const cur = this.#row(id);
    if (cur && (cur.place !== place || String(cur.author_link) !== who.link)) throw new MarketError(403, en('Only the author can change a listing.'));
    if (!cur && (this.#db.prepare('SELECT COUNT(*) AS n FROM mk_listings WHERE place = ?').get(place) as { n: number }).n >= MARKET.listings) throw new MarketError(409, en('This shelf is full.'));
    const old = cur ? (JSON.parse(String(cur.listing)) as Listing) : undefined;
    const base = { id, kind: input.kind, title: clip(input.title, MARKET.titleChars), description: clip(input.description, MARKET.descChars), version: clip(input.version, 20), author: clip(who.name, 80) || '?', permissions: { tools: (input.permissions?.tools ?? []).map(String), settings: (input.permissions?.settings ?? []).map(String) }, payload: input.payload ?? {}, at: this.#iso() };
    const l: Listing = { ...base, hash: hashListing(base) };
    // The keeper checks what doesn't depend on a server (shape, size, secrets, hard limits, protected settings).
    const c = checkListing(l);
    if (!c.ok) throw new MarketError(400, c.problems[0]!);
    if (old && old.version === l.version) throw new MarketError(409, en('Give the new version a new number.'));
    const at = this.#iso();
    if (cur) this.#db.prepare("UPDATE mk_listings SET listing = ?, status = 'live', updated_at = ? WHERE id = ?").run(JSON.stringify(l), at, id);
    else this.#db.prepare('INSERT INTO mk_listings (id, place, author_link, listing, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, place, who.link, JSON.stringify(l), at, at);
    audit({ action: cur ? 'market.update' : 'market.publish', who: who.link ? `link:${who.name}`.slice(0, 80) : undefined, role: who.link ? 'system' : 'owner', outcome: 'ok', target: place.slice(0, 80), content: `${l.kind} ${l.title} ${l.version}` });
    if (cur) this.#tellSubscribers(l);
    return this.#view(this.#row(id)!, who.link);
  }
  #tellSubscribers(l: Listing): void {
    for (const s of this.#db.prepare('SELECT link FROM mk_subs WHERE listing = ?').all(l.id) as { link: string }[]) {
      if (!s.link) this.noticed('', l.id, l.version, l.title);
      else if (!privateLocalOn()) this.#track(this.#call(s.link, 'notice', { listing: l.id, version: l.version, title: l.title }));
    }
  }
  /** Keeper: the author withdraws his own, or this server's owner (the community's owner) removes any. */
  takeDown(place: string, who: Caller, id: string): void {
    const row = this.#live(place, id);
    if (who.link && String(row.author_link) !== who.link) throw new MarketError(403, en('Only the author or the community’s owner can remove a listing.'));
    this.#db.prepare("UPDATE mk_listings SET status = 'removed', updated_at = ? WHERE id = ?").run(this.#iso(), id);
    audit({ action: 'market.remove', role: who.link ? 'system' : 'owner', outcome: 'ok', target: id });
  }
  rateHere(place: string, who: Caller, id: string, stars: unknown, comment: unknown): void {
    this.#live(place, id);
    const n = Number(stars);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new MarketError(400, en('Pick 1 to 5 stars.'));
    this.#db.prepare('INSERT OR REPLACE INTO mk_ratings (listing, who, name, stars, comment, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, who.link, clip(who.name, 80), n, plainRedactor.redact(clip(comment, MARKET.commentChars)), this.#iso());
  }
  reportHere(place: string, who: Caller, id: string, why: unknown): void {
    const row = this.#live(place, id);
    const text = plainRedactor.redact(clip(why, MARKET.whyChars));
    if (!text) throw new MarketError(400, en('Say what is wrong with it.'));
    this.#db.prepare('INSERT INTO mk_reports (id, listing, place, who, why, at) VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), id, place, clip(who.name, 80), text, this.#iso());
    const title = (JSON.parse(String(row.listing)) as Listing).title;
    const chat = place.startsWith('c:') ? place.slice(2) : (this.#m.chats().find((c) => c.linkId === place.slice(2))?.id ?? '');
    this.deps.notify(title, en('A shared item was reported to you. Get more → Shared by friends shows it.'), chat);
  }
  subscribeHere(place: string, who: Caller, id: string): void {
    this.#live(place, id);
    this.#db.prepare('INSERT OR IGNORE INTO mk_subs (listing, link) VALUES (?, ?)').run(id, who.link);
  }
  getHere(place: string, who: Caller, id: string): ListingView {
    return this.#view(this.#live(place, id), who.link, true);
  }
  /** Subscriber: a newer version is out (never applied by itself). */
  noticed(via: string, id: string, version: unknown, title: unknown): void {
    const v = clip(version, 20);
    const row = this.#db.prepare('SELECT * FROM mk_installs WHERE via = ? AND listing = ?').get(via, id) as Row | undefined;
    if (!row || row.version === v) return;
    this.#db.prepare('UPDATE mk_installs SET update_version = ? WHERE id = ?').run(v, row.id as string);
    this.deps.notify(clip(title, 80) || String(row.title), en('A new version of a shared item you installed is out. Nothing changes until you review it in Get more.'), '');
  }

  // ---- the wire ------------------------------------------------------------------------------------
  async #call(link: string, op: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.#m.linkInfo(link);
    const key = this.#m.privateKeyFor(link);
    if (!p || !key) throw new MarketError(404, en('That link is gone. Link the servers again under Messages.'));
    const body = JSON.stringify({ v: 1, id: randomUUID(), ...payload });
    let res: Response;
    try {
      res = await this.#m.peerFetch(`${p.url}/msg/v1/market/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signMarket(link, op, body, key, this.#now()) }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new MarketError(502, en('The other server did not answer. Check its address and try again.'));
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new MarketError([400, 403, 404, 409].includes(res.status) ? res.status : 502, typeof j.error === 'string' && res.status < 500 ? clip(j.error, 300) : en('The other server did not answer. Check its address and try again.'));
    return j;
  }
  /** Checks a peer request (link, time, market-scope signature for this op, replay); returns the caller. */
  verify(headers: IncomingHttpHeaders, op: string, body: string): Caller {
    const link = String(headers['sara-mk-link'] ?? '');
    const time = String(headers['sara-mk-time'] ?? '');
    const sig = String(headers['sara-mk-sig'] ?? '');
    const p = link ? this.#m.linkInfo(link) : undefined;
    const t = Date.parse(time);
    const unsigned = new MarketError(401, 'unsigned');
    if (!p || !Number.isFinite(t) || Math.abs(t - this.#now().getTime()) > MARKET.skewMs) throw unsigned;
    let ok = false;
    try {
      ok = verify(null, Buffer.from(`market\n${link}\n${time}\n${op}\n${sha(body)}`), p.key, Buffer.from(sig, 'base64'));
    } catch {
      ok = false;
    }
    if (!ok) throw unsigned;
    // U5.33: a linked server that floods the marketplace is slowed down.
    if (!peerRate(this.#rate, `market:${link}`, this.#now().getTime())) throw new MarketError(429, 'slow down');
    let id = '';
    try {
      id = String((JSON.parse(body) as { id?: unknown }).id ?? '');
    } catch {
      throw new MarketError(400, 'bad request');
    }
    if (!id) throw new MarketError(400, 'bad request');
    const seen = sha(`${link}/${id}`);
    if (this.#db.prepare('SELECT 1 FROM mk_seen WHERE id = ?').get(seen)) throw new MarketError(409, 'replay');
    this.#db.prepare('INSERT INTO mk_seen (id, at) VALUES (?, ?)').run(seen, this.#iso());
    this.#db.prepare('DELETE FROM mk_seen WHERE at < ?').run(new Date(this.#now().getTime() - 86_400_000).toISOString());
    return { link, name: p.name };
  }
  /** A verified peer op. */
  serve(op: string, who: Caller, b: Record<string, unknown>): Record<string, unknown> {
    if (privateLocalOn()) throw new MarketError(403, 'private local mode');
    if (op === 'notice') return (this.noticed(who.link, clip(b.listing, 64), b.version, b.title), { ok: true });
    const place = this.#placeOf(who.link);
    if (!place) throw new MarketError(403, 'not a member');
    const id = clip(b.listing, 64);
    switch (op) {
      case 'list':
        return { listings: this.shelf(place, who.link) };
      case 'get':
        return { listing: this.getHere(place, who, id) };
      case 'publish':
        if (!place.startsWith('c:')) throw new MarketError(403, en('Only community members publish to a community.'));
        return { listing: this.keep(place, who, (b.listing ?? {}) as Listing) };
      case 'withdraw':
        return (this.takeDown(place, who, id), { ok: true });
      case 'rate':
        return (this.rateHere(place, who, id, b.stars, b.comment), { ok: true });
      case 'report':
        return (this.reportHere(place, who, id, b.why), { ok: true });
      case 'subscribe':
        return (this.subscribeHere(place, who, id), { ok: true });
    }
    throw new MarketError(404, 'not found');
  }

  // ---- the owner's actions ---------------------------------------------------------------------------
  #me(): Caller {
    return { link: '', name: this.#m.name() || 'Sara' };
  }
  /** A place's shelf (a friend's shelf also lists what this server shares with that friend, marked mine). */
  async browse(place: string): Promise<ListingView[]> {
    const w = this.#where(place);
    if (w.local) return this.shelf(w.local, '');
    this.#remoteOk();
    const r = await this.#call(w.link!, 'list', {});
    const theirs = (Array.isArray(r.listings) ? r.listings : []) as ListingView[];
    return place.startsWith('f:') ? [...this.shelf(place, ''), ...theirs.map((l) => ({ ...l, mine: false }))] : theirs;
  }
  /** Shares one of the owner's items (or a new version of an earlier listing) into a place. */
  async publish(place: string, o: { kind: unknown; ref?: unknown; title?: unknown; text?: unknown; description?: unknown; version?: unknown; tools?: unknown; settings?: unknown; listing?: unknown }): Promise<ListingView> {
    const kind = String(o.kind) as Kind;
    if (!KINDS.includes(kind)) throw new MarketError(400, en('This kind of item can’t be shared.'));
    const item = this.deps.item(kind, clip(o.ref, 120), { title: clip(o.title, MARKET.titleChars), text: String(o.text ?? '').slice(0, MARKET.bodyChars), description: clip(o.description, MARKET.descChars) });
    const tools = [...new Set([...(Array.isArray(o.tools) ? o.tools.map(String) : []), ...item.tools])];
    const settings = Array.isArray(o.settings) ? o.settings.map((s) => clip(s, 60)).filter(Boolean) : [];
    const w = this.#where(place);
    const me = this.#me();
    const draft = { id: clip(o.listing, 64) || randomUUID(), kind, title: item.title, description: clip(o.description, MARKET.descChars), version: clip(o.version, 20) || '1.0.0', author: me.name, permissions: { tools, settings }, payload: item.payload, at: this.#iso() };
    // The sender checks first with its own tools: a secret never leaves this server.
    const c = checkListing({ ...draft, hash: hashListing(draft) }, { tools: this.deps.tools().names, hard: this.deps.tools().hard });
    if (!c.ok) throw new MarketError(400, c.problems[0]!);
    if (place.startsWith('f:')) return this.keep(place, me, { ...draft, hash: '' });
    if (w.local) return this.keep(w.local, me, { ...draft, hash: '' });
    this.#remoteOk();
    const r = await this.#call(w.link!, 'publish', { listing: draft });
    return { ...(r.listing as ListingView), mine: true };
  }
  async #fetch(place: string, id: string): Promise<{ l: Listing; via: string; w: { local?: string; link?: string; title: string } }> {
    const w = this.#where(place);
    if (place.startsWith('f:') && this.#row(id)?.place === place) return { l: this.getHere(place, this.#me(), id) as unknown as Listing, via: '', w: { local: place, title: w.title } };
    if (w.local) return { l: this.getHere(w.local, this.#me(), id) as unknown as Listing, via: '', w };
    this.#remoteOk();
    const r = await this.#call(w.link!, 'get', { listing: id });
    return { l: r.listing as Listing, via: w.link!, w };
  }
  #env(): CheckEnv {
    const t = this.deps.tools();
    return { tools: t.names, hard: t.hard, storeIds: this.deps.storeIds() };
  }
  #bare(v: Listing | ListingView): Listing {
    const x = v as ListingView;
    return { id: x.id, kind: x.kind, title: x.title, description: x.description, version: x.version, author: x.author, permissions: x.permissions, payload: x.payload ?? {}, hash: x.hash, at: x.at };
  }
  /** What installing would do, and this server's own checks (nothing changes). */
  async review(place: string, id: string): Promise<{ listing: ListingView; check: CheckResult }> {
    const { l } = await this.#fetch(place, clip(id, 64));
    return { listing: l as unknown as ListingView, check: checkListing(this.#bare(l), this.#env()) };
  }
  /** Installs exactly the reviewed content (its hash), after checking it again here. */
  async install(place: string, id: string, hash: unknown): Promise<{ installed?: { kind: Kind; ref: string; title: string }; open?: string }> {
    const { l: got, via } = await this.#fetch(place, clip(id, 64));
    const l = this.#bare(got);
    const c = checkListing(l, this.#env());
    if (!c.ok) throw new MarketError(400, c.problems[0]!);
    if (l.hash !== String(hash ?? '')) throw new MarketError(409, en('It changed since you looked. Review it again.'));
    if (l.kind === 'addon') return { open: String(l.payload.storeId) };
    const prev = this.#db.prepare('SELECT * FROM mk_installs WHERE via = ? AND listing = ?').get(via, l.id) as Row | undefined;
    const ref = prev?.ref ? String(prev.ref) : undefined;
    let out: string;
    if (l.kind === 'skill' || l.kind === 'template') out = this.deps.install.skill(l.payload as never, { ref, author: l.author });
    else if (l.kind === 'automation') out = this.deps.install.automation(l.payload, { ref });
    else out = this.deps.install.team(l.payload, { ref });
    const at = this.#iso();
    if (prev) this.#db.prepare('UPDATE mk_installs SET version = ?, hash = ?, ref = ?, title = ?, update_version = NULL, at = ? WHERE id = ?').run(l.version, l.hash, out, l.title, at, prev.id as string);
    else this.#db.prepare('INSERT INTO mk_installs (id, place, via, listing, kind, title, author, version, hash, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), place, via, l.id, l.kind, l.title, l.author, l.version, l.hash, out, at);
    audit({ action: 'market.install', role: 'owner', outcome: 'ok', target: `${l.kind}:${out}`.slice(0, 80), content: `${l.title} ${l.version} from ${l.author}` });
    if (!via) this.#db.prepare('INSERT OR IGNORE INTO mk_subs (listing, link) VALUES (?, ?)').run(l.id, '');
    else if (!prev) this.#track(this.#call(via, 'subscribe', { listing: l.id }));
    return { installed: { kind: l.kind, ref: out, title: l.title } };
  }
  async rate(place: string, id: string, stars: unknown, comment: unknown): Promise<void> {
    const w = this.#where(place);
    if (w.local || this.#row(id)?.place === place) return this.rateHere(w.local ?? place, this.#me(), id, stars, comment);
    this.#remoteOk();
    await this.#call(w.link!, 'rate', { listing: id, stars, comment });
  }
  async report(place: string, id: string, why: unknown): Promise<void> {
    const w = this.#where(place);
    if (w.local || this.#row(id)?.place === place) return this.reportHere(w.local ?? place, this.#me(), id, why);
    this.#remoteOk();
    await this.#call(w.link!, 'report', { listing: id, why });
  }
  /** The community's owner (or the friend who shares) removes; a member withdraws his own on the keeper. */
  async remove(place: string, id: string): Promise<void> {
    const w = this.#where(place);
    if (w.local || this.#row(id)?.place === place) return this.takeDown(w.local ?? place, this.#me(), id);
    this.#remoteOk();
    await this.#call(w.link!, 'withdraw', { listing: id });
  }
  installs(): { id: string; place: string; listing: string; kind: string; title: string; author: string; version: string; update: string | null; ref: string | null; at: string }[] {
    return (this.#db.prepare('SELECT * FROM mk_installs ORDER BY at DESC LIMIT 200').all() as Row[]).map((r) => ({ id: String(r.id), place: String(r.place), listing: String(r.listing), kind: String(r.kind), title: String(r.title), author: String(r.author), version: String(r.version), update: r.update_version ? String(r.update_version) : null, ref: r.ref ? String(r.ref) : null, at: String(r.at) }));
  }
  /** Reports on shelves this server keeps (its communities and friend shelves). */
  reports(): { id: string; place: string; listing: string; title: string; who: string; why: string; at: string }[] {
    return (this.#db.prepare("SELECT r.*, l.listing AS body FROM mk_reports r JOIN mk_listings l ON l.id = r.listing WHERE l.status = 'live' ORDER BY r.at DESC LIMIT 50").all() as Row[]).map((r) => ({ id: String(r.id), place: String(r.place), listing: String(r.listing), title: (JSON.parse(String(r.body)) as Listing).title, who: String(r.who), why: String(r.why), at: String(r.at) }));
  }
  dismissReport(id: string): void {
    this.#db.prepare('DELETE FROM mk_reports WHERE id = ?').run(clip(id, 64));
  }
}

/** The headers of a market-scope request (exported for tests). */
export function signMarket(link: string, op: string, body: string, key: KeyObject, at: Date): Record<string, string> {
  const time = at.toISOString();
  const sig = sign(null, Buffer.from(`market\n${link}\n${time}\n${op}\n${sha(body)}`), key).toString('base64');
  return { 'sara-mk-link': link, 'sara-mk-time': time, 'sara-mk-sig': sig };
}

function freeSkillName(app: AppContext, name: string): string {
  let n = name;
  for (let i = 2; app.skills?.get('companion', n); i++) n = `${name.slice(0, 60)}-${i}`;
  return n;
}

const cache = new WeakMap<Messenger, Market>();
/** The owner's marketplace (undefined for household members, kid mode and the demo: they have no Messenger). */
export function marketOf(app: AppContext): Market | undefined {
  const m = app.messages;
  if (!m || app.member) return undefined;
  let mk = cache.get(m);
  if (mk) return mk;
  const deps: MarketDeps = {
    tools: () => {
      const names = new Set<string>();
      const hard = new Set<string>();
      for (const t of app.tools.list()) {
        if (t.isAvailable && !t.isAvailable()) continue;
        names.add(t.spec.name);
        if (t.runsCommands) hard.add(t.spec.name);
      }
      return { names, hard };
    },
    storeIds: () => {
      const idx = app.storeClient?.current()?.index as { items?: { id?: unknown }[] } | undefined;
      return new Set((idx?.items ?? []).map((i) => String(i.id ?? '')).filter(Boolean));
    },
    install: {
      skill: (p, o) => {
        const s = app.skills;
        if (!s) throw new MarketError(409, en('Skills are not available here.'));
        const input = { name: String(p.name), description: String(p.description ?? ''), body: String(p.body ?? '') };
        let name = o.ref && s.get('companion', o.ref) ? o.ref : '';
        if (name) s.save('companion', { ...input, name }, { why: `Update from ${o.author} (shared)` });
        else {
          name = freeSkillName(app, input.name);
          s.save('companion', { ...input, name }, { create: true, source: 'imported', origin: `market:${o.author}`.slice(0, 120) });
        }
        s.setLearned('companion', name, { status: 'trial' });
        return name;
      },
      automation: (p, o) => {
        const a = app.automations;
        if (!a) throw new MarketError(409, en('Automations are not available here.'));
        const cur = o.ref ? a.get(Number(o.ref)) : undefined;
        const got = cur ? a.patch(cur.id, p) : a.create(p, { by: 'settings' });
        return String(a.setEnabled(got.id, false).id);
      },
      team: (p, o) => {
        const r = app.teamRuns?.recipes;
        if (!r) throw new MarketError(409, en('Team recipes are not available here.'));
        if (o.ref) r.remove(Number(o.ref));
        return String(r.importJson(p).id);
      },
    },
    item: (kind, ref, o) => {
      if (kind === 'skill' || kind === 'template') {
        if (kind === 'template') {
          const name = o.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
          if (!name || !o.text.trim()) throw new MarketError(400, en('Give the template a name and its text.'));
          return { title: o.title, payload: { name, description: o.description || o.title, body: o.text }, tools: [] };
        }
        const v = app.skills?.get('companion', ref) ?? app.skills?.resolve(ref);
        const d = v ? app.skills!.detail(v.scope, v.name) : undefined;
        if (!d) throw new MarketError(404, en('That skill is gone.'));
        return { title: d.name, payload: { name: d.name, description: d.description, body: d.body }, tools: [] };
      }
      if (kind === 'automation') {
        const a = app.automations?.get(Number(ref));
        if (!a) throw new MarketError(404, en('Automation not found.'));
        return { title: a.name, payload: { name: a.name, trigger: a.trigger, condition: a.condition, actions: a.actions }, tools: [] };
      }
      if (kind === 'team') {
        const r = app.teamRuns?.recipes;
        if (!r?.get(Number(ref))) throw new MarketError(404, en('No such team recipe.'));
        const j = r.exportJson(Number(ref));
        return { title: j.name, payload: j as unknown as Record<string, unknown>, tools: [...new Set(j.plan.roles.flatMap((x) => x.tools ?? []))] };
      }
      const id = ref.toLowerCase();
      return { title: o.title || id, payload: { storeId: id }, tools: [] };
    },
    notify: (title, body, chat) => m.onNotify?.(title, body, chat),
  };
  mk = new Market({ dataDir: app.dataDir, messenger: m, now: () => app.now(), deps });
  cache.set(m, mk);
  return mk;
}
