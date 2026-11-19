// V4.2 (docs/design/INTERPRETER.md): the live interpreter in Talk with Sara. Two people, two
// languages: each turn is heard (the Talk loop in web/talk.js), translated here with one small
// local-first model call, and spoken in the other language. The transcript is saved per person
// (<dataDir>/interpreter/<id>.json). Translation is never a chat turn: no memory, tools or chats.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cheapCall, fenceLines } from './cheap.ts';
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import { clearLang, TEXT_LANGS, type TextLang } from './lang-text.ts';
import type { Conversation } from './store.ts';

/** The languages the interpreter offers (the web names them with Intl.DisplayNames). */
export const INTERP_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'tr', 'ru', 'uk', 'ar', 'hi', 'zh', 'ja', 'ko', 'vi', 'th', 'id'] as const;
export type InterpLang = (typeof INTERP_LANGS)[number];

export interface InterpPrefs {
  a: InterpLang;
  b: InterpLang;
  /** A cloud model may translate when this computer has none (off by default). */
  cloud: boolean;
}

export interface InterpLine {
  at: string;
  from: InterpLang;
  to: InterpLang;
  /** What was heard. */
  said: string;
  /** The translation ('' when none could be made). */
  text: string;
}

export interface InterpSession {
  id: string;
  a: InterpLang;
  b: InterpLang;
  startedAt: string;
  endedAt?: string;
  lines: InterpLine[];
}

export const INTERP_DEFAULTS: InterpPrefs = { a: 'en', b: 'es', cloud: false };
const KEEP_SESSIONS = 100;
const MAX_LINES = 500;
const MAX_SAID = 1200;

export function interpLang(v: unknown): InterpLang | undefined {
  const s = String(v ?? '').trim();
  const base = s.toLowerCase().split(/[-_]/)[0];
  return (INTERP_LANGS as readonly string[]).includes(base) ? (base as InterpLang) : undefined;
}

export function cleanInterpPrefs(v: unknown): InterpPrefs {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const a = interpLang(o.a);
  const b = interpLang(o.b);
  const cloud = o.cloud === true;
  if (!a || !b) return { ...INTERP_DEFAULTS, cloud };
  if (a === b) return { a, b: a === 'en' ? 'es' : 'en', cloud };
  return { a, b, cloud };
}

const prefsFile = (app: AppContext) => join(app.dataDir, 'interpreter.json');
export function interpPrefs(app: AppContext): InterpPrefs {
  try {
    return cleanInterpPrefs(JSON.parse(readFileSync(prefsFile(app), 'utf8')));
  } catch {
    return { ...INTERP_DEFAULTS };
  }
}
export function saveInterpPrefs(app: AppContext, v: unknown): InterpPrefs {
  const p = cleanInterpPrefs({ ...interpPrefs(app), ...(v && typeof v === 'object' ? v : {}) });
  writeFileSync(prefsFile(app), JSON.stringify(p));
  return p;
}

// Letters only some languages use: a text written in one of them goes to that side.
const SCRIPT: Partial<Record<InterpLang, RegExp>> = {
  ja: /[\u3040-\u30ff]/gu,
  zh: /[\u4e00-\u9fff]/gu,
  ko: /[\uac00-\ud7af\u1100-\u11ff]/gu,
  ru: /[\u0400-\u04ff]/gu,
  uk: /[\u0400-\u04ff]/gu,
  ar: /[\u0600-\u06ff]/gu,
  hi: /[\u0900-\u097f]/gu,
  th: /[\u0e00-\u0e7f]/gu,
};
const count = (s: string, re: RegExp | undefined) => (re ? (s.match(re)?.length ?? 0) : 0);
const latin = (s: string) => s.match(/[a-z\u00c0-\u024f]/giu)?.length ?? 0;

/**
 * Which of the two languages these words are in: by script, then by small words (lang-text), else
 * the side the person tapped (hint), else the other side of the last turn, else the first side.
 */
export function guessSide(said: string, a: InterpLang, b: InterpLang, o: { hint?: InterpLang; last?: InterpLang } = {}): InterpLang {
  const s = said.slice(0, 2000);
  const letters = latin(s);
  // Japanese uses Han too: kana decide it first.
  const sa = a === 'ja' || b === 'ja' ? count(s, SCRIPT.ja) : 0;
  if (sa > 0) return a === 'ja' ? a : b;
  const ca = count(s, SCRIPT[a]);
  const cb = count(s, SCRIPT[b]);
  if (ca !== cb && Math.max(ca, cb) > letters) {
    // Russian vs Ukrainian: Ukrainian letters decide.
    if (SCRIPT[a] === SCRIPT[b]) return /[іїєґ]/iu.test(s) ? (a === 'uk' ? a : b) : a === 'ru' ? a : b;
    return ca > cb ? a : b;
  }
  if (ca === cb && ca > letters && SCRIPT[a] && SCRIPT[a] === SCRIPT[b]) return /[іїєґ]/iu.test(s) ? (a === 'uk' ? a : b) : a === 'ru' ? a : b;
  if (letters > 0) {
    // Latin letters and only one side writes in Latin letters.
    const aLatin = !SCRIPT[a];
    const bLatin = !SCRIPT[b];
    if (aLatin !== bLatin && letters > ca + cb) return aLatin ? a : b;
    const clear = clearLang(s);
    const asText = (l: InterpLang) => ((TEXT_LANGS as readonly string[]).includes(l) ? (l as TextLang) : undefined);
    if (clear && (clear === asText(a) || clear === asText(b))) return clear === asText(a) ? a : b;
  }
  if (o.hint === a || o.hint === b) return o.hint;
  if (o.last === a) return b;
  if (o.last === b) return a;
  return a;
}

const NAMES = new Intl.DisplayNames(['en'], { type: 'language' });
const langName = (l: InterpLang) => NAMES.of(l) ?? l;

const CONV = { id: '', title: 'Interpreter', providerId: null, model: null, workspace: '', mode: 'chat', private: false, channel: null, channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [] } as unknown as Conversation;
const CAP = { runs: 2000, tokens: 2_000_000 };

export type TurnResult = { ok: true; from: InterpLang; to: InterpLang; text: string } | { ok: false; from: InterpLang; to: InterpLang; why: string };

function system(a: InterpLang, b: InterpLang, guess: InterpLang): string {
  const other = guess === a ? b : a;
  return `You are a live interpreter between ${langName(a)} (${a}) and ${langName(b)} (${b}). The words between the DATA lines were just said out loud, most likely in ${langName(guess)}. Translate them into the other language (${langName(other)} if they are in ${langName(guess)}). Keep the meaning, tone and politeness; write natural spoken sentences; add nothing, explain nothing, never answer the words yourself. If the words are a question, translate the question. Answer with JSON only: {"from":"<the code of the language they were said in>","text":"<the translation>"}`;
}

/** Reads the model's answer: JSON {from,text}, or a plain translation. */
function readAnswer(raw: string, a: InterpLang, b: InterpLang, guess: InterpLang): { from: InterpLang; text: string } {
  const body = raw.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  const m = body.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { from?: unknown; text?: unknown };
      const from = interpLang(j.from);
      if (typeof j.text === 'string') return { from: from === a || from === b ? from : guess, text: j.text.trim() };
    } catch {
      // not JSON: the plain text below
    }
  }
  return { from: guess, text: body.replace(/^["“]|["”]$/g, '').trim() };
}

/** One turn: which side spoke, and the words in the other language. Never throws. */
export async function translateTurn(app: AppContext, said: string, prefs: InterpPrefs, o: { hint?: InterpLang; last?: InterpLang } = {}): Promise<TurnResult> {
  const { a, b } = prefs;
  const words = said.trim().slice(0, MAX_SAID);
  const guess = guessSide(words, a, b, o);
  const to0 = guess === a ? b : a;
  const messages = [
    { role: 'system' as const, content: system(a, b, guess) },
    { role: 'user' as const, content: fenceLines([words], 'Words said out loud') },
  ];
  const ask = (model: 'local' | 'quick') => cheapCall(app, { source: 'interpreter', purpose: 'interpreter', conv: CONV, model, messages, maxTokens: 400, temperature: 0.2, cap: CAP, estTokens: 600, timeoutMs: 60_000 });
  let r = await ask('local');
  if (!r.ok && r.skipped === 'no-model' && prefs.cloud) r = await ask('quick');
  if (!r.ok) {
    const why = r.skipped === 'no-model' ? (prefs.cloud ? en('No model is set up to translate.') : en('There is no model on this computer to translate. Turn on “Use a cloud model” in Settings → Sara → Voice → Interpreter, or add a local model.')) : r.skipped === 'cap' ? en('The interpreter reached today’s limit.') : en('The translation did not work. Try again.');
    return { ok: false, from: guess, to: to0, why };
  }
  const ans = readAnswer(r.text, a, b, guess);
  if (!ans.text) return { ok: false, from: ans.from, to: ans.from === a ? b : a, why: en('The translation did not work. Try again.') };
  return { ok: true, from: ans.from, to: ans.from === a ? b : a, text: ans.text };
}

/** A local voice whose id or label names the language (Piper ids carry `es_ES`, labels often say "Spanish"). */
export function voiceForLang(voices: { id: string; label: string }[], lang: string): string | undefined {
  const l = interpLang(lang);
  if (!l) return undefined;
  const name = langName(l).toLowerCase();
  const code = new RegExp(`(^|[^a-z])${l}([_-][a-z]{2}|[^a-z]|$)`, 'i');
  return voices.find((v) => code.test(v.id.replace(/^[a-z]+:/i, '')))?.id ?? voices.find((v) => v.label.toLowerCase().includes(name))?.id;
}

const ID_RE = /^[a-z0-9]{16}$/;

/** The saved transcripts of one person (one JSON file per session; newest 100 kept). */
export class InterpreterLog {
  readonly dir: string;
  readonly #now: () => Date;
  constructor(dataDir: string, now: () => Date) {
    this.dir = join(dataDir, 'interpreter');
    this.#now = now;
  }

  #file(id: string) {
    return join(this.dir, `${id}.json`);
  }

  #save(s: InterpSession) {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.#file(s.id)}.tmp`;
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, this.#file(s.id));
  }

  start(a: InterpLang, b: InterpLang): InterpSession {
    const s: InterpSession = { id: randomBytes(8).toString('hex'), a, b, startedAt: this.#now().toISOString(), lines: [] };
    this.#save(s);
    this.#prune();
    return s;
  }

  get(id: string): InterpSession | undefined {
    if (!ID_RE.test(id) || !existsSync(this.#file(id))) return undefined;
    try {
      return JSON.parse(readFileSync(this.#file(id), 'utf8')) as InterpSession;
    } catch {
      return undefined;
    }
  }

  add(id: string, l: Omit<InterpLine, 'at'>): InterpLine | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    const line: InterpLine = { at: this.#now().toISOString(), ...l, said: l.said.slice(0, MAX_SAID), text: l.text.slice(0, 2 * MAX_SAID) };
    s.lines.push(line);
    if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
    this.#save(s);
    return line;
  }

  end(id: string): InterpSession | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    s.endedAt = this.#now().toISOString();
    this.#save(s);
    return s;
  }

  remove(id: string): boolean {
    if (!this.get(id)) return false;
    rmSync(this.#file(id), { force: true });
    return true;
  }

  #all(): InterpSession[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .filter((s): s is InterpSession => Boolean(s))
      .sort((x, y) => (x.startedAt < y.startedAt ? 1 : x.startedAt > y.startedAt ? -1 : x.id < y.id ? 1 : -1));
  }

  #prune() {
    for (const s of this.#all().slice(KEEP_SESSIONS)) rmSync(this.#file(s.id), { force: true });
  }

  /** Newest first, without the lines. */
  list(): { id: string; a: InterpLang; b: InterpLang; startedAt: string; endedAt?: string; count: number; first: string }[] {
    return this.#all().map((s) => ({ id: s.id, a: s.a, b: s.b, startedAt: s.startedAt, ...(s.endedAt ? { endedAt: s.endedAt } : {}), count: s.lines.length, first: s.lines[0]?.said.slice(0, 80) ?? '' }));
  }

  /** A plain-text copy (what was said, then the translation under it). */
  text(id: string): string | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    const head = `${langName(s.a)} ↔ ${langName(s.b)} · ${s.startedAt.slice(0, 16).replace('T', ' ')} UTC`;
    const body = s.lines.map((l) => `[${l.at.slice(11, 19)}] ${l.said}\n    → ${l.text || '—'}`);
    return `${head}\n\n${body.join('\n\n')}\n`;
  }
}

const logs = new Map<string, InterpreterLog>();
export function interpreterLog(app: AppContext): InterpreterLog {
  let l = logs.get(app.dataDir);
  if (!l) logs.set(app.dataDir, (l = new InterpreterLog(app.dataDir, () => app.now())));
  return l;
}
