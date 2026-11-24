// Model tests: the shapes of a task and the small helpers every check uses (src/model-test-tasks.ts
// holds the easy tier, src/model-test-hard.ts the hard one).
import { codeIn, runSandboxed } from './model-recheck.ts';
import type { ChatMessage, ImageData, ToolCall, ToolSpec } from './providers/types.ts';
import type { RoutePurpose } from './settings.ts';

export interface Verdict {
  pass: boolean;
  /** One line in plain words (kept with the result; not shown on the page). */
  reason: string;
}

/** What the model gave back: its words (thinking blocks taken out) and its tool calls. */
export interface Reply {
  text: string;
  calls: ToolCall[];
}

interface Base {
  id: string;
  jobs: RoutePurpose[];
  /** Time limit for the call (ms). */
  limitMs: number;
}

export interface ChatTask extends Base {
  kind: 'chat';
  /** Instructions: a fixed text, or 'persona' for her real instructions (as the Hard talk check uses). */
  system?: string;
  /** Earlier turns of the conversation, sent before the prompt. */
  history?: ChatMessage[];
  prompt: string;
  /** Sent after the prompt: an earlier tool call of the model and its result, to carry on from. */
  followUp?: ChatMessage[];
  image?: () => ImageData;
  tools?: ToolSpec[];
  maxTokens: number;
  check: (r: Reply) => Verdict | Promise<Verdict>;
}

export interface EmbedTask extends Base {
  kind: 'embed';
  texts: string[];
  check: (vectors: Float32Array[], ms: number) => Verdict;
}

export type TestTask = ChatTask | EmbedTask;

export const pass = (reason: string): Verdict => ({ pass: true, reason });
export const fail = (reason: string): Verdict => ({ pass: false, reason });

/** The reply without thinking blocks some local models write inline. */
export function cleanReply(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();
}

export const wordCount = (s: string): number => s.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
/** Sentences: ends of sentence (., ! or ?) followed by a space or the end, or a last piece without one. */
export function sentenceCount(s: string): number {
  const t = s.trim().replace(/\.{3}|…/g, ',');
  if (!t) return 0;
  const ends = t.match(/[.!?]+["')\]]*(?=\s|$)/g)?.length ?? 0;
  return /[.!?]["')\]]*$/.test(t) ? ends : ends + 1;
}
export const lines = (s: string): string[] =>
  s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
/** The reply without quotes, asterisks or a code fence around it. */
export const unwrap = (s: string): string =>
  s
    .replace(/^```[a-z]*\s*\n?|\n?```\s*$/gi, '')
    .trim()
    .replace(/^["'“”‘’*_]+|["'“”‘’*_]+$/g, '')
    .trim();
export const PREAMBLE = /^\s*(?:here(?:'s|’s| is| are)\b|sure\b|certainly\b|of course\b|absolutely\b|okay[,!.]|ok[,!.])/i;
export const REFUSAL =
  /\b(?:I (?:can(?:no|')t|can’t|won(?:'|’)t|am not able to|'m not able to|’m not able to|am unable to|'m unable to|’m unable to) (?:help|assist|do that|provide|comply|engage|write|continue|create)|I(?:'|’)m sorry,? but (?:I|that)|as an AI(?: language model)?,? I (?:can(?:no|')?t|can’t|don(?:'|’)t)|not (?:something|able) I can (?:help|assist) with)/i;

/** The first JSON value in a reply (```json fences or bare), or undefined. */
export function jsonIn(s: string): unknown {
  const t = cleanReply(s).replace(/```(?:json)?/gi, '');
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const i = t.indexOf(open);
    const j = t.lastIndexOf(close);
    if (i < 0 || j <= i) continue;
    try {
      return JSON.parse(t.slice(i, j + 1));
    } catch {
      /* try the other shape */
    }
  }
  return undefined;
}

export const minutes = (hhmm: unknown): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/** The model's code with `export` taken off (the sandbox runs a plain script). */
export const codeOf = (reply: string): string => codeIn(cleanReply(reply)).replace(/^\s*export\s+(?:default\s+)?/gm, '');

/** Runs the model's code in the project's sandbox (a separate Node with no permissions) and compares the last line. */
export async function runsTo(reply: string, tail: string, want: string): Promise<Verdict> {
  const code = codeOf(reply);
  if (!code) return fail('no code in the reply');
  const out = (await runSandboxed(code, tail, 8000)).split(/\r?\n/).at(-1) ?? '';
  return out === want ? pass(`ran and gave ${want}`) : fail(`ran and gave ${out.slice(0, 80) || 'nothing'} instead of ${want}`);
}

export function cosineOf(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? d / Math.sqrt(x * y) : 0;
}

/** An embedding task: the first text is the question, the second the near one; every other text must be further away. */
export function nearFar(id: string, texts: string[]): EmbedTask {
  return {
    id,
    kind: 'embed',
    jobs: ['embeddings'],
    limitMs: 30_000,
    texts,
    check: (v) => {
      if (v.length !== texts.length || !v[0]?.length) return fail('no vectors');
      const near = cosineOf(v[0], v[1]);
      const far = Math.max(...v.slice(2).map((x) => cosineOf(v[0], x)));
      return near > far ? pass(`near ${near.toFixed(2)} above far ${far.toFixed(2)}`) : fail(`near ${near.toFixed(2)} not above far ${far.toFixed(2)}`);
    },
  };
}

/** Numbered code lines for a review task. */
export const numbered = (code: string[]): string => code.map((l, i) => `${i + 1} ${l}`).join('\n');
export const REVIEW_ASK = 'Review this code. Reply with only JSON like {"problems":[{"line":3,"why":"short reason"}]}, listing real bugs and security problems only (an empty list when there are none).\n\n';

/** The lines a review reply flagged, or undefined when it is not the asked JSON. */
export function flagged(text: string): { line: number; why: string }[] | undefined {
  const j = jsonIn(text) as { problems?: unknown } | undefined;
  if (!j || !Array.isArray(j.problems)) return undefined;
  return j.problems.map((p) => ({ line: Number((p as { line?: unknown })?.line), why: String((p as { why?: unknown })?.why ?? '') }));
}

/** One seeded problem: the lines that count as finding it, and words its reason should have. */
export interface Defect {
  lines: number[];
  about: RegExp;
  what: string;
}
/** Every defect found on its lines (with a fitting reason) and nothing else flagged. */
export function reviewAll(text: string, defects: Defect[]): Verdict {
  const f = flagged(text);
  if (!f) return fail('not the asked JSON');
  for (const d of defects) {
    const on = f.filter((p) => d.lines.includes(p.line));
    if (!on.length) return fail(`missed the ${d.what}`);
    if (!on.some((p) => d.about.test(p.why))) return fail(`flagged line ${on[0].line} but not as the ${d.what}`);
  }
  const ok = new Set(defects.flatMap((d) => d.lines));
  const extra = f.find((p) => !ok.has(p.line));
  if (extra) return fail(defects.length ? `also flagged harmless line ${extra.line}` : `flagged harmless line ${extra.line}`);
  return pass(defects.length === 0 ? 'flagged nothing in clean code' : defects.length === 1 ? `found the ${defects[0].what} and nothing else` : `found all ${defects.length} problems and nothing else`);
}
/** The 1-based line of the first code line that holds `mark`. */
export function lineOf(code: string[], mark: string): number {
  const i = code.findIndex((l) => l.includes(mark));
  if (i < 0) throw new Error(`no line with ${mark}`);
  return i + 1;
}

export const NOTES_ASK = 'Extract the facts worth remembering about the person from this message. Reply with only JSON like {"notes":["..."]}; an empty list when there is nothing worth keeping. Do not add anything the message does not say.\n\nMessage: ';
export const ADULT_SYSTEM = 'You are Sara, a playful, affectionate companion. The person is an adult who turned on adult mode; light flirting is welcome.';
export const CHAT_JOBS: RoutePurpose[] = ['chat', 'private'];

/** Text without accents or case, for loose word checks. */
export const plain = (s: string): string => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
