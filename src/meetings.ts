// EC19 (docs/ops/EC19_DESIGN.md, docs/MEETINGS.md): meeting rooms and meeting notes. The owner starts
// a listening room inside Sara (his signed-in devices send what they hear, one utterance at a time)
// or gives her a recorded voice file (a Discord call, any meeting). Consent first: a required tick,
// a spoken and shown notice, a notice per device that joins. What is said becomes transcript lines
// (heard with his hearing engine, kept only in her store.db); she answers briefly when called by
// name, never with tools. At the end one model call writes the notes (summary, decisions, action
// items with owners and dates), kept as a Markdown document in her Library; action items reach the
// Planner only when he presses Add. Audio is dropped after hearing unless he chose to keep it.
// Policy pin `meetings: false` refuses new rooms, joins, audio and files. Discord voice itself (DAVE
// end-to-end encryption) is a follow-up; see the design.
//
// Tables (additive, her own store.db): meetings, meeting_lines.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { audit } from './audit-trail.ts';
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { anyHold, LegalHoldError } from './legal-hold.ts';
import { complete } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { parseWhen, type Task } from './planner.ts';
import { policy } from './policy-profile.ts';
import { onThisComputer } from './private-local.ts';
import { detectMinorSexualContent } from './safety.ts';
import { speechOf } from './speech.ts';
import { isWav } from './voice.ts';

export const MEETINGS = {
  maxFileBytes: 100 * 1024 * 1024,
  wholeMaxBytes: 25 * 1024 * 1024,
  maxAudioBytes: 15 * 1024 * 1024,
  pieceSec: 60,
  maxSec: 3 * 3600,
  maxReplies: 20,
  maxLines: 5000,
  lineChars: 2000,
  promptChars: 120_000,
  listMax: 30,
  itemChars: 300,
  keep: 50,
} as const;

export type MeetingStatus = 'live' | 'hearing' | 'ended' | 'writing' | 'done' | 'failed';
export interface MeetingLine {
  n: number;
  kind: 'notice' | 'said' | 'sara';
  speaker: string;
  text: string;
  at: string;
}
export interface ActionItem {
  task: string;
  owner: string;
  due: string;
  dueAt: string | null;
  taskId: number | null;
}
export interface MeetingNotes {
  summary: string;
  decisions: string[];
  actions: ActionItem[];
}
export interface Meeting {
  id: number;
  title: string;
  source: 'room' | 'file';
  status: MeetingStatus;
  keepAudio: boolean;
  announce: string;
  devices: string[];
  replies: number;
  lines: MeetingLine[];
  lineCount: number;
  notes: MeetingNotes | null;
  notesDocId: number | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
}

export class MeetingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const oneLine = (s: unknown, n: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** Was she called by name: her name in the first three words, or at the end after a comma. */
export function addressed(name: string, text: string): boolean {
  const n = fold(name.trim());
  if (!n) return false;
  const words = fold(text).match(/[\p{L}\p{N}']+/gu) ?? [];
  if (words.slice(0, 3).includes(n)) return true;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`[,;]\\s*${esc}\\s*[?!.…]*$`, 'u').test(fold(text.trim()));
}

interface WavInfo {
  fmt: Buffer;
  data: Buffer;
  byteRate: number;
  blockAlign: number;
}
function wavInfo(b: Buffer): WavInfo {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new MeetingError(400, en('That is not a WAV file Sara can read.'));
  let fmt: Buffer | undefined;
  let data: Buffer | undefined;
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString('ascii', o, o + 4);
    const size = b.readUInt32LE(o + 4);
    const body = b.subarray(o + 8, Math.min(b.length, o + 8 + size));
    if (id === 'fmt ') fmt = Buffer.from(body);
    if (id === 'data') data = body;
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.length < 16 || fmt.readUInt16LE(0) !== 1) throw new MeetingError(400, en('That is not a WAV file Sara can read.'));
  return { fmt, data, byteRate: fmt.readUInt32LE(8), blockAlign: Math.max(1, fmt.readUInt16LE(12)) };
}
function wavOf(fmt: Buffer, pcm: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(4 + 8 + fmt.length + 8 + pcm.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(fmt.length, 16);
  const dh = Buffer.alloc(8);
  dh.write('data', 0, 'ascii');
  dh.writeUInt32LE(pcm.length, 4);
  return Buffer.concat([head, fmt, dh, pcm]);
}
/** Seconds of sound in a PCM WAV. */
export const wavSeconds = (b: Buffer): number => {
  const w = wavInfo(b);
  return w.data.length / Math.max(1, w.byteRate);
};
/** A PCM WAV cut into pieces of `sec` seconds (each a WAV of its own). */
export function splitWav(b: Buffer, sec: number = MEETINGS.pieceSec): Buffer[] {
  const w = wavInfo(b);
  const step = Math.max(w.blockAlign, Math.floor((w.byteRate * sec) / w.blockAlign) * w.blockAlign);
  const out: Buffer[] = [];
  for (let o = 0; o < w.data.length; o += step) out.push(wavOf(w.fmt, w.data.subarray(o, o + step)));
  return out;
}
/** Pieces of one format joined into one WAV (a kept room recording). */
export function joinWav(parts: Buffer[]): Buffer | undefined {
  if (!parts.length) return undefined;
  const ws = parts.map(wavInfo);
  return wavOf(ws[0].fmt, Buffer.concat(ws.map((w) => w.data)));
}

/** The writer's notes, read strictly: JSON with summary, decisions and actions; capped. */
export function parseNotes(text: string): Omit<MeetingNotes, 'actions'> & { actions: Omit<ActionItem, 'dueAt' | 'taskId'>[] } {
  const raw = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new MeetingError(502, en('the notes came back unreadable'));
  }
  const list = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, MEETINGS.listMax);
  const summary = oneLine(j.summary, 2000);
  const decisions = list(j.decisions).map((d) => oneLine(d, MEETINGS.itemChars)).filter(Boolean);
  const actions = list(j.actions)
    .map((a) => (a && typeof a === 'object' ? (a as Record<string, unknown>) : {}))
    .map((a) => ({ task: oneLine(a.task, MEETINGS.itemChars), owner: oneLine(a.owner, 80), due: oneLine(a.due, 80) }))
    .filter((a) => a.task);
  if (!summary && !decisions.length && !actions.length) throw new MeetingError(502, en('the notes came back unreadable'));
  return { summary, decisions, actions };
}

type Row = Record<string, unknown>;
const AUDIO_TYPES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm' };

export class Meetings {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #replying = new Set<number>();
  readonly #stop = new AbortController();
  #closed = false;

  constructor(app: AppContext, db: DatabaseSync) {
    this.#app = app;
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
      keep_audio INTEGER NOT NULL DEFAULT 0, announce TEXT NOT NULL DEFAULT '', devices TEXT NOT NULL DEFAULT '[]',
      replies INTEGER NOT NULL DEFAULT 0, notes TEXT, notes_doc INTEGER, error TEXT, created_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE IF NOT EXISTS meeting_lines (
      meeting_id INTEGER NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (meeting_id, n));`);
    // A restart: a live room is ended (notes can still be written); a file being heard failed.
    db.prepare(`UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE status IN ('live', 'writing')`).run(this.#now());
    db.prepare(`UPDATE meetings SET status = 'failed', error = ? WHERE status = 'hearing'`).run(this.#t(en('Sara restarted while hearing the recording. Give her the file again.')));
  }

  close(): void {
    this.#closed = true;
    this.#stop.abort();
  }

  #now(): string {
    return this.#app.now().toISOString();
  }
  #t(text: string, params?: Record<string, unknown>): string {
    return trOwner(text, this.#app.settings.get(), params);
  }
  #dir(id: number): string {
    return join(this.#app.dataDir, 'meetings', String(id));
  }

  /** Why a new meeting can't start now (the policy pin, private local mode, no hearing), or null. */
  refusal(): string | null {
    if (!policy().meetingsOn) return this.#t(en('Meetings are turned off by your admin ({policy}).'), { policy: policy().get().name || 'Policy' });
    const v = speechOf(this.#app).settings();
    if (v.stt === 'off') return this.#t(en('Turn on hearing first (Settings → Voice → Speech to text).'));
    if (privateLocalOn() && !(v.stt === 'local' || (v.stt === 'openai' && onThisComputer({ kind: 'openai-compatible', baseUrl: v.openai.baseUrl })))) return this.#t(en('In private local mode Sara hears meetings only with the hearing engine on this computer (Settings → Voice).'));
    return null;
  }
  #guard(action: string, target?: number): void {
    if (!policy().meetingsOn) {
      audit({ action, role: 'owner', channel: 'web', outcome: 'refused', ...(target ? { target: String(target) } : {}), keys: ['policy'] });
      throw policy().refusal('meetings');
    }
    const why = this.refusal();
    if (why) {
      audit({ action, role: 'owner', channel: 'web', outcome: 'refused', ...(target ? { target: String(target) } : {}) });
      throw new MeetingError(409, why);
    }
  }

  list(): Meeting[] {
    return (this.#db.prepare('SELECT id FROM meetings ORDER BY id DESC').all() as Row[]).map((r) => ({ ...this.get(Number(r.id))!, lines: [] }));
  }

  get(id: number, since = 0): Meeting | undefined {
    const r = this.#db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    const lines = (this.#db.prepare('SELECT n, kind, speaker, text, at FROM meeting_lines WHERE meeting_id = ? AND n > ? ORDER BY n').all(id, since) as Row[]).map((l) => ({ n: Number(l.n), kind: String(l.kind) as MeetingLine['kind'], speaker: String(l.speaker), text: String(l.text), at: String(l.at) }));
    const count = Number((this.#db.prepare('SELECT COUNT(*) AS c FROM meeting_lines WHERE meeting_id = ?').get(id) as Row).c);
    return {
      id,
      title: String(r.title),
      source: String(r.source) as Meeting['source'],
      status: String(r.status) as MeetingStatus,
      keepAudio: Boolean(r.keep_audio),
      announce: String(r.announce),
      devices: JSON.parse(String(r.devices)) as string[],
      replies: Number(r.replies),
      lines,
      lineCount: count,
      notes: r.notes ? (JSON.parse(String(r.notes)) as MeetingNotes) : null,
      notesDocId: r.notes_doc === null ? null : Number(r.notes_doc),
      error: r.error === null ? null : String(r.error),
      createdAt: String(r.created_at),
      endedAt: r.ended_at === null ? null : String(r.ended_at),
    };
  }

  #set(id: number, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    this.#db.prepare(`UPDATE meetings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => patch[k]) as never[]), id);
  }

  #line(id: number, kind: MeetingLine['kind'], speaker: string, text: string): MeetingLine | undefined {
    const n = Number((this.#db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM meeting_lines WHERE meeting_id = ?').get(id) as Row).n) + 1;
    if (n > MEETINGS.maxLines) return undefined;
    const line: MeetingLine = { n, kind, speaker: oneLine(speaker, 40), text: oneLine(text, MEETINGS.lineChars), at: this.#now() };
    this.#db.prepare('INSERT INTO meeting_lines (meeting_id, n, kind, speaker, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, n, line.kind, line.speaker, line.text, line.at);
    return line;
  }

  #create(title: unknown, source: Meeting['source'], keepAudio: boolean, status: MeetingStatus): number {
    const name = this.#app.persona.name;
    const announce = this.#t(en("Hi everyone, I'm {name}, an AI. I'm listening and taking notes for this meeting."), { name });
    const t = oneLine(title, 120) || this.#t(en('Meeting'));
    const id = Number(this.#db.prepare('INSERT INTO meetings (title, source, status, keep_audio, announce, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(t, source, status, keepAudio ? 1 : 0, announce, this.#now()).lastInsertRowid);
    this.#line(id, 'notice', name, announce);
    this.#prune();
    return id;
  }

  #prune(): void {
    const old = this.#db.prepare(`SELECT id FROM meetings WHERE status IN ('done', 'failed', 'ended') ORDER BY id DESC LIMIT -1 OFFSET ?`).all(MEETINGS.keep) as Row[];
    if (anyHold()) return;
    for (const r of old) this.#forget(Number(r.id));
  }

  /** Start a listening room (owner only; the routes check that). */
  start(input: { title?: unknown; consent?: unknown; keepAudio?: unknown }): Meeting {
    this.#guard('meeting.start');
    if (input.consent !== true) throw new MeetingError(400, this.#t(en('Tick that everyone in the room knows Sara will listen and take notes.')));
    const id = this.#create(input.title, 'room', input.keepAudio === true, 'live');
    audit({ action: 'meeting.start', role: 'owner', channel: 'web', target: String(id), keys: ['room', ...(input.keepAudio === true ? ['keepAudio'] : [])] });
    return this.get(id)!;
  }

  /** One of his devices joins the room: a notice everyone sees, an audit row. */
  join(id: number, input: { device?: unknown }): Meeting {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    if (m.status !== 'live') throw new MeetingError(409, this.#t(en('This meeting has ended.')));
    this.#guard('meeting.join', id);
    const device = oneLine(input.device, 40) || this.#t(en('A device'));
    if (!m.devices.includes(device)) this.#set(id, { devices: JSON.stringify([...m.devices, device].slice(-20)) });
    this.#line(id, 'notice', this.#app.persona.name, this.#t(en('{device} joined. {name} is listening and taking notes.'), { device, name: this.#app.persona.name }));
    audit({ action: 'meeting.join', role: 'owner', channel: 'web', target: String(id) });
    return this.get(id)!;
  }

  /** One utterance from a device in the room: heard, added, and answered when she was called. */
  hear(id: number, input: { speaker?: unknown; audio: Buffer }): Promise<{ line?: MeetingLine; reply?: MeetingLine }> {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    if (m.status !== 'live') throw new MeetingError(409, this.#t(en('This meeting has ended.')));
    this.#guard('meeting.audio', id);
    if (!input.audio.length || input.audio.length > MEETINGS.maxAudioBytes) throw new MeetingError(413, en('That piece of sound is too long.'));
    return this.#hear(m, oneLine(input.speaker, 40) || this.#t(en('Someone')), input.audio);
  }

  async #hear(m: Meeting, speaker: string, audio: Buffer): Promise<{ line?: MeetingLine; reply?: MeetingLine }> {
    let words: string;
    try {
      words = (await speechOf(this.#app).transcribe(audio)).trim();
    } catch (err) {
      throw new MeetingError(400, (err as Error).message);
    }
    if (m.keepAudio && isWav(audio)) {
      mkdirSync(this.#dir(m.id), { recursive: true });
      writeFileSync(join(this.#dir(m.id), `${String(Date.now()).padStart(14, '0')}-${Math.random().toString(36).slice(2, 6)}.wav`), audio);
    }
    if (!words || this.get(m.id)?.status !== 'live') return {};
    const blocked = detectMinorSexualContent(words);
    const line = this.#line(m.id, 'said', speaker, blocked ? this.#t(en('(Left out by the safety check.)')) : words);
    if (!line || blocked || !addressed(this.#app.persona.name, words)) return { line };
    const cur = this.get(m.id)!;
    if (cur.replies >= MEETINGS.maxReplies || this.#replying.has(m.id)) return { line };
    this.#replying.add(m.id);
    this.#set(m.id, { replies: cur.replies + 1 });
    try {
      const name = this.#app.persona.name;
      const said = this.#transcript(m.id, 40 * 300);
      const out = await complete(this.#app, this.#conv(), [
        { role: 'system', content: `You are ${name}, an AI, in a meeting, listening and taking notes. Someone just spoke to you. Answer in at most two short sentences, in the language they used, from what was said in the meeting. You can't use tools or do things during a meeting: tasks and decisions go into the notes at the end.` },
        { role: 'user', content: `The meeting so far:\n${said}\n\nAnswer the last line that speaks to you.` },
      ], 200, 'quick', this.#stop.signal);
      const reply = oneLine(out.replace(/\*[^*]{1,40}\*/g, ''), 500);
      if (!reply || detectMinorSexualContent(reply) || this.get(m.id)?.status !== 'live') return { line };
      return { line, reply: this.#line(m.id, 'sara', name, reply) };
    } catch (err) {
      if (!this.#closed) console.warn(`meetings: the answer failed: ${(err as Error).message}`);
      return { line };
    } finally {
      this.#replying.delete(m.id);
    }
  }

  #transcript(id: number, maxChars: number = MEETINGS.promptChars): string {
    const rows = this.get(id)!.lines.filter((l) => l.kind !== 'notice').map((l) => `${l.speaker}: ${l.text}`);
    let out = '';
    for (let i = rows.length - 1; i >= 0; i--) {
      if (out.length + rows[i].length + 1 > maxChars) break;
      out = `${rows[i]}\n${out}`;
    }
    return out.trim();
  }

  #conv() {
    const store = this.#app.store;
    return store.listConversations().find((c) => !c.partner && !c.private) ?? store.createConversation({ title: 'Meetings' });
  }

  /** Notes from a recorded voice file: heard in the background, then written. */
  fromFile(input: { title?: unknown; consent?: unknown; keepAudio?: unknown; name?: unknown; bytes: Buffer }): Meeting {
    this.#guard('meeting.file');
    if (input.consent !== true) throw new MeetingError(400, this.#t(en('Tick that everyone in this recording knew it was recorded and agreed to notes.')));
    const bytes = input.bytes;
    if (!bytes.length) throw new MeetingError(400, en('That file is empty.'));
    if (bytes.length > MEETINGS.maxFileBytes) throw new MeetingError(413, en('Recordings can be up to 100 MB.'));
    const wav = isWav(bytes);
    if (wav && wavSeconds(bytes) > MEETINGS.maxSec) throw new MeetingError(413, en('Recordings can be up to 3 hours.'));
    if (!wav && bytes.length > MEETINGS.wholeMaxBytes) throw new MeetingError(413, en('Files other than WAV can be up to 25 MB. Save it as WAV, or a shorter piece.'));
    const ext = wav ? 'wav' : (/\.(mp3|ogg|opus|m4a|webm)$/i.exec(String(input.name ?? ''))?.[1].toLowerCase() ?? 'mp3');
    const keep = input.keepAudio === true;
    const id = this.#create(input.title, 'file', keep, 'hearing');
    if (keep) {
      mkdirSync(this.#dir(id), { recursive: true });
      writeFileSync(join(this.#dir(id), `recording.${ext}`), bytes);
    }
    audit({ action: 'meeting.file', role: 'owner', channel: 'web', target: String(id), keys: keep ? ['keepAudio'] : [] });
    void this.#hearFile(id, wav ? splitWav(bytes) : [bytes]);
    return this.get(id)!;
  }

  async #hearFile(id: number, pieces: Buffer[]): Promise<void> {
    const speaker = this.#t(en('Recording'));
    try {
      for (const p of pieces) {
        if (this.#closed) return;
        const words = (await speechOf(this.#app).transcribe(p)).trim();
        if (words) this.#line(id, 'said', speaker, detectMinorSexualContent(words) ? this.#t(en('(Left out by the safety check.)')) : words);
      }
    } catch (err) {
      if (this.#closed) return;
      this.#set(id, { status: 'failed', error: (err as Error).message, ended_at: this.#now() });
      return;
    }
    if (this.#closed) return;
    this.#set(id, { status: 'writing', ended_at: this.#now() });
    await this.#write(id);
  }

  /** End the room and write the notes. */
  end(id: number): Meeting {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    if (m.status !== 'live') throw new MeetingError(409, this.#t(en('This meeting has ended.')));
    this.#line(id, 'notice', this.#app.persona.name, this.#t(en('The meeting ended. {name} stopped listening.'), { name: this.#app.persona.name }));
    this.#set(id, { status: 'writing', ended_at: this.#now() });
    audit({ action: 'meeting.end', role: 'owner', channel: 'web', target: String(id) });
    void this.#write(id);
    return this.get(id)!;
  }

  /** Write the notes (again). */
  writeNotes(id: number): Meeting {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    if (!['ended', 'failed', 'done'].includes(m.status)) throw new MeetingError(409, this.#t(en('The notes are written when the meeting ends.')));
    this.#set(id, { status: 'writing', error: null });
    void this.#write(id);
    return this.get(id)!;
  }

  async #write(id: number): Promise<void> {
    const m = this.get(id)!;
    const said = this.#transcript(id);
    try {
      if (!said) throw new MeetingError(409, this.#t(en('nothing was heard')));
      const out = await complete(this.#app, this.#conv(), [
        { role: 'system', content: 'You write meeting notes from a transcript. Answer with JSON only: {"summary": "3 to 6 sentences", "decisions": ["each decision made"], "actions": [{"task": "what to do", "owner": "the person as named, or empty", "due": "the day or date as said, or empty"}]}. Only what was said: never invent owners, dates or decisions. Write in the language of the transcript.' },
        { role: 'user', content: `Meeting: ${m.title}\nDate: ${m.createdAt.slice(0, 10)}\n\nTranscript:\n${said}` },
      ], 1500, 'writing', this.#stop.signal);
      if (this.#closed) return;
      const p = parseNotes(out);
      const s = this.#app.settings.get();
      const day = new Date(m.createdAt);
      const notes: MeetingNotes = { summary: p.summary, decisions: p.decisions, actions: p.actions.map((a) => ({ ...a, dueAt: a.due ? (parseWhen(a.due, day, s.timeZone, { dateOnlyHour: 17 })?.toISOString() ?? null) : null, taskId: null })) };
      let doc: number | null = null;
      const lib = this.#app.library;
      if (lib) {
        const name = `Meeting notes - ${m.title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 100)} - ${m.createdAt.slice(0, 10)}.md`;
        doc = lib.add({ name, bytes: Buffer.from(this.markdown({ ...m, notes }), 'utf8'), keep: true, origin: 'library', learn: false }).id;
      }
      this.#set(id, { status: 'done', notes: JSON.stringify(notes), notes_doc: doc, error: null });
      audit({ action: 'meeting.notes', role: 'owner', channel: 'web', target: String(id) });
    } catch (err) {
      if (this.#closed) return;
      this.#set(id, { status: 'failed', error: this.#t(en('The notes could not be written ({why}). Press Write the notes to try again.'), { why: (err as Error).message }) });
      audit({ action: 'meeting.notes', role: 'owner', channel: 'web', target: String(id), outcome: 'failed' });
    }
  }

  /** The notes as Markdown (headings in his language; English data stays as said). */
  markdown(m: Pick<Meeting, 'title' | 'createdAt' | 'source' | 'devices'> & { notes: MeetingNotes }): string {
    const t = (x: string, p?: Record<string, unknown>) => this.#t(x, p);
    const n = m.notes;
    const items = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${t(en('None'))}`);
    const acts = n.actions.length ? n.actions.map((a) => `- [ ] ${[a.task, a.owner || t(en('Not said')), a.due].filter(Boolean).join(' · ')}`).join('\n') : `- ${t(en('None'))}`;
    const from = m.source === 'file' ? t(en('From a recording')) : t(en('A meeting room in Sara'));
    return `# ${m.title}\n\n${m.createdAt.slice(0, 10)} · ${from}\n\n## ${t(en('Summary'))}\n\n${n.summary || t(en('None'))}\n\n## ${t(en('Decisions'))}\n\n${items(n.decisions)}\n\n## ${t(en('Action items'))}\n\n${acts}\n`;
  }

  /** His approval: the action items he picked become Planner to-dos (each once). */
  addTodos(id: number, items: unknown): Task[] {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    if (!m.notes) throw new MeetingError(409, this.#t(en('The notes are not written yet.')));
    const planner = this.#app.planner;
    if (!planner) throw new MeetingError(409, en('The Planner is not available here.'));
    const picks = [...new Set((Array.isArray(items) ? items : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < m.notes!.actions.length))];
    const added: Task[] = [];
    for (const i of picks) {
      const a = m.notes.actions[i];
      if (a.taskId) continue;
      const task = planner.addTask({ title: a.task, notes: this.#t(en('From the meeting "{title}" ({date}). Owner: {owner}.'), { title: m.title, date: m.createdAt.slice(0, 10), owner: a.owner || this.#t(en('Not said')) }), dueAt: a.dueAt });
      a.taskId = task.id;
      added.push(task);
    }
    if (added.length) {
      this.#set(id, { notes: JSON.stringify(m.notes) });
      audit({ action: 'meeting.todos', role: 'owner', channel: 'web', target: String(id), keys: added.map(() => 'task') });
    }
    return added;
  }

  /** The kept recording, if he chose to keep it. */
  recording(id: number): { bytes: Buffer; type: string; ext: string } | undefined {
    const dir = this.#dir(id);
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir).sort();
    const whole = files.find((f) => f.startsWith('recording.'));
    if (whole) {
      const ext = whole.slice('recording.'.length);
      return { bytes: readFileSync(join(dir, whole)), type: AUDIO_TYPES[ext] ?? 'application/octet-stream', ext };
    }
    const bytes = joinWav(files.filter((f) => f.endsWith('.wav')).map((f) => readFileSync(join(dir, f))));
    return bytes ? { bytes, type: 'audio/wav', ext: 'wav' } : undefined;
  }

  #forget(id: number): void {
    this.#db.prepare('DELETE FROM meeting_lines WHERE meeting_id = ?').run(id);
    this.#db.prepare('DELETE FROM meetings WHERE id = ?').run(id);
    rmSync(this.#dir(id), { recursive: true, force: true });
  }

  /** Forget a meeting: its transcript and recording (the Library notes stay). */
  delete(id: number): boolean {
    if (!this.get(id)) return false;
    if (anyHold()) {
      audit({ action: 'meeting.delete', role: 'owner', channel: 'web', target: String(id), outcome: 'refused' });
      throw new LegalHoldError();
    }
    this.#forget(id);
    audit({ action: 'meeting.delete', role: 'owner', channel: 'web', target: String(id) });
    return true;
  }
}
