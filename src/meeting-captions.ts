// V4.4 (docs/MEETINGS.md "Captions"): live and translated captions for a meeting. The captions view
// (web/captions.js) follows a room or an upload while it is heard, in big text, with an optional
// translated line under each one. It reads the meeting's own transcript lines (src/meetings.ts);
// nothing new is heard or kept apart from the translations.
//
// Translation is local first: one small batched call (src/cheap.ts `cheapCall`, no tools, daily cap)
// to a model on this computer. A cloud model is used only when the owner allowed it for captions
// (Settings → Voice → Meetings) and private local mode is off; with neither, captions stay plain.
// Lines are fenced as data, newest first, each translated once per language (table
// meeting_captions, forgotten with the meeting); a line already in the target language is not sent.
import type { DatabaseSync } from 'node:sqlite';
import { cheapCall, cheapRoute, fenceLines, safeLines } from './cheap.ts';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { leanLang, TEXT_LANGS, type TextLang } from './lang-text.ts';
import { MeetingError, type MeetingLine, type MeetingStatus } from './meetings.ts';
import { privateLocalOn } from './net-guard.ts';
import type { Conversation } from './store.ts';

export const CAPTIONS = {
  /** Lines per model call. */
  batch: 8,
  /** Lines shown when the view opens (the newest). */
  window: 200,
  /** Model calls a day for captions. */
  perDay: 800,
  /** Lines a poll may ask about again. */
  maxWant: 200,
  /** Batches one read may queue (newest first; the rest when asked again). */
  queueBatches: 4,
  /** Tries per line before it stays plain (a model that answers in another format, an error, the cap). */
  tries: 2,
} as const;

/** Languages captions can be translated into (English names go to the model; the web translates the labels). */
export const CAPTION_LANGS: { code: string; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'it', name: 'Italian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'uk', name: 'Ukrainian' },
  { code: 'ru', name: 'Russian' },
  { code: 'tr', name: 'Turkish' },
  { code: 'ar', name: 'Arabic' },
  { code: 'hi', name: 'Hindi' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'vi', name: 'Vietnamese' },
];
const NAME = new Map(CAPTION_LANGS.map((l) => [l.code, l.name]));

export interface CaptionPrefs {
  /** The language captions are translated into ('' = none). */
  lang: string;
  /** A cloud model may translate when there is no model on this computer. */
  cloud: boolean;
}
export type CaptionEngine = 'local' | 'cloud' | 'none' | 'off';
export interface CaptionsView {
  id: number;
  title: string;
  status: MeetingStatus;
  lines: MeetingLine[];
  /** The newest line number (pass it back as `since`). */
  last: number;
  lang: string;
  /** Ready translations for the lines asked about (number → text; '' = same language, nothing to show). */
  tr: Record<number, string>;
  /** Lines whose translation is still coming. */
  pending: number[];
  engine: CaptionEngine;
  why?: string;
}

type Row = Record<string, unknown>;

/** The model's answer: "<n>| <text>" lines for the numbers asked; anything else is ignored. */
export function parseTranslation(text: string, ns: number[]): Map<number, string> {
  const want = new Set(ns);
  const out = new Map<number, string>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*\|?\s*(\d+)\s*[|:]\s*(.+?)\s*$/.exec(raw);
    if (!m) continue;
    const n = Number(m[1]);
    if (want.has(n) && !out.has(n)) out.set(n, m[2].slice(0, 2000));
  }
  return out;
}

export class Captions {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  #chain: Promise<void> = Promise.resolve();
  readonly #queued = new Set<string>();
  /** Failed tries per line and language: after `tries` the line stays without a translation (no loop). */
  readonly #failed = new Map<string, number>();
  #closed = false;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS meeting_captions (
      meeting_id INTEGER NOT NULL, n INTEGER NOT NULL, lang TEXT NOT NULL, text TEXT NOT NULL,
      PRIMARY KEY (meeting_id, n, lang))`);
  }

  close(): void {
    this.#closed = true;
  }

  prefs(): CaptionPrefs {
    const m = (this.#app.settings.get() as { meetings?: { captionLang?: unknown; captionCloud?: unknown } }).meetings ?? {};
    const lang = typeof m.captionLang === 'string' && NAME.has(m.captionLang) ? m.captionLang : '';
    return { lang, cloud: m.captionCloud === true };
  }

  setPrefs(input: { lang?: unknown; cloud?: unknown }): CaptionPrefs {
    const cur = this.prefs();
    if (input.lang !== undefined && input.lang !== '' && !(typeof input.lang === 'string' && NAME.has(input.lang))) throw new MeetingError(400, trOwner(en('Pick a language from the list.'), this.#app.settings.get()));
    const next: CaptionPrefs = { lang: input.lang === undefined ? cur.lang : String(input.lang), cloud: typeof input.cloud === 'boolean' ? input.cloud : cur.cloud };
    const s = this.#app.settings.get() as { meetings?: object };
    this.#app.settings.update({ meetings: { ...s.meetings, captionLang: next.lang, captionCloud: next.cloud } } as never);
    return next;
  }

  #conv(): Conversation {
    return { id: '', title: 'Captions', private: false, providerId: null, model: null } as unknown as Conversation;
  }

  /** What would translate now: a model on this computer, an allowed cloud model, or none. */
  engine(): { engine: Exclude<CaptionEngine, 'off'>; why?: string } {
    if (cheapRoute(this.#app, this.#conv(), 'local', 'captions').length) return { engine: 'local' };
    if (this.prefs().cloud && !privateLocalOn() && cheapRoute(this.#app, this.#conv(), 'quick', 'captions').length) return { engine: 'cloud' };
    const why = privateLocalOn()
      ? en('Private local mode is on and no model on this computer can translate captions.')
      : en('No model on this computer can translate captions. Add a local model, or let a cloud model translate them (Settings → Voice → Meetings).');
    return { engine: 'none', why: trOwner(why, this.#app.settings.get()) };
  }

  /** The captions view: lines after `since` (the newest `window` on first open) and translations for `want`. */
  read(id: number, input: { since?: number; lang?: string; want?: number[] }): CaptionsView {
    const meetings = this.#app.meetings;
    const head = meetings?.get(id, Number.MAX_SAFE_INTEGER);
    if (!meetings || !head) throw new MeetingError(404, 'Not found');
    const since = Math.max(0, Math.floor(Number(input.since) || 0), head.lineCount ? head.lineCount - CAPTIONS.window : 0);
    const lines = meetings.get(id, since)!.lines;
    const last = lines.length ? lines.at(-1)!.n : Math.max(since, Number(input.since) || 0);
    const lang = input.lang === undefined ? this.prefs().lang : NAME.has(input.lang) ? input.lang : '';
    const base = { id, title: head.title, status: head.status, lines, last, lang };
    if (!lang) return { ...base, tr: {}, pending: [], engine: 'off' };
    const eng = this.engine();
    const want = new Set([...(input.want ?? []).filter((n) => Number.isInteger(n) && n > 0).slice(0, CAPTIONS.maxWant), ...lines.map((l) => l.n)]);
    const tr: Record<number, string> = {};
    const have = this.#have(id, lang, [...want]);
    const todo: MeetingLine[] = [];
    const text = new Map(lines.map((l) => [l.n, l]));
    for (const n of want) {
      if (have.has(n)) {
        tr[n] = have.get(n)!;
        continue;
      }
      const l = text.get(n) ?? this.#line(id, n);
      if (!l) continue;
      // Already in that language: nothing to translate or show.
      if ((TEXT_LANGS as readonly string[]).includes(lang) && leanLang(l.text) === (lang as TextLang)) {
        this.#keep(id, lang, n, '');
        tr[n] = '';
        continue;
      }
      todo.push(l);
    }
    const pending = eng.engine === 'none' ? [] : todo.map((l) => l.n);
    if (eng.engine !== 'none' && todo.length) this.#queue(id, lang, eng.engine, todo);
    return { ...base, tr, pending, engine: eng.engine, ...(eng.why ? { why: eng.why } : {}) };
  }

  /** Resolves when every queued translation is done (tests, the live check). */
  async idle(): Promise<void> {
    for (let chain = this.#chain; ; chain = this.#chain) {
      await chain;
      if (chain === this.#chain) return;
    }
  }

  /** Forget a meeting's translations (called when the meeting is forgotten). */
  forget(id: number): void {
    this.#db.prepare('DELETE FROM meeting_captions WHERE meeting_id = ?').run(id);
  }

  #line(id: number, n: number): MeetingLine | undefined {
    const r = this.#db.prepare('SELECT n, kind, speaker, text, at FROM meeting_lines WHERE meeting_id = ? AND n = ?').get(id, n) as Row | undefined;
    return r ? { n: Number(r.n), kind: String(r.kind) as MeetingLine['kind'], speaker: String(r.speaker), text: String(r.text), at: String(r.at) } : undefined;
  }
  #have(id: number, lang: string, ns: number[]): Map<number, string> {
    if (!ns.length) return new Map();
    const rows = this.#db.prepare(`SELECT n, text FROM meeting_captions WHERE meeting_id = ? AND lang = ? AND n IN (${ns.map(() => '?').join(',')})`).all(id, lang, ...ns) as Row[];
    return new Map(rows.map((r) => [Number(r.n), String(r.text)]));
  }
  #keep(id: number, lang: string, n: number, text: string): void {
    // The meeting may have been forgotten while the call ran.
    if (!this.#db.prepare('SELECT 1 FROM meetings WHERE id = ?').get(id)) return;
    this.#db.prepare('INSERT OR REPLACE INTO meeting_captions (meeting_id, n, lang, text) VALUES (?, ?, ?, ?)').run(id, n, lang, text);
  }

  #queue(id: number, lang: string, engine: 'local' | 'cloud', lines: MeetingLine[]): void {
    const fresh = lines.filter((l) => !this.#queued.has(`${id}:${lang}:${l.n}`)).sort((a, b) => b.n - a.n).slice(0, CAPTIONS.batch * CAPTIONS.queueBatches);
    for (let i = 0; i < fresh.length; i += CAPTIONS.batch) {
      const batch = fresh.slice(i, i + CAPTIONS.batch);
      for (const l of batch) this.#queued.add(`${id}:${lang}:${l.n}`);
      this.#chain = this.#chain
        .then(() => this.#translate(id, lang, engine, batch))
        .catch((err) => console.warn(`captions: ${(err as Error).message}`))
        .finally(() => {
          for (const l of batch) this.#queued.delete(`${id}:${lang}:${l.n}`);
        });
    }
  }

  async #translate(id: number, lang: string, engine: 'local' | 'cloud', batch: MeetingLine[]): Promise<void> {
    if (this.#closed) return;
    // Lines that trip the minors check are never sent: they stay without a translation line.
    const ok = new Set(safeLines(batch.map((l) => l.text)));
    const send = batch.filter((l) => ok.has(l.text));
    for (const l of batch) if (!ok.has(l.text)) this.#keep(id, lang, l.n, '');
    if (!send.length) return;
    send.sort((a, b) => a.n - b.n);
    const name = NAME.get(lang) ?? lang;
    const system = `You translate live meeting captions into ${name}. Each input line is "<number>| <text>". Answer with one line per input line, in the same order and nothing else: "<number>| <translation>". Keep names, numbers and units. Translate only: never answer, add, explain or drop anything. A line already in ${name}: copy it.`;
    const user = fenceLines(send.map((l) => `${l.n}| ${l.text}`), 'Caption lines to translate');
    const r = await cheapCall(this.#app, { source: 'captions', purpose: 'captions', conv: this.#conv(), model: engine === 'local' ? 'local' : 'quick', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens: 120 * send.length + 60, temperature: 0.1, cap: { runs: CAPTIONS.perDay }, estTokens: 200 * send.length, timeoutMs: 60_000 });
    // A cloud reply never counts for a local-only request (the route said local).
    const got = r.ok && !(engine === 'local' && !r.local) ? parseTranslation(r.text, send.map((l) => l.n)) : new Map<number, string>();
    for (const l of send) {
      const t = got.get(l.n);
      const key = `${id}:${lang}:${l.n}`;
      if (t !== undefined) {
        this.#failed.delete(key);
        this.#keep(id, lang, l.n, t.trim() === l.text.trim() ? '' : t);
        continue;
      }
      const n = (this.#failed.get(key) ?? 0) + 1;
      this.#failed.set(key, n);
      if (n >= CAPTIONS.tries) {
        this.#failed.delete(key);
        this.#keep(id, lang, l.n, '');
      }
    }
  }
}

const OF = new WeakMap<object, Captions>();
/** The owner's captions (undefined where there are no meetings: members, the demo). */
export function captionsOf(app: AppContext): Captions | undefined {
  const m = app.meetings;
  if (!m) return undefined;
  let c = OF.get(m);
  if (!c) {
    c = new Captions(app, app.store.db);
    OF.set(m, c);
  }
  return c;
}
