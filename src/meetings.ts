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
// S2 (docs/MEETINGS.md) adds: uploads in parts (any format, turned into WAV pieces in the browser;
// the desktop app's stereo recording, mic left and computer sound right), speakers told apart by
// channel or by pauses and pitch (src/meeting-audio.ts; Speaker 1/2, renamable), a time on each line,
// open questions, the calendar event the meeting matches, follow-up email drafts per attendee group
// that wait for the owner (never sent on their own), a Today tile and the meeting_list /
// meeting_summarize tools. Hearing is local first: a cloud engine only when he allowed it for meetings.
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
import { allEvents, calendarSources, type LabeledEvent } from './mail/calendars.ts';
import { cutWav, diarize, diarizeByVoice, pcmSeconds, readPcm } from './meeting-audio.ts';
import type { SpeakerEngine } from './speaker-addon.ts';
import { privateLocalOn } from './net-guard.ts';
import { parseWhen, type Task } from './planner.ts';
import { policy } from './policy-profile.ts';
import { onThisComputer } from './private-local.ts';
import { detectMinorSexualContent } from './safety.ts';
import { speechOf } from './speech.ts';
import { hearLang, isWav } from './voice.ts';

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
  /** S2: one uploaded part (the browser sends about 10 minutes of 16 kHz WAV each). */
  partBytes: 48 * 1024 * 1024,
  maxParts: 60,
  draftGroups: 4,
  groupSize: 20,
  tileDays: 7,
} as const;

/** S2: a follow-up email waiting for the owner (sent or saved only when he presses it). */
export interface FollowUp {
  group: string;
  to: string[];
  subject: string;
  body: string;
  status: 'waiting' | 'sent' | 'saved' | 'dismissed';
  at: string | null;
}
export interface MeetingEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  attendees: string[];
  account?: string;
}
export interface MeetingsOptions {
  /** Calendar events between two times (all accounts); tests pass a fake. */
  events?: (from: Date, to: Date) => Promise<(Pick<LabeledEvent, 'id' | 'title' | 'start' | 'end' | 'allDay' | 'attendees' | 'account'>)[]>;
  /** U3.13: the speaker add-on (src/speaker-addon.ts): speakers by voice print; tests pass a fake. */
  speakers?: SpeakerEngine;
}

export type MeetingStatus = 'live' | 'hearing' | 'ended' | 'writing' | 'done' | 'failed';
export interface MeetingLine {
  n: number;
  kind: 'notice' | 'said' | 'sara';
  speaker: string;
  text: string;
  at: string;
  /** S2: seconds from the start of the recording (or of the room). */
  t?: number;
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
  /** S2: questions left open. */
  questions?: string[];
  /** S2: the calendar event at the meeting's time, if one matched. */
  event?: MeetingEvent;
  /** S2: follow-up emails per attendee group, waiting for the owner. */
  drafts?: FollowUp[];
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
  /** S2: an upload in parts: how many, how many heard, and how the channels are meant. */
  parts: number;
  got: number;
  channels: 'speakers' | 'mixed' | '';
  /** S2: when the recording started (the desktop app, or the file's time), else null. */
  startedAt: string | null;
  /** S2: seconds of sound heard so far. */
  seconds: number;
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
  const questions = list(j.questions).map((d) => oneLine(d, MEETINGS.itemChars)).filter(Boolean);
  if (!summary && !decisions.length && !actions.length) throw new MeetingError(502, en('the notes came back unreadable'));
  return { summary, decisions, actions, questions };
}

const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|gmx|web|mail)\.[a-z.]+$/;
/** S2: attendees grouped by organisation (their mail domain; free-mail addresses each on their own). */
export function attendeeGroups(attendees: string[], own: string[]): { group: string; to: string[] }[] {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const groups = new Map<string, string[]>();
  for (const raw of attendees) {
    const a = raw.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) || mine.has(a)) continue;
    const domain = a.split('@')[1];
    const key = FREE_MAIL.test(domain) ? a : domain;
    const g = groups.get(key) ?? [];
    if (!g.includes(a) && g.length < MEETINGS.groupSize) g.push(a);
    groups.set(key, g);
  }
  return [...groups].slice(0, MEETINGS.draftGroups).map(([group, to]) => ({ group, to }));
}

type Row = Record<string, unknown>;
const AUDIO_TYPES: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', webm: 'audio/webm' };

export class Meetings {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #replying = new Set<number>();
  readonly #stop = new AbortController();
  readonly #opts: MeetingsOptions;
  /** S2: each upload's parts are heard one after another. */
  readonly #chains = new Map<number, Promise<void>>();
  #closed = false;

  constructor(app: AppContext, db: DatabaseSync, opts: MeetingsOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#opts = opts;
    db.exec(`CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
      keep_audio INTEGER NOT NULL DEFAULT 0, announce TEXT NOT NULL DEFAULT '', devices TEXT NOT NULL DEFAULT '[]',
      replies INTEGER NOT NULL DEFAULT 0, notes TEXT, notes_doc INTEGER, error TEXT, created_at TEXT NOT NULL, ended_at TEXT);
    CREATE TABLE IF NOT EXISTS meeting_lines (
      meeting_id INTEGER NOT NULL, n INTEGER NOT NULL, kind TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY (meeting_id, n));`);
    // S2 columns (additive).
    const has = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)));
    const mc = has('meetings');
    for (const [c, def] of [['parts', 'INTEGER NOT NULL DEFAULT 0'], ['got', 'INTEGER NOT NULL DEFAULT 0'], ['channels', "TEXT NOT NULL DEFAULT ''"], ['started_at', 'TEXT'], ['seconds', 'REAL NOT NULL DEFAULT 0'], ['voices', "TEXT NOT NULL DEFAULT '[]'"]] as const)
      if (!mc.has(c)) db.exec(`ALTER TABLE meetings ADD COLUMN ${c} ${def}`);
    if (!has('meeting_lines').has('t')) db.exec('ALTER TABLE meeting_lines ADD COLUMN t REAL');
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
    if (!this.#localEngine() && v.stt === 'openai' && !onThisComputer({ kind: 'openai-compatible', baseUrl: v.openai.baseUrl }) && !this.prefs().cloud) return this.#cloudRefusal();
    return null;
  }

  /** S2: Settings → Voice → Meetings (remind me to tell everyone; let a cloud engine hear meetings; U3.13 better speaker separation). */
  prefs(): { remind: boolean; cloud: boolean; speakers: boolean } {
    const p = (this.#app.settings.get() as { meetings?: { remind?: unknown; cloud?: unknown; speakers?: unknown } }).meetings ?? {};
    return { remind: p.remind !== false, cloud: p.cloud === true, speakers: p.speakers !== false };
  }
  /** U3.13: the speaker add-on's state (null: this server has none). */
  speakerAddon(): (ReturnType<SpeakerEngine['status']> & { on: boolean }) | null {
    const e = this.#opts.speakers;
    return e ? { ...e.status(), on: this.prefs().speakers } : null;
  }
  /** U3.13: Settings → Download now / Remove. */
  speakerAddonAction(action: unknown): ReturnType<Meetings['speakerAddon']> {
    const e = this.#opts.speakers;
    if (!e) throw new MeetingError(404, en('This server has no speaker add-on.'));
    if (action === 'install') e.ensure();
    else if (action === 'remove') e.remove();
    else throw new MeetingError(400, en('Unknown action.'));
    audit({ action: `meeting.speakers.${action}`, role: 'owner', channel: 'web' });
    return this.speakerAddon();
  }
  #cloudRefusal(): string {
    return this.#t(en('Meetings are heard on this computer unless you allow a cloud engine (Grok voice or a speech API): Settings → Voice → Meetings.'));
  }
  /** A hearing engine on this server (the installed local one). */
  #localEngine(): boolean {
    const v = this.#app.voice as { available?: { stt?: boolean } } | undefined;
    return Boolean(v) && v!.available?.stt !== false;
  }
  /** Local first: the engine on this server for WAV; a cloud engine only when he allowed it. */
  async #transcribe(audio: Buffer): Promise<string> {
    const v = speechOf(this.#app).settings();
    const wav = isWav(audio);
    // W0.3: in the owner's language (es/fr/de/pt/it through the multilingual streaming model when installed; captions follow).
    if (wav && this.#localEngine() && v.stt !== 'off') return (await this.#app.voice!.transcribe(audio, { lang: hearLang(this.#app.settings.get()) })).trim();
    const local = v.stt === 'openai' ? onThisComputer({ kind: 'openai-compatible', baseUrl: v.openai.baseUrl }) : v.stt === 'local' && wav;
    if (!local && v.stt !== 'off' && !this.prefs().cloud) throw new MeetingError(409, this.#cloudRefusal());
    return (await speechOf(this.#app).transcribe(audio)).trim();
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
    const lines = (this.#db.prepare('SELECT n, kind, speaker, text, at, t FROM meeting_lines WHERE meeting_id = ? AND n > ? ORDER BY n').all(id, since) as Row[]).map((l) => ({ n: Number(l.n), kind: String(l.kind) as MeetingLine['kind'], speaker: String(l.speaker), text: String(l.text), at: String(l.at), ...(l.t === null || l.t === undefined ? {} : { t: Math.round(Number(l.t) * 10) / 10 }) }));
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
      parts: Number(r.parts ?? 0),
      got: Number(r.got ?? 0),
      channels: (String(r.channels ?? '') as Meeting['channels']),
      startedAt: r.started_at ? String(r.started_at) : null,
      seconds: Math.round(Number(r.seconds ?? 0)),
    };
  }

  #set(id: number, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    this.#db.prepare(`UPDATE meetings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(keys.map((k) => patch[k]) as never[]), id);
  }

  #line(id: number, kind: MeetingLine['kind'], speaker: string, text: string, t?: number): MeetingLine | undefined {
    const n = Number((this.#db.prepare('SELECT COALESCE(MAX(n), 0) AS n FROM meeting_lines WHERE meeting_id = ?').get(id) as Row).n) + 1;
    if (n > MEETINGS.maxLines) return undefined;
    // A room's line: seconds since it started.
    const at = t ?? Math.max(0, (this.#app.now().getTime() - Date.parse(String((this.#db.prepare('SELECT created_at FROM meetings WHERE id = ?').get(id) as Row | undefined)?.created_at ?? ''))) / 1000);
    const line: MeetingLine = { n, kind, speaker: oneLine(speaker, 40), text: oneLine(text, MEETINGS.lineChars), at: this.#now(), ...(Number.isFinite(at) ? { t: Math.round(at * 10) / 10 } : {}) };
    this.#db.prepare('INSERT INTO meeting_lines (meeting_id, n, kind, speaker, text, at, t) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, n, line.kind, line.speaker, line.text, line.at, line.t ?? null);
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
      words = await this.#transcribe(audio);
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
    const ext = wav ? 'wav' : (/\.(mp3|ogg|opus|m4a|webm|mp4)$/i.exec(String(input.name ?? ''))?.[1].toLowerCase() ?? 'mp3');
    const keep = input.keepAudio === true;
    const id = this.#create(input.title, 'file', keep, 'hearing');
    this.#set(id, { parts: 1, channels: 'mixed' });
    if (keep) {
      mkdirSync(this.#dir(id), { recursive: true });
      writeFileSync(join(this.#dir(id), `recording.${ext}`), bytes);
    }
    audit({ action: 'meeting.file', role: 'owner', channel: 'web', target: String(id), keys: keep ? ['keepAudio'] : [] });
    this.#queue(id, () => (wav ? this.#hearPart(id, bytes) : this.#hearWhole(id, bytes)));
    return this.get(id)!;
  }

  /**
   * S2: an upload in parts (the browser turns any recording into WAV pieces of about ten minutes;
   * the desktop app's stereo recording keeps the microphone left and the computer's sound right).
   */
  upload(input: { title?: unknown; consent?: unknown; keepAudio?: unknown; name?: unknown; parts?: unknown; channels?: unknown; startedAt?: unknown; seconds?: unknown }): Meeting {
    this.#guard('meeting.file');
    if (input.consent !== true) throw new MeetingError(400, this.#t(en('Tick that everyone in this recording knew it was recorded and agreed to notes.')));
    const parts = Number(input.parts);
    if (!Number.isInteger(parts) || parts < 1 || parts > MEETINGS.maxParts) throw new MeetingError(400, en('Recordings can be up to 3 hours.'));
    if (Number(input.seconds) > MEETINGS.maxSec + 60) throw new MeetingError(413, en('Recordings can be up to 3 hours.'));
    const keep = input.keepAudio === true;
    const started = typeof input.startedAt === 'string' && !Number.isNaN(Date.parse(input.startedAt)) ? new Date(input.startedAt).toISOString() : null;
    const id = this.#create(input.title, 'file', keep, 'hearing');
    this.#set(id, { parts, channels: input.channels === 'speakers' ? 'speakers' : 'mixed', started_at: started });
    audit({ action: 'meeting.file', role: 'owner', channel: 'web', target: String(id), keys: ['parts', ...(keep ? ['keepAudio'] : [])] });
    return this.get(id)!;
  }

  /** S2: one part of an upload (a WAV), heard after the parts before it. */
  async part(id: number, index: number, bytes: Buffer): Promise<{ received: number }> {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    if (m.status !== 'hearing' || !m.parts) throw new MeetingError(409, this.#t(en('This meeting has ended.')));
    this.#guard('meeting.file', id);
    if (!bytes.length || bytes.length > MEETINGS.partBytes) throw new MeetingError(413, en('That piece of sound is too long.'));
    if (!isWav(bytes)) throw new MeetingError(400, en('That is not a WAV file Sara can read.'));
    const seen = this.#received.get(id) ?? new Set<number>();
    if (!Number.isInteger(index) || index < 0 || index >= m.parts || seen.has(index)) throw new MeetingError(409, en('That part was already sent.'));
    seen.add(index);
    this.#received.set(id, seen);
    if (m.keepAudio) {
      mkdirSync(this.#dir(id), { recursive: true });
      writeFileSync(join(this.#dir(id), `part-${String(index).padStart(4, '0')}.wav`), bytes);
    }
    this.#queue(id, () => this.#hearPart(id, bytes));
    return { received: seen.size };
  }
  readonly #received = new Map<number, Set<number>>();

  #queue(id: number, job: () => Promise<void>): void {
    const run = (this.#chains.get(id) ?? Promise.resolve()).then(async () => {
      const m = this.get(id);
      if (this.#closed || !m || m.status !== 'hearing') return;
      try {
        await job();
      } catch (err) {
        if (this.#closed) return;
        this.#set(id, { status: 'failed', error: (err as Error).message, ended_at: this.#now() });
        this.#received.delete(id);
        return;
      }
      const got = (this.get(id)?.got ?? 0) + 1;
      this.#set(id, { got });
      if (got >= m.parts && !this.#closed) {
        this.#received.delete(id);
        this.#set(id, { status: 'writing', ended_at: this.#now() });
        await this.#write(id);
      }
    });
    this.#chains.set(id, run);
    void run.finally(() => {
      if (this.#chains.get(id) === run) this.#chains.delete(id);
    });
  }

  /** A WAV part: speakers told apart (channel or pauses), each turn heard, a line with its time. */
  async #hearPart(id: number, bytes: Buffer): Promise<void> {
    const m = this.get(id)!;
    let pcm;
    try {
      pcm = readPcm(bytes);
    } catch {
      throw new MeetingError(400, en('That is not a WAV file Sara can read.'));
    }
    const offset = Number((this.#db.prepare('SELECT seconds FROM meetings WHERE id = ?').get(id) as Row).seconds) || 0;
    const stored = JSON.parse(String((this.#db.prepare('SELECT voices FROM meetings WHERE id = ?').get(id) as Row).voices || '[]')) as number[] | { prints: number[][] };
    const label = (n: number) => this.#t(en('Speaker {n}'), { n: n + 1 });
    const notice = (text: string, t: number) => this.#line(id, 'notice', this.#app.persona.name, text, t);
    // U3.13: by voice print when the add-on is ready (never for the desktop app's stereo, never
    // switching ways in the middle of one upload); else S2's channel or pauses-and-pitch way.
    let d: { segments: { start: number; end: number; speaker: number }[]; centers: number[] | { prints: number[][] } } | undefined;
    const pitchSoFar = Array.isArray(stored) && stored.length > 0;
    const engine = m.channels !== 'speakers' && !pitchSoFar && this.prefs().speakers ? this.#opts.speakers : undefined;
    const state = engine?.status().state;
    if (engine && state === 'ready') {
      try {
        const v = await diarizeByVoice(pcm, (x, w) => engine.prints(x, w), Array.isArray(stored) ? [] : stored.prints);
        if (Array.isArray(stored)) notice(this.#t(en('Speakers are told apart by their voices, on this computer (up to 8). Rename them with the names above the transcript.')), offset);
        const said = new Set<string>();
        for (const g of v.merges) {
          const text = g.why === 'too-many' ? this.#t(en('More than 8 voices: extra voices were added to the most alike speaker, {who}.'), { who: label(g.into) }) : this.#t(en('{who} may be two people with very alike voices, kept as one. Rename the speaker if you know who it was.'), { who: label(g.into) });
          if (!said.has(text)) said.add(text), notice(text, offset);
        }
        d = { segments: v.segments, centers: { prints: v.centers.map((c) => c.map((x) => Math.round(x * 1e4) / 1e4)) } };
      } catch {
        notice(this.#t(en('The speaker add-on stopped, so this part was split by pauses and pitch (at most two voices).')), offset);
      }
    } else if (engine && (state === 'missing' || state === 'installing' || state === 'failed') && Array.isArray(stored)) {
      engine.ensure();
      if (engine.status().state === 'installing') notice(this.#t(en('Better speaker separation is downloading (about {mb} MB). This recording is split by pauses and pitch (at most two voices); the next one uses it.'), { mb: engine.status().mb }), offset);
    }
    if (!d) {
      const p = diarize(pcm, { byChannel: m.channels === 'speakers', centers: Array.isArray(stored) ? stored : [] });
      d = { segments: p.segments, centers: p.centers };
    }
    const say = (speaker: string, words: string, t: number) => {
      if (words) this.#line(id, 'said', speaker, detectMinorSexualContent(words) ? this.#t(en('(Left out by the safety check.)')) : words, t);
    };
    if (d.segments.length) {
      for (const s of d.segments) {
        if (this.#closed) return;
        say(label(s.speaker), await this.#transcribe(cutWav(pcm, s.start, s.end)), offset + s.start);
      }
    } else {
      // Nothing that looks like speech by loudness: heard in plain pieces, so nothing is lost.
      const pieces = splitWav(bytes);
      for (let i = 0; i < pieces.length; i++) {
        if (this.#closed) return;
        say(label(0), await this.#transcribe(pieces[i]), offset + i * MEETINGS.pieceSec);
      }
    }
    const total = offset + pcmSeconds(pcm);
    if (total > MEETINGS.maxSec + 60) throw new MeetingError(413, en('Recordings can be up to 3 hours.'));
    this.#set(id, { seconds: total, voices: JSON.stringify(d.centers) });
  }

  /** A compressed file sent whole (the old way in): one engine call, one speaker. */
  async #hearWhole(id: number, bytes: Buffer): Promise<void> {
    const words = await this.#transcribe(bytes);
    if (words) this.#line(id, 'said', this.#t(en('Speaker {n}'), { n: 1 }), detectMinorSexualContent(words) ? this.#t(en('(Left out by the safety check.)')) : words, 0);
  }

  /** S2: rename a speaker label everywhere in the transcript (and as an action item's owner). */
  rename(id: number, from: unknown, to: unknown): Meeting {
    const m = this.get(id);
    if (!m) throw new MeetingError(404, en('Not found'));
    const a = oneLine(from, 40);
    const b = oneLine(to, 40);
    if (!a || !b) throw new MeetingError(400, this.#t(en('Give the new name.')));
    this.#db.prepare(`UPDATE meeting_lines SET speaker = ? WHERE meeting_id = ? AND speaker = ? AND kind = 'said'`).run(b, id, a);
    if (m.notes) {
      for (const x of m.notes.actions) if (x.owner === a) x.owner = b;
      this.#set(id, { notes: JSON.stringify(m.notes) });
    }
    audit({ action: 'meeting.rename', role: 'owner', channel: 'web', target: String(id) });
    return this.get(id)!;
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
        { role: 'system', content: 'You write meeting notes from a transcript. Answer with JSON only: {"summary": "3 to 6 sentences", "decisions": ["each decision made"], "actions": [{"task": "what to do", "owner": "the person as named (or their speaker label), or empty", "due": "the day or date as said, or empty"}], "questions": ["each question left open"]}. Only what was said: never invent owners, dates or decisions. Write in the language of the transcript.' },
        { role: 'user', content: `Meeting: ${m.title}\nDate: ${(m.startedAt ?? m.createdAt).slice(0, 10)}\n\nTranscript:\n${said}` },
      ], 1500, 'writing', this.#stop.signal);
      if (this.#closed) return;
      const p = parseNotes(out);
      const s = this.#app.settings.get();
      const day = new Date(m.startedAt ?? m.createdAt);
      const notes: MeetingNotes = { summary: p.summary, decisions: p.decisions, actions: p.actions.map((a) => ({ ...a, dueAt: a.due ? (parseWhen(a.due, day, s.timeZone, { dateOnlyHour: 17 })?.toISOString() ?? null) : null, taskId: null })), questions: p.questions };
      const event = m.notes?.event ?? (await this.#findEvent(m));
      if (event) notes.event = event;
      if (this.#closed) return;
      const drafts = m.notes?.drafts?.length ? m.notes.drafts : event ? await this.#followUps(m, notes, event) : [];
      if (drafts.length) notes.drafts = drafts;
      if (this.#closed) return;
      let doc: number | null = null;
      const lib = this.#app.library;
      if (lib) {
        const name = `Meeting notes - ${m.title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 100)} - ${m.createdAt.slice(0, 10)}.md`;
        doc = lib.add({ name, bytes: Buffer.from(this.markdown({ ...m, notes }), 'utf8'), keep: true, origin: 'library', learn: false }).id;
      }
      this.#set(id, { status: 'done', notes: JSON.stringify(notes), notes_doc: doc, error: null });
      audit({ action: 'meeting.notes', role: 'owner', channel: 'web', target: String(id), ...(drafts.length ? { keys: ['drafts'] } : {}) });
    } catch (err) {
      if (this.#closed) return;
      this.#set(id, { status: 'failed', error: this.#t(en('The notes could not be written ({why}). Press Write the notes to try again.'), { why: (err as Error).message }) });
      audit({ action: 'meeting.notes', role: 'owner', channel: 'web', target: String(id), outcome: 'failed' });
    }
  }

  /** S2: the calendar event at the meeting's time (all calendars; never in private local mode). */
  async #findEvent(m: Meeting): Promise<MeetingEvent | undefined> {
    const start = m.startedAt ? Date.parse(m.startedAt) : m.source === 'room' ? Date.parse(m.createdAt) : NaN;
    if (Number.isNaN(start) || privateLocalOn()) return undefined;
    const end = m.source === 'room' && m.endedAt ? Date.parse(m.endedAt) : start + Math.max(60, m.seconds) * 1000;
    let list: Awaited<ReturnType<NonNullable<MeetingsOptions['events']>>> = [];
    try {
      const from = new Date(start - 30 * 60_000);
      const to = new Date(end + 30 * 60_000);
      list = this.#opts.events ? await this.#opts.events(from, to) : (await allEvents(calendarSources(this.#app), from, to, 20, AbortSignal.timeout(8000))).events;
    } catch (err) {
      console.warn(`meetings: the calendar could not be read: ${(err as Error).message}`);
      return undefined;
    }
    let best: { e: (typeof list)[number]; overlap: number } | undefined;
    for (const e of list) {
      if (e.allDay || !e.end) continue;
      const a = Date.parse(e.start);
      const z = Date.parse(e.end);
      const overlap = Math.min(z, end) - Math.max(a, start);
      const shorter = Math.min(z - a, end - start);
      if (overlap > 0 && (overlap >= shorter * 0.5 || overlap >= 10 * 60_000) && (!best || overlap > best.overlap)) best = { e, overlap };
    }
    if (!best) return undefined;
    const e = best.e;
    return { id: e.id, title: oneLine(e.title, 200), start: e.start, ...(e.end ? { end: e.end } : {}), attendees: (e.attendees ?? []).slice(0, 60), ...(e.account ? { account: e.account } : {}) };
  }

  #ownAddresses(): string[] {
    const accts = this.#app.mailAccounts as { list?: () => { address?: string }[] } | undefined;
    const list = typeof accts?.list === 'function' ? accts.list() : [];
    return list.map((a) => String(a.address ?? '')).filter(Boolean);
  }

  /** S2: one follow-up email per attendee group, drafted by the writing model; they wait for him. */
  async #followUps(m: Meeting, notes: MeetingNotes, event: MeetingEvent): Promise<FollowUp[]> {
    const groups = attendeeGroups(event.attendees, this.#ownAddresses());
    if (!groups.length) return [];
    const recap = this.markdown({ ...m, notes: { ...notes, drafts: [] } });
    const owner = this.#app.settings.get().ownerName || '';
    let parsed: { group?: unknown; subject?: unknown; body?: unknown }[] = [];
    try {
      const out = await complete(this.#app, this.#conv(), [
        { role: 'system', content: `You draft short follow-up emails after a meeting, one per group of attendees, from the notes only (never invent facts). Each: a greeting, the decisions and the action items that matter to that group, open questions, a friendly close${owner ? ` signed ${owner}` : ''}. Answer with JSON only: {"drafts": [{"group": 0, "subject": "...", "body": "..."}]}.` },
        { role: 'user', content: `Groups:\n${groups.map((g, i) => `${i}: ${g.to.join(', ')}`).join('\n')}\n\nNotes:\n${recap}` },
      ], 1500, 'writing', this.#stop.signal);
      const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { drafts?: unknown };
      parsed = Array.isArray(j.drafts) ? (j.drafts as typeof parsed) : [];
    } catch (err) {
      if (!this.#closed) console.warn(`meetings: the follow-up drafts could not be written: ${(err as Error).message}`);
    }
    const plain = [notes.summary, ...notes.actions.map((a) => `- ${[a.task, a.owner, a.due].filter(Boolean).join(' · ')}`)].filter(Boolean).join('\n');
    return groups.map((g, i) => {
      const d = parsed.find((x) => Number(x.group) === i) ?? {};
      return { group: g.group, to: g.to, subject: oneLine(d.subject, 200) || this.#t(en('Notes from {title}'), { title: m.title }), body: String(d.body ?? '').slice(0, 8000).trim() || plain, status: 'waiting', at: null };
    });
  }

  /** S2: his decision on a follow-up email: send it, save it as a draft in his mailbox, or drop it. */
  async draft(id: number, index: number, input: { action?: unknown; to?: unknown; subject?: unknown; body?: unknown }): Promise<FollowUp> {
    const action = String(input.action ?? '');
    if (!['send', 'save', 'dismiss'].includes(action)) throw new MeetingError(400, en('Bad request'));
    if (action !== 'dismiss' && privateLocalOn()) throw new MeetingError(409, this.#t(en('In private local mode Sara sends no email.')));
    const m = this.get(id);
    const d = m?.notes?.drafts?.[index];
    if (!m || !d) throw new MeetingError(404, en('Not found'));
    if (d.status !== 'waiting') throw new MeetingError(409, this.#t(en('This email is already handled.')));
    if (typeof input.subject === 'string' && input.subject.trim()) d.subject = oneLine(input.subject, 200);
    if (typeof input.body === 'string' && input.body.trim()) d.body = input.body.slice(0, 20000).trim();
    if (typeof input.to === 'string' && input.to.trim()) d.to = input.to.split(/[,;\s]+/).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)).slice(0, 50);
    if (action !== 'dismiss') {
      if (!d.to.length) throw new MeetingError(400, this.#t(en('Give at least one address.')));
      const accts = this.#app.mailAccounts as { default?: () => { id: string } | undefined; provider?: (id: string) => { send?: (x: object) => Promise<string>; draft?: (x: object) => Promise<string> } } | undefined;
      const acc = typeof accts?.default === 'function' ? accts.default() : undefined;
      const provider = acc && typeof accts?.provider === 'function' ? accts.provider(acc.id) : undefined;
      const fn = action === 'send' ? provider?.send : provider?.draft;
      if (!provider || typeof fn !== 'function') throw new MeetingError(409, this.#t(en('Connect a mailbox first.')));
      try {
        await fn.call(provider, { to: d.to.join(', '), subject: d.subject, body: d.body });
      } catch (err) {
        audit({ action: 'meeting.draft', role: 'owner', channel: 'web', target: String(id), outcome: 'failed', keys: [action] });
        throw new MeetingError(502, (err as Error).message);
      }
    }
    d.status = action === 'send' ? 'sent' : action === 'save' ? 'saved' : 'dismissed';
    d.at = this.#now();
    this.#set(id, { notes: JSON.stringify(m.notes) });
    audit({ action: 'meeting.draft', role: 'owner', channel: 'web', target: String(id), keys: [action] });
    return d;
  }

  /** S2: Today: action items due within a week (not yet in the Planner) and emails waiting. */
  todayTile(): { items: { meeting: number; title: string; task: string; owner: string; dueAt: string }[]; drafts: number } | undefined {
    const soon = this.#app.now().getTime() + MEETINGS.tileDays * 86_400_000;
    const items: { meeting: number; title: string; task: string; owner: string; dueAt: string }[] = [];
    let drafts = 0;
    for (const r of this.#db.prepare(`SELECT id, title, notes FROM meetings WHERE status = 'done' AND notes IS NOT NULL ORDER BY id DESC LIMIT 20`).all() as Row[]) {
      const n = JSON.parse(String(r.notes)) as MeetingNotes;
      drafts += (n.drafts ?? []).filter((d) => d.status === 'waiting').length;
      for (const a of n.actions) if (!a.taskId && a.dueAt && Date.parse(a.dueAt) <= soon) items.push({ meeting: Number(r.id), title: String(r.title), task: a.task, owner: a.owner, dueAt: a.dueAt });
    }
    if (!items.length && !drafts) return undefined;
    items.sort((x, y) => x.dueAt.localeCompare(y.dueAt));
    return { items: items.slice(0, 6), drafts };
  }

  /** S2 (meeting_list): recent meetings, one line each. */
  listText(max = 10): string {
    const list = this.list().slice(0, max);
    if (!list.length) return 'No meetings yet. The person can record one or give a recording on the Meetings page (Library → Meetings).';
    return list.map((m) => `#${m.id} "${m.title}" · ${(m.startedAt ?? m.createdAt).slice(0, 16).replace('T', ' ')} · ${m.status}${m.notes ? ` · ${m.notes.actions.length} action items${m.notes.event ? ` · calendar: ${m.notes.event.title}` : ''}` : ''}`).join('\n');
  }

  /** S2 (meeting_summarize): one meeting's notes as text (no id: the latest with notes). */
  summaryText(id?: number): string {
    const m = id ? this.get(id) : this.list().find((x) => x.notes);
    if (!m) return id ? `There is no meeting #${id}.` : 'No meeting has notes yet.';
    const n = m.notes;
    if (!n) return `Meeting #${m.id} "${m.title}" has no notes yet (${m.status}${m.error ? `: ${m.error}` : ''}).`;
    const out = [`Meeting #${m.id} "${m.title}" (${(m.startedAt ?? m.createdAt).slice(0, 10)})${n.event ? `, calendar event "${n.event.title}"` : ''}.`, `Summary: ${n.summary}`];
    if (n.decisions.length) out.push(`Decisions:\n${n.decisions.map((d) => `- ${d}`).join('\n')}`);
    if (n.actions.length) out.push(`Action items:\n${n.actions.map((a) => `- ${a.task} (owner: ${a.owner || 'not said'}${a.due ? `, due ${a.due}` : ''}${a.taskId ? ', in the Planner' : ''})`).join('\n')}`);
    if (n.questions?.length) out.push(`Open questions:\n${n.questions.map((q) => `- ${q}`).join('\n')}`);
    const waiting = (n.drafts ?? []).filter((d) => d.status === 'waiting').length;
    if (waiting) out.push(`${waiting} follow-up email(s) wait for the person on the Meetings page (only they can send them).`);
    return out.join('\n\n');
  }

  /** The notes as Markdown (headings in his language; English data stays as said). */
  markdown(m: Pick<Meeting, 'title' | 'createdAt' | 'source' | 'devices'> & { notes: MeetingNotes }): string {
    const t = (x: string, p?: Record<string, unknown>) => this.#t(x, p);
    const n = m.notes;
    const items = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `- ${t(en('None'))}`);
    const acts = n.actions.length ? n.actions.map((a) => `- [ ] ${[a.task, a.owner || t(en('Not said')), a.due].filter(Boolean).join(' · ')}`).join('\n') : `- ${t(en('None'))}`;
    const from = m.source === 'file' ? t(en('From a recording')) : t(en('A meeting room in Sara'));
    const ev = n.event ? ` · ${t(en('Calendar'))}: ${n.event.title}` : '';
    const qs = n.questions?.length ? `\n## ${t(en('Open questions'))}\n\n${items(n.questions)}\n` : '';
    return `# ${m.title}\n\n${m.createdAt.slice(0, 10)} · ${from}${ev}\n\n## ${t(en('Summary'))}\n\n${n.summary || t(en('None'))}\n\n## ${t(en('Decisions'))}\n\n${items(n.decisions)}\n\n## ${t(en('Action items'))}\n\n${acts}\n${qs}`;
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
    // V4.4: its caption translations (src/meeting-captions.ts; the table exists once captions were used).
    if (this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meeting_captions'").get()) this.#db.prepare('DELETE FROM meeting_captions WHERE meeting_id = ?').run(id);
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
