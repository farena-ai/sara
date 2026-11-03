// Phase 74: reading a long document (a 500- to 1,000-page manual or book, up to about 1 GB) in
// the background, a little at a time. The work is a job kept in the database, in phases:
//   text       every page's text, page by page, from the file on disk (src/library/pager.ts)
//   ocr        every scanned page, by the picture model (local by default; a cloud model only
//              after the owner saw the cost and time estimate and said yes)
//   structure  the contents: the PDF's own bookmarks, else its headings, else parts of ~25 pages
//   summaries  a short summary of each chapter/section, then one for the whole document
//   learn      key points into her memory (more for longer documents, exact-words rule)
//   vectors    meaning-search vectors for every passage
// Each step saves its progress, so pausing, a restart or a crash goes on from the same page.
// Between pages the job yields (and waits a little, by the owner's speed setting), so chats stay
// quick while a big book is read.
import type { AppContext } from '../chat.ts';
import { chatTurns, resolveFor } from '../chat.ts';
import { embedTarget } from '../embeddings.ts';
import { privateLocalOn } from '../net-guard.ts';
import { onThisComputer } from '../private-local.ts';
import { billingOf, findPrice, priceTable } from '../usage.ts';
import { Pager } from './pager.ts';
import { type LibraryDoc, type LibraryJob, type LibraryStore, libraryLimits, type Section } from './store.ts';
import { complete, convFor, learnOne, readPageImage } from './worker.ts';

/** Documents at least this long get a contents with section summaries. */
export const LONG_DOC_PAGES = 30;
/** Pages per part when a long document has no bookmarks or headings. */
const PART_PAGES = 25;
/** Sections summarised per document (the top level; more are grouped). */
const MAX_SUMMARIES = 200;
/** Text a section summary reads (start, middle and end of a long section). */
const SUMMARY_CHARS = 12_000;
/** Rough tokens a page picture and its text take (for the cost estimate). */
const OCR_IN_TOKENS = 1_100;
const OCR_OUT_TOKENS = 450;

/** Waits after each page, by the owner's speed setting (1 gentle, 2 normal, 3 fast). */
export const PAGE_PAUSE_MS: Record<1 | 2 | 3, number> = { 1: 120, 2: 15, 3: 0 };

/**
 * Chat first: before each background model call (a scanned page, a summary, a window of key
 * points), wait while a chat turn is running (Gentle and Normal speeds; at most two minutes), so
 * her replies don't queue behind the book on a shared model.
 */
export async function chatFirst(app: AppContext, signal?: AbortSignal): Promise<void> {
  if (libraryLimits(app.settings.get()).speed === 3) return;
  const until = Date.now() + 120_000;
  while (chatTurns.running > 0 && Date.now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, 250));
}

/**
 * A background model call that steps aside for chat (Gentle and Normal speeds): it waits while a
 * chat turn runs, and if a chat starts while it is running it is stopped and tried again after
 * the chat (at most three times, so a busy chat can't starve the book).
 */
export async function yielding<T>(app: AppContext, signal: AbortSignal | undefined, fn: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await chatFirst(app, signal);
    if (libraryLimits(app.settings.get()).speed === 3 || attempt >= 3) return fn(signal);
    const ctl = new AbortController();
    let yielded = false;
    const onChat = () => {
      yielded = true;
      if (process.env.SARA_DEBUG_LIBRARY) console.log(`library: a background call stepped aside for a chat (${new Date().toISOString()})`);
      ctl.abort(new Error('stepped aside for a chat'));
    };
    chatTurns.onStart.add(onChat);
    try {
      return await fn(signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal);
    } catch (err) {
      if (yielded && !signal?.aborted) continue;
      throw err;
    } finally {
      chatTurns.onStart.delete(onChat);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => (ms > 0 ? setTimeout(r, ms) : setImmediate(r)));
const ema = (old: number, x: number) => (old > 0 ? old * 0.8 + x * 0.2 : x);

/**
 * Open readers by document (one thread per big document being read), stops for running jobs
 * (Cancel aborts the model call in flight), and jobs that already went on after a restart in this
 * process (their half-done page is dropped once). Keyed by library folder and document id:
 * each companion (and each household member) has a library of their own.
 */
const pagers = new Map<string, Pager>();
const stops = new Map<string, AbortController>();
const resumed = new Set<string>();
const keyOf = (lib: LibraryStore, docId: number) => `${lib.dir}|${docId}`;

/** Tests: forget which jobs already went on in this process (as after a real restart). */
export function forgetResumed(): void {
  resumed.clear();
}

async function pagerFor(lib: LibraryStore, doc: LibraryDoc, bodySize = 0): Promise<Pager> {
  const key = keyOf(lib, doc.id);
  const had = pagers.get(key);
  if (had?.alive) return had;
  const path = lib.filePath(doc);
  if (!path) throw new Error('The file is missing from her library folder.');
  const p = await Pager.open(path, { bodySize });
  pagers.set(key, p);
  return p;
}

export async function closePager(lib: LibraryStore, docId: number): Promise<void> {
  const key = keyOf(lib, docId);
  const p = pagers.get(key);
  pagers.delete(key);
  await p?.close();
}

/** Stops everything (server shutting down, or one library's worker stopping). */
export async function closeAllPagers(lib?: LibraryStore): Promise<void> {
  const mine = (k: string) => !lib || k.startsWith(`${lib.dir}|`);
  for (const [k, c] of stops) {
    if (!mine(k)) continue;
    c.abort();
    stops.delete(k);
  }
  await Promise.all(
    [...pagers.keys()].filter(mine).map(async (k) => {
      const p = pagers.get(k);
      pagers.delete(k);
      await p?.close();
    }),
  );
}

/** Is this stored file a PDF (its first bytes)? */
export function isPdfDoc(lib: LibraryStore, doc: LibraryDoc): boolean {
  if (doc.kind === 'pdf') return true;
  const bytes = lib.head(doc, 1024);
  return Boolean(bytes && bytes.toString('latin1').includes('%PDF-'));
}

// ---------------------------------------------------------------- what the owner sees

export interface OcrEstimate {
  pages: number;
  model: string;
  provider: string;
  local: boolean;
  /** Rough time for all of them, in seconds. */
  seconds: number;
  /** Rough cost in US dollars (null when the model's price isn't known). */
  usd: number | null;
}

/** The picture model that would read scanned pages, and what that costs. */
export function ocrEstimate(app: AppContext, doc: LibraryDoc, pages: number, secPerPage = 0): OcrEstimate | { error: string } {
  let r: ReturnType<typeof resolveFor>;
  try {
    r = resolveFor(app, convFor(app, doc), 'vision');
  } catch (err) {
    return { error: (err as Error).message };
  }
  const local = billingOf(r.provider.config) === 'local' || onThisComputer(r.provider.config, r.model);
  const price = findPrice(priceTable(app.settings.get().prices), r.provider.config.id, r.model);
  const usd = local ? 0 : price ? Math.round(((pages * (OCR_IN_TOKENS * price.inPerM + OCR_OUT_TOKENS * price.outPerM)) / 1_000_000) * 100) / 100 : null;
  return { pages, model: r.model, provider: r.provider.config.label, local, seconds: Math.round(pages * (secPerPage || (local ? 12 : 6)) / (local ? 1 : 3)), usd };
}

/** The job as the Library page shows it ("Reading page 412 of 980 · about 6 minutes left"). */
export function jobView(app: AppContext, lib: LibraryStore, doc: LibraryDoc, job = lib.job(doc.id)): Record<string, unknown> | null {
  if (!job) return null;
  const left = Math.max(0, job.pages - job.page);
  const ocrLeft = job.phase === 'text' ? Math.round(job.page ? ((job.ocrTotal || lib.ocrPages(doc.id).length) / job.page) * left : 0) + lib.ocrPages(doc.id).length : Math.max(0, job.ocrTotal - job.ocrDone);
  const stepsLeft = Math.max(0, job.stepsTotal - job.stepsDone);
  const eta = job.phase === 'done' || job.phase === 'cancelled' ? 0 : Math.round(left * (job.secPage || 0.05) + ocrLeft * (job.secOcr || 12) + stepsLeft * (job.secStep || 20));
  const out: Record<string, unknown> = {
    phase: job.phase,
    paused: job.paused,
    needs: job.needs,
    page: job.page,
    pages: job.pages,
    ocrDone: job.ocrDone,
    ocrTotal: job.phase === 'text' ? job.ocrDone + lib.ocrPages(doc.id).length : job.ocrTotal,
    stepsDone: job.stepsDone,
    stepsTotal: job.stepsTotal,
    etaSeconds: eta,
    warnings: job.warnings,
    timings: job.timings,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
  if (job.needs === 'ocr-approval' || job.needs === 'local-ocr') out.estimate = ocrEstimate(app, doc, lib.ocrPages(doc.id).length, job.secOcr);
  return out;
}

// ---------------------------------------------------------------- the job

export type JobStep = 'more' | 'done' | 'paused' | 'waiting' | 'cancelled';

interface RunOpts {
  signal?: AbortSignal;
  /** Work for about this long, then return 'more' (Infinity: until the phase in `until`). */
  sliceMs?: number;
  /** Stop when this phase is reached (readOne: 'structure', so the text is ready). */
  until?: LibraryJob['phase'];
  /** Speed override (tests). */
  pauseMs?: number;
}

/**
 * Runs a document's job for one slice of time. Returns 'more' when there is more to do, 'done',
 * 'paused', 'waiting' (for the owner: the OCR question), or 'cancelled'.
 */
export async function runJob(app: AppContext, lib: LibraryStore, docId: number, opts: RunOpts = {}): Promise<JobStep> {
  const until = Date.now() + (opts.sliceMs ?? Infinity);
  const key = keyOf(lib, docId);
  const ctl = stops.get(key) && !stops.get(key)!.signal.aborted ? stops.get(key)! : new AbortController();
  stops.set(key, ctl);
  const signal = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
  try {
    for (;;) {
      const job = lib.job(docId);
      const doc = lib.get(docId);
      if (!job || !doc) return 'cancelled';
      if (job.phase === 'cancelled') return 'cancelled';
      if (job.phase === 'done') return 'done';
      if (job.paused) return 'paused';
      if (job.needs) return 'waiting';
      if (opts.until && phaseIndex(job.phase) >= phaseIndex(opts.until)) return 'more';
      if (Date.now() >= until) return 'more';
      if (signal.aborted) return lib.job(docId)?.phase === 'cancelled' ? 'cancelled' : 'paused';
      const started = Date.now();
      const phase = job.phase;
      const r = await PHASES[phase](app, lib, doc, job, { ...opts, signal, deadline: until });
      lib.addTiming(docId, phase, Date.now() - started);
      if (r !== 'next') return r;
    }
  } finally {
    const j = lib.job(docId);
    if (!j || ['done', 'cancelled'].includes(j.phase) || j.paused) {
      stops.delete(key);
      if (!j || (j.phase !== 'text' && j.phase !== 'ocr')) void closePager(lib, docId);
    }
  }
}

const ORDER: LibraryJob['phase'][] = ['text', 'ocr', 'structure', 'summaries', 'learn', 'vectors', 'done'];
const phaseIndex = (p: LibraryJob['phase']) => (p === 'cancelled' ? 99 : ORDER.indexOf(p));

type PhaseFn = (app: AppContext, lib: LibraryStore, doc: LibraryDoc, job: LibraryJob, o: RunOpts & { signal: AbortSignal; deadline: number }) => Promise<JobStep | 'next'>;

const warn = (lib: LibraryStore, job: LibraryJob, w: string) => {
  if (!job.warnings.includes(w)) lib.updateJob(job.docId, { warnings: [...job.warnings, w].slice(-30) });
};

const stopNow = (lib: LibraryStore, docId: number): JobStep | undefined => {
  const j = lib.job(docId);
  if (!j || j.phase === 'cancelled') return 'cancelled';
  if (j.paused) return 'paused';
  return undefined;
};

const PHASES: Record<Exclude<LibraryJob['phase'], 'done' | 'cancelled'>, PhaseFn> = {
  // Every page's text, from the file, one page at a time.
  async text(app, lib, doc, job, o) {
    const pager = await pagerFor(lib, doc, job.bodySize);
    const info = pager.info!;
    if (!job.pages) {
      lib.updateJob(doc.id, { pages: info.pages, bodySize: info.bodySize, warnings: info.warnings });
      job = lib.job(doc.id)!;
    } else if (!resumed.has(keyOf(lib, doc.id))) {
      // Going on after a restart: whatever was stored past the last finished page goes.
      lib.dropPagesFrom(doc.id, job.page + 1);
    }
    resumed.add(keyOf(lib, doc.id));
    const pause = o.pauseMs ?? PAGE_PAUSE_MS[libraryLimits(app.settings.get()).speed];
    let heading = job.heading;
    let unreadable = 0;
    for (let i = job.page; i < job.pages; i++) {
      // At least one page per slice (opening a big file can take the whole slice).
      if (i > job.page && Date.now() >= o.deadline) return 'more';
      const stop = stopNow(lib, doc.id);
      if (stop) return stop;
      const t0 = Date.now();
      let page;
      try {
        page = await (await pagerFor(lib, doc, job.bodySize)).page(i);
      } catch (err) {
        warn(lib, lib.job(doc.id)!, `Page ${i + 1} couldn't be read (${(err as Error).message.slice(0, 120)}).`);
        lib.updateJob(doc.id, { page: i + 1 });
        continue;
      }
      if (page.warning) warn(lib, lib.job(doc.id)!, page.warning);
      if (page.unreadable) unreadable++;
      if (page.scan) {
        lib.addOcrPage(doc.id, i + 1);
        lib.updateJob(doc.id, { page: i + 1 });
      } else if (page.text.trim()) {
        const r = lib.addPage(doc.id, i + 1, page.text, { heading, jobPage: i + 1 });
        lib.addHeadingSections(doc.id, i + 1, r.headings);
        heading = r.heading;
      } else lib.updateJob(doc.id, { page: i + 1 });
      const cur = lib.job(doc.id)!;
      lib.updateJob(doc.id, { secPage: ema(cur.secPage, (Date.now() - t0) / 1000) });
      if (i % 25 === 24) app.events?.publish({ type: 'library', id: doc.id });
      await sleep(pause);
    }
    if (unreadable) warn(lib, lib.job(doc.id)!, `${unreadable} page${unreadable === 1 ? '' : 's'} use a font without a letter table, so their text couldn't be read.`);
    lib.updateJob(doc.id, { phase: 'ocr', ocrTotal: lib.ocrPages(doc.id).length + lib.ocrPages(doc.id, 'done').length });
    app.events?.publish({ type: 'library', id: doc.id });
    return 'next';
  },

  // Every scanned page, by the picture model.
  async ocr(app, lib, doc, job, o) {
    const todo = lib.ocrPages(doc.id);
    if (todo.length) {
      const limits = libraryLimits(app.settings.get());
      if (limits.ocr === 'off') {
        lib.setOcrStatus(doc.id, null, 'skipped');
        warn(lib, job, `${todo.length} scanned page${todo.length === 1 ? ' was' : 's were'} not read: reading scanned pages is off (Settings → Add-ons → Library).`);
        return finishText(app, lib, doc);
      }
      const est = ocrEstimate(app, doc, todo.length, job.secOcr);
      if ('error' in est) {
        // Private local mode with a cloud picture model, or no model at all.
        lib.updateJob(doc.id, { needs: 'local-ocr' });
        warn(lib, job, est.error);
        return 'waiting';
      }
      if (!est.local && (limits.ocr === 'local' || privateLocalOn())) {
        lib.updateJob(doc.id, { needs: 'local-ocr' });
        return 'waiting';
      }
      if (!est.local && !job.ocrOk) {
        lib.updateJob(doc.id, { needs: 'ocr-approval' });
        app.events?.publish({ type: 'library', id: doc.id });
        return 'waiting';
      }
      const conv = convFor(app, doc);
      const batch = est.local ? 1 : 3;
      let failures = 0;
      for (let k = 0; k < todo.length; k += batch) {
        if (Date.now() >= o.deadline) return 'more';
        const stop = stopNow(lib, doc.id);
        if (stop) return stop;
        const group = todo.slice(k, k + batch);
        await chatFirst(app, o.signal);
        const t0 = Date.now();
        const results = await Promise.all(
          group.map(async (page) => {
            try {
              const img = await (await pagerFor(lib, doc, job.bodySize)).image(page - 1);
              if ('problem' in img) return { page, problem: `Page ${page} is a scanned picture, but ${img.problem}.` };
              return { page, text: await yielding(app, o.signal, (s) => readPageImage(app, conv, img, s)) };
            } catch (err) {
              return { page, error: (err as Error).message.slice(0, 160) };
            }
          }),
        );
        for (const r of results) {
          if ('text' in r && r.text !== undefined) {
            failures = 0;
            if (r.text.trim()) lib.addPage(doc.id, r.page, r.text, { ocr: true });
            else lib.setOcrStatus(doc.id, r.page, 'done');
          } else if ('problem' in r) {
            lib.setOcrStatus(doc.id, r.page, 'failed');
            warn(lib, lib.job(doc.id)!, r.problem!);
          } else {
            if (o.signal.aborted) return stopNow(lib, doc.id) ?? 'paused';
            failures++;
            lib.setOcrStatus(doc.id, r.page, 'failed');
            warn(lib, lib.job(doc.id)!, `Couldn't read page ${r.page} with the picture model: ${r.error}`);
          }
        }
        const cur = lib.job(doc.id)!;
        lib.updateJob(doc.id, { ocrDone: cur.ocrDone + group.length, secOcr: ema(cur.secOcr, (Date.now() - t0) / 1000 / group.length) });
        app.events?.publish({ type: 'library', id: doc.id });
        if (failures >= 3) {
          // The picture model isn't answering: the rest wait for "Read it again".
          lib.setOcrStatus(doc.id, null, 'failed');
          warn(lib, lib.job(doc.id)!, 'The picture model stopped answering, so the remaining scanned pages were not read. Check Settings → Models → Which model does what → Looking at pictures, then press Read it again.');
          break;
        }
      }
    }
    return finishText(app, lib, doc);
  },

  // The contents: bookmarks, else headings, else parts.
  async structure(app, lib, doc, job) {
    let outline: { title: string; level: number; page: number }[] = [];
    if (isPdfDoc(lib, doc)) {
      try {
        outline = (await pagerFor(lib, doc, job.bodySize)).info?.outline ?? [];
      } catch {
        outline = [];
      }
    }
    const pages = Math.max(job.pages, doc.pages);
    const rows = buildContents(outline, lib.sections(doc.id), pages);
    lib.setSections(doc.id, rows);
    void closePager(lib, doc.id);
    const long = pages >= LONG_DOC_PAGES && doc.keep;
    const targets = long ? summaryTargets(lib.sections(doc.id)) : [];
    lib.updateJob(doc.id, { phase: long ? 'summaries' : 'learn', stepsTotal: targets.length + (long ? 1 : 0) + (doc.keep && doc.learn !== 'off' ? learnSteps(doc.chars) : 0), stepsDone: 0 });
    app.events?.publish({ type: 'library', id: doc.id });
    return 'next';
  },

  // A summary per section, then the whole document.
  async summaries(app, lib, doc, job, o) {
    const sections = lib.sections(doc.id);
    const targets = summaryTargets(sections);
    let failures = 0;
    for (const sec of targets) {
      if (sec.summary) continue;
      if (Date.now() >= o.deadline) return 'more';
      const stop = stopNow(lib, doc.id);
      if (stop) return stop;
      await chatFirst(app, o.signal);
      const t0 = Date.now();
      const text = sample(lib.pagesText(doc.id, sec.page, sec.pageEnd || sec.page, SUMMARY_CHARS * 4), SUMMARY_CHARS);
      if (!text.trim()) {
        lib.setSectionSummary(sec.id, '');
        continue;
      }
      try {
        const out = await yielding(app, o.signal, (s) => complete(app, convFor(app, doc), 'background', [
          { role: 'system', content: 'You summarise sections of long documents accurately. Output only the summary.' },
          {
            role: 'user',
            content: `Below is the section "${sec.title}" (pages ${sec.page} to ${sec.pageEnd || sec.page}) of the document "${doc.title || doc.name}". Write 2 to 4 plain sentences on what it covers. Keep names, numbers, limits and part numbers exact, and put the page of a key fact in brackets, like (p. ${sec.page}). Don't add anything that isn't in the text.\n\nTEXT:\n${text}`,
          },
        ], 400, s));
        lib.setSectionSummary(sec.id, out.replace(/^summary:\s*/i, ''));
        failures = 0;
      } catch (err) {
        if (o.signal.aborted) return stopNow(lib, doc.id) ?? 'paused';
        if (++failures >= 2) {
          warn(lib, lib.job(doc.id)!, `The summaries couldn't be written (the background model didn't answer: ${(err as Error).message.slice(0, 120)}).`);
          break;
        }
        continue;
      }
      const cur = lib.job(doc.id)!;
      lib.updateJob(doc.id, { stepsDone: cur.stepsDone + 1, secStep: ema(cur.secStep, (Date.now() - t0) / 1000) });
      app.events?.publish({ type: 'library', id: doc.id });
    }
    // The whole document, from its section summaries.
    const done = lib.sections(doc.id).filter((s) => s.summary);
    if (done.length && !lib.get(doc.id)?.overview && failures < 2) {
      await chatFirst(app, o.signal);
      const list = done.map((s) => `- ${s.title} (p. ${s.page}${s.pageEnd > s.page ? `-${s.pageEnd}` : ''}): ${s.summary}`).join('\n').slice(0, 24_000);
      try {
        const out = await yielding(app, o.signal, (s) => complete(app, convFor(app, doc), 'background', [
          { role: 'system', content: 'You summarise long documents accurately. Output only valid JSON.' },
          { role: 'user', content: `Below are the sections of the document "${doc.title || doc.name}" (${Math.max(job.pages, doc.pages)} pages), each with a short summary.\n\nAnswer with only this JSON: {"about": "one line saying what this document is (kind, subject, who, when)", "overview": "5 to 8 plain sentences on what the whole document covers, in order"}\n\nSECTIONS:\n${list}` },
        ], 900, s));
        const j = parseJsonObject(out);
        const overview = typeof j?.overview === 'string' ? j.overview : out.trim().startsWith('{') ? '' : out;
        lib.setOverview(doc.id, overview || null, typeof j?.about === 'string' ? j.about : null);
      } catch (err) {
        if (o.signal.aborted) return stopNow(lib, doc.id) ?? 'paused';
        warn(lib, lib.job(doc.id)!, `The summary of the whole document couldn't be written (${(err as Error).message.slice(0, 120)}).`);
      }
      const cur = lib.job(doc.id)!;
      lib.updateJob(doc.id, { stepsDone: cur.stepsDone + 1 });
    }
    lib.updateJob(doc.id, { phase: 'learn' });
    app.events?.publish({ type: 'library', id: doc.id });
    return 'next';
  },

  // Key points into her memory (scaled to the length).
  async learn(app, lib, doc, _job, o) {
    if (doc.keep && (doc.learn === 'waiting' || doc.learn === 'learning')) {
      await learnOne(app, lib, doc, o.signal, (windowsDone) => {
        const cur = lib.job(doc.id);
        if (cur) lib.updateJob(doc.id, { stepsDone: cur.stepsDone + 1, learnDone: windowsDone });
        app.events?.publish({ type: 'library', id: doc.id });
        return Boolean(stopNow(lib, doc.id));
      }, (fn) => yielding(app, o.signal, fn), _job.learnDone).catch((err: Error) => {
        if (!o.signal.aborted) lib.setLearn(doc.id, 'failed', { error: err.message.slice(0, 300) });
      });
      const stop = stopNow(lib, doc.id);
      if (stop) return stop;
      app.events?.publish({ type: 'memory', conversationId: '' });
    }
    lib.updateJob(doc.id, { phase: 'vectors' });
    return 'next';
  },

  // Meaning-search vectors for every passage.
  async vectors(app, lib, doc, job, o) {
    const target = embedTarget(app);
    if (target) {
      if (privateLocalOn() && !onThisComputer(target.config, target.model)) warn(lib, job, 'Meaning search is paused in private local mode (the embedding model is not on this computer); word search works.');
      else {
        for (;;) {
          if (Date.now() >= o.deadline) return 'more';
          const stop = stopNow(lib, doc.id);
          if (stop) return stop;
          await chatFirst(app, o.signal);
          const n = await lib.indexVectors(target, 64, doc.id).catch((err: Error) => {
            warn(lib, lib.job(doc.id)!, `Meaning search vectors couldn't be made: ${err.message.slice(0, 120)}`);
            return 0;
          });
          if (!n) break;
          await sleep(0);
        }
      }
    }
    lib.updateJob(doc.id, { phase: 'done', finishedAt: app.now().toISOString() });
    app.events?.publish({ type: 'library', id: doc.id });
    return 'done';
  },
};

/** Text and scanned pages are all in: the document can be searched from now on. */
function finishText(app: AppContext, lib: LibraryStore, doc: LibraryDoc): JobStep | 'next' {
  const job = lib.job(doc.id)!;
  const c = lib.ocrCounts(doc.id);
  const pagesSeen = (c.done ?? 0);
  const cur = lib.get(doc.id)!;
  const passages = lib.passages(doc.id, { limit: 1 }).length;
  if (!passages) {
    lib.setStatus(doc.id, 'failed', (c.done ?? 0) + (c.failed ?? 0) + (c.skipped ?? 0) ? "She couldn't find readable text in it (the picture model found none, or isn't set up)." : 'There is no text in it she can read.');
    lib.updateJob(doc.id, { phase: 'done', finishedAt: app.now().toISOString() });
    return 'done';
  }
  lib.finishPages(doc.id, { title: pagerInfoTitle(lib, doc.id) ?? cur.title, kind: 'pdf', warnings: job.warnings, pagesSeen, pages: job.pages });
  lib.updateJob(doc.id, { phase: 'structure', ocrTotal: (c.done ?? 0) + (c.failed ?? 0) + (c.skipped ?? 0) + (c.waiting ?? 0) });
  app.events?.publish({ type: 'library', id: doc.id });
  return 'next';
}

const pagerInfoTitle = (lib: LibraryStore, docId: number) => pagers.get(keyOf(lib, docId))?.info?.title;

/**
 * The contents of a document: its bookmarks when it has at least two that point at pages, else
 * the headings found while reading (bigger type, or "Chapter 3" / "3.2 …" lines), else parts of
 * about 25 pages. Each entry runs to the page before the next entry at the same or a higher level.
 */
export function buildContents(outline: { title: string; level: number; page: number }[], headings: Section[], pages: number): { level: number; title: string; page: number; pageEnd: number; source: 'outline' | 'heading' }[] {
  let rows: { level: number; title: string; page: number; source: 'outline' | 'heading' }[] = [];
  const marks = outline.filter((o) => o.page > 0);
  if (marks.length >= 2) rows = marks.map((o) => ({ level: o.level, title: o.title, page: o.page, source: 'outline' as const }));
  else {
    const hs = headings.filter((h) => h.title.length <= 120 && /\p{L}/u.test(h.title));
    // Running heads repeated on most pages are not sections.
    const counts = new Map<string, number>();
    for (const h of hs) counts.set(h.title, (counts.get(h.title) ?? 0) + 1);
    const deduped = hs.filter((h, i) => i === 0 || h.title !== hs[i - 1].title);
    let kept = deduped.filter((h) => (counts.get(h.title) ?? 0) <= Math.max(3, pages / 20));
    if (kept.length > 2000) kept = kept.filter((h) => h.level === Math.min(...kept.map((x) => x.level)));
    rows = kept.map((h) => ({ level: h.level, title: h.title, page: h.page, source: 'heading' as const }));
  }
  if (!rows.length && pages >= LONG_DOC_PAGES) {
    for (let p = 1; p <= pages; p += PART_PAGES) rows.push({ level: 1, title: `Pages ${p}–${Math.min(pages, p + PART_PAGES - 1)}`, page: p, source: 'heading' });
  }
  return rows.map((r, i) => {
    let end = pages || r.page;
    for (let k = i + 1; k < rows.length; k++) {
      if (rows[k].level <= r.level) {
        end = Math.max(r.page, rows[k].page - (rows[k].page > r.page ? 1 : 0));
        break;
      }
    }
    return { ...r, pageEnd: end };
  });
}

/** Which sections get a summary: the top level (and the next one when there are few). */
export function summaryTargets(sections: Section[]): Section[] {
  if (!sections.length) return [];
  const top = Math.min(...sections.map((s) => s.level));
  let t = sections.filter((s) => s.level === top);
  if (t.length < 3) t = sections.filter((s) => s.level <= top + 1);
  return t.slice(0, MAX_SUMMARIES);
}

/** Model calls the key points take for a document of this length (for the time estimate). */
export function learnSteps(chars: number): number {
  return Math.min(Math.ceil(chars / 9000) || 1, Math.max(6, Math.ceil(factsBudget(chars) / 4)));
}

/** Key points kept for a document: 30 for ordinary ones, more for long ones (up to 400). */
export function factsBudget(chars: number): number {
  return chars <= 200_000 ? 30 : Math.min(400, Math.round(30 + (chars - 200_000) / 10_000));
}

/** The start, middle and end of a long text (for a summary). */
function sample(text: string, max: number): string {
  if (text.length <= max) return text;
  const part = Math.floor(max / 3);
  const mid = Math.floor(text.length / 2 - part / 2);
  return `${text.slice(0, part)}\n\n[…]\n\n${text.slice(mid, mid + part)}\n\n[…]\n\n${text.slice(-part)}`;
}

function parseJsonObject(out: string): Record<string, unknown> | null {
  const a = out.indexOf('{');
  const b = out.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(out.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the owner's controls

export function pauseJob(lib: LibraryStore, docId: number): LibraryJob | undefined {
  const j = lib.job(docId);
  if (!j || ['done', 'cancelled'].includes(j.phase)) return j;
  stops.get(keyOf(lib, docId))?.abort();
  stops.delete(keyOf(lib, docId));
  return lib.updateJob(docId, { paused: true });
}

export function resumeJob(lib: LibraryStore, docId: number): LibraryJob | undefined {
  const j = lib.job(docId);
  if (!j || ['done', 'cancelled'].includes(j.phase)) return j;
  // "Waiting for a local picture model": trying again checks the settings again.
  return lib.updateJob(docId, { paused: false, ...(j.needs === 'local-ocr' ? { needs: null } : {}) });
}

/** The owner's answer to "read the scanned pages with a cloud model?" (yes, or skip them). */
export function answerOcr(lib: LibraryStore, docId: number, approve: boolean): LibraryJob | undefined {
  const j = lib.job(docId);
  if (!j || j.phase !== 'ocr') return j;
  if (approve) return lib.updateJob(docId, { needs: null, ocrOk: true });
  const n = lib.ocrPages(docId).length;
  lib.setOcrStatus(docId, null, 'skipped');
  lib.updateJob(docId, { needs: null, warnings: [...j.warnings, `${n} scanned page${n === 1 ? ' was' : 's were'} not read (you chose to skip them).`].slice(-30) });
  return lib.job(docId);
}

/**
 * Cancel: she stops reading. What was read so far stays searchable (with a note saying where she
 * stopped); a document with nothing read yet is marked as not read.
 */
export function cancelJob(app: AppContext, lib: LibraryStore, docId: number): LibraryJob | undefined {
  const j = lib.job(docId);
  const doc = lib.get(docId);
  if (!j || !doc || ['done', 'cancelled'].includes(j.phase)) return j;
  stops.get(keyOf(lib, docId))?.abort();
  stops.delete(keyOf(lib, docId));
  void closePager(lib, docId);
  const stoppedAt = j.phase === 'text' ? `She stopped reading at page ${j.page} of ${j.pages} because reading was cancelled.` : j.phase === 'ocr' ? 'Reading was cancelled before every scanned page was read.' : 'Reading was cancelled before the summaries and key points were finished.';
  lib.updateJob(docId, { phase: 'cancelled', paused: false, needs: null, finishedAt: app.now().toISOString(), warnings: [...j.warnings, stoppedAt].slice(-30) });
  if (doc.status !== 'ready') {
    if (lib.passages(docId, { limit: 1 }).length) lib.finishPages(docId, { title: doc.title, kind: 'pdf', warnings: [...j.warnings, stoppedAt], pagesSeen: lib.ocrCounts(docId).done ?? 0, pages: j.pages });
    else lib.setStatus(docId, 'failed', 'Reading was cancelled.');
  }
  if (doc.learn === 'waiting' || doc.learn === 'learning') lib.setLearn(docId, 'off');
  return lib.job(docId);
}
