// Phase 124 (2.57.0, SARA_STORE.md §6.2, §10.3, §11, K3): Sara's reader of the Sara Store. It
// downloads the one public list (v1/index.json + index.sig) from Sara's server, never from the page:
// GET only, `User-Agent: Sara` and nothing else about him (no cookie, no install id, no query
// string, no version), HTTPS only, no redirects, a 2 MB cap and 15 s. An unchanged list is a 304
// (If-None-Match). The last list that checked out is kept in <data>/store/ and checked again on
// every read; a list that doesn't check out is refused and the old one kept. Never in the demo, in
// private local mode, when the network guard is offline, for a household member, with the store
// switched off, or in tests unless SARA_STORE_URL points at a local fake.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../fs-util.ts';
import { isLoopbackHost, netFetch, outboundAllowed, privateLocalOn } from '../net-guard.ts';
import type { PackageFile } from '../packages.ts';
import type { PluginManager } from '../plugins/manager.ts';
import { compareSemver, satisfies } from '../plugins/manifest.ts';
import { COMPANION_PACKAGE_MAX, parseEntry, type StoreBlock, type StoreEntry, type StoreIndex, type StoreItem, type StorePlatform, type StoreVersion } from './format.ts';
import type { StoreInstallRow, StoreInstalls } from './installs.ts';
import { STORE_KEYS } from './keys.ts';
import { STORE_COMPANION_LIMITS } from '../packs/format.ts';
import { acceptIndex, checkPackage, checkPinned, indexFresh, sha256, signatureOk, StoreRefused } from './verify.ts';
import { LOCALE_LIMITS, listingFor, parseLocales, type ListingText, type StoreLocales } from './locales.ts';

export const STORE_DEFAULT = 'https://backstagecoding.com/sara/store';
export const STORE_UA = 'Sara';
export const INDEX_CAP = 2 * 1024 * 1024;
export const SIG_CAP = 4 * 1024;
export const ENTRY_CAP = 256 * 1024;
export const SHOT_CAP = 1024 * 1024;
export const PACKAGE_CAP = 10 * 1024 * 1024;
export const FETCH_MS = 15_000;
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;
/** The daily look for updates and blocks: at most once per 20 hours. */
export const DAILY_MIN_MS = 20 * 3600_000;
/** *Get more* (Phase 125) fetches again when the list is older than this. */
export const STALE_MS = 6 * 3600_000;

export type StoreBlockReason = 'demo' | 'member' | 'private' | 'offline' | 'off' | 'tests';
const testing = (env: NodeJS.ProcessEnv): boolean => Boolean(env.NODE_TEST_CONTEXT) || env.SARA_TESTING === '1';

/** The store's address: SARA_STORE_URL (https, or http on this computer; no credentials) or the default. */
export function storeBase(env: NodeJS.ProcessEnv = process.env): string {
  const raw = String(env.SARA_STORE_URL ?? '').trim();
  if (!raw) return STORE_DEFAULT;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.search || u.hash) return STORE_DEFAULT;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))) return u.href.replace(/\/+$/, '');
  } catch {
    /* the default */
  }
  return STORE_DEFAULT;
}
export function localStore(base: string): boolean {
  try {
    return isLoopbackHost(new URL(base).hostname);
  } catch {
    return false;
  }
}

/** Why the store may not be read right now (undefined: it may). */
export function storeBlocked(o: { demo?: boolean; member?: boolean; on: boolean; base: string; env?: NodeJS.ProcessEnv }): StoreBlockReason | undefined {
  const env = o.env ?? process.env;
  if (o.demo || env.SARA_DEMO === '1') return 'demo';
  if (o.member) return 'member';
  if (privateLocalOn()) return 'private';
  if (!outboundAllowed(`${o.base}/v1/index.json`)) return 'offline';
  if (!o.on) return 'off';
  // Tests never reach the real store: only a local fake (SARA_STORE_URL on this computer).
  if (testing(env) && !localStore(o.base)) return 'tests';
  return undefined;
}

export interface StoreNotice {
  at: string;
  item: string;
  name: string;
  action: 'disable' | 'warn';
  reason: string;
}
export interface StoreState {
  seq: number;
  sha?: string;
  etag?: string;
  fetchedAt?: string;
  checkedAt?: string;
  revokedKeys: string[];
  lastError?: string;
  failures: number;
  /** Blocks already applied ("<plugin>:<contentSha>" → when), so switching one back on sticks. */
  applied: Record<string, string>;
  notices: StoreNotice[];
  /** Phase 125 (§10.2): the hub's unsigned held list, read with each check. It can only hide. */
  held?: { id: string; since: string }[];
}
const EMPTY_STATE = (): StoreState => ({ seq: 0, revokedKeys: [], failures: 0, applied: {}, notices: [] });

export type StoreSend = (url: string, init: RequestInit) => Promise<Response>;

/** A plugin manager as the block check needs it (src/plugins/manager.ts). */
export interface BlockTarget {
  store: { all(): { id: string; name: string; version: string; approved_sha: string; status: string; status_note?: string | null }[] };
  storeBlock(id: string, note: string): Promise<void>;
}
export const PULLED_NOTE = 'The Sara Store pulled this: ';

export interface StoreClientOptions {
  dataDir: string;
  base: string;
  blocked: () => StoreBlockReason | undefined;
  keys?: Readonly<Record<string, string>>;
  send?: StoreSend;
  now?: () => Date;
  log?: (line: string) => void;
  /** Phase 125: the held list (an anonymous GET to the hub with no id; see submit.ts fetchHeld). */
  held?: () => Promise<{ id: string; since: string }[]>;
}

export interface StripInfo {
  item: string;
  version: string;
  name: string;
  trust: StoreItem['trust'];
  yanked?: string;
}

export class StoreClient {
  readonly dir: string;
  readonly base: string;
  readonly #o: StoreClientOptions;
  #state: StoreState | undefined;
  #cache: { index: StoreIndex; skipped: string[] } | null | undefined;
  #locales: { seq: number; l: StoreLocales | null } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy: Promise<CheckResult> | undefined;
  /** Called with every list that checked out (fresh or, at start, from the cache). */
  onIndex?: (index: StoreIndex) => void | Promise<void>;

  constructor(o: StoreClientOptions) {
    this.#o = o;
    this.base = o.base.replace(/\/+$/, '');
    this.dir = join(o.dataDir, 'store');
  }
  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }
  get keys(): Readonly<Record<string, string>> {
    return this.#o.keys ?? STORE_KEYS;
  }
  blocked(): StoreBlockReason | undefined {
    return this.#o.blocked();
  }

  // ---- state.json ----
  state(): StoreState {
    if (!this.#state) {
      try {
        this.#state = { ...EMPTY_STATE(), ...(JSON.parse(readFileSync(join(this.dir, 'state.json'), 'utf8')) as Partial<StoreState>) };
      } catch {
        this.#state = EMPTY_STATE();
      }
    }
    return this.#state;
  }
  #save(patch: Partial<StoreState>): void {
    const next = { ...this.state(), ...patch };
    for (const k of Object.keys(next) as (keyof StoreState)[]) if (next[k] === undefined) delete next[k];
    this.#state = next;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.dir, 'state.json'), JSON.stringify(next, null, 1));
  }

  // ---- the cached list ----
  /** The last list that checked out (checked again here; a damaged copy is dropped). */
  current(): { index: StoreIndex; skipped: string[] } | undefined {
    if (this.#cache !== undefined) return this.#cache ?? undefined;
    const ij = join(this.dir, 'index.json');
    const is = join(this.dir, 'index.sig');
    if (!existsSync(ij) || !existsSync(is)) {
      this.#cache = null;
      return undefined;
    }
    try {
      const st = this.state();
      const r = acceptIndex(readFileSync(ij), readFileSync(is), { seq: st.seq, ...(st.sha ? { sha: st.sha } : {}), revokedKeys: st.revokedKeys }, { keys: this.keys, now: this.#now(), cached: true });
      if (r.index.seq !== st.seq) throw new StoreRefused('rollback', 'The cached list is not the one Sara accepted.');
      this.#cache = { index: r.index, skipped: r.skipped };
    } catch (err) {
      this.#o.log?.(`store: the cached list was dropped (${(err as Error).message})`);
      rmSync(ij, { force: true });
      rmSync(is, { force: true });
      const { etag: _e, sha: _s, ...rest } = this.state();
      this.#state = rest as StoreState;
      this.#save({});
      this.#cache = null;
    }
    return this.#cache ?? undefined;
  }
  /** Installs and updates need a list that hasn't expired (and the store reachable). */
  installAllowed(): boolean {
    const c = this.current();
    return Boolean(c) && indexFresh(c!.index, this.#now()) && !this.blocked();
  }

  // ---- fetching ----
  async #get(path: string, max: number, headers: Record<string, string> = {}): Promise<{ status: number; body: Buffer; etag?: string }> {
    const url = `${this.base}/v1/${path}`;
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new StoreRefused('https', 'The store must be reached over https.');
    const send = this.#o.send ?? netFetch;
    const res = await send(url, { method: 'GET', headers: { 'User-Agent': STORE_UA, Accept: '*/*', ...headers }, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(FETCH_MS) });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      await res.body?.cancel().catch(() => undefined);
      throw new StoreRefused('redirect', 'The store answered with a redirect, which Sara does not follow.');
    }
    if (res.status === 304) return { status: 304, body: Buffer.alloc(0) };
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new StoreRefused('http', `The store answered ${res.status}.`);
    }
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > max) {
      await res.body?.cancel().catch(() => undefined);
      throw new StoreRefused('size', 'The store sent a file bigger than Sara accepts.');
    }
    const chunks: Buffer[] = [];
    let n = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > max) {
          await reader.cancel().catch(() => undefined);
          throw new StoreRefused('size', 'The store sent a file bigger than Sara accepts.');
        }
        chunks.push(Buffer.from(value));
      }
    }
    const etag = res.headers.get('etag') ?? undefined;
    return { status: 200, body: Buffer.concat(chunks), ...(etag ? { etag } : {}) };
  }

  /** Fetch the list now (Check now, the daily look). Never throws. */
  check(): Promise<CheckResult> {
    this.#busy ??= this.#check().finally(() => (this.#busy = undefined));
    return this.#busy;
  }
  async #check(): Promise<CheckResult> {
    const why = this.blocked();
    if (why) return { ok: false, reason: why };
    const now = this.#now().toISOString();
    const had = this.current();
    const st = this.state();
    try {
      const r = await this.#get('index.json', INDEX_CAP, had && st.etag ? { 'If-None-Match': st.etag } : {});
      if (r.status === 304) {
        this.#save({ checkedAt: now, failures: 0, lastError: undefined });
        await this.#readHeld();
        if (had) await this.#fetchLocales(had.index.seq);
        if (had) await this.onIndex?.(had.index);
        return { ok: true, changed: false };
      }
      const sig = await this.#get('index.sig', SIG_CAP);
      const acc = acceptIndex(r.body, sig.body, { seq: st.seq, ...(st.sha ? { sha: st.sha } : {}), revokedKeys: st.revokedKeys }, { keys: this.keys, now: this.#now() });
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(join(this.dir, 'index.sig'), sig.body);
      writeFileAtomic(join(this.dir, 'index.json'), r.body);
      const changed = acc.sha !== st.sha;
      this.#save({ seq: acc.index.seq, sha: acc.sha, etag: r.etag, fetchedAt: now, checkedAt: now, revokedKeys: acc.revokedKeys, failures: 0, lastError: undefined });
      this.#cache = { index: acc.index, skipped: acc.skipped };
      await this.#readHeld();
      await this.#fetchLocales(acc.index.seq);
      await this.onIndex?.(acc.index);
      return { ok: true, changed };
    } catch (err) {
      const refused = err instanceof StoreRefused;
      const message = refused ? (err as Error).message : 'offline';
      this.#save({ checkedAt: now, failures: st.failures + 1, lastError: message });
      this.#o.log?.(`store: ${refused ? "the store's list didn't check out, so Sara kept the last good one" : "couldn't reach the store"} (${(err as Error).message})`);
      return { ok: false, reason: refused ? 'refused' : 'unreachable', message };
    }
  }

  /**
   * Listing translations (src/store/locales.ts): the signed sidecar for this list, fetched after the
   * list itself. Never fails a check: a missing (404), unreachable or refused sidecar only means the
   * English text, and an old one is dropped.
   */
  async #fetchLocales(seq: number): Promise<void> {
    const lj = join(this.dir, 'locales.json');
    const ls = join(this.dir, 'locales.sig');
    try {
      const json = await this.#get('locales.json', LOCALE_LIMITS.bytes);
      const sig = await this.#get('locales.sig', SIG_CAP);
      signatureOk(json.body, sig.body, this.keys, this.state().revokedKeys ?? []);
      parseLocales(json.body.toString('utf8'), seq);
      writeFileAtomic(ls, sig.body);
      writeFileAtomic(lj, json.body);
    } catch (err) {
      if (!/\b404\b/.test((err as Error).message)) this.#o.log?.(`store: listing translations not used (${(err as Error).message})`);
      rmSync(lj, { force: true });
      rmSync(ls, { force: true });
    }
    this.#locales = undefined;
  }
  /** The verified translations for the current list ({} for English, none published, or none valid). */
  translations(lang: string | undefined): Record<string, ListingText> {
    const cur = this.current();
    if (!cur || !lang || lang === 'en' || lang.startsWith('en-')) return {};
    if (this.#locales?.seq !== cur.index.seq) {
      let l: StoreLocales | null = null;
      try {
        const lj = join(this.dir, 'locales.json');
        const ls = join(this.dir, 'locales.sig');
        if (existsSync(lj) && existsSync(ls)) {
          const bytes = readFileSync(lj);
          signatureOk(bytes, readFileSync(ls), this.keys, this.state().revokedKeys ?? []);
          l = parseLocales(bytes.toString('utf8'), cur.index.seq);
        }
      } catch {
        l = null;
      }
      this.#locales = { seq: cur.index.seq, l };
    }
    const out: Record<string, ListingText> = {};
    for (const it of cur.index.items) {
      const t = listingFor(this.#locales.l ?? undefined, it.id, lang);
      if (t) out[it.id] = t;
    }
    return out;
  }

  async #readHeld(): Promise<void> {
    if (!this.#o.held) return;
    try {
      this.#save({ held: (await this.#o.held()).slice(0, 200) });
    } catch {
      /* the hub is down: the last held list stays (it can only hide) */
    }
  }
  /** Held ids (§10.2): no Get or Update for them; never switches anything off. */
  held(): { id: string; since: string }[] {
    return this.state().held ?? [];
  }

  /** The version of an item in the verified list. */
  version(id: string, version?: string): { item: StoreItem; v: StoreVersion } | undefined {
    const item = this.current()?.index.items.find((x) => x.id === id);
    const v = item?.versions.find((x) => x.version === (version ?? item.latest));
    return item && v ? { item, v } : undefined;
  }

  /** One entry (cached by its hash), checked against the signed list. */
  async entry(id: string, version?: string): Promise<StoreEntry> {
    const hit = this.version(id, version);
    if (!hit) throw new StoreRefused('missing', 'That add-on is not in the store.');
    const file = join(this.dir, 'entries', `${hit.v.entrySha}.json`);
    let bytes: Buffer | undefined;
    if (existsSync(file)) {
      bytes = readFileSync(file);
      if (sha256(bytes) !== hit.v.entrySha) {
        rmSync(file, { force: true });
        bytes = undefined;
      }
    }
    if (!bytes) {
      if (this.blocked()) throw new StoreRefused('blocked', 'The store is off here.');
      bytes = (await this.#get(hit.v.entry, ENTRY_CAP)).body;
      checkPinned(bytes, hit.v.entrySha, 'entry');
      mkdirSync(join(this.dir, 'entries'), { recursive: true });
      writeFileAtomic(file, bytes);
    }
    return parseEntry(bytes.toString('utf8'), { id, version: hit.v.version, kind: hit.item.kind });
  }

  /** A screenshot or icon by its hash (which the signed list or a verified entry pins). */
  async shot(path: string, sha: string): Promise<Buffer> {
    const file = join(this.dir, 'shots', sha);
    if (existsSync(file)) {
      const b = readFileSync(file);
      if (sha256(b) === sha) return b;
      rmSync(file, { force: true });
    }
    if (this.blocked()) throw new StoreRefused('blocked', 'The store is off here.');
    const b = (await this.#get(path, SHOT_CAP)).body;
    checkPinned(b, sha, 'picture');
    mkdirSync(join(this.dir, 'shots'), { recursive: true });
    writeFileAtomic(file, b);
    return b;
  }

  /** A package, downloaded only when installing (Phase 125): sha256, size and content hash checked. */
  async packageFiles(id: string, version?: string): Promise<PackageFile[]> {
    const hit = this.version(id, version);
    if (!hit?.v.package) throw new StoreRefused('missing', 'That add-on has no package.');
    if (!this.installAllowed()) throw new StoreRefused('expired', "The list expired: installs wait until Sara can check again.");
    // Phase 127: a companion pack (pictures) may be up to 25 MB, read with its own limits.
    const companion = hit.item.kind === 'companion';
    const zip = (await this.#get(hit.v.package, companion ? COMPANION_PACKAGE_MAX : PACKAGE_CAP)).body;
    return checkPackage(zip, hit.v, companion ? STORE_COMPANION_LIMITS : undefined);
  }

  /** Keeps entries/ and shots/ under 50 MB, oldest first. */
  prune(max = CACHE_MAX_BYTES): number {
    const files: { path: string; size: number; at: number }[] = [];
    for (const sub of ['entries', 'shots']) {
      const d = join(this.dir, sub);
      if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const s = statSync(p);
        if (s.isFile()) files.push({ path: p, size: s.size, at: s.mtimeMs });
      }
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    let removed = 0;
    for (const f of files.sort((a, b) => a.at - b.at)) {
      if (total <= max) break;
      rmSync(f.path, { force: true });
      total -= f.size;
      removed++;
    }
    return removed;
  }

  /** The store strip for a plugin or skill whose files hash to a listed version (§6.1, §8.3). */
  match(contentSha: string): StripInfo | undefined {
    for (const item of this.current()?.index.items ?? []) {
      const v = item.versions.find((x) => x.contentSha === contentSha);
      if (v) return { item: item.id, version: v.version, name: item.name, trust: item.trust, ...(v.yanked ? { yanked: v.yanked } : {}) };
    }
    return undefined;
  }

  /** The daily look (jittered; at most once per 20 hours). */
  startDaily(o: { firstMs?: number; everyMs?: number } = {}): void {
    if (this.#timer) return;
    const run = async () => {
      const last = Date.parse(this.state().checkedAt ?? '') || 0;
      if (this.#now().getTime() - last >= DAILY_MIN_MS) await this.check();
      this.prune();
      this.#timer = setTimeout(run, o.everyMs ?? 3600_000 + Math.floor(Math.random() * 600_000));
      this.#timer.unref?.();
    };
    this.#timer = setTimeout(run, o.firstMs ?? 10 * 60_000 + Math.floor(Math.random() * 50 * 60_000));
    this.#timer.unref?.();
  }
  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** A notice was shown: it goes. */
  dismiss(item: string): void {
    this.#save({ notices: this.state().notices.filter((n) => n.item !== item) });
  }
  /** Blocks applied are remembered so the owner's choice to switch one back on sticks. */
  markApplied(key: string): boolean {
    const st = this.state();
    if (st.applied[key]) return false;
    this.#save({ applied: { ...st.applied, [key]: this.#now().toISOString() } });
    return true;
  }
  addNotice(n: StoreNotice): void {
    const st = this.state();
    if (st.notices.some((x) => x.item === n.item && x.reason === n.reason)) return;
    this.#save({ notices: [...st.notices, n].slice(-20) });
  }
}

export type CheckResult = { ok: true; changed: boolean } | { ok: false; reason: StoreBlockReason | 'refused' | 'unreachable'; message?: string };

const blockedVersion = (b: StoreBlock, version: string): boolean => b.versions === '*' || b.versions.includes(version);

/**
 * §10.3 and §4.6 on a verified list: a blocked add-on (a store_installs row, or any plugin whose
 * approved content hash matches a blocked version) is switched off with the store's reason, or only
 * noted (`warn`); yanked and removed versions are marked on their store_installs rows. Nothing is
 * deleted. Each block is applied once per plugin and content hash.
 */
export async function applyIndex(index: StoreIndex, o: { client: StoreClient; installs?: StoreInstalls; plugins?: BlockTarget; now?: Date; others?: (row: import('./installs.ts').StoreInstallRow, reason: string) => Promise<void> }): Promise<{ disabled: string[]; warned: string[] }> {
  const at = (o.now ?? new Date()).toISOString();
  const disabled: string[] = [];
  const warned: string[] = [];
  const rows = o.installs?.all() ?? [];
  for (const b of index.blocked) {
    const shas = new Set(b.contentShas ?? []);
    const hits = new Map<string, { id: string; name: string; sha: string }>();
    for (const r of rows) if (r.item === b.id && blockedVersion(b, r.version) && r.kind === 'plugin') hits.set(r.local_ref, { id: r.local_ref, name: r.local_ref, sha: r.content_sha ?? '' });
    for (const p of o.plugins?.store.all() ?? []) {
      if (shas.has(p.approved_sha) || hits.has(p.id)) hits.set(p.id, { id: p.id, name: p.name, sha: p.approved_sha });
    }
    for (const r of rows) if (r.item === b.id && blockedVersion(b, r.version)) o.installs?.setState(r.item, 'blocked', b.reason, at);
    // Phase 125 (§10.3): skills and tool servers from the store are switched off too (never deleted).
    for (const r of rows) {
      if (r.item !== b.id || !blockedVersion(b, r.version) || r.kind === 'plugin') continue;
      if (!o.client.markApplied(`${r.kind}:${r.local_ref}:${b.action}`)) continue;
      o.client.addNotice({ at, item: b.id, name: r.local_ref, action: b.action, reason: b.reason });
      if (b.action === 'disable') {
        await o.others?.(r, `${PULLED_NOTE}${b.reason}`);
        disabled.push(r.local_ref);
      } else warned.push(r.local_ref);
    }
    for (const h of hits.values()) {
      if (!o.client.markApplied(`${h.id}:${h.sha}:${b.action}`)) continue;
      o.client.addNotice({ at, item: b.id, name: h.name, action: b.action, reason: b.reason });
      if (b.action === 'disable' && o.plugins) {
        await o.plugins.storeBlock(h.id, `${PULLED_NOTE}${b.reason}`);
        disabled.push(h.id);
      } else warned.push(h.id);
    }
  }
  for (const r of rows) {
    // This snapshot predates the block writes above; a yank must not overwrite a fresh block.
    if (r.state === 'blocked' || index.blocked.some(b => b.id === r.item && blockedVersion(b, r.version))) continue;
    const item = index.items.find((x) => x.id === r.item);
    if (!item) {
      if (!index.blocked.some((b) => b.id === r.item)) o.installs?.setState(r.item, 'removed-from-store', null, at);
      continue;
    }
    const v = item.versions.find((x) => x.version === r.version);
    if (v?.yanked) o.installs?.setState(r.item, 'yanked', v.yanked, at);
    else if (r.state !== 'ok') o.installs?.setState(r.item, 'ok', null, at);
  }
  return { disabled, warned };
}

export const platformOf = (p: NodeJS.Platform = process.platform): StorePlatform | 'other' => (p === 'win32' ? 'windows' : p === 'darwin' ? 'macos' : p === 'linux' ? 'linux' : 'other');

/** The lowest version a range asks for (">=2.60.0" → "2.60.0"), for "Needs Sara 2.60". */
const rangeFloor = (range: string): string | undefined => /(\d+\.\d+\.\d+)/.exec(range)?.[1];

export interface ShelfItem {
  id: string;
  kind: StoreItem['kind'];
  name: string;
  summary: string;
  trust: StoreItem['trust'];
  category: string;
  tags: string[];
  author: string;
  version: string;
  permissions: string[];
  canRun: boolean;
  why?: { code: 'sara' | 'platform'; text: string; params?: Record<string, string> };
  installed: boolean;
  installedVersion?: string;
  installedOrigin?: string;
  installHeld?: string;
  installHeldCode?: 'candidate' | 'association';
  updateAvailable: boolean;
  /** Phase 125: being checked by the Sara team (no Get or Update). */
  held?: boolean;
  icon?: string;
  yankedHere?: string;
  blockedHere?: string;
  /** Companions (2.60): the author's rating and whether she's romantic. */
  rating?: string;
  romance?: boolean;
}

/** Signed-content association does not change the source of the installed plugin. */
export function pluginInstallation(plugins: Pick<PluginManager, 'store'> | undefined, id: string, association?: StoreInstallRow): { installed: boolean; version?: string; origin?: string; installHeld?: string; installHeldCode?: 'candidate' | 'association' } {
  const local = plugins?.store.get(id);
  let origin: string | undefined;
  if (local) {
    try { origin = (JSON.parse(local.origin ?? '{}') as { kind?: string }).kind; } catch { origin = 'unknown'; }
  }
  const installHeld = origin === 'candidate'
    ? 'This is a local candidate. Review its updates in Plugins. Remove it before choosing a different source.'
    : plugins && association && (!local || association.local_ref !== id || association.content_sha !== local.approved_sha || association.version !== local.version)
      ? 'The saved store association no longer matches the installed plugin. Remove the stale association before installing again.'
      : undefined;
  return { installed: plugins ? Boolean(local && (association || origin === 'candidate')) : Boolean(association), ...(local ? { version: local.version, origin } : association ? { version: association.version } : {}), ...(installHeld ? { installHeld, installHeldCode: origin === 'candidate' ? 'candidate' : 'association' } : {}) };
}

/** The read model of GET /api/store (§6.2). */
export function shelfView(client: StoreClient, o: { saraVersion: string; platform?: NodeJS.Platform; installs?: StoreInstalls; plugins?: Pick<PluginManager, 'store'>; on: boolean; community: boolean; adultAny?: boolean; lang?: string }): Record<string, unknown> {
  const tr = client.translations(o.lang);
  const blocked = client.blocked();
  const cur = client.current();
  const st = client.state();
  const now = Date.now();
  const plat = platformOf(o.platform);
  const rows = new Map((o.installs?.all() ?? []).map((r) => [r.item, r]));
  const items: ShelfItem[] = [];
  const heldIds = new Set(client.held().map((h) => h.id));
  for (const it of cur?.index.items ?? []) {
    if (it.trust === 'community' && !o.community) continue;
    // Phase 127 (PACKS.md §10.2): an explicit companion shows only where Adult mode is on for one of his companions.
    if (it.kind === 'companion' && it.rating === 'explicit' && !o.adultAny) continue;
    const listed = it.versions.filter((v) => !v.yanked);
    const v = listed.find((x) => x.version === it.latest) ?? listed[0];
    if (!v) continue;
    let why: ShelfItem['why'];
    if (!satisfies(o.saraVersion, v.sara)) why = { code: 'sara', text: 'Needs Sara {version}', params: { version: rangeFloor(v.sara) ?? v.sara } };
    else if (it.works && (plat === 'other' || !it.works.includes(plat))) why = { code: 'platform', text: 'Not for this computer' };
    const row = rows.get(it.id);
    const plugin = it.kind === 'plugin' ? pluginInstallation(o.plugins, it.id, row) : undefined;
    const held = heldIds.has(it.id);
    items.push({
      id: it.id,
      kind: it.kind,
      name: it.name,
      summary: tr[it.id]?.summary ?? it.summary,
      trust: it.trust,
      category: it.category ?? 'more',
      tags: it.tags ?? [],
      author: it.author.name,
      version: v.version,
      permissions: v.permissions,
      canRun: !why,
      ...(why ? { why } : {}),
      installed: plugin?.installed ?? Boolean(row),
      ...(plugin?.version || row ? { installedVersion: plugin?.version ?? row!.version } : {}),
      ...(plugin?.origin ? { installedOrigin: plugin.origin } : {}),
      ...(plugin?.installHeld ? { installHeld: plugin.installHeld, installHeldCode: plugin.installHeldCode } : {}),
      updateAvailable: Boolean(row && row.state !== 'blocked' && compareSemver(v.version, row.version) > 0 && !why && !held && !plugin?.installHeld),
      ...(held ? { held: true } : {}),
      ...(it.icon && it.iconSha ? { icon: it.iconSha } : {}),
      ...(row?.state === 'yanked' ? { yankedHere: row.state_note ?? '' } : {}),
      ...(row?.state === 'blocked' ? { blockedHere: row.state_note ?? '' } : {}),
      ...(it.kind === 'companion' ? { rating: it.rating ?? 'general', romance: Boolean(it.romance) } : {}),
    });
  }
  const expired = cur ? !indexFresh(cur.index) : false;
  const freshness = !o.on ? 'off' : blocked === 'private' ? 'private' : !cur ? (st.lastError ? 'unreachable' : 'none') : expired ? 'expired' : st.lastError === 'offline' || blocked === 'offline' ? 'offline' : 'fresh';
  return {
    on: o.on,
    community: o.community,
    blocked: blocked ?? null,
    freshness,
    checkedAt: st.checkedAt ?? null,
    fetchedAt: st.fetchedAt ?? null,
    generated: cur?.index.generated ?? null,
    expires: cur?.index.expires ?? null,
    seq: cur?.index.seq ?? null,
    installAllowed: client.installAllowed(),
    failures: st.failures,
    lastError: st.lastError ?? null,
    minSara: cur?.index.minSara ?? null,
    tooOld: cur ? compareSemver(o.saraVersion, cur.index.minSara) < 0 : false,
    items,
    held: client.held(),
    notices: st.notices,
    url: `${client.base}/`,
    stale: !st.checkedAt || now - Date.parse(st.checkedAt) > STALE_MS,
  };
}
