// W4.3 (docs/LANGUAGE_PRACTICE.md): the state file of language practice and the note her system
// prompt gets in the practice chat (Talk at your level). No imports beyond node: chat.ts reads this.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEARN_LANGS = ['es', 'fr', 'de', 'pt', 'it', 'en'] as const;
export type LearnLang = (typeof LEARN_LANGS)[number];
export const LEARN_LEVELS = ['a1', 'a2', 'b1'] as const;
export type LearnLevel = (typeof LEARN_LEVELS)[number];

export const LANG_NAME: Record<LearnLang, string> = { es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', en: 'English' };
const LEVEL_WORDS: Record<LearnLevel, string> = {
  a1: 'A1 (beginner): very short, simple sentences, everyday words, present tense',
  a2: 'A2 (elementary): short sentences, everyday topics, simple past and future',
  b1: 'B1 (intermediate): natural sentences on familiar topics, opinions and plans',
};

export interface LearnState {
  lang: LearnLang | null;
  level: LearnLevel;
  daily: number;
  /** Study set per "<lang>:<level>". */
  sets: Record<string, number>;
  /** Local days with practice (YYYY-MM-DD, newest last). */
  days: string[];
  /** Words said right, per language (folded word → times). */
  words: Partial<Record<LearnLang, Record<string, number>>>;
  /** Sentence id → times said, per language. */
  said: Partial<Record<LearnLang, Record<string, number>>>;
  /** Day → sentences said that day. */
  saidOn: Record<string, number>;
  /** The practice chat per language. */
  talk: Partial<Record<LearnLang, string>>;
}

export const learnFile = (app: { dataDir: string }) => join(app.dataDir, 'lang-learn.json');

export function readLearn(app: { dataDir: string }): LearnState {
  const empty: LearnState = { lang: null, level: 'a1', daily: 10, sets: {}, days: [], words: {}, said: {}, saidOn: {}, talk: {} };
  const f = learnFile(app);
  if (!existsSync(f)) return empty;
  try {
    const v = JSON.parse(readFileSync(f, 'utf8')) as Partial<LearnState>;
    return {
      lang: LEARN_LANGS.includes(v.lang as LearnLang) ? (v.lang as LearnLang) : null,
      level: LEARN_LEVELS.includes(v.level as LearnLevel) ? (v.level as LearnLevel) : 'a1',
      daily: [5, 10, 20].includes(Number(v.daily)) ? Number(v.daily) : 10,
      sets: v.sets && typeof v.sets === 'object' ? v.sets : {},
      days: Array.isArray(v.days) ? v.days.filter((d) => /^\d{4}-\d\d-\d\d$/.test(d)).slice(-400) : [],
      words: v.words && typeof v.words === 'object' ? v.words : {},
      said: v.said && typeof v.said === 'object' ? v.said : {},
      saidOn: v.saidOn && typeof v.saidOn === 'object' ? v.saidOn : {},
      talk: v.talk && typeof v.talk === 'object' ? v.talk : {},
    };
  } catch {
    return empty;
  }
}

export function writeLearn(app: { dataDir: string }, s: LearnState): void {
  const f = learnFile(app);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, f);
}

/** Her system note in the practice chat: answer in the language, at the level, gentle corrections. */
export function learnTalkNote(app: { dataDir: string }, conv: { id: string }): string | undefined {
  if (!existsSync(learnFile(app))) return undefined;
  const s = readLearn(app);
  const lang = LEARN_LANGS.find((l) => s.talk[l] === conv.id);
  if (!lang) return undefined;
  const name = LANG_NAME[lang];
  return [
    `Language practice: the person is learning ${name}, level ${LEVEL_WORDS[s.level]}.`,
    `Talk with them only in ${name}, at that level: one or two short sentences per reply, then one simple question back so the talk goes on.`,
    `When they make a mistake, first answer what they meant, then add one gentle correction ("You could say: …") in ${name}; never more than one correction per reply, never a lecture.`,
    `If they are stuck or ask in another language, help with one short hint in their language, then go back to ${name}.`,
  ].join(' ');
}
