// Phase 104 (MI1, docs/design/MOVE_IN.md): "Move in from another agent". One manager per data folder:
// resumable uploads (8 MB chunks), one-time move-in codes for the collector's `send`, reading a bundle
// (hash check, reader, staging), the preview, the batch, Undo, and deleting bundles (after success +
// 48 h, at Undo, or on demand). Owner-only (src/household.ts never lists "movein" as a member route);
// never in the demo.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveChain, type AppContext } from '../chat.ts';
import { SOURCE_CHANNEL } from '../history-import/types.ts';
import { adultModeOn } from '../settings.ts';
import { batch, batches, earlier, ensureTables, type ImportChoices, type ReportLine, runBatch, type BatchRow, undoBatch, undoPreview } from './batch.ts';
import { Bundle, BundleError } from './bundle.ts';
import { hermesReader } from './readers/hermes.ts';
import { openclawReader } from './readers/openclaw.ts';
import { ACTIVE_NOTES, type Choices, LEARN_DAYS, Staging } from './staging.ts';
import type { ConversationData, MemoryData, MoveInReader, PersonaFinding, ScheduleData, Section, SkillData, Staged } from './types.ts';
import { AGENT_NAME, SECTIONS } from './types.ts';

export const CHUNK = 8 * 1024 * 1024;
/** §7.1: biggest bundle accepted (the 20 GB setting's default). */
export const MAX_BUNDLE = 20 * 1024 ** 3;
const CODE_MS = 30 * 60_000;
const KEEP_AFTER_MS = 48 * 3600_000;
/** The collector Sara serves (same version as the server). */
export const COLLECTOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sara-movein.py');

const WORDS = 'amber apple arrow aspen autumn badge bamboo banner basil beacon bison blossom bramble breeze brook cactus candle canyon cedar cherry clover cobalt comet copper coral cotton crane crystal daisy delta dune ember falcon fern fiddle forest fossil garnet ginger glacier granite harbor hazel heron honey indigo island ivory jasmine juniper kettle lagoon lantern lava lemon lilac linen lotus maple marble meadow mint moss nectar nutmeg oak ocean olive orchid otter pebble pepper pine plum poppy prairie quartz quill raven reef ripple river saffron sage sequoia shell sierra silver spruce summit thistle tide timber topaz tulip velvet violet walnut willow winter yarrow zephyr'.split(' ');

/** A reader per agent kind (MI2 adds `custom`). */
export const READERS: Record<string, MoveInReader> = { hermes: hermesReader, openclaw: openclawReader };

const LEFT_REASON: Record<string, string> = {
  secret: 'never collected (keys stay with you)',
  log: 'not useful to her',
  media: 'skipped by default (collector --include)',
  backup: 'dated copies and backups: skipped by default',
  'code-env': 'program code and environments',
  telemetry: 'logs and telemetry: not useful to her',
  'sensitive-unchosen': 'you said no at collection',
  'too-big': 'bigger than the collector packs',
  'owner-never': 'you left these out',
  unreadable: "couldn't be read",
  derived: 'search indexes Sara builds herself',
  other: 'not part of a move-in',
  since: 'older than --since',
};

export type BundleState = 'uploading' | 'checking' | 'reading' | 'ready' | 'importing' | 'imported' | 'failed';
interface Session {
  id: string;
  name: string;
  size: number;
  received: number;
  state: BundleState;
  line: string;
  error?: string;
  createdAt: number;
  /** Set when the code (collector `send`) started this upload. */
  code?: string;
  batchId?: string;
  progress?: { done: number; total: number };
  abort?: AbortController;
  sha?: string;
}

interface Code {
  hash: Buffer;
  expires: number;
  tries: number;
}

const hashCode = (c: string) => createHash('sha256').update(c.toLowerCase().replace(/[^a-z]+/g, ' ').trim()).digest();

export class MoveIn {
  readonly #app: () => AppContext;
  readonly #sessions = new Map<string, Session>();
  readonly #codes: Code[] = [];
  readonly #bundles = new Map<string, Bundle>();
  readonly #staging = new Map<string, Staging>();

  constructor(app: () => AppContext) {
    this.#app = app;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    ensureTables(app().store.db);
    // Bundles staged before a restart are still there (ready to preview again).
    for (const f of readdirSync(this.dir)) {
      const m = /^([\w-]{8,64})\.saramove$/.exec(f);
      if (!m) continue;
      const meta = this.#readMeta(m[1]);
      if (meta) this.#sessions.set(m[1], { ...meta, state: meta.state === 'ready' || meta.state === 'imported' ? meta.state : 'failed', ...(meta.state === 'ready' || meta.state === 'imported' ? {} : { error: 'Sara restarted while this bundle was being read. Upload it again.' }) });
    }
    this.prune();
  }

  get dir(): string {
    return join(this.#app().dataDir, 'movein');
  }
  #file(id: string): string {
    return join(this.dir, `${id}.saramove`);
  }
  #metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  #readMeta(id: string): Session | undefined {
    try {
      return JSON.parse(readFileSync(this.#metaPath(id), 'utf8')) as Session;
    } catch {
      return undefined;
    }
  }
  #save(s: Session): void {
    const { abort: _a, ...rest } = s;
    try {
      const fd = openSync(this.#metaPath(s.id), 'w', 0o600);
      writeSync(fd, JSON.stringify(rest));
      closeSync(fd);
    } catch {
      /* the folder is gone (deleted) */
    }
    this.#app().events?.publish({ type: 'movein', id: s.id, state: s.state, line: s.line });
  }

  // ---------------------------------------------------------------------------------------------
  // The collector and move-in codes
  // ---------------------------------------------------------------------------------------------
  collector(): { sha256: string; bytes: number; version: string } | undefined {
    try {
      const b = readFileSync(COLLECTOR_PATH);
      return { sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length, version: /^VERSION = '([^']+)'/m.exec(b.toString('utf8'))?.[1] ?? '' };
    } catch {
      return undefined;
    }
  }

  /** A six-word move-in code, valid 30 minutes, good only for the move-in upload routes. */
  mintCode(): { code: string; expiresAt: string } {
    const now = Date.now();
    for (let i = this.#codes.length - 1; i >= 0; i--) if (this.#codes[i].expires < now) this.#codes.splice(i, 1);
    if (this.#codes.length >= 5) this.#codes.shift();
    const bytes = randomBytes(6);
    const code = [...bytes].map((x) => WORDS[x % WORDS.length]).join(' ');
    this.#codes.push({ hash: hashCode(code), expires: now + CODE_MS, tries: 0 });
    return { code, expiresAt: new Date(now + CODE_MS).toISOString() };
  }

  /** True when the code is one of the live ones (wrong guesses are counted against every live code). */
  checkCode(code: string): boolean {
    const now = Date.now();
    const h = hashCode(String(code ?? ''));
    const live = this.#codes.filter((c) => c.expires > now && c.tries < 10);
    const hit = live.find((c) => timingSafeEqual(c.hash, h));
    if (!hit) for (const c of live) c.tries++;
    return Boolean(hit);
  }

  // ---------------------------------------------------------------------------------------------
  // Uploads (8 MB chunks, resumable)
  // ---------------------------------------------------------------------------------------------
  startUpload(name: string, size: number, code?: string): { id: string; chunk: number; received: number } {
    if (!Number.isFinite(size) || size <= 0) throw new BundleError('That file is empty.');
    if (size > MAX_BUNDLE) throw new BundleError('That bundle is bigger than 20 GB.');
    if (!/\.saramove$/i.test(name)) throw new BundleError('Choose the .saramove file the collector made.');
    for (const s of this.#sessions.values()) if (s.state === 'uploading' && s.name === name && s.size === size) return { id: s.id, chunk: CHUNK, received: s.received };
    const free = freeBytes(this.dir);
    if (free !== undefined && free < size * 1.1) throw new BundleError('There is not enough free space on the server for this bundle.');
    const id = randomUUID();
    closeSync(openSync(this.#file(id), 'w', 0o600));
    const s: Session = { id, name: name.slice(0, 200), size, received: 0, state: 'uploading', line: 'Uploading', createdAt: Date.now(), ...(code ? { code: hashCode(code).toString('hex') } : {}) };
    this.#sessions.set(id, s);
    this.#save(s);
    return { id, chunk: CHUNK, received: 0 };
  }

  session(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  /** Whether a code-authenticated request may touch this upload. */
  codeFits(id: string, code: string): boolean {
    const s = this.#sessions.get(id);
    return Boolean(s?.code && s.code === hashCode(code).toString('hex') && Date.now() - s.createdAt < 24 * 3600_000);
  }

  async putChunk(id: string, offset: number, body: AsyncIterable<Buffer>): Promise<{ received: number; size: number }> {
    const s = this.#sessions.get(id);
    if (!s || s.state !== 'uploading') throw new BundleError('That upload is gone. Start it again.');
    if (offset !== s.received) return { received: s.received, size: s.size };
    const fd = openSync(this.#file(id), 'r+');
    let pos = s.received;
    try {
      for await (const c of body) {
        if (pos + c.length > s.size || pos + c.length - offset > CHUNK + 1024) throw new BundleError('That piece is bigger than the upload said.');
        writeSync(fd, c, 0, c.length, pos);
        pos += c.length;
      }
    } finally {
      closeSync(fd);
    }
    s.received = pos;
    s.line = `Uploading ${Math.round((100 * pos) / s.size)}%`;
    this.#save(s);
    return { received: s.received, size: s.size };
  }

  /** The upload is complete: check the bundle and read it in the background. */
  finish(id: string): Session {
    const s = this.#sessions.get(id);
    if (!s) throw new BundleError('That upload is gone. Start it again.');
    if (s.state !== 'uploading') return s;
    if (s.received !== s.size || fstatOf(this.#file(id)) !== s.size) throw new BundleError('The upload is not complete yet.');
    s.state = 'checking';
    s.line = 'Checking the bundle';
    this.#save(s);
    void this.#read(s).catch(() => undefined);
    return s;
  }

  /** Adds a bundle already on the server (tests, `sara movein import <file>`). */
  async addFile(path: string): Promise<Session> {
    const size = statSync(path).size;
    const { id } = this.startUpload(path.split(/[\\/]/).at(-1)!.replace(/(\.saramove)?$/i, '.saramove'), size);
    const s = this.#sessions.get(id)!;
    const { createReadStream } = await import('node:fs');
    for (let off = 0; off < size; off += CHUNK) await this.putChunk(id, off, createReadStream(path, { start: off, end: Math.min(size, off + CHUNK) - 1 }) as AsyncIterable<Buffer>);
    this.finish(id);
    await this.idle(id);
    return s;
  }

  /** Waits until a bundle is no longer being checked/read/imported (tests). */
  async idle(id: string): Promise<Session | undefined> {
    for (let i = 0; i < 6000; i++) {
      const s = this.#sessions.get(id);
      if (!s || !['checking', 'reading', 'importing'].includes(s.state)) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.#sessions.get(id);
  }

  async #read(s: Session): Promise<void> {
    const app = this.#app();
    const ac = new AbortController();
    s.abort = ac;
    try {
      const b = await Bundle.open(this.#file(s.id));
      await b.verify((done, total) => {
        s.line = `Checking the bundle ${total ? Math.round((100 * done) / total) : 100}%`;
      }, ac.signal);
      s.sha = await Bundle.fileSha(this.#file(s.id));
      const reader = READERS[b.manifest.source.kind];
      if (!reader) throw new BundleError(b.manifest.source.kind === 'custom' ? 'This bundle is from a custom agent. Sara reads those after the 2.38 update; keep the file.' : 'Sara has no reader for this kind of agent yet.');
      s.state = 'reading';
      s.line = 'Reading what she brought';
      this.#save(s);
      const st = this.#stagingOf(s.id, true);
      st.clear();
      // A separate scratch file for the readers' big joins (messages grouped by session); gone after reading.
      const scratchPath = join(this.dir, `${s.id}.scratch.db`);
      for (const x of ['', '-wal', '-shm']) rmSync(scratchPath + x, { force: true });
      const scratch = new DatabaseSync(scratchPath);
      scratch.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;');
      const ctx = {
        ownerName: app.settings.get().ownerName?.trim() || 'the owner',
        current: app.persona,
        adultOn: adultModeOn(app.settings.get()),
        scrub: (t: string) => scrub(app, t),
        now: app.now(),
        timeZone: app.settings.get().timeZone,
        scratch,
      };
      let summary;
      try {
        summary = await reader.read(b, (f) => st.add(f), ac.signal, ctx);
      } finally {
        scratch.close();
        for (const x of ['', '-wal', '-shm', '-journal']) rmSync(scratchPath + x, { force: true });
      }
      st.flush();
      const prev = earlier(app.store.db, b.manifest.source.kind, b.manifest.source.agentId);
      st.settle({
        already: (ref, sha) => prev.refShas.has(`${ref}|${sha}`),
        alreadyRef: (ref) => prev.refs.has(ref),
        existing: (text) => (app.memory ? app.memory.search(text, 5).map((r) => ({ id: r.memory.id, content: r.memory.content })) : []),
      });
      st.setMeta('summary', summary);
      st.setMeta('manifest', { source: b.manifest.source, createdAt: b.manifest.createdAt, collector: b.manifest.collector, categories: b.manifest.categories, redactions: b.manifest.redactions, timeZone: b.manifest.timeZone });
      st.setMeta('leftBehind', leftBehind(b, summary.skipped));
      // The collector's own plan (what it packed and skipped), shown above the preview.
      try {
        const plan = JSON.parse(await b.text('plan.json', 32 * 1024 * 1024)) as { sections?: unknown[]; skipped?: Record<string, { files: number; bytes: number }>; categories?: unknown; redactions?: unknown; estimateBytes?: number };
        st.setMeta('plan', { sections: plan.sections ?? [], skipped: plan.skipped ?? {}, categories: plan.categories ?? {}, redactions: plan.redactions ?? {} });
      } catch {
        st.setMeta('plan', null);
      }
      this.#bundles.set(s.id, b);
      s.state = 'ready';
      s.line = 'Ready';
    } catch (err) {
      s.state = 'failed';
      s.error = err instanceof BundleError ? err.message : `The bundle couldn't be read: ${(err as Error).message}`;
      s.line = s.error;
    } finally {
      s.abort = undefined;
      this.#save(s);
    }
  }

  #stagingOf(id: string, create = false): Staging {
    let st = this.#staging.get(id);
    if (!st) {
      const p = join(this.dir, `${id}.db`);
      if (!create && !existsSync(p)) throw new BundleError('That bundle has not been read yet.');
      st = new Staging(p);
      this.#staging.set(id, st);
    }
    return st;
  }

  async #bundle(id: string): Promise<Bundle> {
    let b = this.#bundles.get(id);
    if (!b) {
      b = await Bundle.open(this.#file(id));
      this.#bundles.set(id, b);
    }
    return b;
  }

  // ---------------------------------------------------------------------------------------------
  // The preview (§7.2)
  // ---------------------------------------------------------------------------------------------
  preview(id: string, choices: Choices = {}): Record<string, unknown> {
    const s = this.#sessions.get(id);
    if (!s) throw new BundleError('That bundle is gone.');
    if (s.state !== 'ready' && s.state !== 'imported') return { id, state: s.state, line: s.line, error: s.error ?? null, name: s.name };
    const app = this.#app();
    const st = this.#stagingOf(id);
    const c: Choices = { ...choices, adultOn: adultModeOn(app.settings.get()) };
    const counts = st.counts(c);
    const manifest = st.meta<Record<string, unknown>>('manifest') ?? {};
    const src = (manifest.source ?? {}) as { kind: 'hermes' | 'openclaw' | 'custom'; agentId: string; displayName?: string };
    const sections: Record<string, unknown> = {};
    for (const sec of SECTIONS) {
      const all = [...st.all(sec)];
      const fresh = all.filter((f) => f.state === 'new');
      sections[sec] = { ...counts.sections[sec], samples: samples(fresh.filter((f) => !f.held), sec), list: sec === 'skills' || sec === 'schedules' || sec === 'later' ? fresh.map(brief) : undefined };
    }
    // Memories: what will be active vs archived (§6.4).
    const notes = (counts.sections.memories.writes ?? 0) + (counts.sections.profile.writes ?? 0) + (counts.sections.reflections.writes ?? 0);
    const persona = [...st.all('persona')][0];
    const pf = persona?.data as PersonaFinding | undefined;
    // Learning estimate (§6.6: the last 90 days by default).
    const convs = [...st.selection(c)].filter((f) => f.kind === 'conversation');
    const cutoff = Date.now() - LEARN_DAYS * 86_400_000;
    const recent = convs.filter((f) => Date.parse((f.data as ConversationData).updatedAt) >= cutoff);
    const chars = (list: Staged[]) => list.reduce((n, f) => n + (f.data as ConversationData).messages.reduce((k, m) => k + m.text.length, 0), 0);
    let model: string | null = null;
    try {
      const chain = resolveChain(app, { id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: false, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, createdAt: '', updatedAt: '' } as never, 'background');
      model = chain[0] ? `${chain[0].provider.config.label} · ${chain[0].model}` : null;
    } catch {
      model = null;
    }
    const dates = convs.map((f) => (f.data as ConversationData).createdAt).sort();
    return {
      id,
      state: s.state,
      name: s.name,
      batchId: s.batchId ?? null,
      source: { kind: src.kind, agentId: src.agentId, displayName: src.displayName ?? src.agentId, agent: AGENT_NAME[src.kind] ?? src.kind },
      createdAt: manifest.createdAt ?? null,
      collector: manifest.collector ?? null,
      sections,
      held: counts.held,
      adultOn: c.adultOn,
      notes: { total: notes, active: Math.min(notes, ACTIVE_NOTES), archived: Math.max(0, notes - ACTIVE_NOTES) },
      persona: pf ? { ref: persona.ref, refused: pf.refused ?? null, history: pf.history, drafts: pf.drafts.map((d) => ({ label: d.label, files: d.files, sheet: d.sheet, notes: d.notes, leftOut: d.leftOut, ageGuessed: d.ageGuessed ?? false })), current: { name: app.persona.name, summary: app.persona.summary } } : null,
      conversations: { count: convs.length, from: dates[0] ?? null, to: dates.at(-1) ?? null, learnRecent: recent.length, tokensRecent: Math.ceil(chars(recent) / 4), tokensAll: Math.ceil(chars(convs) / 4), model, learnDays: LEARN_DAYS },
      leftBehind: st.meta<ReportLine[]>('leftBehind') ?? [],
      plan: st.meta('plan') ?? null,
      summary: st.meta('summary') ?? null,
    };
  }

  /** Every finding of one section (titles only, for "list ▸"). */
  section(id: string, sec: Section): { id: number; title: string; state: string; why: string | null; held: string | null }[] {
    return [...this.#stagingOf(id).all(sec)].map((f) => ({ id: f.id, title: f.title, state: f.state, why: f.why ?? null, held: f.held ?? null }));
  }

  // ---------------------------------------------------------------------------------------------
  // Import, Stop, Undo, Delete
  // ---------------------------------------------------------------------------------------------
  async start(id: string, choices: ImportChoices): Promise<Session> {
    const s = this.#sessions.get(id);
    if (!s) throw new BundleError('That bundle is gone.');
    if (s.state !== 'ready') throw new BundleError(s.state === 'imported' ? 'This bundle was already imported. Undo it first, or upload a newer one.' : 'The bundle is not ready yet.');
    for (const x of this.#sessions.values()) if (x.state === 'importing') throw new BundleError('Another move-in is running. Wait for it to finish.');
    const app = this.#app();
    const b = await this.#bundle(id);
    const st = this.#stagingOf(id);
    const ac = new AbortController();
    s.abort = ac;
    s.state = 'importing';
    s.line = 'Moving in';
    this.#save(s);
    const job = async (signal: AbortSignal, progress: (line: string) => void) => {
      const r = await runBatch({
        app,
        staging: st,
        bundle: b,
        bundleSha: s.sha ?? '',
        choices: { ...choices, adultOn: adultModeOn(app.settings.get()) },
        signal,
        progress: (p) => {
          s.line = `${p.line} (${p.done} of ${p.total})`;
          s.progress = { done: p.done, total: p.total };
          progress(s.line);
        },
        leftBehind: st.meta<ReportLine[]>('leftBehind') ?? [],
      });
      s.batchId = r.id;
      s.state = 'imported';
      s.line = r.state === 'partial' ? 'Stopped part way: Undo removes what was written.' : 'Moved in';
      s.createdAt = Date.now();
      return r;
    };
    // The jobs strip shows it with a Stop button when the server has jobs (§7.3); else it runs here.
    const run = (async () => {
      try {
        await job(ac.signal, () => this.#save(s));
      } catch (err) {
        s.state = 'ready';
        s.error = (err as Error).message;
        s.line = `The move-in stopped: ${s.error}`;
      } finally {
        s.abort = undefined;
        this.#save(s);
      }
    })();
    void run;
    return s;
  }

  stop(id: string): void {
    this.#sessions.get(id)?.abort?.abort();
  }

  batches(): BatchRow[] {
    return batches(this.#app().store.db);
  }
  batch(id: string): BatchRow | undefined {
    return batch(this.#app().store.db, id);
  }
  undoPreview(batchId: string) {
    return undoPreview(this.#app(), batchId);
  }
  undo(batchId: string, opts: { keepEdited?: boolean } = {}) {
    const r = undoBatch(this.#app(), batchId, opts);
    for (const s of this.#sessions.values()) if (s.batchId === batchId) this.deleteBundle(s.id);
    return r;
  }

  deleteBundle(id: string): boolean {
    const s = this.#sessions.get(id);
    s?.abort?.abort();
    this.#staging.get(id)?.close();
    this.#staging.delete(id);
    this.#bundles.delete(id);
    for (const f of [this.#file(id), this.#metaPath(id), join(this.dir, `${id}.db`), join(this.dir, `${id}.db-wal`), join(this.dir, `${id}.db-shm`)]) rmSync(f, { force: true });
    return this.#sessions.delete(id);
  }

  list(): { id: string; name: string; size: number; received: number; state: BundleState; line: string; error: string | null; batchId: string | null; createdAt: string }[] {
    return [...this.#sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map((s) => ({ id: s.id, name: s.name, size: s.size, received: s.received, state: s.state, line: s.line, error: s.error ?? null, batchId: s.batchId ?? null, createdAt: new Date(s.createdAt).toISOString() }));
  }

  /** §7.4 / §11.11: a bundle and its staging go 48 h after its move-in, unfinished uploads after a day. */
  prune(now = Date.now()): void {
    for (const s of [...this.#sessions.values()]) {
      if ((s.state === 'imported' && now - s.createdAt > KEEP_AFTER_MS) || ((s.state === 'uploading' || s.state === 'failed') && now - s.createdAt > 24 * 3600_000)) this.deleteBundle(s.id);
    }
  }

  close(): void {
    for (const s of this.#sessions.values()) s.abort?.abort();
    for (const st of this.#staging.values()) st.close();
    this.#staging.clear();
  }
}

/** The left-behind list from the manifest (every skip has a reason code) plus what the server dropped. */
function leftBehind(b: Bundle, skipped: Record<string, number>): ReportLine[] {
  const by = new Map<string, { files: number; bytes: number; examples: string[] }>();
  for (const s of b.manifest.skipped) {
    const o = by.get(s.reason) ?? { files: 0, bytes: 0, examples: [] };
    o.files += s.files ?? 1;
    o.bytes += s.bytes ?? 0;
    if (o.examples.length < 4) o.examples.push(s.path.split('/').filter(Boolean).slice(-1)[0] + (s.path.endsWith('/') ? '/' : ''));
    by.set(s.reason, o);
  }
  const out: ReportLine[] = [...by.entries()].map(([reason, o]) => ({ key: reason, count: o.files, text: `${reason}: ${o.files} files, ${Math.round(o.bytes / 1024)} KB: ${LEFT_REASON[reason] ?? 'left behind'}`, examples: o.examples, bytes: o.bytes } as ReportLine));
  if (skipped['safety-layer']) out.push({ key: 'safety-layer', count: skipped['safety-layer'], text: `${skipped['safety-layer']} lines conflicted with Sara's safety layer` });
  if (skipped['minors-check']) out.push({ key: 'minors-check', count: skipped['minors-check'], text: `${skipped['minors-check']} items failed the minors check (not shown)` });
  for (const k of ['tool', 'system', 'hidden', 'compacted', 'duplicates', 'side-branches', 'custom', 'automation-runs']) if (skipped[k]) out.push({ key: `skip-${k}`, count: skipped[k], text: `${skipped[k]} ${k.replace('-', ' ')} entries in sessions` });
  return out;
}

/** Three samples per section, picked with a fixed seed (the same on every refresh). */
function samples(list: Staged[], sec: Section): { title: string; text: string; from: string }[] {
  if (!list.length) return [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pool = [...list];
  const out: Staged[] = [];
  while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out.map((f) => ({ title: f.title, text: sampleText(f, sec), from: f.ref }));
}
function sampleText(f: Staged, sec: Section): string {
  if (sec === 'conversations') {
    const c = f.data as ConversationData;
    return c.messages.slice(0, 3).map((m) => `${m.role === 'user' ? '›' : '‹'} ${m.text.slice(0, 160)}`).join('\n');
  }
  if (f.kind === 'memory') return (f.data as MemoryData).content.slice(0, 300);
  if (f.kind === 'skill') return (f.data as SkillData).description.slice(0, 300);
  if (f.kind === 'schedule') return `${(f.data as ScheduleData).words}`;
  return f.title;
}
function brief(f: Staged): Record<string, unknown> {
  const d = f.data as unknown as Record<string, unknown>;
  return { id: f.id, title: f.title, held: f.held ?? null, ...(f.kind === 'skill' ? { scripts: d.scripts === true, bundled: d.bundled === true } : {}), ...(f.kind === 'schedule' ? { target: d.target, words: d.words, why: d.why ?? null, repeat: d.repeat ?? null } : {}), ...(f.kind === 'later' ? { code: d.code, what: d.what, why: d.why } : {}) };
}

/** Second wall for secrets (§4.4): Sara's redactor plus the collector's extra shapes (JWTs, bot tokens). */
export function scrub(app: AppContext, s: string): string {
  return app.redactor.redact(s).replace(/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]').replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, '[REDACTED]');
}

function fstatOf(p: string): number {
  const fd = openSync(p, 'r');
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

function freeBytes(dir: string): number | undefined {
  try {
    // node:fs statfs (Node ≥ 18.15).
    const { statfsSync } = require_fs();
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}
// statfsSync is looked up lazily so a platform without it still runs.
import * as fsAll from 'node:fs';
function require_fs(): { statfsSync: (p: string) => { bavail: number | bigint; bsize: number | bigint } } {
  return fsAll as unknown as { statfsSync: (p: string) => { bavail: number | bigint; bsize: number | bigint } };
}

export { SOURCE_CHANNEL };
