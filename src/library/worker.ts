// Phase 44: reads what the owner gives her library, in the background. For each waiting document:
// read it (src/library/read.ts), have the picture model write out scanned pages and photos of
// pages, split it into passages; then, for documents kept in her library, have the memory model
// write the key facts into her memory, each with the exact words it came from (a fact whose words
// aren't in the document is dropped, like any other note); and make meaning-search vectors.
import { guard } from '../log.ts';
import { everyJob, type EveryJob } from '../tick-jobs.ts';
import type { AppContext } from '../chat.ts';
import { resolveFor } from '../chat.ts';
import { embedTarget } from '../embeddings.ts';
import { localDate } from '../memory-worker.ts';
import type { Conversation } from '../store.ts';
import { ReadError, type DocPart } from './read.ts';
import { readInThread } from './read-thread.ts';
import { type LibraryDoc, type LibraryStore, libraryLimits, sourceLabel } from './store.ts';
import { usageScope } from '../usage.ts';
import { closeAllPagers, factsBudget, isPdfDoc, learnSteps, runJob } from './bigread.ts';

/**
 * Phase 74: every scanned page is read (the old limit of 40 is gone): PDFs go through the
 * page-by-page job in src/library/bigread.ts. Pictures handed back by the other readers (a photo of
 * a page) are read too, without a cap.
 */
export const MAX_SEEN_PAGES = Infinity;
/** How much of a document the memory model reads for facts, in windows spread over the text. */
const LEARN_WINDOWS = 6;
const LEARN_WINDOW_CHARS = 9000;
/** Facts kept per ordinary document; long ones get more (factsBudget in bigread.ts, up to 400). */
export const MAX_FACTS_PER_DOC = 30;
const MODEL_TIMEOUT_MS = 180_000;

export const defaultConv = () => ({ id: '', providerId: null, model: null, mode: 'chat', private: false, partner: null, channel: 'web' }) as unknown as Conversation;

/** The conversation a document's model calls follow (a private chat keeps its read-once files local). */
export function convFor(app: AppContext, doc: LibraryDoc): Conversation {
  return (doc.conversationId && app.store.getConversation(doc.conversationId)) || defaultConv();
}

export async function complete(app: AppContext, conv: Conversation, job: 'background' | 'vision', messages: Parameters<ReturnType<typeof resolveFor>['provider']['stream']>[0]['messages'], maxTokens: number, signal?: AbortSignal): Promise<string> {
  const { provider, model } = resolveFor(app, conv, job);
  const timeout = AbortSignal.timeout(MODEL_TIMEOUT_MS);
  let out = '';
  for await (const ev of provider.stream({ model, messages, temperature: 0.1, maxTokens, reasoning: 'none', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })) {
    if (ev.type === 'text') out += ev.text;
    if (out.length > maxTokens * 8) break;
  }
  return out.trim();
}

/** Has the picture model write out the text of one scanned page or photo of a page. */
export async function readPageImage(app: AppContext, conv: Conversation, img: { mime: string; data: Buffer }, signal?: AbortSignal): Promise<string> {
  const text = await complete(
    app,
    conv,
    'vision',
    [
      { role: 'system', content: 'You copy the text of document pages exactly. Output only the text on the page, nothing else.' },
      {
        role: 'user',
        content:
          'Write out all the text on this page, in reading order, exactly as written (keep numbers, dates and names exact). Keep headings on their own lines and put a blank line between paragraphs. Write table rows as cells separated by " | ". If there is no readable text, answer with exactly: (no text)',
        images: [{ mime: img.mime, data: img.data.toString('base64') }],
      },
    ],
    3000,
    signal,
  );
  return /^\(no text\)$/i.test(text) ? '' : text;
}

/** Reads one waiting document into passages. Returns the updated document. */
export async function readOne(app: AppContext, lib: LibraryStore, doc: LibraryDoc, signal?: AbortSignal): Promise<LibraryDoc | undefined> {
  // Phase 74: PDFs are read page by page from the file (any size), as a job that can be paused
  // and goes on after a restart. Here: until the text is in (the rest goes on in the background).
  if (lib.filePath(doc) && isPdfDoc(lib, doc)) {
    if (!lib.job(doc.id)) lib.startJob(doc.id);
    await runJob(app, lib, doc.id, { signal, until: 'structure' });
    return lib.get(doc.id);
  }
  lib.setStatus(doc.id, 'reading');
  const bytes = lib.file(doc);
  if (!bytes) {
    lib.setStatus(doc.id, 'failed', 'The file is missing from her library folder.');
    return lib.get(doc.id);
  }
  try {
    const r = await readInThread(doc.name, bytes, { signal });
    const parts: DocPart[] = [...r.parts];
    const warnings = [...r.warnings];
    let seen = 0;
    if (r.images.length) {
      const conv = convFor(app, doc);
      for (const img of r.images.slice(0, MAX_SEEN_PAGES)) {
        try {
          const text = await readPageImage(app, conv, img, signal);
          seen++;
          if (text) parts.push({ text, where: img.where });
        } catch (err: unknown) {
          warnings.push(`Couldn't read ${img.where || 'a page'} with the picture model: ${(err as Error).message.slice(0, 160)}`);
          break; // the model isn't answering: don't try every page
        }
      }
      // Scanned pages come back in page order with the text pages.
      parts.sort((a, b) => pageNo(a.where) - pageNo(b.where));
    }
    if (!parts.some((p) => p.text.trim())) {
      lib.setStatus(doc.id, 'failed', r.images.length ? "She couldn't find readable text in it (the picture model found none, or isn't set up)." : 'There is no text in it she can read.');
      return lib.get(doc.id);
    }
    return lib.setRead(doc.id, { title: r.title ?? null, kind: r.kind, parts, warnings, pagesSeen: seen });
  } catch (err) {
    const msg = err instanceof ReadError ? err.message : `She couldn't read it: ${(err as Error).message.slice(0, 200)}`;
    lib.setStatus(doc.id, 'failed', msg);
    return lib.get(doc.id);
  }
}

const pageNo = (where: string) => {
  const m = /^page (\d+)/.exec(where);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/** Words compared loosely: case, spacing, quotes and dashes don't matter. */
export function loose(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201b`´]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

export function learnPrompt(owner: string, her: string, doc: Pick<LibraryDoc, 'name' | 'title'>, place: string, text: string, first: boolean): string {
  return `${owner} gave you (${her}) a document to keep and remember: "${sourceLabel(doc, '')}". Below is ${place}.

Write down what is worth remembering from it, as memory notes:
- Each note is one short sentence that makes sense on its own later: say what it is about (e.g. "${owner}'s lease for 14 Elm St ends on 31 March 2027", "The dishwasher manual says to clean the filter monthly").
- Keep names, dates, amounts, deadlines, obligations, decisions and contact details exact.
- Skip boilerplate, page furniture and fine print that doesn't matter.
- "quote" must be words copied exactly from the text below that support the note (5 to 25 words).
- At most 8 notes, the most useful first. Fewer is fine. None if nothing is worth keeping.
${first ? '- Also write "about": one line saying what this document is (kind, subject, who, when).\n' : ''}
Answer with only this JSON: {${first ? '"about": "...", ' : ''}"notes": [{"note": "...", "quote": "..."}]}

TEXT:
${text}`;
}

export function parseLearned(out: string): { about?: string; notes: { note: string; quote: string }[] } | null {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(out.slice(start, end + 1)) as { about?: unknown; notes?: unknown };
    const notes = Array.isArray(j.notes) ? j.notes : [];
    return {
      ...(typeof j.about === 'string' && j.about.trim() ? { about: j.about.trim().slice(0, 300) } : {}),
      notes: notes
        .filter((n): n is { note: string; quote: string } => Boolean(n) && typeof (n as { note?: unknown }).note === 'string' && typeof (n as { quote?: unknown }).quote === 'string')
        .map((n) => ({ note: n.note.trim().slice(0, 400), quote: n.quote.trim().slice(0, 400) }))
        .filter((n) => n.note && n.quote),
    };
  } catch {
    return null;
  }
}

/** Windows of text spread over the document (its start always first). */
export function learnWindows(full: string, windows = LEARN_WINDOWS, size = LEARN_WINDOW_CHARS): { place: string; text: string }[] {
  if (full.length <= size) return [{ place: 'the whole document', text: full }];
  const n = Math.min(windows, Math.ceil(full.length / size));
  const step = (full.length - size) / Math.max(1, n - 1);
  const out: { place: string; text: string }[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.round(i * step);
    out.push({ place: `part ${i + 1} of ${n} of it`, text: full.slice(from, from + size) });
  }
  return out;
}

/** Writes the key facts of a kept document into her memory. Returns how many were kept. */
export async function learnOne(
  app: AppContext,
  lib: LibraryStore,
  doc: LibraryDoc,
  signal?: AbortSignal,
  onWindow?: (windowsDone: number) => boolean,
  wrap?: (fn: (signal: AbortSignal | undefined) => Promise<string>) => Promise<string>,
  /** Phase 74: windows already learned before a pause or restart (they aren't asked again). */
  from = 0,
): Promise<number> {
  const mem = app.memory;
  if (!mem) {
    lib.setLearn(doc.id, 'off');
    return 0;
  }
  lib.setLearn(doc.id, 'learning');
  const s = app.settings.get();
  const owner = s.ownerName?.trim() || 'The owner';
  const full = lib.text(doc.id, 8_000_000);
  // Phase 74: longer documents get more key points, from more windows spread over the text.
  const maxFacts = factsBudget(full.length);
  const haystack = loose(full);
  const day = localDate(app.now().toISOString(), s.timeZone);
  const already = new Set(mem.fromDoc(doc.id).map((m) => loose(m.content)));
  let kept = mem.fromDoc(doc.id).length;
  let about: string | undefined;
  let failures = 0;
  let lastErr = '';
  const windows = learnWindows(full, learnSteps(full.length));
  let stopped = false;
  for (let i = from; i < windows.length && kept < maxFacts; i++) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const w = windows[i];
    let parsed: ReturnType<typeof parseLearned> = null;
    try {
      const ask = (sig: AbortSignal | undefined) =>
        complete(
          app,
          convFor(app, doc),
          'background',
          [
            { role: 'system', content: 'You write concise, factual memory notes from documents. Output only valid JSON.' },
            { role: 'user', content: learnPrompt(owner, app.persona.name, doc, w.place, w.text, i === 0) },
          ],
          1500,
          sig,
        );
      // Phase 74: a long document's job passes a wrapper that lets chat go first.
      const out = wrap ? await wrap(ask) : await ask(signal);
      parsed = parseLearned(out);
      if (!parsed) lastErr = `The memory model didn't answer with notes: ${out.slice(0, 120)}`;
    } catch (err) {
      lastErr = (err as Error).message;
    }
    if (!parsed) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      if (++failures >= 2) break;
      continue;
    }
    if (parsed.about) about = parsed.about;
    for (const n of parsed.notes) {
      // Exact-words rule: the quote must really be in the document.
      if (loose(n.quote).length < 12 || !haystack.includes(loose(n.quote))) continue;
      if (already.has(loose(n.note))) continue;
      already.add(loose(n.note));
      mem.add({ kind: 'fact', content: n.note, conversationId: null, sourceMessageId: null, happenedOn: day, evidence: n.quote, sourceDocId: doc.id });
      if (++kept >= maxFacts) break;
    }
    if (onWindow?.(i + 1)) {
      stopped = i + 1 < windows.length && kept < maxFacts;
      break;
    }
  }
  // Paused or stopped part way: it stays "learning" and goes on from the next window later.
  if (stopped) return kept;
  const ok = failures < windows.length || kept > 0;
  // Phase 74: a long document's one line comes from the whole-document summary (the first window
  // of key points only saw its first pages), so it isn't replaced here.
  const whole = lib.get(doc.id)?.overview ? lib.get(doc.id)?.summary : null;
  lib.setLearn(doc.id, ok ? 'done' : 'failed', { facts: kept, summary: whole || (about ?? null), error: ok ? null : lastErr.slice(0, 300) || 'The memory model did not answer.' });
  return kept;
}

/** Runs the library's background work a little at a time: reading, then learning, then vectors. */
export class LibraryWorker {
  readonly #app: AppContext;
  readonly #lib: () => LibraryStore | undefined;
  #timer: EveryJob | undefined;
  #busy = false;
  #ctl = new AbortController();

  constructor(app: AppContext, lib: () => LibraryStore | undefined) {
    this.#app = app;
    this.#lib = lib;
  }

  start(): void {
    this.#timer = everyJob('library', 20_000, () => this.tick());
    setTimeout(() => guard('library', () => this.tick()), 3_000).unref();
  }

  stop(): void {
    this.#timer?.stop();
    this.#ctl.abort();
    this.#ctl = new AbortController();
    void closeAllPagers(this.#lib());
  }

  /** Something was added: start soon instead of waiting for the next round. */
  nudge(): void {
    setTimeout(() => guard('library', () => this.tick()), 50).unref();
  }

  /** One round. Returns true when there may be more to do. */
  tick(): Promise<boolean> {
    return usageScope.run({ purpose: 'library' }, () => this.#tick());
  }

  async #tick(): Promise<boolean> {
    const lib = this.#lib();
    if (!lib || this.#busy) return false;
    this.#busy = true;
    try {
      const signal = this.#ctl.signal;
      // Read-once files first (someone is waiting in a chat), then the library.
      const waiting = lib.waiting(20).sort((a, b) => Number(a.keep) - Number(b.keep));
      for (const d of waiting.slice(0, 3)) {
        // Phase 74: PDFs become a job (read below, a slice at a time); the rest are read at once.
        if (lib.filePath(d) && isPdfDoc(lib, d)) lib.startJob(d.id);
        else await readOne(this.#app, lib, d, signal);
        this.#app.events?.publish({ type: 'library', id: d.id });
      }
      if (waiting.length > 3) return this.#again();
      // Phase 74: one long document's job for a slice of time (read-once ones first), then a breath.
      const jobs = lib
        .activeJobs()
        .filter((j) => !j.paused && !j.needs)
        .sort((a, b) => Number(lib.get(a.docId)?.keep) - Number(lib.get(b.docId)?.keep));
      if (jobs.length) {
        const speed = libraryLimits(this.#app.settings.get()).speed;
        const r = await runJob(this.#app, lib, jobs[0].docId, { signal, sliceMs: speed === 1 ? 1500 : speed === 2 ? 4000 : 10_000 });
        this.#app.events?.publish({ type: 'library', id: jobs[0].docId });
        if (r === 'more' || jobs.length > 1 || r === 'done') return this.#again(speed === 1 ? 400 : speed === 2 ? 100 : 20);
      }
      const learn = lib.toLearn(1);
      for (const d of learn) {
        await learnOne(this.#app, lib, d, signal).catch((err: Error) => lib.setLearn(d.id, 'failed', { error: err.message.slice(0, 300) }));
        this.#app.events?.publish({ type: 'library', id: d.id });
        this.#app.events?.publish({ type: 'memory', conversationId: '' });
      }
      const n = await lib.indexVectors(embedTarget(this.#app)).catch(() => 0);
      if (learn.length || n) return this.#again();
      return false;
    } finally {
      this.#busy = false;
    }
  }

  #again(ms = 200): boolean {
    setTimeout(() => guard('library', () => this.tick()), ms).unref();
    return true;
  }
}
