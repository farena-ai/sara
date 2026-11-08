// C7: "Bring your companion". Reads what a Character.AI, Replika, Kindroid or Nomi user can actually
// get out of the app (an export zip, JSON / CSV / TXT / Markdown / saved HTML files, or the backstory
// and memories pasted in), works out which app it came from, and turns it into a Sara companion:
// her character (through the character-card reader, so the minors and age refusals and the Adult
// mode filter are the same), her memories (marked imported, with the app and the date) and,
// when the owner wants, the chat history as archived read-only conversations.
//
// Safety: everything is read here, in memory; nothing is fetched, run or rendered. HTML is reduced
// to text with regular expressions (scripts, styles and tags dropped, never executed). Sizes are
// capped (files, paste, zip entries, memories, chats). A chat that fails the minors check is dropped
// whole; memories are checked one by one; explicit memories are left out with Adult mode off.
// Nothing here logs the content. Formats and sources: docs/ops/C7_DESIGN.md.
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../chat.ts';
import { CardError, cardToCharacter, type CardData } from '../character-cards.ts';
import { type HistorySource, SOURCE_CHANNEL, SOURCE_NAME } from '../history-import/types.ts';
import { en } from '../i18n.ts';
import { ReadError } from '../library/read.ts';
import { decodeXmlBytes, openZip } from '../library/zip.ts';
import { localDate } from '../memory-worker.ts';
import type { MemoryKind } from '../memory.ts';
import { type Persona, validatePersona } from '../persona.ts';
import { detectExplicit, detectMinorSexualContent } from '../safety.ts';
import { looksLikeCharacterAI, looksLikeCsv, looksLikeGenericJson, readCharacterAI, readCsv, readGenericJson, readTranscript } from './readers.ts';
import { IMPORT_ZIP_LIMITS, obj, type RawConversation, type RawExport, str, timeOf } from './types.ts';

export type BringSource = 'characterai' | 'replika' | 'kindroid' | 'nomi' | 'other';
export const BRING_SOURCES: readonly BringSource[] = ['characterai', 'replika', 'kindroid', 'nomi', 'other'];
export const BRING_SOURCE_NAME: Record<BringSource, string> = { characterai: 'Character.AI', replika: 'Replika', kindroid: 'Kindroid', nomi: 'Nomi', other: 'another app' };
const HISTORY_SOURCE: Record<BringSource, HistorySource> = { characterai: 'characterai', replika: 'replika', kindroid: 'kindroid', nomi: 'nomi', other: 'text' };

/** All files of one bring together (a zip counts as its own size). */
export const MAX_BRING_BYTES = 50 * 1024 * 1024;
export const MAX_BRING_FILES = 10;
export const MAX_PASTE = 300_000;
export const MAX_MEMORIES = 500;
const MAX_MEMORY_CHARS = 1000;
const MAX_FIELD = 20_000;
const MAX_ZIP_FILES = 500;
const MAX_CHATS = 5000;
const READABLE = /\.(json|jsonl|txt|md|markdown|csv|html?|log)$/i;
/** Account files in an export: never read (the owner's e-mail, settings, payments). */
const ACCOUNT_FILE = /(^|\/)(user|users|account|accounts|settings|profile_settings|billing|payments?)\.json$/i;

export class BringError extends Error {
  readonly params?: Record<string, unknown>;
  constructor(message: string, params?: Record<string, unknown>) {
    super(message);
    this.params = params;
  }
}

export interface BringMemory {
  text: string;
  /** What it was in the other app ("key memory", "journal entry", "diary entry", "your appearance"…). */
  label: string;
  /** Whom it is about: the owner, her, or the two of them. */
  about: 'you' | 'her' | 'both';
  /** The day it happened or was written (YYYY-MM-DD), when the export says. */
  date?: string;
}

export interface BringProfile {
  description: string;
  personality: string;
  scenario: string;
  greeting: string;
  examples: string;
  style: string;
  appearance: string;
  boundaries: string;
  pronouns?: 'she' | 'he' | 'they';
}

export interface BringRead {
  source: BringSource;
  /** The owner chose the app (not guessed). */
  sourceChosen: boolean;
  name: string;
  profile: BringProfile;
  memories: BringMemory[];
  chats: RawExport | null;
  /** Files that weren't anything Sara reads (skipped). */
  skippedFiles: number;
}

// ---------- reading ----------

type Field = keyof Omit<BringProfile, 'pronouns'> | 'name' | 'tagline' | 'memories' | 'you' | 'journal' | 'diary' | 'chat';
/** Section names as the apps (and their help pages) call them, letters only, lower case. */
const HEADS: Record<string, Field> = {
  name: 'name', charactername: 'name', nominame: 'name', kindroidname: 'name', replikaname: 'name',
  backstory: 'description', description: 'description', longdescription: 'description', about: 'description', bio: 'description', persona: 'description', backstoryplus: 'description',
  tagline: 'tagline', shortdescription: 'tagline',
  personality: 'personality', inclination: 'personality', traits: 'personality', personalitytraits: 'personality',
  greeting: 'greeting', firstmessage: 'greeting',
  examplemessage: 'examples', examplemessages: 'examples', exampledialog: 'examples', exampledialogs: 'examples', exampledialogue: 'examples', exampledialogues: 'examples', definition: 'examples',
  responsedirective: 'style', directive: 'style', responsestyle: 'style',
  scenario: 'scenario', currentroleplay: 'scenario', roleplay: 'scenario',
  appearance: 'appearance', nomisappearance: 'appearance', herappearance: 'appearance', hisappearance: 'appearance', theirappearance: 'appearance', looks: 'appearance', avatardescription: 'appearance',
  boundaries: 'boundaries',
  yourappearance: 'you', nicknames: 'you', preferences: 'you', desires: 'you', aboutme: 'you', aboutyou: 'you', facts: 'you', factsaboutme: 'you',
  keymemories: 'memories', keymemory: 'memories', memories: 'memories', memory: 'memories', sharednotes: 'memories', notes: 'memories',
  journal: 'journal', journalentries: 'journal', journalentry: 'journal',
  diary: 'diary', diaryentries: 'diary',
  chat: 'chat', chathistory: 'chat', transcript: 'chat', conversation: 'chat',
};
/** Section names only one app uses: they tell where the export came from. */
const HINTS: Record<string, BringSource> = {
  keymemories: 'kindroid', keymemory: 'kindroid', responsedirective: 'kindroid', journalentries: 'kindroid', journal: 'kindroid', examplemessage: 'kindroid', kindroidname: 'kindroid',
  inclination: 'nomi', currentroleplay: 'nomi', nomisappearance: 'nomi', yourappearance: 'nomi', nicknames: 'nomi', desires: 'nomi', sharednotes: 'nomi', backstoryplus: 'nomi', nominame: 'nomi',
  diary: 'replika', diaryentries: 'replika', replika: 'replika', replikaname: 'replika',
  greeting: 'characterai', definition: 'characterai', tagline: 'characterai', longdescription: 'characterai',
};
const keyOf = (k: string): string => k.toLowerCase().replace(/[^a-z]/g, '');

interface Acc {
  fields: Partial<Record<Field, string[]>>;
  memories: (BringMemory & { field: Field })[];
  chats: RawExport[];
  hints: Map<BringSource, number>;
  skipped: number;
  pronouns?: BringProfile['pronouns'];
}

const clean = (s: string, max = MAX_FIELD): string => s.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
const hint = (a: Acc, k: string, n = 1) => {
  const h = HINTS[keyOf(k)];
  if (h) a.hints.set(h, (a.hints.get(h) ?? 0) + n);
};
const dayOf = (v: unknown): string | undefined => timeOf(v)?.slice(0, 10);
const DATE_PREFIX = /^\s*(?:\*\*)?\[?((?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}\/\d{1,2}\/\d{2,4})|(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\]?(?:\*\*)?\s*[:\-–—]\s*/i;

function addField(a: Acc, f: Field, text: string, label?: string, date?: string): void {
  const t = clean(text);
  if (!t) return;
  if (f === 'memories' || f === 'you' || f === 'journal' || f === 'diary') {
    // Lists: one item per bullet (or per line); journal and diary entries: one per paragraph.
    const items = f === 'journal' || f === 'diary' ? t.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/) : t.split(/\n+/);
    for (const raw of items) {
      let item = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
      let d = date;
      const m = DATE_PREFIX.exec(item);
      if (m) {
        d = dayOf(m[1].replace(/(\d)(st|nd|rd|th)/, '$1')) ?? d;
        item = item.slice(m[0].length).trim();
      }
      if (item.length < 2 || a.memories.length >= MAX_MEMORIES * 2) continue;
      a.memories.push({ text: item.slice(0, MAX_MEMORY_CHARS), label: label ?? '', about: 'both', field: f, ...(d ? { date: d } : {}) });
    }
    return;
  }
  if (f === 'chat') {
    const r = readTranscript(t, 'chat');
    if (r.conversations.length) a.chats.push(r);
    return;
  }
  (a.fields[f] ??= []).push(t);
}

/** Pasted text or a text file: sections under the apps' own headings, a transcript, or else a backstory. */
function readText(a: Acc, text: string): void {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const sections: { f: Field; label: string; body: string[] }[] = [];
  let cur: (typeof sections)[number] | undefined;
  const loose: string[] = [];
  for (const l of lines) {
    const alone = /^\s*(?:#{1,4}\s*)?(?:\*\*|__)?([\p{L}' +’]{2,40}?)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*$/u.exec(l);
    const inline = /^\s*(?:\*\*|__)?([\p{L}' +’]{2,40}?)(?:\*\*|__)?\s*:\s+(.+)$/u.exec(l);
    const k = alone ? keyOf(alone[1]) : inline ? keyOf(inline[1]) : '';
    if (k && HEADS[k] && (alone || HEADS[k] === 'name' || /^\s*(?:#|\*\*|__)/.test(l) || ['scenario', 'greeting', 'boundaries', 'personality', 'tagline'].includes(HEADS[k]))) {
      hint(a, k, 2);
      cur = { f: HEADS[k], label: (alone ?? inline)![1].trim().toLowerCase(), body: inline && !alone ? [inline[2]] : [] };
      sections.push(cur);
      continue;
    }
    (cur ? cur.body : loose).push(l);
  }
  for (const s of sections) addField(a, s.f, s.body.join('\n'), s.label);
  const rest = loose.join('\n').trim();
  if (!rest) return;
  const chat = readTranscript(rest, 'chat');
  if (chat.conversations.some((c) => c.messages.length >= 2)) a.chats.push(chat);
  else addField(a, 'description', rest);
}

/** HTML as plain text: script, style and head blocks dropped, tags removed, entities decoded. Never rendered or run. */
export function htmlText(html: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|template|noscript|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]{2,8});/gi, (m, e: string) => {
      if (e[0] !== '#') return named[e.toLowerCase()] ?? m;
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff && n !== 0 ? String.fromCodePoint(n) : '';
    })
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const CHAT_KEYS = new Set(['messages', 'chats', 'chat', 'turns', 'conversations', 'histories', 'history', 'msgs', 'conversation']);
const ENTRY_TEXT = ['text', 'content', 'entry', 'body', 'memory', 'fact', 'value', 'note', 'description'];
const ENTRY_DATE = ['date', 'created', 'created_at', 'createdAt', 'timestamp', 'time', 'day', 'updated_at'];

/** A JSON value: Character.AI characters and chats, profile objects with the apps' fields, generic chats. */
function readJsonValue(a: Acc, v: unknown): void {
  if (looksLikeCharacterAI(v)) {
    a.chats.push(readCharacterAI(v));
    hint(a, 'greeting', 1);
  }
  let found = false;
  const walk = (x: unknown, depth: number, under?: BringSource) => {
    if (depth > 4) return;
    if (Array.isArray(x)) {
      for (const y of x.slice(0, 200)) walk(y, depth + 1, under);
      return;
    }
    const o = obj(x);
    if (!o) return;
    const isCaiCharacter = typeof o.greeting === 'string' && typeof o.name === 'string' && ['definition', 'description', 'title', 'tagline'].some((k) => typeof o[k] === 'string');
    if (isCaiCharacter) {
      // One character per bring: the first one in the export.
      if (a.fields.name?.length) return;
      found = true;
      hint(a, 'greeting', 3);
      if (str(o.title)) addField(a, 'tagline', str(o.title));
    }
    for (const [k0, val] of Object.entries(o)) {
      const k = keyOf(k0);
      if (CHAT_KEYS.has(k)) continue;
      if (k === 'replika' || k === 'kindroid' || k === 'nomi') {
        hint(a, k === 'replika' ? 'replika' : k === 'kindroid' ? 'kindroidname' : 'nominame', 3);
        if (typeof val === 'string') addField(a, 'name', val);
        else walk(val, depth + 1, k as BringSource);
        continue;
      }
      if (k === 'gender') {
        const g = str(val).toLowerCase();
        a.pronouns = /^(female|woman|f|she)/.test(g) ? 'she' : /^(male|man|m|he)/.test(g) ? 'he' : /^(non|nb|they|other)/.test(g) ? 'they' : a.pronouns;
        continue;
      }
      if (k === 'title' && !isCaiCharacter) continue;
      const f = k === 'title' ? undefined : HEADS[k];
      if (!f) {
        if (val && typeof val === 'object' && (k === 'sharednotes' || k === 'backstoryplus' || k === 'profile' || k === 'character' || k === 'characters' || k === 'data' || k === 'info')) {
          hint(a, k, 2);
          walk(val, depth + 1, under);
        }
        continue;
      }
      if (f === 'name' && depth > 0 && !isCaiCharacter && !under && a.fields.name?.length) continue;
      found = true;
      hint(a, k, 2);
      if (typeof val === 'string' || typeof val === 'number') addField(a, f, str(val), k0.replace(/[_-]+/g, ' ').toLowerCase());
      else if (Array.isArray(val)) {
        for (const item of val.slice(0, MAX_MEMORIES * 2)) {
          const io = obj(item);
          const text = io ? str(ENTRY_TEXT.map((t) => io[t]).find((t) => typeof t === 'string' && t.trim())) : str(item);
          const date = io ? dayOf(ENTRY_DATE.map((t) => io[t]).find((t) => t !== undefined)) : undefined;
          if (text) addField(a, f, text, k0.replace(/[_-]+/g, ' ').toLowerCase(), date);
        }
      } else if (obj(val)) walk(val, depth + 1, under);
    }
  };
  walk(v, 0);
  if (!looksLikeCharacterAI(v) && looksLikeGenericJson(v)) {
    a.chats.push(readGenericJson(v, 'chat'));
    found = true;
  }
  if (!found && !looksLikeCharacterAI(v)) a.skipped++;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''), (k, val) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : val)) as unknown;
  } catch {
    return undefined;
  }
}

function readOne(a: Acc, name: string, bytes: Buffer): void {
  const isZip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
  if (isZip) return readZipFile(a, bytes);
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) throw new BringError(en('This is a picture (perhaps a character card). Character cards are imported with From a file… above.'));
  const head = bytes.subarray(0, 4096);
  if (head.includes(0) && !(head[0] === 0xff && head[1] === 0xfe) && !(head[0] === 0xfe && head[1] === 0xff)) {
    a.skipped++;
    return;
  }
  const text = decodeXmlBytes(bytes);
  const t = text.trimStart();
  if (/\.html?$/i.test(name) || /^<(!doctype|html|body|div|head)/i.test(t)) return readText(a, htmlText(text));
  if (/\.jsonl$/i.test(name)) {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map(parseJson).filter((x) => x !== undefined);
    return readJsonValue(a, rows);
  }
  if (t.startsWith('{') || t.startsWith('[')) {
    const v = parseJson(t);
    if (v === undefined) throw new BringError(en('{file} isn’t valid JSON, so it can’t be read.'), { file: name.slice(0, 80) });
    return readJsonValue(a, v);
  }
  if (/\.csv$/i.test(name) || looksLikeCsv(text)) {
    if (looksLikeCsv(text)) {
      a.chats.push(readCsv(text, 'chat'));
      return;
    }
    // A list of memories or diary entries saved as a spreadsheet: the first text-like column.
    const rows = text.split(/\r?\n/).filter((l) => l.trim());
    const f: Field = /diary/i.test(name) ? 'diary' : /journal/i.test(name) ? 'journal' : 'memories';
    hint(a, f === 'diary' ? 'diary' : f === 'journal' ? 'journal' : 'x');
    for (const r of rows.slice(1, MAX_MEMORIES + 1)) addField(a, f, r.split(/[,;\t](?=(?:[^"]*"[^"]*")*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').replace(/""/g, '"')).sort((x, y) => y.length - x.length)[0] ?? '', f === 'diary' ? 'diary entry' : f === 'journal' ? 'journal entry' : 'memory');
    return;
  }
  readText(a, text);
}

function readZipFile(a: Acc, bytes: Buffer): void {
  try {
    const zip = openZip(bytes, IMPORT_ZIP_LIMITS);
    const names = [...zip.entries.keys()].filter((n) => !/(^|\/)(__MACOSX|\.)/.test(n) && READABLE.test(n) && !ACCOUNT_FILE.test(n)).sort().slice(0, MAX_ZIP_FILES);
    let total = 0;
    for (const n of names) {
      const e = zip.get(n)!;
      total += e.size;
      if (e.size > MAX_BRING_BYTES || total > MAX_BRING_BYTES * 4) throw new BringError(en('This export is too big to read (more than 200 MB unpacked). Choose the files you need from it instead.'));
      readOne(a, n, zip.read(n));
    }
  } catch (err) {
    if (err instanceof ReadError) {
      if (/password/i.test(err.message)) throw new BringError(en('This zip is locked with a password. Unzip it first (with the password the app gave you), then choose the files inside.'));
      throw new BringError(err.message);
    }
    throw err;
  }
}

/**
 * Reads what the owner chose: up to 10 files (zips included) and/or pasted text. `source` is the
 * app the owner picked ('' or undefined: guess); `name` overrides her name.
 */
export function readBring(input: { files?: { name: string; bytes: Buffer }[]; text?: string; source?: string; name?: string }, now: Date): BringRead {
  const files = (input.files ?? []).filter((f) => f.bytes.length);
  if (files.length > MAX_BRING_FILES) throw new BringError(en('Choose up to 10 files at a time.'));
  if (files.reduce((n, f) => n + f.bytes.length, 0) > MAX_BRING_BYTES) throw new BringError(en('These files are bigger than 50 MB together. Choose fewer, or only the ones with her character and memories.'));
  const text = input.text ?? '';
  if (text.length > MAX_PASTE) throw new BringError(en('The pasted text is too long (up to 300,000 characters).'));
  if (!files.length && !text.trim()) throw new BringError(en('Nothing to bring: choose her export files or paste her backstory and memories.'));
  void now;
  const a: Acc = { fields: {}, memories: [], chats: [], hints: new Map(), skipped: 0 };
  for (const f of files) readOne(a, f.name.replace(/\\/g, '/'), f.bytes);
  if (text.trim()) readText(a, text);
  // Where it came from: the owner's choice, else the app whose own section names showed up most.
  const chosen = BRING_SOURCES.includes(input.source as BringSource) ? (input.source as BringSource) : undefined;
  const guessed = [...a.hints].sort((x, y) => y[1] - x[1])[0]?.[0] ?? (a.chats.some((c) => c.format === 'characterai') ? 'characterai' : 'other');
  const source = chosen ?? guessed;
  const chats = mergeChats(a.chats);
  const j = (f: Field) => (a.fields[f] ?? []).join('\n\n').slice(0, MAX_FIELD);
  const profile: BringProfile = {
    description: j('description'),
    personality: [j('tagline'), j('personality')].filter(Boolean).join('\n'),
    scenario: j('scenario'),
    greeting: (a.fields.greeting ?? [])[0] ?? '',
    examples: j('examples'),
    style: j('style'),
    appearance: j('appearance'),
    boundaries: j('boundaries'),
    ...(a.pronouns ? { pronouns: a.pronouns } : {}),
  };
  const name = clean(input.name ?? '', 40) || clean((a.fields.name ?? [])[0] ?? '', 200).split('\n')[0].replace(/\s+/g, ' ').slice(0, 40) || guessName(profile, chats) || '';
  if (!name && !profile.description && !profile.personality && !a.memories.length && !chats) throw new BringError(en('Sara couldn’t find a companion in this. Supported: Character.AI exports, Replika, Kindroid and Nomi files (JSON, CSV, text or a saved web page), or her backstory and memories pasted in.'));
  const label = (m: BringMemory & { field: Field }): string => {
    if (m.field === 'diary') return 'diary entry';
    if (m.field === 'journal') return 'journal entry';
    if (m.field === 'you') return m.label || 'about you';
    return source === 'kindroid' ? 'key memory' : source === 'nomi' ? 'shared note' : 'memory';
  };
  const about = (m: BringMemory & { field: Field }): BringMemory['about'] => (m.field === 'you' || (m.field === 'memories' && source === 'replika') ? 'you' : m.field === 'diary' ? 'her' : 'both');
  const seen = new Set<string>();
  const memories = a.memories
    .filter((m) => {
      const k = m.text.toLowerCase();
      return !seen.has(k) && Boolean(seen.add(k));
    })
    .slice(0, MAX_MEMORIES)
    .map((m) => ({ text: m.text, label: label(m), about: about(m), ...(m.date ? { date: m.date } : {}) }));
  return { source, sourceChosen: Boolean(chosen), name, profile, memories, chats, skippedFiles: a.skipped };
}

function mergeChats(parts: RawExport[]): RawExport | null {
  const found = parts.filter((p) => p.conversations.length);
  if (!found.length) return null;
  const seen = new Set<string>();
  const conversations = found.flatMap((p) => p.conversations).filter((c) => !seen.has(`${c.sourceId}|${c.messages.length}|${c.messages[0]?.text ?? ''}`) && Boolean(seen.add(`${c.sourceId}|${c.messages.length}|${c.messages[0]?.text ?? ''}`)));
  const characterName = found.find((p) => p.characterName)?.characterName;
  return { format: found[0].format, conversations: conversations.slice(-MAX_CHATS), ownerSpeakers: [...new Set(found.flatMap((p) => p.ownerSpeakers))], ...(characterName ? { characterName } : {}), leftOut: found.reduce((n, p) => n + p.leftOut, 0) };
}

/** Her name when nothing says it: the chat's character, a speaker the backstory talks about, or "X is …" at its start. */
function guessName(p: BringProfile, chats: RawExport | null): string {
  if (chats?.characterName) return chats.characterName.slice(0, 40);
  const speakers = [...new Set(chats?.conversations.flatMap((c) => c.messages.map((m) => m.speaker)) ?? [])].filter((s) => !chats?.ownerSpeakers.includes(s) && !/^(you|me|user|human)$/i.test(s));
  const desc = `${p.description}\n${p.personality}`;
  const said = speakers.find((s) => new RegExp(`(^|\\n)\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(desc)) ?? speakers.find((s) => desc.includes(s));
  if (said) return said.slice(0, 40);
  const m = /^\s*(\p{Lu}[\p{L}'’-]{1,30})\s+(?:is|was|has|loves)\b/u.exec(p.description);
  if (m) return m[1];
  return speakers.length === 1 ? speakers[0].slice(0, 40) : '';
}

// ---------- the plan (what will come over) ----------

export interface BringPicks {
  /** Her backstory, personality, scenario, look, style and boundaries (default on). */
  backstory?: boolean;
  greeting?: boolean;
  examples?: boolean;
  /** The memories kept, by index in BringRead.memories (default all). */
  memories?: number[];
}

export interface BringNote {
  text: string;
  params?: Record<string, unknown>;
}

export interface BringPlan {
  source: BringSource;
  persona: Persona;
  greeting: string;
  examples: string[];
  memories: (BringMemory & { index: number })[];
  conversations: RawConversation[];
  messages: number;
  /** Conversations and memories dropped by the minors check (never stored or shown). */
  droppedForSafety: number;
  notes: BringNote[];
  nsfw: boolean;
}

const EXAMPLE = /^Example of how .* talks:\s*/s;

/** What will come over, with every safety rule applied. Throws BringError when she can't come over. */
export function planBring(r: BringRead, opts: { adultOn: boolean; ownerName?: string; picks?: BringPicks; name?: string }): BringPlan {
  const picks = opts.picks ?? {};
  const story = picks.backstory !== false;
  const p = r.profile;
  const app = BRING_SOURCE_NAME[r.source];
  const name = (opts.name?.trim() || r.name || '').slice(0, 40);
  if (!name) throw new BringError(en('Give her (or him) a name of up to 40 characters.'));
  // Character.AI writes example dialogs as "{{char}}: …" lines between END_OF_DIALOG marks.
  const examples = picks.examples === false ? '' : p.examples.replace(/\bEND_OF_DIALOG\b/g, '<START>');
  const card: CardData = {
    spec: 'chara_card_v2',
    name,
    description: story ? p.description : '',
    personality: story ? p.personality : '',
    scenario: story ? p.scenario : '',
    first_mes: picks.greeting === false ? '' : p.greeting,
    mes_example: examples,
    creator_notes: '',
    system_prompt: '',
    // The rest of what she was goes through the same checks (minors, ages) as the card's own fields.
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    character_book: story && (p.style || p.boundaries || p.appearance) ? { name: '', entries: [p.style, p.boundaries, p.appearance].filter(Boolean).map((content) => ({ keys: [], content })) } : null,
  };
  let imp;
  try {
    imp = cardToCharacter(card, { adultOn: opts.adultOn, ownerName: opts.ownerName });
  } catch (err) {
    if (err instanceof CardError) throw new BringError(err.message.replace(/\bThis card\b/g, 'This export').replace(/\bcard\b/g, 'export'));
    throw err;
  }
  let explicit = Number(/(\d+) explicit part/.exec(imp.notes.join(' '))?.[1] ?? 0);
  const keepLine = (t: string) => {
    if (opts.adultOn || !detectExplicit(t)) return true;
    explicit++;
    return false;
  };
  const persona: Persona = { ...imp.persona };
  if (r.profile.pronouns) persona.pronouns = r.profile.pronouns;
  if (!story || !p.description) persona.summary = `${name} came over from ${app}.${persona.summary && !/is a character from a character card\.$/.test(persona.summary) ? ` ${persona.summary}` : ''}`;
  persona.personality = persona.personality.map((x) => (x === `${name} as described on the card.` ? `${name}, as in ${app}.` : x));
  if (story) {
    const extra = [...(p.style ? [`How ${name} liked to reply in ${app} (a style note, not a rule): ${p.style}`] : []), ...(p.boundaries ? [`Boundaries the two of you set in ${app}: ${p.boundaries}`] : [])].filter(keepLine).map((x) => x.slice(0, 400));
    persona.background = [...persona.background, ...extra].slice(0, 20);
    if (p.appearance && keepLine(p.appearance)) persona.appearance = p.appearance.replace(/\s+/g, ' ').slice(0, 600);
  }
  let checked: Persona;
  try {
    checked = validatePersona(persona);
  } catch (err) {
    throw new BringError(en('Her character can’t be used: {why}.'), { why: (err as Error).message });
  }
  // Memories: the owner's picks, each minors-checked; explicit ones only with Adult mode on.
  const pick = picks.memories ? new Set(picks.memories) : undefined;
  let droppedForSafety = 0;
  const memories: BringPlan['memories'] = [];
  r.memories.forEach((m, index) => {
    if (detectMinorSexualContent(m.text)) return void droppedForSafety++;
    if (!keepLine(m.text)) return;
    if (pick && !pick.has(index)) return;
    memories.push({ ...m, index });
  });
  // Chats: a conversation that fails the minors check is dropped whole.
  const conversations: RawConversation[] = [];
  for (const c of r.chats?.conversations ?? []) {
    if (detectMinorSexualContent(c.title) || c.messages.some((m) => detectMinorSexualContent(m.text))) {
      droppedForSafety++;
      continue;
    }
    if (c.messages.length) conversations.push(c);
  }
  const notes: BringNote[] = [];
  if (imp.check.age === null) notes.push({ text: en('No age given: set to 25 (change it under Name and personality).') });
  if (explicit) notes.push({ text: en('{n} explicit parts were left out because Adult mode is off.'), params: { n: explicit } });
  else if (imp.check.nsfw && opts.adultOn) notes.push({ text: en('This export has adult content. Explicit replies still follow your Adult mode and intimacy settings.') });
  if (droppedForSafety) notes.push({ text: en('{n} items were left out by the safety check (Sara never imports sexual content involving minors).'), params: { n: droppedForSafety } });
  if (r.skippedFiles) notes.push({ text: en('{n} files had nothing Sara reads and were skipped.'), params: { n: r.skippedFiles } });
  notes.push({ text: en('Her safety rules and the AI notice always stay, whatever the export says.') });
  return {
    source: r.source,
    persona: checked,
    greeting: imp.greeting,
    examples: checked.speech.filter((x) => !/^How .* might say hello:/.test(x)).map((x) => x.replace(EXAMPLE, '').trim()).filter(Boolean),
    memories,
    conversations,
    messages: conversations.reduce((n, c) => n + c.messages.length, 0),
    droppedForSafety,
    notes,
    nsfw: imp.check.nsfw,
  };
}

// ---------- saving into a companion ----------

const KIND: Record<BringMemory['about'], MemoryKind> = { you: 'fact', her: 'self', both: 'fact' };

/**
 * Saves the plan's memories (marked imported: the app, what it was, the day) and, with `chats`, the
 * chat history as archived, read-only conversations, into `app` (the new companion). Secrets are
 * blanked first. Her character is saved by the caller (it makes the companion from plan.persona).
 */
export function applyBring(app: AppContext, r: BringRead, plan: BringPlan, opts: { chats: boolean }): { memories: number; conversations: number } {
  const source = HISTORY_SOURCE[plan.source];
  const channel = SOURCE_CHANNEL[source];
  const nowIso = app.now().toISOString();
  const today = localDate(nowIso, app.settings.get().timeZone);
  const mem = app.memory;
  let memories = 0;
  if (mem && plan.memories.length) {
    const anchor = app.store.insertImported({ title: `${SOURCE_NAME[source]}: what came over (${today})`, channel, channelKey: `bring-${randomUUID()}`, createdAt: nowIso, updatedAt: nowIso, archived: true, from: source, messages: [] }).id;
    const known = new Set(mem.list({ limit: 1000 }).map((m) => m.content.toLowerCase()));
    for (const m of plan.memories) {
      const text = app.redactor.redact(m.text).slice(0, MAX_MEMORY_CHARS);
      if (known.has(text.toLowerCase())) continue;
      known.add(text.toLowerCase());
      const kind: MemoryKind = m.label === 'journal entry' ? 'summary' : KIND[m.about];
      mem.add({ kind, content: text, conversationId: anchor, sourceMessageId: null, happenedOn: m.date ?? today, evidence: `Imported from ${BRING_SOURCE_NAME[plan.source]} (${m.label}) on ${today}.` });
      memories++;
    }
    app.events?.publish({ type: 'memory', conversationId: anchor });
  }
  let conversations = 0;
  if (opts.chats) {
    const ownerName = (app.settings.get().ownerName ?? '').trim().toLowerCase();
    const her = new Set([plan.persona.name.toLowerCase(), r.name.toLowerCase(), (r.chats?.characterName ?? '').toLowerCase()].filter(Boolean));
    const owners = new Set((r.chats?.ownerSpeakers ?? []).map((s) => s.toLowerCase()));
    for (const c of plan.conversations) {
      const speakers = [...new Set(c.messages.map((m) => m.speaker.toLowerCase()))];
      const isOwner = (s: string) => owners.has(s) || /^(you|me|user|human)$/.test(s) || (ownerName && s === ownerName);
      const herHere = speakers.some((s) => her.has(s)) ? (s: string) => her.has(s) : speakers.some(isOwner) ? (s: string) => !isOwner(s) : (s: string) => s === speakers[0];
      let last = c.messages.find((m) => m.at)?.at ?? nowIso;
      const msgs = c.messages.map((m) => {
        const at = m.at && !Number.isNaN(Date.parse(m.at)) && new Date(m.at).toISOString() >= last ? new Date(m.at).toISOString() : last;
        last = at;
        return { role: herHere(m.speaker.toLowerCase()) ? ('assistant' as const) : ('user' as const), content: app.redactor.redact(m.text), createdAt: at };
      });
      const res = app.store.insertImported({ title: app.redactor.redact(c.title).slice(0, 120) || `${SOURCE_NAME[source]} chat`, channel, channelKey: c.sourceId.slice(0, 200), createdAt: msgs[0].createdAt, updatedAt: msgs.at(-1)!.createdAt, archived: true, from: source, messages: msgs });
      // The everyday memory worker leaves them alone: what she remembers is what the owner brought.
      mem?.setState(res.id, { summarizedThrough: res.lastId, lastError: null });
      conversations++;
    }
  }
  return { memories, conversations };
}
