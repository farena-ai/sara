// Phase 51: "Bring your history". The owner uploads a ChatGPT or Claude data export; a preview
// says what's in it; then the conversations come in as archived past conversations (original
// times and titles; the other assistant's replies marked as theirs), and, if wanted, she learns
// from them in the background a few conversations a minute through the normal memory pipeline
// (the exact-words rule against the owner's own lines). Everything can be removed again.
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from '../chat.ts';
import { openZip } from '../library/zip.ts';
import { ReadError } from '../library/read.ts';
import { memorySettings, summarizeConversation } from '../memory-worker.ts';
import { looksLikeChatGPT, parseChatGPT } from './chatgpt.ts';
import { looksLikeClaude, parseClaude } from './claude.ts';
import { type HistorySource, type ParsedExport, type SkipCounts, SOURCE_CHANNEL, SOURCE_NAME } from './types.ts';

export { SOURCE_CHANNEL, SOURCE_NAME } from './types.ts';

/** Biggest export accepted (the zip as uploaded). */
export const MAX_HISTORY_BYTES = 500 * 1024 * 1024;
/** One conversations file inside the zip (a JSON string can't be much bigger than this). */
const MAX_JSON_BYTES = 450 * 1024 * 1024;
/** Real exports hold thousands of pictures and files besides the conversations. */
const ZIP_LIMITS = { maxEntries: 300_000, maxEntryBytes: MAX_JSON_BYTES, maxTotalBytes: 1.5 * 1024 * 1024 * 1024 };
/** Default pause between two conversations she learns from (three a minute). */
export const LEARN_GAP_MS = 20_000;
const PREVIEW_TTL_MS = 2 * 3600_000;
const CONVERSATIONS_FILE = /(^|\/)conversations(-\d+)?\.jsonl?$/i;

/** Reads an export (a zip, or a bare conversations.json) and tells which assistant it's from. */
export function readExport(bytes: Buffer, now: Date): ParsedExport {
  const head = bytes.subarray(0, 64).toString('utf8').trimStart();
  const lists: unknown[] = [];
  const parse = (text: string, jsonl: boolean) => {
    try {
      if (!jsonl) return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
      return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as unknown);
    } catch {
      throw new ReadError("The conversations file in this export isn't valid JSON, so it can't be read.");
    }
  };
  if (head.startsWith('[') || head.startsWith('{')) {
    const v = parse(bytes.toString('utf8'), false);
    lists.push(Array.isArray(v) ? v : (v as { conversations?: unknown }).conversations);
  } else {
    const zip = openZip(bytes, ZIP_LIMITS);
    const names = [...zip.entries.keys()].filter((n) => CONVERSATIONS_FILE.test(n) && !/__MACOSX\//.test(n)).sort();
    if (!names.length) throw new ReadError('No conversations.json in this file. Upload the .zip that ChatGPT or Claude emailed you (Export data).');
    for (const n of names) {
      const e = zip.get(n)!;
      if (e.size > MAX_JSON_BYTES) throw new ReadError('The conversations file in this export is too big to read in one go (over 450 MB).');
      const v = parse(zip.read(n).toString('utf8'), /\.jsonl$/i.test(n));
      lists.push(Array.isArray(v) ? v : (v as { conversations?: unknown })?.conversations);
    }
  }
  if (lists.some(looksLikeChatGPT)) return parseChatGPT(lists, now);
  if (lists.some(looksLikeClaude)) return parseClaude(lists, now);
  if (lists.every((l) => Array.isArray(l) && !l.length)) throw new ReadError('This export has no conversations in it.');
  throw new ReadError("This doesn't look like a ChatGPT or Claude export. Upload the .zip from Settings → Data controls → Export (ChatGPT) or Settings → Privacy → Export data (Claude).");
}

export interface HistoryPreview {
  id: string;
  source: HistorySource;
  /** "ChatGPT" / "Claude". */
  name: string;
  conversations: number;
  messages: number;
  yourMessages: number;
  /** Already brought in before (skipped on import). */
  already: number;
  from: string | null;
  to: string | null;
  sampleTitles: string[];
  skipped: SkipCounts;
}

export interface HistoryStatus {
  state: 'idle' | 'importing' | 'learning' | 'paused' | 'done' | 'error';
  source?: HistorySource;
  name?: string;
  imported: number;
  skippedExisting: number;
  total: number;
  /** Learning: conversations done / to do, notes written. */
  learned: number;
  learnTotal: number;
  notes: number;
  failed: number;
  message?: string;
  /** What's on this server now. */
  onServer: { conversations: number; notes: number; bySource: Record<string, number> };
}

interface Queue {
  ids: string[];
  total: number;
  learned: number;
  notes: number;
  failed: number;
  paused: boolean;
  source?: HistorySource;
}

const QUEUE_KEY = 'history-import:queue';

/** Streams an upload into a file, stopping past `max` bytes. Returns the size. */
export async function saveUpload(body: AsyncIterable<Buffer> & NodeJS.ReadableStream, path: string, max: number): Promise<number> {
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > max) return done(Object.assign(new Error('too big'), { code: 'TOO_BIG' }));
      done(null, chunk);
    },
  });
  try {
    await pipeline(body, count, createWriteStream(path, { mode: 0o600 }));
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  return size;
}

export class HistoryImporter {
  readonly #app: () => AppContext;
  readonly #gapMs: number;
  /** The latest preview only, with its parsed export (run uses it; the file is read once). */
  readonly #previews = new Map<string, { at: number; preview: HistoryPreview; parsed: ParsedExport }>();
  /** One upload at a time: a 500 MB export parsed twice in parallel would take gigabytes. */
  #uploading = false;
  #status: Omit<HistoryStatus, 'onServer'> = { state: 'idle', imported: 0, skippedExisting: 0, total: 0, learned: 0, learnTotal: 0, notes: 0, failed: 0 };
  #learning: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #timer: NodeJS.Timeout | undefined;
  #wake: (() => void) | undefined;
  #stopped = false;

  constructor(app: () => AppContext, opts: { learnGapMs?: number } = {}) {
    this.#app = app;
    this.#gapMs = opts.learnGapMs ?? LEARN_GAP_MS;
  }

  get dir(): string {
    return join(this.#app().dataDir, 'cache', 'history-import');
  }

  /**
   * A fresh temp file for an upload. Only one upload runs at a time (call uploadDone() when it is
   * read); leftover *.upload files older than the preview time are cleared, never one still being
   * written.
   */
  uploadPath(): string {
    if (this.#uploading) throw new Error('Another history file is being read. Wait for it to finish, then try again.');
    mkdirSync(this.dir, { recursive: true });
    const cutoff = Date.now() - PREVIEW_TTL_MS;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.upload')) continue;
      const p = join(this.dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
      } catch {
        /* gone already */
      }
    }
    for (const [id, pv] of this.#previews) if (pv.at < cutoff) this.#previews.delete(id);
    this.#uploading = true;
    return join(this.dir, `${randomUUID()}.upload`);
  }

  /** The upload from uploadPath() is finished (read, refused or failed): the next one may start. */
  uploadDone(path?: string): void {
    this.#uploading = false;
    if (path) rmSync(path, { force: true });
  }

  get uploading(): boolean {
    return this.#uploading;
  }

  /** Reads an uploaded export and keeps it for `run` (the preview the owner sees first). */
  preview(path: string): HistoryPreview {
    const app = this.#app();
    let parsed: ParsedExport;
    try {
      parsed = readExport(readFileSync(path), app.now());
    } finally {
      // Read once: the parsed result is kept for run, so the file isn't needed any more.
      rmSync(path, { force: true });
    }
    const channel = SOURCE_CHANNEL[parsed.source];
    const convs = parsed.conversations;
    const times = convs.flatMap((c) => [c.createdAt, c.messages.at(-1)!.createdAt]).sort();
    const already = convs.filter((c) => app.store.findChannelConversation(channel, c.sourceId)).length;
    const id = randomUUID();
    const preview: HistoryPreview = {
      id,
      source: parsed.source,
      name: SOURCE_NAME[parsed.source],
      conversations: convs.length,
      messages: convs.reduce((n, c) => n + c.messages.length, 0),
      yourMessages: convs.reduce((n, c) => n + c.messages.filter((m) => m.role === 'user').length, 0),
      already,
      from: times[0] ?? null,
      to: times.at(-1) ?? null,
      sampleTitles: [...convs].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 6).map((c) => c.title),
      skipped: parsed.skipped,
    };
    // Only the newest preview is kept (each holds a whole parsed export in memory).
    this.#previews.clear();
    this.#previews.set(id, { at: Date.now(), preview, parsed });
    return preview;
  }

  status(): HistoryStatus {
    const app = this.#app();
    const ids = app.store.importedConversationIds();
    const bySource: Record<string, number> = {};
    for (const s of Object.keys(SOURCE_CHANNEL) as HistorySource[]) {
      const n = app.store.importedConversationIds(SOURCE_CHANNEL[s]).length;
      if (n) bySource[SOURCE_NAME[s]] = n;
    }
    const notes = ids.length ? Number((app.store.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE conversation_id IN (SELECT id FROM conversations WHERE channel LIKE 'import-%')`).get() as { n: number }).n) : 0;
    const q = this.#queue();
    const st = { ...this.#status };
    if (q && st.state !== 'importing') {
      st.learned = q.learned;
      st.learnTotal = q.total;
      st.notes = q.notes;
      st.failed = q.failed;
      if (q.ids.length) {
        st.state = q.paused ? 'paused' : 'learning';
        // A later import without learning mustn't leave its "brought in" note over the running job.
        if (!q.paused) st.message = `Learning from your history in the background, a few conversations a minute (${q.learned} of ${q.total} so far).`;
      }
    }
    return { ...st, onServer: { conversations: ids.length, notes, bySource } };
  }

  #publish(): void {
    this.#app().events?.publish({ type: 'history-import', status: this.status() });
  }

  #queue(): Queue | undefined {
    const raw = this.#app().memory?.kvGet(QUEUE_KEY);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Queue;
    } catch {
      return undefined;
    }
  }

  #saveQueue(q: Queue | undefined): void {
    this.#app().memory?.kvSet(QUEUE_KEY, q ? JSON.stringify(q) : '');
  }

  /** Brings the previewed conversations in. Returns when they're stored; learning goes on in the background. */
  async run(id: string, options: { learn?: boolean; oldestFirst?: boolean } = {}): Promise<HistoryStatus> {
    const pv = this.#previews.get(id);
    if (!pv) throw new Error('That preview has expired. Upload the export again.');
    if (this.#status.state === 'importing') throw new Error('An import is already running.');
    const app = this.#app();
    this.#previews.delete(id);
    const learn = options.learn !== false && Boolean(app.memory);
    const oldestFirst = options.oldestFirst !== false;
    const parsed = pv.parsed;
    const name = SOURCE_NAME[parsed.source];
    const channel = SOURCE_CHANNEL[parsed.source];
    const convs = [...parsed.conversations].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    this.#status = { state: 'importing', source: parsed.source, name, imported: 0, skippedExisting: 0, total: convs.length, learned: 0, learnTotal: 0, notes: 0, failed: 0 };
    this.#publish();
    const added: string[] = [];
    try {
      for (let i = 0; i < convs.length; i++) {
        const c = convs[i];
        if (app.store.findChannelConversation(channel, c.sourceId)) {
          this.#status.skippedExisting++;
        } else {
          const r = app.store.insertImported({
            title: c.title,
            channel,
            channelKey: c.sourceId,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            archived: true,
            from: parsed.source,
            messages: c.messages.map((m) => ({ role: m.role, content: m.text, createdAt: m.createdAt, ...(m.attachments ? { attachments: m.attachments } : {}) })),
          });
          // The everyday memory worker leaves these alone: learning is this job's (rate-limited) work.
          app.memory?.setState(r.id, { summarizedThrough: r.lastId, lastError: null });
          added.push(r.id);
          this.#status.imported++;
        }
        if (i % 25 === 24) {
          this.#publish();
          await new Promise((res) => setImmediate(res));
        }
      }
    } catch (err) {
      this.#status = { ...this.#status, state: 'error', message: `Stopped after ${this.#status.imported} conversations: ${(err as Error).message}` };
      this.#publish();
      throw err;
    }
    const memOn = app.memory && memorySettings(app).enabled;
    if (learn && added.length && memOn) {
      const old = this.#queue();
      const ids = oldestFirst ? added : [...added].reverse();
      const q: Queue = old?.ids.length ? { ...old, ids: [...old.ids, ...ids], total: old.total + ids.length } : { ids, total: ids.length, learned: 0, notes: 0, failed: 0, paused: false, source: parsed.source };
      this.#saveQueue(q);
      this.#status = { ...this.#status, state: 'learning', message: `Brought in ${this.#status.imported} conversations. Learning from them in the background, a few a minute.` };
      this.start();
    } else {
      this.#status = {
        ...this.#status,
        state: 'done',
        message: `Brought in ${this.#status.imported} conversations${this.#status.skippedExisting ? ` (${this.#status.skippedExisting} were already here)` : ''}.${learn && added.length && !memOn ? ' Memory is off, so she did not learn from them.' : ''}`,
      };
    }
    this.#publish();
    return this.status();
  }

  /** Starts (or resumes after a restart) the background learning. */
  start(): void {
    this.#stopped = false;
    if (this.#learning) return void this.#wake?.();
    const q = this.#queue();
    if (!q?.ids.length || q.paused) return;
    this.#learning = this.#learnLoop().finally(() => (this.#learning = undefined));
  }

  /** Waits until the learning stops (tests). */
  idle(): Promise<void> {
    return this.#learning ?? Promise.resolve();
  }

  async #learnLoop(): Promise<void> {
    const app = this.#app();
    let failsInRow = 0;
    while (!this.#stopped) {
      const q = this.#queue();
      if (!q?.ids.length || q.paused || !app.memory) break;
      const id = q.ids[0];
      if (!app.store.getConversation(id)) {
        q.ids.shift();
        this.#saveQueue(q);
        continue;
      }
      if (app.isBusy?.(id)) {
        await this.#sleep(this.#gapMs || 1000);
        continue;
      }
      this.#abort = new AbortController();
      let r: Awaited<ReturnType<typeof summarizeConversation>> | undefined;
      try {
        r = await summarizeConversation(app, app.memory!, id, { fromId: 0, signal: this.#abort.signal });
      } catch (err) {
        console.warn(`history import: learning from ${id} failed: ${(err as Error).message}`);
      }
      this.#abort = undefined;
      if (this.#stopped) break;
      const now = this.#queue();
      if (!now || now.ids[0] !== id) continue; // cancelled, paused-and-cleared or removed meanwhile
      now.ids.shift();
      if (!r || r.error) {
        now.failed++;
        failsInRow++;
      } else {
        failsInRow = 0;
        now.learned++;
        now.notes += (r.summaryId ? 1 : 0) + r.factIds.length + (r.dateIds?.length ?? 0);
      }
      // The model keeps failing (not set up, unreachable): pause and say why, instead of burning through.
      if (failsInRow >= 3) {
        now.paused = true;
        now.ids.unshift(id);
        now.failed--;
        this.#status = { ...this.#status, message: `Paused: the background model didn't answer (${r?.error ?? 'error'}). Check Settings → Models, then press Resume.` };
      }
      this.#saveQueue(now);
      if (!now.ids.length) {
        this.#status = { ...this.#status, state: 'done', message: `Learned from ${now.learned} imported conversations (${now.notes} notes).${now.failed ? ` ${now.failed} couldn't be read by the model.` : ''}` };
      }
      this.#publish();
      if (now.paused || !now.ids.length) break;
      await this.#sleep(this.#gapMs);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((res) => {
      this.#wake = () => {
        clearTimeout(this.#timer);
        this.#wake = undefined;
        res();
      };
      this.#timer = setTimeout(() => this.#wake?.(), ms);
      this.#timer.unref?.();
    });
  }

  pause(): HistoryStatus {
    const q = this.#queue();
    if (q?.ids.length) {
      q.paused = true;
      this.#saveQueue(q);
      this.#status = { ...this.#status, message: 'Paused. Resume whenever you like.' };
    }
    this.#wake?.();
    this.#publish();
    return this.status();
  }

  resume(): HistoryStatus {
    const q = this.#queue();
    if (q?.ids.length) {
      q.paused = false;
      this.#saveQueue(q);
      this.#status = { ...this.#status, state: 'learning', message: 'Learning from your history again.' };
      this.start();
    }
    this.#publish();
    return this.status();
  }

  /** Stops learning; what's imported and learned so far stays. */
  cancel(): HistoryStatus {
    const q = this.#queue();
    this.#abort?.abort();
    this.#saveQueue(undefined);
    this.#wake?.();
    this.#status = { ...this.#status, state: 'done', message: q ? `Stopped learning. ${q.learned} of ${q.total} conversations were learned from; the rest stay as past conversations she can look through.` : this.#status.message };
    this.#publish();
    return this.status();
  }

  /** Learns from imported conversations she hasn't learned from yet (e.g. imported with learning off). */
  learnRest(): HistoryStatus {
    const app = this.#app();
    if (!app.memory) throw new Error('Memory is not available.');
    const learned = new Set((app.store.db.prepare(`SELECT DISTINCT conversation_id AS id FROM memories WHERE kind = 'summary' AND conversation_id IN (SELECT id FROM conversations WHERE channel LIKE 'import-%')`).all() as { id: string }[]).map((r) => r.id));
    const q = this.#queue();
    const queued = new Set(q?.ids ?? []);
    const ids = app.store.importedConversationIds().filter((id) => !learned.has(id) && !queued.has(id));
    if (ids.length) {
      this.#saveQueue(q?.ids.length ? { ...q, ids: [...q.ids, ...ids], total: q.total + ids.length, paused: false } : { ids, total: ids.length, learned: 0, notes: 0, failed: 0, paused: false });
      this.#status = { ...this.#status, state: 'learning', message: `Learning from ${ids.length} imported conversations, a few a minute.` };
      this.start();
    }
    this.#publish();
    return this.status();
  }

  /** Phase 104 (move-in): learn from these imported conversations in the background (the same queue, pause and resume). */
  queueLearning(ids: string[], source: HistorySource): HistoryStatus {
    const app = this.#app();
    if (!ids.length || !app.memory || !memorySettings(app).enabled) return this.status();
    const q = this.#queue();
    const queued = new Set(q?.ids ?? []);
    const add = ids.filter((id) => !queued.has(id));
    this.#saveQueue(q?.ids.length ? { ...q, ids: [...q.ids, ...add], total: q.total + add.length } : { ids: add, total: add.length, learned: 0, notes: 0, failed: 0, paused: false, source });
    this.#status = { ...this.#status, state: 'learning', source, name: SOURCE_NAME[source], message: `Learning from ${add.length} moved-in conversations in the background, a few a minute.` };
    this.start();
    this.#publish();
    return this.status();
  }

  /** Phase 104 (move-in Undo): these conversations leave the learning queue (one in progress is stopped). */
  forget(ids: string[]): void {
    const q = this.#queue();
    if (!q) return;
    const gone = new Set(ids);
    if (gone.has(q.ids[0] ?? '')) this.#abort?.abort();
    const rest = q.ids.filter((x) => !gone.has(x));
    this.#saveQueue(rest.length ? { ...q, ids: rest, total: Math.max(rest.length, q.total - (q.ids.length - rest.length)) } : undefined);
    this.#wake?.();
  }

  /** "Remove imported history": the imported conversations and every note learned from them. */
  remove(source?: HistorySource): { conversations: number; notes: number } {
    const app = this.#app();
    this.#abort?.abort();
    const ids = app.store.importedConversationIds(source ? SOURCE_CHANNEL[source] : undefined);
    const q = this.#queue();
    if (q) {
      const gone = new Set(ids);
      const rest = q.ids.filter((x) => !gone.has(x));
      this.#saveQueue(rest.length ? { ...q, ids: rest } : undefined);
    }
    let notes = 0;
    const db = app.store.db;
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        if (app.memory) {
          const mine = (db.prepare('SELECT id FROM memories WHERE conversation_id = ?').all(id) as { id: number }[]).map((r) => r.id);
          // Notes these had replaced are current again.
          for (const m of mine) db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(m);
          notes += app.memory.deleteForConversation(id);
        }
        app.store.deleteConversation(id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    this.#wake?.();
    this.#status = { state: 'idle', imported: 0, skippedExisting: 0, total: 0, learned: 0, learnTotal: 0, notes: 0, failed: 0, message: `Removed ${ids.length} imported conversations and ${notes} notes learned from them.` };
    for (const id of ids) app.events?.publish({ type: 'memory', conversationId: id });
    this.#publish();
    return { conversations: ids.length, notes };
  }

  stop(): void {
    this.#stopped = true;
    this.#abort?.abort();
    this.#wake?.();
    this.#previews.clear();
  }

  /** For tests: whether an upload file is still kept. */
  hasFile(path: string): boolean {
    return existsSync(path);
  }
}
