// U4.23 (docs/LEARNING.md "Learning coach"): study sets made from a Library document, one of its
// chapters, or pasted text: flashcards (front/back and cloze), quiz cards (multiple choice, shown in
// chat as S10 choice cards; short answers graded against a rubric with kind feedback) and a summary
// sheet. Spaced repetition is SM-2, local, per space (a household member's sets live in their own
// space). The reminder tick posts one "cards due" reminder a day at the chosen time; the Today tile
// counts due cards. Kid mode (R8): wording for their age, a hint before every answer, and their
// homework is coached, never answered (the S11 rule: the cards hold guiding steps, not answers; no
// summary sheet); a parent sees titles and counts in Family, never the card text.
// Cost cap: one model call per set on at most STUDY.maxChars of text, at most `maxCards` cards kept;
// a short answer costs one small call. Any model works (local ones too); when the reply is not JSON
// the cards are made locally (cloze cards and a few multiple-choice ones from the text itself).
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { postAlert } from './destinations.ts';
import { localDay } from './family.ts';
import { isAssignment } from './humanize.ts';
import { en, trOwner } from './i18n.ts';
import { complete, quietNow } from './life.ts';
import { privateLocalOn } from './net-guard.ts';
import { zonedParts } from './planner.ts';
import { backgroundConversation } from './store.ts';

export const STUDY = { maxChars: 24_000, maxSets: 200, cardsDefault: 20, cardsMin: 5, cardsMax: 60, newDefault: 20, maxImport: 2000 } as const;
export const CARD_KINDS = ['basic', 'cloze', 'choice', 'short'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
export const GRADES = [1, 3, 4, 5] as const; // Again, Hard, Good, Easy

export interface CardDraft {
  kind: CardKind;
  front: string;
  back: string;
  hint?: string;
  choices?: string[];
  rubric?: string;
  /** A cloze card's original text with {{c1::…}} (Anki export). */
  raw?: string;
}
export interface Card extends Required<Pick<CardDraft, 'kind' | 'front' | 'back'>> {
  id: number;
  setId: number;
  hint: string | null;
  choices: string[] | null;
  rubric: string | null;
  raw: string | null;
  ease: number;
  interval: number;
  reps: number;
  lapses: number;
  due: string;
  lastGrade: number | null;
}
export interface StudySource {
  kind: 'text' | 'library' | 'import';
  docId?: number;
  section?: number;
  label?: string;
}
export interface StudySet {
  id: number;
  title: string;
  summary: string[];
  source: StudySource;
  made: 'model' | 'local' | 'import';
  kid: boolean;
  coach: boolean;
  createdAt: string;
}
export interface StudyPrefs {
  remind: boolean;
  remindAt: string;
  newPerDay: number;
  maxCards: number;
}
export interface StudyOptions {
  /** Tests: the model call (default: the background model through complete()). */
  model?: (system: string, user: string, maxTokens: number) => Promise<string>;
  notify?: (title: string, body: string, tag: string) => Promise<void>;
  quiet?: () => boolean;
}
export class StudyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const STUDY_LINES = [en('Study set not found.'), en('Card not found.'), en('Document not found.'), en('There is no text to study.'), en('Grade 1 (Again), 3 (Hard), 4 (Good) or 5 (Easy).'), en('You have the most study sets this keeps.'), en('No cards to import.')];

// ------------------------------------------------------------------ SM-2
export function sm2(s: { ease: number; interval: number; reps: number; lapses: number }, q: number): { ease: number; interval: number; reps: number; lapses: number } {
  const ease = Math.max(1.3, Math.round((s.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)) * 100) / 100);
  if (q < 3) return { ease, interval: 1, reps: 0, lapses: s.lapses + 1 };
  const interval = s.reps === 0 ? 1 : s.reps === 1 ? 6 : Math.max(1, Math.round(s.interval * s.ease));
  return { ease, interval, reps: s.reps + 1, lapses: s.lapses };
}
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ cleaning cards
const clip = (v: unknown, n: number) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const CLOZE = /\{\{c\d+::(.+?)(?:::(.+?))?\}\}/;
export function cleanCard(v: Record<string, unknown>): CardDraft | undefined {
  let kind = String(v.type ?? v.kind ?? 'basic').toLowerCase() as CardKind;
  const raw = clip(v.text ?? v.raw ?? '', 600);
  let front = clip(v.front ?? v.question ?? v.q ?? '', 600);
  let back = clip(v.back ?? v.answer ?? v.a ?? '', 600);
  const hint = clip(v.hint ?? '', 300) || undefined;
  if (CLOZE.test(raw || front)) {
    const src = raw || front;
    const m = src.match(CLOZE)!;
    return { kind: 'cloze', front: src.replace(/\{\{c\d+::(.+?)(?:::(.+?))?\}\}/g, '[…]'), back: m[1].trim(), raw: src, ...(hint ?? m[2] ? { hint: hint ?? m[2]!.trim() } : {}) };
  }
  if (!CARD_KINDS.includes(kind)) kind = 'basic';
  if (kind === 'choice') {
    const choices = (Array.isArray(v.choices ?? v.options) ? (v.choices ?? v.options) as unknown[] : []).map((c) => clip(c, 200)).filter(Boolean).slice(0, 6);
    if (!back && typeof v.correct === 'number') back = choices[v.correct] ?? '';
    if (choices.length < 2 || !back) kind = 'basic';
    else {
      if (!choices.some((c) => fold(c) === fold(back))) choices[choices.length - 1] = back;
      return { kind, front, back, choices, ...(hint ? { hint } : {}) };
    }
  }
  if (!front || !back) return undefined;
  const rubric = kind === 'short' ? clip(v.rubric ?? '', 500) || undefined : undefined;
  return { kind, front, back, ...(hint ? { hint } : {}), ...(rubric ? { rubric } : {}) };
}
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The JSON object in a model reply (fenced or not). */
function jsonOf(reply: string): Record<string, unknown> | undefined {
  const s = reply.replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m)).replace(/```[\s\S]*$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ local cards (no model needed)
const PRONOUN = /^(it|this|that|these|those|they|he|she|we|there|here|es|esto|il|elle|ce|cela|er|sie|das|ele|ela|isso|esso|questo)$/i;
const sentencesOf = (text: string) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=\p{Lu}|\d)/u).map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 300);

/** Cloze and multiple-choice cards and a summary sheet made from the text alone (small or no model). */
export function localCards(text: string, max: number): { summary: string[]; cards: CardDraft[] } {
  const cards: CardDraft[] = [];
  for (const s of sentencesOf(text)) {
    if (cards.length >= max) break;
    let term: string | undefined;
    const def = s.match(/^(?:the |a |an )?([\p{L}][\p{L}\p{N} '-]{1,40}?) (?:is|are|was|were|means|refers to|es|son|est|sont|ist|sind|é|são|è|sono) /iu);
    if (def && !PRONOUN.test(def[1].trim()) && def[1].split(' ').length <= 4) term = def[1].trim();
    term ??= s.match(/\b(?:called|named|known as|llamad[oa]s?|appelée?s?|genannt|chamad[oa]s?|chiamat[oi])\s+([\p{L}][\p{L}-]+)/iu)?.[1];
    term ??= s.match(/\b(1\d{3}|20\d{2})\b/)?.[1];
    if (!term) continue;
    const front = s.replace(term, '[…]');
    if (front === s) continue;
    cards.push({ kind: 'cloze', front, back: term, raw: s.replace(term, `{{c1::${term}}}`) });
  }
  // A few multiple-choice cards from the cloze answers (the other answers are the wrong choices).
  const answers = [...new Set(cards.map((c) => c.back))];
  if (answers.length >= 3) {
    for (const c of cards.slice(0, 3)) {
      if (cards.length >= max) break;
      const others = answers.filter((a) => a !== c.back).slice(0, 3);
      const choices = [c.back, ...others].sort((a, b) => fold(a).localeCompare(fold(b)));
      cards.push({ kind: 'choice', front: c.front, back: c.back, choices });
    }
  }
  const paras = text.split(/\n\s*\n/).map((p) => sentencesOf(p)[0]).filter(Boolean);
  const summary = (paras.length >= 2 ? paras : sentencesOf(text)).slice(0, 6);
  return { summary, cards };
}

// ------------------------------------------------------------------ export / import
const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const frontOf = (c: Pick<Card, 'kind' | 'front' | 'raw'>) => (c.kind === 'cloze' && c.raw ? c.raw : c.front);
export function toCsv(cards: Pick<Card, 'kind' | 'front' | 'back' | 'hint' | 'choices' | 'rubric' | 'raw'>[]): string {
  const rows = cards.map((c) => [frontOf(c), c.back, c.kind, c.hint ?? '', (c.choices ?? []).join(' | '), c.rubric ?? ''].map(csvCell).join(','));
  return ['front,back,kind,hint,choices,rubric', ...rows].join('\n') + '\n';
}
export function toAnki(cards: Pick<Card, 'kind' | 'front' | 'back' | 'hint' | 'choices' | 'rubric' | 'raw'>[]): string {
  const tab = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  const rows = cards.map((c) => (c.kind === 'cloze' ? [frontOf(c), c.hint ?? '', 'Cloze', 'sara'] : [c.kind === 'choice' && c.choices ? `${c.front} (${c.choices.join(' / ')})` : c.front, c.back, 'Basic', 'sara']).map(tab).join('\t'));
  return ['#separator:tab', '#html:false', '#notetype column:3', '#tags column:4', ...rows].join('\n') + '\n';
}
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c.trim()));
}
export function fromCsv(text: string): CardDraft[] {
  const rows = csvRows(text.replace(/^\uFEFF/, ''));
  const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const named = head.includes('front');
  const col = (n: string, d: number) => (named ? head.indexOf(n) : d);
  return (named ? rows.slice(1) : rows).slice(0, STUDY.maxImport).map((r) => {
    const at = (n: string, d: number) => (col(n, d) >= 0 ? r[col(n, d)] ?? '' : '');
    return cleanCard({ front: at('front', 0), back: at('back', 1), type: at('kind', 2) || 'basic', hint: at('hint', 3), choices: at('choices', 4).split(' | ').filter(Boolean), answer: at('back', 1), rubric: at('rubric', 5) });
  }).filter((c): c is CardDraft => Boolean(c));
}
export function fromAnki(text: string): CardDraft[] {
  let sep = '\t';
  const out: CardDraft[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line.startsWith('#')) {
      const m = line.match(/^#separator:(\w+)/i);
      if (m) sep = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' }[m[1].toLowerCase()] ?? '\t';
      continue;
    }
    if (!line.trim()) continue;
    const [front = '', back = ''] = line.split(sep).map((s) => s.replace(/<[^>]+>/g, ' ').trim());
    const c = CLOZE.test(front) ? cleanCard({ text: front, hint: back }) : cleanCard({ front, back });
    if (c) out.push(c);
    if (out.length >= STUDY.maxImport) break;
  }
  return out;
}

// ------------------------------------------------------------------ the engine
const SCHEMA = `
CREATE TABLE IF NOT EXISTS study_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT '{}', made TEXT NOT NULL DEFAULT 'model', kid INTEGER NOT NULL DEFAULT 0, coach INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS study_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, set_id INTEGER NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, front TEXT NOT NULL, back TEXT NOT NULL, hint TEXT, choices TEXT, rubric TEXT, raw TEXT, ease REAL NOT NULL DEFAULT 2.5, interval INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, due TEXT NOT NULL, last_grade INTEGER, seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS study_cards_set ON study_cards (set_id, ord);
CREATE TABLE IF NOT EXISTS study_log (id INTEGER PRIMARY KEY AUTOINCREMENT, set_id INTEGER NOT NULL, card_id INTEGER NOT NULL, day TEXT NOT NULL, grade INTEGER NOT NULL, first INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS study_prefs (k TEXT PRIMARY KEY, v TEXT NOT NULL);`;

type CardRow = { id: number; set_id: number; kind: CardKind; front: string; back: string; hint: string | null; choices: string | null; rubric: string | null; raw: string | null; ease: number; interval: number; reps: number; lapses: number; due: string; last_grade: number | null; seen: number };
type SetRow = { id: number; title: string; summary: string; source: string; made: StudySet['made']; kid: number; coach: number; created_at: string };

export class Study {
  readonly #app: AppContext;
  readonly #db: DatabaseSync;
  readonly #o: StudyOptions;

  constructor(app: AppContext, db: DatabaseSync = app.store.db, o: StudyOptions = {}) {
    this.#app = app;
    this.#db = db;
    this.#o = o;
    db.exec(SCHEMA);
  }

  #now(): Date {
    return this.#app.now();
  }
  #tz(): string | undefined {
    return this.#app.settings.get().timeZone || undefined;
  }
  today(): string {
    return localDay(this.#now(), this.#tz());
  }
  #T(s: string, p?: Record<string, unknown>): string {
    return trOwner(s, this.#app.settings.get(), p);
  }
  #kid(): { band: string } | undefined {
    const c = this.#app.member?.child?.();
    return c ? { band: String((c as { band?: string }).band ?? '10-12') } : undefined;
  }

  // ---------------------------------------------------------------- prefs
  prefs(): StudyPrefs {
    const rows = Object.fromEntries((this.#db.prepare('SELECT k, v FROM study_prefs').all() as { k: string; v: string }[]).map((r) => [r.k, r.v]));
    const num = (v: string | undefined, d: number, lo: number, hi: number) => (v != null && Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
    return {
      remind: rows.remind !== '0',
      remindAt: /^\d\d:\d\d$/.test(rows.remindAt ?? '') ? rows.remindAt : '16:00',
      newPerDay: num(rows.newPerDay, STUDY.newDefault, 0, 200),
      maxCards: num(rows.maxCards, STUDY.cardsDefault, STUDY.cardsMin, STUDY.cardsMax),
    };
  }
  setPrefs(p: Partial<StudyPrefs>): StudyPrefs {
    const put = this.#db.prepare('INSERT INTO study_prefs (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
    if (typeof p.remind === 'boolean') put.run('remind', p.remind ? '1' : '0');
    if (typeof p.remindAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.remindAt)) put.run('remindAt', p.remindAt);
    if (Number.isFinite(Number(p.newPerDay)) && p.newPerDay != null) put.run('newPerDay', String(Math.round(Number(p.newPerDay))));
    if (Number.isFinite(Number(p.maxCards)) && p.maxCards != null) put.run('maxCards', String(Math.round(Number(p.maxCards))));
    return this.prefs();
  }

  // ---------------------------------------------------------------- reading
  #set(r: SetRow): StudySet {
    return { id: r.id, title: r.title, summary: JSON.parse(r.summary) as string[], source: JSON.parse(r.source) as StudySource, made: r.made, kid: Boolean(r.kid), coach: Boolean(r.coach), createdAt: r.created_at };
  }
  #card(r: CardRow): Card {
    return { id: r.id, setId: r.set_id, kind: r.kind, front: r.front, back: r.back, hint: r.hint, choices: r.choices ? (JSON.parse(r.choices) as string[]) : null, rubric: r.rubric, raw: r.raw, ease: r.ease, interval: r.interval, reps: r.reps, lapses: r.lapses, due: r.due, lastGrade: r.last_grade };
  }
  list(): StudySet[] {
    return (this.#db.prepare('SELECT * FROM study_sets ORDER BY id DESC').all() as SetRow[]).map((r) => this.#set(r));
  }
  get(id: number): StudySet | undefined {
    const r = this.#db.prepare('SELECT * FROM study_sets WHERE id = ?').get(id) as SetRow | undefined;
    return r ? this.#set(r) : undefined;
  }
  #must(id: number): StudySet {
    const s = this.get(id);
    if (!s) throw new StudyError(404, en('Study set not found.'));
    return s;
  }
  cards(setId: number): Card[] {
    return (this.#db.prepare('SELECT * FROM study_cards WHERE set_id = ? ORDER BY ord').all(setId) as CardRow[]).map((r) => this.#card(r));
  }
  card(id: number): Card | undefined {
    const r = this.#db.prepare('SELECT * FROM study_cards WHERE id = ?').get(id) as CardRow | undefined;
    return r ? this.#card(r) : undefined;
  }
  #mustCard(id: number): Card {
    const c = this.card(id);
    if (!c) throw new StudyError(404, en('Card not found.'));
    return c;
  }
  #newToday(): number {
    return Number((this.#db.prepare('SELECT COUNT(*) AS n FROM study_log WHERE day = ? AND first = 1').get(this.today()) as { n: number }).n);
  }
  /** Cards to study now: seen cards that are due, then new ones up to the daily limit. */
  queue(setId?: number, limit = 200): Card[] {
    const where = setId ? 'AND set_id = ?' : '';
    const args = setId ? [setId] : [];
    const today = this.today();
    const old = (this.#db.prepare(`SELECT * FROM study_cards WHERE seen = 1 AND due <= ? ${where} ORDER BY due, id LIMIT ?`).all(today, ...args, limit) as CardRow[]).map((r) => this.#card(r));
    const room = Math.max(0, this.prefs().newPerDay - this.#newToday());
    const fresh = room ? (this.#db.prepare(`SELECT * FROM study_cards WHERE seen = 0 ${where} ORDER BY set_id, ord LIMIT ?`).all(...args, Math.min(room, limit)) as CardRow[]).map((r) => this.#card(r)) : [];
    return [...old, ...fresh].slice(0, limit);
  }
  next(setId?: number): Card | undefined {
    return this.queue(setId, 1)[0];
  }
  dueCount(setId?: number): number {
    return this.queue(setId, 10_000).length;
  }
  progress(setId: number): { cards: number; due: number; learned: number; reviewedToday: number; streak: number; pct: number } {
    const n = (sql: string, ...a: (string | number)[]) => Number((this.#db.prepare(sql).get(...a) as { n: number }).n);
    const cards = n('SELECT COUNT(*) AS n FROM study_cards WHERE set_id = ?', setId);
    const learned = n('SELECT COUNT(*) AS n FROM study_cards WHERE set_id = ? AND reps >= 2', setId);
    const today = this.today();
    const reviewedToday = n('SELECT COUNT(DISTINCT card_id) AS n FROM study_log WHERE set_id = ? AND day = ?', setId, today);
    const days = new Set((this.#db.prepare('SELECT DISTINCT day FROM study_log WHERE set_id = ?').all(setId) as { day: string }[]).map((r) => r.day));
    let streak = 0;
    for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) streak++;
    return { cards, due: this.dueCount(setId), learned, reviewedToday, streak, pct: cards ? Math.round((learned / cards) * 100) : 0 };
  }

  // ---------------------------------------------------------------- making a set
  async #model(system: string, user: string, maxTokens: number): Promise<string> {
    if (this.#o.model) return this.#o.model(system, user, maxTokens);
    const conv = backgroundConversation(this.#app.store, 'Study');
    return complete(this.#app, conv, [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, 'background');
  }
  #sourceText(o: { text?: string; docId?: number; section?: number }): { text: string; title?: string; source: StudySource } {
    if (o.docId != null) {
      const lib = this.#app.library;
      const doc = lib?.get(Number(o.docId));
      if (!lib || !doc) throw new StudyError(404, en('Document not found.'));
      const name = doc.title || doc.name;
      const sec = o.section != null ? lib.sections(doc.id).find((s) => s.id === Number(o.section)) : undefined;
      let text = sec ? lib.pagesText(doc.id, sec.page, sec.pageEnd, STUDY.maxChars) : '';
      if (!text.trim()) {
        const rows = this.#db.prepare(sec ? 'SELECT text FROM library_passages WHERE doc_id = ? AND heading = ? ORDER BY ord' : 'SELECT text FROM library_passages WHERE doc_id = ? ORDER BY ord').all(...(sec ? [doc.id, sec.title] : [doc.id])) as { text: string }[];
        text = rows.map((r) => r.text).join('\n\n');
      }
      return { text, title: sec ? sec.title : name, source: { kind: 'library', docId: doc.id, ...(sec ? { section: sec.id } : {}), label: sec ? `${name} · ${sec.title}` : name } };
    }
    return { text: String(o.text ?? ''), source: { kind: 'text' } };
  }
  async make(o: { text?: string; docId?: number; section?: number; title?: string; signal?: AbortSignal }): Promise<StudySet> {
    const src = this.#sourceText(o);
    const text = src.text.replace(/\r/g, '').trim().slice(0, STUDY.maxChars);
    if (text.length < 20) throw new StudyError(400, en('There is no text to study.'));
    if (Number((this.#db.prepare('SELECT COUNT(*) AS n FROM study_sets').get() as { n: number }).n) >= STUDY.maxSets) throw new StudyError(409, en('You have the most study sets this keeps.'));
    const max = this.prefs().maxCards;
    const kid = this.#kid();
    const coach = Boolean(kid) && (isAssignment(`${o.title ?? ''} ${text.slice(0, 400)}`) || (text.match(/\?\s*$/gm)?.length ?? 0) >= 3);
    const lines = [
      'You make study material from the text the user gives. Answer with JSON only, no other words:',
      `{"title": "short title", "summary": ["3 to 8 short key points"], "cards": [at most ${max} cards]}.`,
      'Card types: {"type":"basic","front":"question","back":"answer","hint":"a nudge"}; {"type":"cloze","text":"a sentence with {{c1::the hidden words}}"}; {"type":"choice","front":"question","choices":["4 options"],"answer":"the right option"}; {"type":"short","front":"question","back":"model answer","rubric":"what a good answer must mention"}.',
      'Mix the types. Use only facts in the text. Write in the language of the text.',
    ];
    if (kid) lines.push(`The learner is a child aged ${kid.band}. Use simple, friendly words for that age. Every card gets a hint that helps without giving the answer away.`);
    if (coach) lines.push('This is their homework: never give the answers and never write it for them. Each card front is one question from it; the back is a guiding question or the first step to try (never the answer); add a hint. summary: [].');
    let made: StudySet['made'] = 'model';
    let title = clip(o.title ?? src.title ?? '', 120);
    let summary: string[] = [];
    let drafts: CardDraft[] = [];
    let reply = '';
    try {
      reply = await this.#model(lines.join('\n'), text, 4000);
    } catch {
      reply = '';
    }
    const j = jsonOf(reply);
    if (j && Array.isArray(j.cards)) {
      drafts = (j.cards as unknown[]).map((c) => (c && typeof c === 'object' ? cleanCard(c as Record<string, unknown>) : undefined)).filter((c): c is CardDraft => Boolean(c));
      summary = (Array.isArray(j.summary) ? j.summary : []).map((s) => clip(s, 300)).filter(Boolean).slice(0, 10);
      title ||= clip(j.title, 120);
    }
    if (!drafts.length) {
      const local = localCards(text, max);
      drafts = local.cards;
      summary = local.summary;
      made = 'local';
    }
    drafts = drafts.slice(0, max);
    if (coach) {
      summary = [];
      drafts = drafts.map((c) => ({ kind: 'basic', front: c.front, back: c.hint ?? en('Try it yourself first: what do you already know? Then ask her for a hint.'), ...(c.hint ? { hint: c.hint } : {}) }));
    }
    title ||= clip(text.split('\n')[0], 80) || this.#T(en('Study set'));
    const set = this.#insert({ title, summary, source: src.source, made, kid: Boolean(kid), coach }, drafts);
    this.#tellParents();
    return set;
  }
  #insert(s: Omit<StudySet, 'id' | 'createdAt'>, drafts: CardDraft[]): StudySet {
    const today = this.today();
    this.#db.exec('BEGIN');
    try {
      const id = Number(this.#db.prepare('INSERT INTO study_sets (title, summary, source, made, kid, coach, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(s.title, JSON.stringify(s.summary), JSON.stringify(s.source), s.made, s.kid ? 1 : 0, s.coach ? 1 : 0, this.#now().toISOString()).lastInsertRowid);
      const put = this.#db.prepare('INSERT INTO study_cards (set_id, ord, kind, front, back, hint, choices, rubric, raw, due) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      drafts.forEach((c, i) => put.run(id, i, c.kind, c.front, c.back, c.hint ?? null, c.choices ? JSON.stringify(c.choices) : null, c.rubric ?? null, c.raw ?? null, today));
      this.#db.exec('COMMIT');
      return this.get(id)!;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
  importCards(title: string, drafts: CardDraft[]): StudySet {
    if (!drafts.length) throw new StudyError(400, en('No cards to import.'));
    return this.#insert({ title: clip(title, 120) || this.#T(en('Imported cards')), summary: [], source: { kind: 'import' }, made: 'import', kid: Boolean(this.#kid()), coach: false }, drafts.slice(0, STUDY.maxImport));
  }
  rename(id: number, title: string): StudySet {
    this.#must(id);
    this.#db.prepare('UPDATE study_sets SET title = ? WHERE id = ?').run(clip(title, 120) || this.#must(id).title, id);
    return this.get(id)!;
  }
  remove(id: number): void {
    this.#must(id);
    this.#db.prepare('DELETE FROM study_cards WHERE set_id = ?').run(id);
    this.#db.prepare('DELETE FROM study_log WHERE set_id = ?').run(id);
    this.#db.prepare('DELETE FROM study_sets WHERE id = ?').run(id);
    this.#tellParents();
  }

  // ---------------------------------------------------------------- studying
  review(cardId: number, grade: number): Card {
    if (!(GRADES as readonly number[]).includes(grade)) throw new StudyError(400, en('Grade 1 (Again), 3 (Hard), 4 (Good) or 5 (Easy).'));
    const c = this.#mustCard(cardId);
    const r = this.#db.prepare('SELECT seen FROM study_cards WHERE id = ?').get(cardId) as { seen: number };
    const next = sm2(c, grade);
    const today = this.today();
    const due = grade < 3 ? today : addDays(today, next.interval);
    this.#db.prepare('UPDATE study_cards SET ease = ?, interval = ?, reps = ?, lapses = ?, due = ?, last_grade = ?, seen = 1 WHERE id = ?').run(next.ease, next.interval, next.reps, next.lapses, due, grade, cardId);
    this.#db.prepare('INSERT INTO study_log (set_id, card_id, day, grade, first, at) VALUES (?, ?, ?, ?, ?, ?)').run(c.setId, cardId, today, grade, r.seen ? 0 : 1, this.#now().toISOString());
    this.#tellParents();
    this.#app.events?.publish({ type: 'today', part: 'study' } as never);
    return this.card(cardId)!;
  }
  /** Kid mode: the hint comes first; anyone: then the answer. */
  reveal(cardId: number, step: number): { step: 'hint' | 'answer'; text: string } {
    const c = this.#mustCard(cardId);
    if (step <= 0 && c.hint && (this.#kid() || this.get(c.setId)?.kid)) return { step: 'hint', text: c.hint };
    return { step: 'answer', text: c.back };
  }
  /** Grades an answer (multiple choice by itself, a short answer against its rubric), reviews the card. */
  async answer(cardId: number, given: string): Promise<{ correct: boolean; score: 0 | 1 | 2; feedback: string; answer: string; hint?: string }> {
    const c = this.#mustCard(cardId);
    const kid = Boolean(this.#kid());
    const coach = this.get(c.setId)?.coach;
    const said = clip(given, 1000);
    let score: 0 | 1 | 2 = 0;
    let feedback = '';
    if (c.kind === 'choice' || c.kind === 'cloze' || coach) {
      score = coach ? 1 : fold(said) === fold(c.back) || (c.kind === 'cloze' && fold(said).includes(fold(c.back))) ? 2 : 0;
    } else {
      const rubric = c.rubric || c.back;
      try {
        const sys = `You grade a learner's short answer against a rubric. Rubric: ${rubric}\nModel answer: ${c.back}\nAnswer with JSON only: {"score": 0, 1 or 2, "feedback": "one or two kind, encouraging sentences: what was right, what to add"}.${kid ? ' The learner is a child: very simple, warm words; never just give the answer, give a hint instead.' : ''} Write in the language of the question.`;
        const j = jsonOf(await this.#model(sys, `Question: ${c.front}\nTheir answer: ${said}`, 300));
        const s = Number(j?.score);
        if (j && [0, 1, 2].includes(s)) {
          score = s as 0 | 1 | 2;
          feedback = clip(j.feedback, 400);
        }
        if (!j || ![0, 1, 2].includes(s)) score = localScore(said, `${c.back} ${c.rubric ?? ''}`);
      } catch {
        score = localScore(said, `${c.back} ${c.rubric ?? ''}`);
      }
    }
    const hintFirst = kid && score < 2 && c.hint && !coach;
    if (!feedback) {
      if (coach) feedback = this.#T(en('Good thinking! Here is a step to try: {step}'), { step: c.back });
      else if (score === 2) feedback = this.#T(en('That’s right! {answer}'), { answer: c.back });
      else if (hintFirst) feedback = this.#T(en('Not quite yet. Hint: {hint} Want to try again?'), { hint: c.hint });
      else if (score === 1) feedback = this.#T(en('Close! The full answer: {answer}'), { answer: c.back });
      else feedback = this.#T(en('Not quite: the answer is {answer}. You’ll see this card again soon.'), { answer: c.back });
    }
    this.review(cardId, score === 2 ? 4 : score === 1 ? 3 : 1);
    return { correct: score === 2, score, feedback, answer: hintFirst || coach ? '' : c.back, ...(c.hint ? { hint: c.hint } : {}) };
  }

  // ---------------------------------------------------------------- Today, reminders, parents
  todayTile(): { due: number; sets: { id: number; title: string; due: number; pct: number }[] } | undefined {
    const sets = this.list().map((s) => ({ id: s.id, title: s.title, due: this.dueCount(s.id), pct: this.progress(s.id).pct })).filter((s) => s.due > 0);
    if (!sets.length) return undefined;
    return { due: this.dueCount(), sets: sets.slice(0, 4) };
  }
  /** The reminder tick: one "cards due" reminder a day at the chosen time. */
  due(now: Date = this.#now()): number {
    if (privateLocalOn()) return 0;
    let p: StudyPrefs;
    try {
      p = this.prefs();
    } catch {
      return 0;
    }
    if (!p.remind) return 0;
    const z = zonedParts(now, this.#tz());
    const [h, m] = p.remindAt.split(':').map(Number);
    if (z.h * 60 + z.mi < h * 60 + m) return 0;
    const day = localDay(now, this.#tz());
    const last = this.#db.prepare("SELECT v FROM study_prefs WHERE k = 'lastReminded'").get() as { v: string } | undefined;
    if (last?.v === day) return 0;
    const n = this.dueCount();
    if (!n) return 0;
    this.#db.prepare("INSERT INTO study_prefs (k, v) VALUES ('lastReminded', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(day);
    const sets = (this.todayTile()?.sets ?? []).map((s) => s.title).join(', ');
    const title = this.#T(en('Study cards due'));
    const body = this.#T(en('{n} cards are due today: {sets}.'), { n, sets });
    try {
      postAlert(this.#app, 'reminders', { role: 'notice', content: `study: ${body}`, meta: { study: { due: n } } });
    } catch {
      /* the reminder still pushes */
    }
    if (!(this.#o.quiet ? this.#o.quiet() : quietNow(this.#app, now))) {
      const push = this.#o.notify ?? ((a: string, b: string, tag: string) => this.#app.push?.notifyOwner(a, b, '/#view=study', tag) ?? Promise.resolve());
      void push(title, body, 'study-due').catch(() => undefined);
    }
    return 1;
  }
  /** A kid's progress for the parents' Family view: titles and counts only. */
  #tellParents(): void {
    const fam = this.#app.family;
    if (!fam || !this.#kid()) return;
    try {
      fam.store.noteStudy(fam.person, this.today(), this.list().map((s) => {
        const p = this.progress(s.id);
        return { set: s.id, title: s.title, cards: p.cards, learned: p.learned, due: p.due, reviewedToday: p.reviewedToday };
      }));
    } catch {
      /* the parent view is best effort */
    }
  }
}

const STOP = new Set('that this with from they their there have what when which into your about will would than then them were been because also just only some more most very such each other these those'.split(' '));
function localScore(given: string, want: string): 0 | 1 | 2 {
  const words = (s: string) => new Set(fold(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 6)));
  const need = words(want);
  if (!need.size) return 0;
  const have = words(given);
  const hit = [...need].filter((w) => have.has(w)).length / need.size;
  return hit >= 0.6 ? 2 : hit >= 0.3 ? 1 : 0;
}

export function studyFor(app: AppContext): Study {
  app.study ??= new Study(app, app.store.db);
  return app.study;
}
