// S11 (docs/WRITING_STYLE.md): "Write like a person". Four parts, all here:
// - a deterministic checker (no model): stock phrases in six languages, em-dash rate, rule-of-three
//   lists, flat sentence rhythm, hedging stacks, empty intensifiers, headings in short pieces → a
//   0-100 "reads natural" score with counts. It shows the score and proves a rewrite improved.
// - the facts lock: numbers, names, quotes, citations [n] and links must be the same before and
//   after. A rewrite that breaks one is retried once; then the original sentences come back for the
//   broken spans; if that still fails, the text stays as written.
// - the rewrite pass (one model call on the 'writing' route, plus at most one retry) with explicit
//   rules, kept only when it reads better, stays in length and keeps every fact.
// - Match my voice: a short style card from 1-5 samples of the person's own writing, kept in their
//   own space's store (a household member's lives in their space; nobody else reads it).
// Kid mode: a child gets coaching on their own draft (suggestions and questions), never a rewrite;
// make_document refuses to write an assignment for a child (src/tools/make-document.ts).
// This is about clear, natural writing. It is not built or sold as a way around AI detectors or
// school rules.
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { detectDocLang, type DocLang } from './facts-lang.ts';
import { HttpError } from './http.ts';
import { complete } from './life.ts';
import { backgroundConversation, type Conversation } from './store.ts';
import { personaStyle, signOffNote } from './persona-style.ts';

export type WritingStyle = 'natural' | 'as-written';
export const WRITING_STYLES: readonly WritingStyle[] = ['natural', 'as-written'];
export const HUMANIZE_MAX_CHARS = 40_000;

// ------------------------------------------------------------------ the checker

/** Stock phrases, per language (lowercase; matched on whole words). */
const PHRASES: Record<DocLang, string[]> = {
  en: ['delve', 'delves', 'delving', 'delved', 'tapestry', 'testament to', "in today's fast-paced", "in today's world", "in today's digital age", "it's important to note", 'it is important to note', "it's worth noting", 'it is worth noting', 'in conclusion', 'in summary', 'moreover', 'furthermore', 'additionally', 'navigate the complexities', 'ever-evolving', 'ever-changing landscape', 'in the realm of', 'embark on', 'unlock the potential', 'unleash', 'game-changer', 'seamlessly', 'leverage', 'elevate your', 'plays a vital role', 'plays a crucial role', 'a crucial role', 'pivotal', 'underscores', 'showcasing', 'foster', 'holistic', 'multifaceted', 'intricate', 'meticulous', 'paramount', 'a beacon of', 'symphony of', 'look no further', 'dive into', 'deep dive', 'at the end of the day', 'whether you\'re', 'not only', 'boasts'],
  es: ['adentrarse', 'adentrémonos', 'profundizar en', 'tapiz', 'testimonio de', 'es importante destacar', 'es importante señalar', 'es importante tener en cuenta', 'cabe destacar', 'cabe señalar', 'en conclusión', 'en resumen', 'además', 'asimismo', 'por otra parte', 'en el mundo actual', 'en la era digital', 'sin lugar a dudas', 'desempeña un papel crucial', 'un papel fundamental', 'sumergirse en'],
  fr: ['plonger dans', 'plongeons', 'tapisserie', 'témoignage de', 'il est important de noter', 'il est important de souligner', 'il convient de noter', 'il convient de souligner', 'en conclusion', 'en résumé', 'de plus', 'en outre', 'par ailleurs', 'dans le monde actuel', "à l'ère numérique", 'un rôle crucial', 'un rôle essentiel', 'incontournable', 'sans aucun doute'],
  de: ['eintauchen', 'tauchen wir ein', 'facettenreich', 'ein zeugnis', 'es ist wichtig zu beachten', 'es ist wichtig zu erwähnen', 'es ist wichtig zu betonen', 'zusammenfassend', 'abschließend lässt sich sagen', 'darüber hinaus', 'außerdem', 'des weiteren', 'in der heutigen schnelllebigen', 'in der heutigen zeit', 'im digitalen zeitalter', 'eine entscheidende rolle', 'nicht zuletzt', 'ohne zweifel'],
  pt: ['mergulhar', 'mergulhemos', 'aprofundar', 'tapeçaria', 'testemunho de', 'é importante notar', 'é importante ressaltar', 'é importante destacar', 'vale ressaltar', 'vale destacar', 'em conclusão', 'em suma', 'em resumo', 'além disso', 'ademais', 'no mundo atual', 'na era digital', 'um papel crucial', 'um papel fundamental', 'sem dúvida'],
  it: ['addentrarsi', 'addentriamoci', 'approfondire', 'arazzo', 'testimonianza di', 'è importante notare', 'è importante sottolineare', 'vale la pena notare', 'va sottolineato', 'in conclusione', 'in sintesi', 'in definitiva', 'inoltre', 'nel mondo odierno', "nell'era digitale", 'un ruolo cruciale', 'un ruolo fondamentale', 'senza dubbio'],
};
const INTENSIFIERS: Record<DocLang, string[]> = {
  en: ['truly', 'incredibly', 'extremely', 'absolutely', 'deeply', 'remarkably', 'utterly', 'very unique', 'super important', 'literally'],
  es: ['verdaderamente', 'increíblemente', 'sumamente', 'absolutamente', 'realmente'],
  fr: ['véritablement', 'incroyablement', 'extrêmement', 'absolument', 'vraiment'],
  de: ['wirklich', 'unglaublich', 'äußerst', 'absolut', 'zutiefst'],
  pt: ['verdadeiramente', 'incrivelmente', 'extremamente', 'absolutamente', 'realmente'],
  it: ['veramente', 'incredibilmente', 'estremamente', 'assolutamente', 'davvero'],
};
const HEDGES: Record<DocLang, string[]> = {
  en: ['may', 'might', 'could', 'perhaps', 'possibly', 'potentially', 'arguably', 'seemingly', 'somewhat', 'it seems', 'to some extent', 'generally speaking', 'in some ways'],
  es: ['quizás', 'tal vez', 'posiblemente', 'podría', 'en cierta medida', 'aparentemente'],
  fr: ['peut-être', 'éventuellement', 'possiblement', 'pourrait', 'dans une certaine mesure', 'apparemment'],
  de: ['vielleicht', 'möglicherweise', 'eventuell', 'könnte', 'gewissermaßen', 'scheinbar'],
  pt: ['talvez', 'possivelmente', 'poderia', 'de certa forma', 'aparentemente', 'potencialmente'],
  it: ['forse', 'possibilmente', 'potrebbe', 'in una certa misura', 'apparentemente', 'potenzialmente'],
};
const AND: Record<DocLang, string> = { en: 'and|or', es: 'y|e|o', fr: 'et|ou', de: 'und|oder', pt: 'e|ou', it: 'e|ed|o' };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (p: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(p)}(?![\\p{L}\\p{N}])`, 'giu');
const norm = (s: string) => s.replace(/[’‘]/g, "'").toLowerCase();
const countOf = (re: RegExp, s: string) => (s.match(re) ?? []).length;

/** Words in a text (Markdown marks left out). */
export function wordCount(s: string): number {
  return (s.replace(/[#>*_`|[\]()-]+/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’.,:/$%-]*/gu) ?? []).length;
}

/** Sentences (headings, bullets and paragraphs break sentences too). */
export function sentences(s: string): string[] {
  return s.split(/\n+/).flatMap((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/, '').split(/(?<=[.!?…])\s+(?=["“«„(¿¡]?[\p{Lu}\p{N}[])/u)).map((x) => x.trim()).filter((x) => /[\p{L}\p{N}]/u.test(x));
}

export type FlagKind = 'phrase' | 'intensifier' | 'hedge' | 'em-dash' | 'triplet' | 'rhythm' | 'headings';
export interface Flag {
  kind: FlagKind;
  text: string;
  count: number;
}
export interface CheckResult {
  lang: DocLang;
  words: number;
  sentences: number;
  /** 0-100: how natural it reads (100 = nothing flagged). */
  score: number;
  label: 'natural' | 'mixed' | 'stiff';
  flags: Flag[];
  emDashPer1k: number;
  triplets: number;
  /** Sentence-length variation (standard deviation / mean); low = flat rhythm. */
  sentenceCv: number;
  headings: number;
}

/** The deterministic "reads natural" check. `lang` defaults to the text's own language. */
export function checkText(text: string, lang?: DocLang): CheckResult {
  const l = lang ?? detectDocLang(text);
  const body = text.replace(/https?:\/\/\S+/g, ' ');
  const low = norm(body);
  const flags: Flag[] = [];
  const langs: DocLang[] = l === 'en' ? ['en'] : [l, 'en'];
  const seen = new Set<string>();
  for (const L of langs) {
    for (const p of PHRASES[L]) {
      if (seen.has(p)) continue;
      seen.add(p);
      const n = countOf(wordRe(p), low);
      if (n) flags.push({ kind: 'phrase', text: p, count: n });
    }
    for (const p of INTENSIFIERS[L]) {
      const n = countOf(wordRe(p), low);
      if (n) flags.push({ kind: 'intensifier', text: p, count: n });
    }
  }
  const sents = sentences(body);
  const words = wordCount(body);
  // Hedging stacks: three or more hedges in one sentence.
  const hedgeRes = HEDGES[l].map(wordRe);
  const stacked = sents.filter((s) => hedgeRes.reduce((n, re) => n + countOf(re, norm(s)), 0) >= 3).length;
  if (stacked) flags.push({ kind: 'hedge', text: 'hedging stack', count: stacked });
  const dashes = countOf(/—|\s–\s|\s--\s/g, body);
  const emDashPer1k = words ? Math.round((dashes / words) * 1000) : 0;
  if (dashes >= 2 && emDashPer1k >= 8) flags.push({ kind: 'em-dash', text: '—', count: dashes });
  const tri = new RegExp(`[\\p{L}'-]+(?: [\\p{L}'-]+)?, [\\p{L}'-]+(?: [\\p{L}'-]+)?,? (?:${AND[l]}) [\\p{L}'-]+`, 'giu');
  const triplets = countOf(tri, body);
  if (triplets) flags.push({ kind: 'triplet', text: 'X, Y, and Z', count: triplets });
  const lens = sents.map(wordCount).filter((n) => n > 0);
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1));
  const sentenceCv = mean ? Math.round((sd / mean) * 100) / 100 : 0;
  if (lens.length >= 5 && sentenceCv < 0.25) flags.push({ kind: 'rhythm', text: 'same-length sentences', count: lens.length });
  const headings = countOf(/^#{1,6}\s/gm, text);
  if (headings >= 3 && words < 300) flags.push({ kind: 'headings', text: 'headings in a short piece', count: headings });
  const n = (k: FlagKind) => flags.filter((f) => f.kind === k).reduce((a, f) => a + f.count, 0);
  const penalty = Math.min(60, n('phrase') * 6) + Math.min(20, n('intensifier') * 3) + Math.min(15, stacked * 5) + (flags.some((f) => f.kind === 'em-dash') ? Math.min(15, dashes * 3) : 0) + Math.min(15, triplets * 5) + (flags.some((f) => f.kind === 'rhythm') ? 10 : 0) + (flags.some((f) => f.kind === 'headings') ? 8 : 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { lang: l, words, sentences: sents.length, score, label: score >= 75 ? 'natural' : score >= 50 ? 'mixed' : 'stiff', flags, emDashPer1k, triplets, sentenceCv, headings };
}

// ------------------------------------------------------------------ the facts lock

export interface Facts {
  numbers: string[];
  quotes: string[];
  citations: string[];
  links: string[];
  names: string[];
}
const LINK = /https?:\/\/[^\s)\]>"'”]+[^\s)\]>"'”.,;:!?]/g;
const CITE = /\[\d+(?:\s*[,–-]\s*\d+)*\]/g;
const QUOTE = /"([^"\n]{2,400})"|“([^”\n]{2,400})”|«\s?([^»\n]{2,400}?)\s?»|„([^“”\n]{2,400})[“”]/g;
const NUM = /\d(?:[\d.,:/]*\d)?/g;
const NAME_SEQ = /\p{Lu}[\p{Ll}'’-]+(?:\s+\p{Lu}[\p{Ll}'’-]+)+/gu;
const NAME_ONE = /(?<=[\p{Ll},;:)]\s+)\p{Lu}[\p{Ll}'’-]{2,}/gu;

/** The facts a rewrite must keep: numbers, quotes, citations, links and names. */
export function factsOf(text: string, lang?: DocLang): Facts {
  const links = text.match(LINK) ?? [];
  let rest = text.replace(LINK, ' ');
  const citations = rest.match(CITE) ?? [];
  rest = rest.replace(CITE, ' ');
  const quotes: string[] = [];
  for (const m of rest.matchAll(QUOTE)) quotes.push(`"${(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/[,.;:!?]+$/, '')}"`);
  const numbers = rest.match(NUM) ?? [];
  // German writes every noun with a capital: names can't be told apart there.
  const names = (lang ?? detectDocLang(text)) === 'de' ? [] : [...new Set([...(rest.match(NAME_SEQ) ?? []), ...(rest.match(NAME_ONE) ?? [])])].filter((n) => !/^(I|I'm|I'll|I've|I'd)$/.test(n));
  return { numbers, quotes, citations, links, names };
}

const tally = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());

/** Whether `after` keeps every fact of `before` (and adds no numbers, quotes, citations or links). */
export function factsLock(before: string, after: string, lang?: DocLang): { ok: boolean; missing: string[]; added: string[] } {
  const l = lang ?? detectDocLang(before);
  const a = factsOf(before, l);
  const b = factsOf(after, l);
  const missing: string[] = [];
  const added: string[] = [];
  for (const k of ['numbers', 'quotes', 'citations', 'links'] as const) {
    const ta = tally(a[k]);
    const tb = tally(b[k]);
    for (const [x, n] of ta) if ((tb.get(x) ?? 0) < n) missing.push(x);
    for (const [x, n] of tb) if ((ta.get(x) ?? 0) < n) added.push(x);
  }
  for (const n of a.names) if (!after.includes(n)) missing.push(n);
  return { ok: !missing.length && !added.length, missing, added };
}

/** Sentences with the whitespace after each (so a text can be put back together as it was). */
function segments(s: string): { text: string; tail: string }[] {
  const parts = s.split(/((?<=[.!?…])[ \t]+(?=["“«„(¿¡]?[\p{Lu}\p{N}[])|\s*\n\s*)/u);
  const out: { text: string; tail: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) if (parts[i] || parts[i + 1]) out.push({ text: parts[i], tail: parts[i + 1] ?? '' });
  return out;
}
const wordsOf = (s: string) => new Set((norm(s).match(/[\p{L}\p{N}]{3,}/gu) ?? []));
function overlap(a: string, b: string): number {
  const A = wordsOf(a);
  const B = wordsOf(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n || 1);
}
const has = (s: string, fact: string) => (fact.startsWith('"') ? factsOf(s).quotes.includes(fact) : s.includes(fact));

/**
 * Puts the original sentences back for spans whose facts the rewrite broke: a sentence that lost a
 * fact is replaced by the original sentence it came from (best word overlap); a sentence with an
 * invented fact is replaced by its closest original or dropped. Returns `before` if that still fails.
 */
export function repairFacts(before: string, after: string, lang?: DocLang): string {
  const lock = factsLock(before, after, lang);
  if (lock.ok) return after;
  const orig = segments(before);
  const segs = segments(after);
  const used = new Set<number>();
  const best = (s: string, pool: { text: string }[], skip: Set<number>) => {
    let at = -1;
    let top = 0;
    pool.forEach((p, i) => {
      if (skip.has(i)) return;
      const o = overlap(s, p.text);
      if (o > top) [top, at] = [o, i];
    });
    return at;
  };
  for (const fact of lock.missing) {
    const oi = orig.findIndex((o) => has(o.text, fact));
    if (oi < 0 || segs.some((s) => s.text === orig[oi].text)) continue;
    const ai = best(orig[oi].text, segs, used);
    if (ai >= 0) {
      segs[ai] = { ...segs[ai], text: orig[oi].text };
      used.add(ai);
    } else {
      const at = Math.min(segs.length, Math.round((oi / Math.max(1, orig.length)) * segs.length));
      segs.splice(at, 0, { text: orig[oi].text, tail: ' ' });
      used.add(at);
    }
  }
  for (const fact of lock.added) {
    segs.forEach((s, i) => {
      if (used.has(i) || !has(s.text, fact)) return;
      const oi = best(s.text, orig, new Set());
      segs[i] = { ...s, text: oi >= 0 && !segs.some((x) => x.text === orig[oi].text) ? orig[oi].text : '' };
      used.add(i);
    });
  }
  const out = segs.filter((s) => s.text).map((s, i, a) => s.text + (i < a.length - 1 ? s.tail || ' ' : '')).join('');
  return factsLock(before, out, lang).ok ? out : before;
}

// ------------------------------------------------------------------ the changed spans

export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}
/** Word-level differences (sentence-level for very long texts), for the side-by-side view. */
export function diffWords(a: string, b: string): DiffPart[] {
  let x: string[] = a.match(/\s+|[^\s]+/g) ?? [];
  let y: string[] = b.match(/\s+|[^\s]+/g) ?? [];
  if (x.length * y.length > 4_000_000) {
    x = segments(a).map((s) => s.text + s.tail);
    y = segments(b).map((s) => s.text + s.tail);
    if (x.length * y.length > 4_000_000) return [{ type: 'del', text: a }, { type: 'add', text: b }];
  }
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = out.at(-1);
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push('same', x[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', x[i++]);
    else push('add', y[j++]);
  }
  while (i < n) push('del', x[i++]);
  while (j < m) push('add', y[j++]);
  // One removed span and one added span per changed stretch: a lone space between two changes joins them.
  const tidy: DiffPart[] = [];
  let del = '';
  let add = '';
  const flush = () => {
    if (del) tidy.push({ type: 'del', text: del });
    if (add) tidy.push({ type: 'add', text: add });
    del = add = '';
  };
  out.forEach((p, k) => {
    const between = p.type === 'same' && !p.text.trim() && k > 0 && k < out.length - 1 && out[k - 1].type !== 'same' && out[k + 1].type !== 'same';
    if (p.type === 'same' && !between) {
      flush();
      tidy.push(p);
    } else if (between) {
      del += p.text;
      add += p.text;
    } else if (p.type === 'del') del += p.text;
    else add += p.text;
  });
  flush();
  return tidy;
}

// ------------------------------------------------------------------ Match my voice

export interface StyleCard {
  samples: number;
  words: number;
  avgSentence: number;
  shortest: number;
  longest: number;
  formality: 'casual' | 'neutral' | 'formal';
  contractions: 'often' | 'sometimes' | 'rarely';
  favorites: string[];
  punctuation: string[];
  updatedAt?: string;
}
const COMMON = new Set('that this with have from they them their there what when your will would just about been were into than then also more some like very much only over such here well even back because could should which while where after before other these those being does done each make made know think really thing things going want need said says told okay yeah para como pero porque sobre cuando esta este todo pour avec dans mais elle sont nous vous leur cette tout comme sich nicht eine einen auch noch sind wird oder aber wenn dass mais você isso esta pelo pela também quando ainda della sono come anche quando questo questa molto alla'.split(' '));

/** A short style card from 1-5 samples of the person's own writing (no model; rules only). */
export function extractStyleCard(samples: string[]): StyleCard {
  const xs = samples.map((s) => String(s ?? '').trim().slice(0, 20_000)).filter(Boolean);
  if (!xs.length) throw new HttpError(400, 'Pick at least one sample of your own writing.');
  if (xs.length > 5) throw new HttpError(400, 'Pick up to 5 samples.');
  const all = xs.join('\n\n');
  const words = wordCount(all);
  if (words < 15) throw new HttpError(400, 'The samples are too short: add a few more sentences of your own writing.');
  const lens = sentences(all).map(wordCount).filter((n) => n > 0);
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const contr = countOf(/[\p{L}](?:'|’)(?:s|re|ve|ll|d|t|m)\b|n['’]t\b|\b[cdjlmnst]['’]\p{L}/giu, all);
  const rate = (contr / Math.max(1, words)) * 100;
  const contractions = rate >= 2 ? 'often' : rate >= 0.5 ? 'sometimes' : 'rarely';
  const tally2 = new Map<string, number>();
  for (const w of norm(all).match(/\p{L}{4,}/gu) ?? []) if (!COMMON.has(w)) tally2.set(w, (tally2.get(w) ?? 0) + 1);
  const favorites = [...tally2].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([w]) => w);
  const sents = Math.max(1, lens.length);
  const punct: [string, RegExp, number][] = [['questions', /\?/g, 0.05], ['exclamations', /!/g, 0.05], ['em-dashes', /—|\s–\s/g, 0.05], ['semicolons', /;/g, 0.05], ['parentheses', /\(/g, 0.05], ['ellipses', /…|\.\.\./g, 0.05], ['colons', /:(?!\/\/)/g, 0.05]];
  const punctuation = punct.filter(([, re, min]) => countOf(re, all) / sents >= min).map(([k]) => k);
  const longWords = (all.match(/\p{L}+/gu) ?? []).reduce((a, w) => a + w.length, 0) / Math.max(1, words);
  const casual = (contractions === 'often' ? 2 : contractions === 'sometimes' ? 1 : 0) + (punctuation.includes('exclamations') ? 1 : 0) + (avg < 12 ? 1 : 0) + (/\b(i|i'm|lol|gonna|kinda|hey|okay|ok)\b/i.test(all) ? 1 : 0);
  const formal = (longWords > 5.2 ? 1 : 0) + (avg > 22 ? 1 : 0) + (contractions === 'rarely' ? 1 : 0) + (/\b(therefore|however|regarding|sincerely|furthermore|hereby|accordingly)\b/i.test(all) ? 1 : 0);
  const formality = casual - formal >= 2 ? 'casual' : formal - casual >= 2 ? 'formal' : 'neutral';
  return { samples: xs.length, words, avgSentence: Math.round(avg * 10) / 10, shortest: Math.min(...lens), longest: Math.max(...lens), formality, contractions, favorites, punctuation };
}

/** The style card as a short note for the rewrite prompt and her chat. */
export function styleCardNote(c: StyleCard): string {
  const parts = [`sentences around ${Math.round(c.avgSentence)} words (from ${c.shortest} to ${c.longest})`, `a ${c.formality} tone`, `uses contractions ${c.contractions}`];
  if (c.favorites.length) parts.push(`words they like: ${c.favorites.join(', ')}`);
  parts.push(c.punctuation.length ? `punctuation they use: ${c.punctuation.join(', ')}` : 'plain punctuation (periods and commas)');
  return `Match the person's own voice (from ${c.samples} sample${c.samples === 1 ? '' : 's'} of their writing): ${parts.join('; ')}. Sound like them; don't copy their sentences.`;
}

export interface WritingPrefs {
  style: WritingStyle;
  card: StyleCard | null;
}
/** Each space's writing default and style card (its own store.db). */
export class WritingPrefsStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS writing_prefs (id INTEGER PRIMARY KEY CHECK (id = 1), style TEXT NOT NULL DEFAULT 'as-written', card TEXT, updated_at TEXT)");
  }
  get(): WritingPrefs {
    const r = this.#db.prepare('SELECT style, card FROM writing_prefs WHERE id = 1').get() as { style: string; card: string | null } | undefined;
    let card: StyleCard | null = null;
    try {
      card = r?.card ? (JSON.parse(r.card) as StyleCard) : null;
    } catch {
      card = null;
    }
    return { style: r?.style === 'natural' ? 'natural' : 'as-written', card };
  }
  #put(col: 'style' | 'card', v: string | null): void {
    this.#db.prepare(`INSERT INTO writing_prefs (id, ${col}, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET ${col} = excluded.${col}, updated_at = excluded.updated_at`).run(v, new Date().toISOString());
  }
  setStyle(s: WritingStyle): void {
    if (!WRITING_STYLES.includes(s)) throw new HttpError(400, 'Pick Natural or As written.');
    this.#put('style', s);
  }
  setCard(c: StyleCard | null): void {
    this.#put('card', c ? JSON.stringify({ ...c, updatedAt: c.updatedAt ?? new Date().toISOString() }) : null);
  }
}
const stores = new WeakMap<DatabaseSync, WritingPrefsStore>();
export function writingFor(app: Pick<AppContext, 'store'>): WritingPrefsStore {
  const db = app.store.db;
  let s = stores.get(db);
  if (!s) {
    s = new WritingPrefsStore(db);
    stores.set(db, s);
  }
  return s;
}

// ------------------------------------------------------------------ kid mode

const ASSIGNMENT = /\b(book reports?|essays?|homework|assignments?|school reports?|term papers?|research papers?|for (my )?(class|school|teacher)|my teacher|informe de lectura|ensayos?|tareas?|deberes|redacci[oó]n|exposés?|dissertations?|devoirs?|rédactions?|aufsatz|aufsätze|hausaufgaben?|referat|buchbericht|reda[cç][aã]o|trabalho escolar|li[cç][aã]o de casa|dever de casa|resenha|compit[oi]|relazione|saggio|tema per la scuola)\b/i;
/** Whether a request or title is a school assignment (book report, essay, homework) in six languages. */
export function isAssignment(text: string): boolean {
  return ASSIGNMENT.test(text);
}
/** Words of running prose (not headings, bullets or questions): an outline has almost none. */
export function proseWords(md: string): number {
  return md.split('\n').filter((l) => l.trim() && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(l) && !/\?\s*$/.test(l.trim())).reduce((n, l) => n + wordCount(l), 0);
}
export const isChild = (app: AppContext): boolean => Boolean(app.member?.child?.());

const TIP: Record<FlagKind, (f: Flag) => string> = {
  phrase: (f) => `“${f.text}” (${f.count}×): say it the way you would out loud, or just start with the point.`,
  intensifier: (f) => `“${f.text}” (${f.count}×): show why it matters with a detail instead of a big word.`,
  hedge: () => 'Some sentences pile up “maybe, could, possibly”: pick what you really think and say it once.',
  'em-dash': (f) => `Lots of dashes (${f.count}): try a period or a comma for some of them.`,
  triplet: (f) => `Lists of three (${f.count}×): do you need all three? One strong example from the book often works better.`,
  rhythm: () => 'Your sentences are all about the same length: mix a short one in after a long one.',
  headings: () => 'Lots of headings for a short piece: plain paragraphs may read better.',
};
/** Coaching for a child's own draft: suggestions and guiding questions, never a rewrite. */
export function coachFeedback(text: string): { suggestions: string[]; questions: string[]; score: number } {
  const c = checkText(text);
  // Quote the phrase as they wrote it ("Moreover", not "moreover").
  const asWritten = (f: Flag): Flag => (f.kind === 'phrase' || f.kind === 'intensifier' ? { ...f, text: text.replace(/[’‘]/g, "'").match(wordRe(f.text))?.[0] ?? f.text } : f);
  const suggestions = c.flags.map((f) => TIP[f.kind](asWritten(f))).slice(0, 8);
  if (!suggestions.length) suggestions.push('This already sounds like you. Read it out loud once and fix anything that trips you up.');
  if (c.words > 40 && !/\d|"|“/.test(text)) suggestions.push('Add one concrete detail: a page, a quote or a moment from the book that shows your point.');
  const questions = ['What is the one thing you most want your reader to remember?', 'Which moment or detail backs that up best?', 'How did it make you feel, or what did it make you think about?'];
  return { suggestions, questions, score: c.score };
}
export function coachText(text: string): string {
  const fb = coachFeedback(text);
  return `I'll coach rather than rewrite it, so it stays your own work. Here are suggestions for your draft (you make the changes):\n${fb.suggestions.map((s) => `- ${s}`).join('\n')}\nQuestions to think about:\n${fb.questions.map((q) => `- ${q}`).join('\n')}\nReads natural: ${fb.score}/100.`;
}

// ------------------------------------------------------------------ the rewrite pass

/** The rewrite rules (one system message). */
export function humanizePrompt(o: { words: number; targetWords?: number; card?: StyleCard | null; lang: DocLang; keep?: string[] }): string {
  const target = o.targetWords ?? o.words;
  const lines = [
    'Rewrite the text the person gives you so it reads like a careful person wrote it. Rules:',
    '- Plain, everyday words. Say things directly.',
    '- Vary sentence length and rhythm: some short sentences, some longer ones.',
    '- Use the concrete specifics already in the text (names, numbers, examples) instead of filler. Add no new facts.',
    "- Cut stock phrases and patterns: delve, tapestry, testament, \"in today's fast-paced world\", \"it's important to note\", \"in conclusion\", chains of moreover/furthermore/additionally, and the same phrases in other languages.",
    '- No rule-of-three lists out of habit; no em-dash habit (use periods and commas); no stacked hedges (may, could, perhaps); no empty intensifiers (truly, incredibly).',
    '- No headings for a short piece; keep the Markdown structure (headings, lists, tables, links) of a longer one.',
    `- Keep every number, name, quote ("..."), citation like [1] and link exactly as written. Keep the meaning.`,
    `- Keep the length within 15% of ${target} words${o.targetWords ? '' : ' (cutting filler may make it a little shorter)'}.`,
    `- Write in the same language as the text (${o.lang}).`,
    '- Answer with the rewritten text only: no preface, no notes, no code fences.',
  ];
  if (o.card) lines.push(styleCardNote(o.card));
  if (o.keep?.length) lines.push(`Last time these facts changed or went missing; keep them exactly: ${o.keep.slice(0, 20).join(' · ')}`);
  return lines.join('\n');
}

export interface HumanizeResult {
  before: string;
  after: string;
  /** rewrite: the model's text; repaired: with original sentences for broken facts; original: kept as written. */
  kept: 'rewrite' | 'repaired' | 'original';
  reason?: string;
  check: { before: CheckResult; after: CheckResult };
  facts: { ok: boolean; missing: string[]; added: string[] };
  lengthRatio: number;
  changes: DiffPart[];
  voice: boolean;
  /** A child gets coaching instead of a rewrite. */
  coach?: { suggestions: string[]; questions: string[]; score: number };
}

const clean = (s: string) => s.trim().replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').trim();

/**
 * "Make it sound human": one rewrite (plus one retry when a fact broke or the length wandered), kept
 * only if every fact survives, the length fits and it reads at least as natural as before.
 */
export async function humanize(app: AppContext, text: string, o: { voice?: boolean; targetWords?: number; conv?: Conversation; signal?: AbortSignal } = {}): Promise<HumanizeResult> {
  const before = String(text ?? '');
  if (!before.trim()) throw new HttpError(400, 'There is no text to rewrite.');
  if (before.length > HUMANIZE_MAX_CHARS) throw new HttpError(413, 'That text is too long to rewrite in one go (up to 40,000 characters).');
  const lang = detectDocLang(before);
  const cb = checkText(before, lang);
  const prefs = writingFor(app).get();
  const card = o.voice ? prefs.card : null;
  const result = (after: string, kept: HumanizeResult['kept'], reason?: string): HumanizeResult => {
    const ca = after === before ? cb : checkText(after, lang);
    return { before, after, kept, ...(reason ? { reason } : {}), check: { before: cb, after: ca }, facts: factsLock(before, after, lang), lengthRatio: Math.round((wordCount(after) / Math.max(1, cb.words)) * 100) / 100, changes: after === before ? [{ type: 'same', text: before }] : diffWords(before, after), voice: Boolean(card) };
  };
  if (isChild(app)) {
    const r = result(before, 'original', 'coach');
    return { ...r, coach: coachFeedback(before) };
  }
  const conv = o.conv ?? backgroundConversation(app.store, 'Writing');
  const target = o.targetWords ?? cb.words;
  const lo = o.targetWords ? 0.85 : 0.5;
  const fits = (s: string) => {
    const r = wordCount(s) / Math.max(1, target);
    return r >= lo && r <= 1.15 || Math.abs(wordCount(s) - target) <= 3;
  };
  const tries: { out: string; lock: ReturnType<typeof factsLock>; fits: boolean }[] = [];
  let keep: string[] = [];
  for (let i = 0; i < 2; i++) {
    const out = clean(await complete(app, conv, [{ role: 'system', content: humanizePrompt({ words: cb.words, targetWords: o.targetWords, card, lang, keep }) }, { role: 'user', content: before }], Math.min(12_000, cb.words * 3 + 300), 'writing', o.signal));
    if (!out) continue;
    const lock = factsLock(before, out, lang);
    const t = { out, lock, fits: fits(out) };
    tries.push(t);
    if (lock.ok && t.fits) {
      if (checkText(out, lang).score < cb.score) continue;
      return result(out, 'rewrite');
    }
    keep = [...lock.missing, ...lock.added];
  }
  if (!tries.length) return result(before, 'original', 'no rewrite came back');
  // Facts broke: keep the original sentences for those spans (the try with the fewest problems).
  const fixable = tries.filter((t) => t.fits).sort((a, b) => a.lock.missing.length + a.lock.added.length - (b.lock.missing.length + b.lock.added.length));
  for (const t of fixable) {
    if (t.lock.ok) continue;
    const fixed = repairFacts(before, t.out, lang);
    if (fixed !== before && fits(fixed) && checkText(fixed, lang).score >= cb.score) return result(fixed, 'repaired');
  }
  if (!tries.some((t) => t.fits)) return result(before, 'original', 'the rewrite changed the length too much');
  if (tries.some((t) => t.fits && t.lock.ok)) return result(before, 'original', 'the rewrite did not read better');
  return result(before, 'original', 'the rewrite changed facts');
}

/** Her chat note when the person's default is Natural (with their voice card when they made one). */
export function writingNote(app: AppContext): string | undefined {
  let prefs: WritingPrefs;
  try {
    prefs = writingFor(app).get();
  } catch {
    return undefined;
  }
  // W1.4: her sign-off for email drafts comes from the one persona style (src/persona-style.ts).
  let sign = '';
  try {
    sign = signOffNote(personaStyle(app));
  } catch {
    sign = '';
  }
  if (prefs.style !== 'natural') return sign || undefined;
  const base = 'Writing style: Natural. When you write something longer for them (an email draft, a summary, a letter, a report), write like a person: plain everyday words, sentences of varied length, concrete details from the source; no stock phrases (delve, tapestry, testament, "it\'s important to note", "in conclusion", moreover/furthermore chains), no rule-of-three lists, few em-dashes, no stacked hedges or empty intensifiers, no headings in short pieces. Numbers, names, quotes, citations and links stay exactly as they are.';
  const out = prefs.card ? `${base} ${styleCardNote(prefs.card)}` : base;
  return sign ? `${out} ${sign}` : out;
}
