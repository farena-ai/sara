// V2.9 One-minute voice journal (docs/design/JOURNAL.md): Library → Journal.
// A short daily entry, spoken (up to a minute) or typed, with an optional mood tag. Spoken entries
// are heard ONLY by the hearing engine on this computer (app.voice, never the general
// /api/voice/transcribe path, which may use a cloud speech service); the words are kept, the
// recording only when the person asks ("Keep the recording", remembered). "On this day" shows the
// same day in earlier years, else the same day last month (like Our moments, src/moments.ts).
//
// Private by default: the book lives in the person's own space (<space>/journal/journal.db; a
// household member's in their own folder) and every entry and recording is sealed with AES-256-GCM
// under that space's own key (journal.key, mode 0600); only the day and time are in clear. No model
// tool reads it, it is not a chat, not memory and not an Ask source, so it never reaches a model,
// another person or a report.
//   GET    /api/library/journal                → {entries, onThisDay, today, streak, hearing, prefs, maxSeconds}
//   POST   /api/library/journal?mood=&keep=1   (audio/wav body) → 201 {entry}   (409 typeInstead without local hearing)
//   POST   /api/library/journal {text, mood?}  → 201 {entry}
//   PATCH  /api/library/journal/:id {text?, mood?} · DELETE /api/library/journal/:id
//   GET    /api/library/journal/:id/audio      → audio/wav (only when the recording was kept)
//   PUT    /api/library/journal/prefs {keepAudio}
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { HttpError, readJson, readRaw, SECURITY_HEADERS, send } from './http.ts';
import { en } from './i18n.ts';
import { localDate } from './memory-worker.ts';
import { isWav } from './voice.ts';

export const MOODS = ['great', 'good', 'okay', 'low', 'rough'] as const;
export type Mood = (typeof MOODS)[number];
/** One minute is the idea; the page stops at this, the server allows a little slack. */
export const JOURNAL_MAX_SECONDS = 60;
const MAX_WAV = 16000 * 2 * (JOURNAL_MAX_SECONDS + 10) + 4096;
export const MAX_TEXT = 4000;
const LIST = 60;

export interface JournalEntry {
  id: number;
  /** The person's own day (YYYY-MM-DD in their time zone). */
  day: string;
  at: string;
  text: string;
  mood: Mood | null;
  /** Spoken (heard on this computer) or typed. */
  spoken: boolean;
  seconds: number;
  edited: boolean;
  /** The recording was kept. */
  audio: boolean;
}

export function cleanMood(v: unknown): Mood | null {
  return (MOODS as readonly string[]).includes(String(v)) ? (v as Mood) : null;
}

/** Days in a row with an entry, ending today (or yesterday: today isn't over yet). */
export function streakOf(days: string[], today: string): number {
  const have = new Set(days);
  const step = (d: string) => {
    const t = new Date(`${d}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 1);
    return t.toISOString().slice(0, 10);
  };
  let d = have.has(today) ? today : step(today);
  let n = 0;
  while (have.has(d)) {
    n++;
    d = step(d);
  }
  return n;
}

/** Seconds of a 16-bit PCM WAV (from its header; 0 when it isn't one). */
export function wavSeconds(b: Buffer): number {
  if (!isWav(b)) return 0;
  const rate = b.readUInt32LE(24);
  const bytesPerSec = b.readUInt32LE(28) || rate * 2;
  return bytesPerSec ? Math.round(((b.length - 44) / bytesPerSec) * 10) / 10 : 0;
}

const OPEN = new Map<string, JournalBook>();

type Row = { id: number | bigint; day: string; at: string; data: Uint8Array; has: number | bigint };
type Sealed = { text: string; mood: Mood | null; spoken: boolean; seconds: number; edited: boolean };

export class JournalBook {
  readonly dir: string;
  readonly #db: DatabaseSync;
  readonly #key: Buffer;

  private constructor(spaceDir: string) {
    this.dir = join(spaceDir, 'journal');
    mkdirSync(this.dir, { recursive: true });
    const kf = join(this.dir, 'journal.key');
    if (!existsSync(kf)) writeFileSync(kf, randomBytes(32).toString('base64'), { mode: 0o600 });
    try {
      chmodSync(kf, 0o600);
    } catch {
      /* not on this system */
    }
    this.#key = Buffer.from(readFileSync(kf, 'utf8').trim(), 'base64');
    this.#db = new DatabaseSync(join(this.dir, 'journal.db'));
    this.#db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, at TEXT NOT NULL, data BLOB NOT NULL, audio BLOB); CREATE INDEX IF NOT EXISTS entries_day ON entries (day);');
  }

  /** The book in a space folder (one instance per folder in this process). */
  static open(spaceDir: string): JournalBook {
    let b = OPEN.get(spaceDir);
    if (!b) OPEN.set(spaceDir, (b = new JournalBook(spaceDir)));
    return b;
  }
  static closeFor(spaceDir: string): void {
    const b = OPEN.get(spaceDir);
    if (!b) return;
    OPEN.delete(spaceDir);
    try {
      b.#db.close();
    } catch {
      /* closed */
    }
  }

  #seal(v: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([c.update(v), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  }
  #unseal(b: Uint8Array): Buffer {
    const buf = Buffer.from(b);
    const d = createDecipheriv('aes-256-gcm', this.#key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  }
  #row(r: Row): JournalEntry {
    const s = JSON.parse(this.#unseal(r.data).toString('utf8')) as Sealed;
    return { id: Number(r.id), day: r.day, at: r.at, text: s.text, mood: cleanMood(s.mood), spoken: Boolean(s.spoken), seconds: Number(s.seconds) || 0, edited: Boolean(s.edited), audio: Boolean(Number(r.has)) };
  }
  #select(where: string, ...args: (string | number)[]): JournalEntry[] {
    const rows = this.#db.prepare(`SELECT id, day, at, data, audio IS NOT NULL AS has FROM entries ${where}`).all(...args) as unknown as Row[];
    return rows.map((r) => this.#row(r));
  }

  add(e: { text: string; mood?: Mood | null; at: Date; timeZone?: string; spoken?: boolean; seconds?: number; audio?: Buffer }): JournalEntry {
    const sealed: Sealed = { text: e.text, mood: e.mood ?? null, spoken: Boolean(e.spoken), seconds: e.seconds ?? 0, edited: false };
    const day = localDate(e.at, e.timeZone);
    const id = Number(
      this.#db.prepare('INSERT INTO entries (day, at, data, audio) VALUES (?, ?, ?, ?)').run(day, e.at.toISOString(), this.#seal(Buffer.from(JSON.stringify(sealed), 'utf8')), e.audio ? this.#seal(e.audio) : null).lastInsertRowid,
    );
    return this.get(id)!;
  }
  get(id: number): JournalEntry | undefined {
    return this.#select('WHERE id = ?', id)[0];
  }
  /** Newest first. */
  list(limit = LIST): JournalEntry[] {
    return this.#select('ORDER BY at DESC, id DESC LIMIT ?', limit);
  }
  days(): string[] {
    return (this.#db.prepare('SELECT DISTINCT day FROM entries ORDER BY day DESC LIMIT 400').all() as { day: string }[]).map((r) => r.day);
  }
  update(id: number, patch: { text?: string; mood?: Mood | null }): JournalEntry | undefined {
    const r = this.#db.prepare('SELECT data FROM entries WHERE id = ?').get(id) as { data: Uint8Array } | undefined;
    if (!r) return undefined;
    const s = JSON.parse(this.#unseal(r.data).toString('utf8')) as Sealed;
    if (patch.text !== undefined && patch.text !== s.text) {
      s.text = patch.text;
      s.edited = true;
    }
    if (patch.mood !== undefined) s.mood = patch.mood;
    this.#db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(this.#seal(Buffer.from(JSON.stringify(s), 'utf8')), id);
    return this.get(id);
  }
  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM entries WHERE id = ?').run(id).changes) > 0;
  }
  audio(id: number): Buffer | undefined {
    const r = this.#db.prepare('SELECT audio FROM entries WHERE id = ? AND audio IS NOT NULL').get(id) as { audio: Uint8Array } | undefined;
    return r ? this.#unseal(r.audio) : undefined;
  }

  /** "On this day": this day in earlier years (newest first), else this day last month. */
  onThisDay(now: Date, timeZone?: string): { kind: 'year' | 'month'; items: (JournalEntry & { years?: number })[] } | undefined {
    const today = localDate(now, timeZone);
    const [y, m, d] = today.split('-').map(Number);
    const mmdd = today.slice(5);
    const years = this.#select("WHERE substr(day, 6) = ? AND day < ? ORDER BY day DESC, at ASC LIMIT 12", mmdd, today);
    if (years.length) return { kind: 'year', items: years.map((e) => ({ ...e, years: y - Number(e.day.slice(0, 4)) })) };
    const last = new Date(Date.UTC(y, m - 2, d, 12));
    if (last.getUTCDate() !== d) return undefined; // no 31st last month
    const month = this.#select('WHERE day = ? ORDER BY at ASC LIMIT 6', last.toISOString().slice(0, 10));
    return month.length ? { kind: 'month', items: month } : undefined;
  }
}

/** The person's own folder: a member's space, or the owner's data folder (shared by her companions). */
function spaceDir(app: AppContext): string {
  if (app.member) return app.dataDir;
  return app.family?.spaceDirOf?.('owner') ?? app.dataDir;
}

export function journalFor(app: AppContext): JournalBook {
  return JournalBook.open(spaceDir(app));
}

/** Prefs (per person): keep the recording next time. */
export interface JournalPrefs {
  keepAudio: boolean;
}
function prefsFile(app: AppContext): string {
  return join(journalFor(app).dir, 'prefs.json');
}
export function journalPrefs(app: AppContext): JournalPrefs {
  try {
    const p = JSON.parse(readFileSync(prefsFile(app), 'utf8')) as Partial<JournalPrefs>;
    return { keepAudio: p.keepAudio === true };
  } catch {
    return { keepAudio: false };
  }
}

/** Hearing on this computer only, and only for a member whose voice the owner allowed. */
export function localHearing(app: AppContext): boolean {
  if (app.member && app.member.limits().voice === false) return false;
  return Boolean(app.voice?.available.stt);
}

const view = (e: JournalEntry) => e;

export async function journalRoute(app: AppContext, req: IncomingMessage, res: ServerResponse, method: string, c: string | undefined, d: string | undefined): Promise<void> {
  const book = journalFor(app);
  const tz = app.settings.get().timeZone || undefined;
  if (!c && method === 'GET') {
    const now = app.now();
    const today = localDate(now, tz);
    const days = book.days();
    const otd = book.onThisDay(now, tz);
    return send(res, 200, {
      entries: book.list().map(view),
      onThisDay: otd ?? null,
      today: days[0] === today,
      streak: streakOf(days, today),
      hearing: localHearing(app),
      prefs: journalPrefs(app),
      maxSeconds: JOURNAL_MAX_SECONDS,
      moods: MOODS,
    });
  }
  if (c === 'prefs' && method === 'PUT') {
    const body = await readJson(req);
    const prefs: JournalPrefs = { keepAudio: body.keepAudio === true };
    writeFileSync(prefsFile(app), JSON.stringify(prefs));
    return send(res, 200, { prefs });
  }
  if (!c && method === 'POST') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const type = String(req.headers['content-type'] ?? '');
    if (!type.includes('json')) {
      // Spoken: a 16 kHz WAV from the page, heard on this computer.
      const wav = await readRaw(req, MAX_WAV);
      if (!isWav(wav)) throw new HttpError(400, en('That recording could not be read. Record it again.'));
      const seconds = wavSeconds(wav);
      if (seconds > JOURNAL_MAX_SECONDS + 5) throw new HttpError(413, en('A journal entry is one minute at most.'));
      const moodRaw = q.get('mood');
      const mood = cleanMood(moodRaw);
      if (moodRaw && !mood) throw new HttpError(400, en('Pick one of the moods.'));
      if (!localHearing(app)) throw new HttpError(409, en('Hearing on this computer is not set up, so the recording was not kept. Type it instead.'), { typeInstead: true });
      let text: string;
      try {
        text = (await app.voice!.transcribe(wav)).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      } catch {
        throw new HttpError(409, en('Hearing on this computer could not hear that. Type it instead.'), { typeInstead: true });
      }
      if (!text) throw new HttpError(422, en('No words were heard. Try again a little closer to the microphone.'));
      const keep = q.get('keep') === '1';
      return send(res, 201, { entry: view(book.add({ text, mood, at: app.now(), timeZone: tz, spoken: true, seconds: Math.round(seconds), ...(keep ? { audio: wav } : {}) })) });
    }
    const body = await readJson(req);
    const text = String(body.text ?? '').trim().slice(0, MAX_TEXT);
    if (!text) throw new HttpError(400, en('Write a few words first.'));
    const mood = cleanMood(body.mood);
    if (body.mood != null && body.mood !== '' && !mood) throw new HttpError(400, en('Pick one of the moods.'));
    return send(res, 201, { entry: view(book.add({ text, mood, at: app.now(), timeZone: tz })) });
  }
  const id = Number(c);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'Not found');
  if (d === 'audio' && method === 'GET') {
    const audio = book.audio(id);
    if (!audio) throw new HttpError(404, 'Not found');
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store', ...SECURITY_HEADERS });
    return void res.end(audio);
  }
  if (!d && method === 'PATCH') {
    const body = await readJson(req);
    const patch: { text?: string; mood?: Mood | null } = {};
    if (body.text !== undefined) {
      const text = String(body.text).trim().slice(0, MAX_TEXT);
      if (!text) throw new HttpError(400, en('Write a few words first.'));
      patch.text = text;
    }
    if (body.mood !== undefined) {
      const mood = cleanMood(body.mood);
      if (body.mood !== null && body.mood !== '' && !mood) throw new HttpError(400, en('Pick one of the moods.'));
      patch.mood = mood;
    }
    const e = book.update(id, patch);
    if (!e) throw new HttpError(404, 'Not found');
    return send(res, 200, { entry: view(e) });
  }
  if (!d && method === 'DELETE') {
    if (!book.remove(id)) throw new HttpError(404, 'Not found');
    return send(res, 200, { removed: true });
  }
  throw new HttpError(404, 'Not found');
}
