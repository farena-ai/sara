// Z7 (docs/TOOL_EVALS.md): tools picked by what a message means, on top of the word lists.
//
// The short tool list (src/lean.ts) offers a tool family when the message has one of the family's
// words. People say it another way ("track my time", "stop sugarcoating things"), and then the tool
// is not in the list: the model has to go looking, or answers without it. Measured: with the tool in
// the list a model used it 53 times of 56; without it, 3 of 11.
//
// With the "Meaning search" job set (the embedding model memory already uses), each tool and each
// tool family gets a vector once, the message gets one per turn, and the nearest few are added to
// what the words found. It only ever adds tools the person may use here, never removes one, and a
// turn never waits long for it: no embedding model, a slow one or an error means the words alone,
// exactly as before.
import { createHash } from 'node:crypto';
import { cosine, embedTexts, prefixed, type EmbedTarget } from './embeddings.ts';
import { familyOf, WHOLE_FAMILY_IDS } from './lean.ts';
import type { Tool } from './tools/types.ts';

/**
 * How much meaning may add, and how sure it must be. Calibrated on nomic-embed-text with
 * scripts/eval-tools.ts: a right tool scores about 0.58 to 0.74 against the message; unrelated
 * small talk tops out around 0.50 to 0.62, so there is no clean line and the numbers below are a
 * trade: a few tools too many on some turns, against the right tool missing on others.
 */
export const MEANT = {
  /** At most this many single tools. */
  tools: 4,
  toolFloor: 0.55,
  /** A tool must be this close to the best one. */
  margin: 0.06,
  /** The nearest family, when it is at least this near: its best few tools. */
  familyFloor: 0.52,
  familyTools: 5,
  /** The most a turn waits for all of it (ms). */
  waitMs: 1500,
  docChars: 300,
  /**
   * S3: how long the one call for a message's vector may take, whoever is waiting for it. Longer
   * than waitMs on purpose: routing asks first and may give up, and the tools ask a moment later
   * for the same vector.
   */
  queryMs: 8000,
  /**
   * S3: after this many messages in a row whose vector came late or not at all, meaning rests for
   * restMs. A computer that keeps one model loaded at a time (Ollama with OLLAMA_MAX_LOADED_MODELS=1,
   * or a chat model that fills the graphics card) swaps the chat model out for every vector: each
   * turn then pays for two model loads and gets nothing for it.
   */
  lateLimit: 3,
  restMs: 10 * 60_000,
};

/**
 * The floors are a property of the embedding model, not of the tools: bge-m3 (the one to use for
 * languages other than English) scores everything lower than nomic-embed-text. Measured the same
 * way (docs/TOOL_EVALS.md, "Third run"). A model not listed uses the numbers above.
 */
const MEANT_BY_MODEL: [RegExp, Partial<typeof MEANT>][] = [[/bge-m3/i, { toolFloor: 0.45, familyFloor: 0.42 }]];
export const meantFor = (model: string): typeof MEANT => ({ ...MEANT, ...(MEANT_BY_MODEL.find(([re]) => re.test(model))?.[1] ?? {}) });

/**
 * S1: routing by meaning. A research ask said without the usual words ("look into which air
 * purifiers are worth buying") is nearer to the asks in RESEARCH_ASKS than to anything in
 * NOT_RESEARCH; `margin` is how much nearer it must be. Strict on purpose: a wrong yes sends small
 * talk to the slow, costly research model, a wrong no is what happened before.
 */
export const ROUTE_MEANT = { floor: 0.5, margin: 0.08 };
/**
 * bge-m3 keeps the two apart more cleanly (of 111 messages that are not research asks, the nearest
 * came to +0.02; nomic-embed-text's nearest came to +0.08), so it may be less strict.
 */
const ROUTE_BY_MODEL: [RegExp, Partial<typeof ROUTE_MEANT>][] = [[/bge-m3/i, { margin: 0.05 }]];
export const routeMeantFor = (model: string): typeof ROUTE_MEANT => ({ ...ROUTE_MEANT, ...(ROUTE_BY_MODEL.find(([re]) => re.test(model))?.[1] ?? {}) });
export const RESEARCH_ASKS = [
  'Research the best options for this and tell me which one to get.',
  'Look into which of these products are actually worth buying.',
  'Find out what people are saying about this online.',
  'Dig into this topic and give me a summary of what you find, with sources.',
  'Can you investigate this for me and report back what you learn?',
  'Compare the reviews and prices of these models and recommend one.',
  'I need a thorough overview of the current state of this, check several sources.',
  'Read up on this for me and tell me what the experts say.',
  // S6: two ways of asking the first set missed.
  'What is the general consensus on this these days? Check a few places.',
  'Gather what is out there on the web about this topic for me.',
];
export const NOT_RESEARCH = [
  'Remind me to do this tomorrow morning.',
  'I had a long day and I am tired, how are you?',
  'I did some reading about this myself over the weekend, it was fun.',
  'My sister works in a research lab.',
  'What is 15 percent of 80?',
  'Write an email to my boss about the meeting.',
  'What is the weather like today?',
  'Add milk to my shopping list.',
  'What do you think, is that rude?',
  'Explain to me in two sentences how this works.',
  'Did my team win last night?',
  'Turn off the lights in the living room.',
  'Make me a document from these notes.',
  'What is on my calendar this week?',
  'Help me decide between these two options, here is what matters most to me.',
  'What do you know about me?',
  'Go through the document I gave you and tell me if anything in it looks off.',
  'Let me know when the price of this drops below a certain amount.',
  'Sum up what we talked about earlier.',
  'Find the note I wrote about this.',
];

const sig = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const toolDoc = (t: Tool): string => `${t.spec.name.replace(/_/g, ' ')}: ${(t.spec.description ?? '').replace(/\s+/g, ' ').slice(0, MEANT.docChars)}`;
const firstSentence = (d: string): string => d.replace(/\s+/g, ' ').split(/(?<=[.:])\s/)[0]!.slice(0, 140);

interface Fam {
  id: string;
  doc: string;
  members: Tool[];
}

function families(tools: Tool[]): Fam[] {
  const by = new Map<string, { label: string; members: Tool[] }>();
  for (const t of tools) {
    const f = familyOf(t);
    const e = by.get(f.id) ?? { label: f.label, members: [] };
    e.members.push(t);
    by.set(f.id, e);
  }
  return [...by.entries()]
    .filter(([, f]) => f.members.length >= 2)
    .map(([id, f]) => ({ id, members: f.members, doc: `${f.label}. ${f.members.slice(0, 14).map((t) => `${t.spec.name.replace(/_/g, ' ')}: ${firstSentence(t.spec.description ?? '')}`).join(' ')}`.slice(0, 1800) }));
}

export class ToolMeaning {
  readonly #target: () => EmbedTarget | undefined;
  readonly #embed: typeof embedTexts;
  /** model + what + text signature -> vector (kept for the life of the process; a few hundred small rows). */
  readonly #vecs = new Map<string, Float32Array>();
  #warming: Promise<void> | undefined;
  #asking: Promise<void> | undefined;
  /** The last message's vector (routing and tool picking of one turn share one call). */
  #last: { key: string; vec: Promise<Float32Array> } | undefined;
  /** Messages in a row whose vector was late, the last one counted, and until when meaning rests. */
  #lateStreak = 0;
  #counted: string | undefined;
  #restUntil = 0;
  lastError: string | undefined;

  constructor(target: () => EmbedTarget | undefined, embed: typeof embedTexts = embedTexts) {
    this.#target = target;
    this.#embed = embed;
  }

  /** Vectors for every tool and family that has none yet (in the background; calls share one run). */
  warm(tools: Tool[]): Promise<void> {
    const t = this.#target();
    if (!t) return Promise.resolve();
    const need: { key: string; text: string }[] = [];
    for (const tool of tools) {
      const text = toolDoc(tool);
      const key = `${t.model}\0t\0${sig(text)}`;
      if (!this.#vecs.has(key)) need.push({ key, text });
    }
    for (const f of families(tools)) {
      const key = `${t.model}\0f\0${sig(f.doc)}`;
      if (!this.#vecs.has(key)) need.push({ key, text: f.doc });
    }
    if (!need.length) return Promise.resolve();
    this.#warming ??= (async () => {
      try {
        for (let i = 0; i < need.length; i += 32) {
          const part = need.slice(i, i + 32);
          const vecs = await this.#embed(t, part.map((n) => prefixed(t.model, 'doc', n.text)));
          part.forEach((n, j) => this.#vecs.set(n.key, vecs[j]!));
        }
        this.lastError = undefined;
      } catch (err) {
        this.lastError = (err as Error).message;
      } finally {
        this.#warming = undefined;
      }
    })();
    return this.#warming;
  }

  /** Is meaning resting after too many late answers in a row? */
  get resting(): boolean {
    return Date.now() < this.#restUntil;
  }

  /**
   * The message's vector; one call per message, however many ask for it. The call has MEANT.queryMs
   * whoever is waiting: a caller that gives up early does not cancel it for the next one.
   */
  #query(t: EmbedTarget, text: string): Promise<Float32Array> {
    const key = `${t.model}\0${text}`;
    if (this.#last?.key !== key) {
      const vec = this.#embed(t, [prefixed(t.model, 'query', text.slice(0, 2000))], AbortSignal.timeout(MEANT.queryMs)).then((v) => v[0]!);
      vec.catch(() => {
        if (this.#last?.vec === vec) this.#last = undefined;
      });
      this.#last = { key, vec };
    }
    return this.#last.vec;
  }

  /** The message's vector if it is there within `waitMs`; late or failed is undefined, and is counted. */
  async #within(t: EmbedTarget, text: string, waitMs: number): Promise<Float32Array | undefined> {
    const key = `${t.model}\0${text}`;
    let timer: NodeJS.Timeout | undefined;
    const got = await Promise.race([
      this.#query(t, text).then(
        (v) => v as Float32Array | undefined,
        (err: Error) => ((this.lastError = err.message), undefined),
      ),
      new Promise<undefined>((ok) => {
        timer = setTimeout(() => ok(undefined), Math.max(50, waitMs));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (got) {
      this.#lateStreak = 0;
      this.#counted = key;
    } else if (this.#counted !== key) {
      this.#counted = key;
      if (++this.#lateStreak >= MEANT.lateLimit) {
        this.#lateStreak = 0;
        this.#restUntil = Date.now() + MEANT.restMs;
        this.lastError = `The embedding model answered too slowly ${MEANT.lateLimit} times in a row, so picking by meaning rests for ${Math.round(MEANT.restMs / 60_000)} minutes. If it shares a graphics card with the chat model, let Ollama keep two models loaded.`;
      }
    }
    return got;
  }

  /** Vectors for the research asks and their opposites (once per model). */
  #asks(t: EmbedTarget): Promise<void> {
    const all = [...RESEARCH_ASKS, ...NOT_RESEARCH];
    const need = all.filter((x) => !this.#vecs.has(`${t.model}\0a\0${sig(x)}`));
    if (!need.length) return Promise.resolve();
    this.#asking ??= (async () => {
      try {
        // Asks are short messages themselves: made the way a message's vector is made.
        const vecs = await this.#embed(t, need.map((x) => prefixed(t.model, 'query', x)));
        need.forEach((x, i) => this.#vecs.set(`${t.model}\0a\0${sig(x)}`, vecs[i]!));
      } catch (err) {
        this.lastError = (err as Error).message;
      } finally {
        this.#asking = undefined;
      }
    })();
    return this.#asking;
  }

  /**
   * Is this message a research ask by what it means? False when there is no embedding model, it is
   * slow, or anything fails (the words decide alone, as before).
   */
  async research(text: string, waitMs = MEANT.waitMs): Promise<boolean> {
    const t = this.#target();
    if (!t || text.trim().length < 12 || this.resting) return false;
    // The message's vector and the asks' vectors are made side by side; both within waitMs.
    const mine = this.#within(t, text, waitMs);
    let late = false;
    await Promise.race([this.#asks(t), new Promise<void>((ok) => setTimeout(() => ((late = true), ok()), waitMs).unref?.())]);
    const q = await mine;
    if (late || !q) return false;
    const near = (list: string[]) => Math.max(0, ...list.map((x) => { const v = this.#vecs.get(`${t.model}\0a\0${sig(x)}`); return v ? cosine(q, v) : 0; }));
    const yes = near(RESEARCH_ASKS);
    const R = routeMeantFor(t.model);
    return yes >= R.floor && yes - near(NOT_RESEARCH) >= R.margin;
  }

  /**
   * The tools nearest to what the message means, best first: up to MEANT.tools single tools and the
   * best few of the nearest family. `skip` = names already offered (they do not use up a place).
   * Empty when there is no embedding model, the vectors are not ready in time, or anything fails.
   */
  async pick(text: string, tools: Tool[], skip: ReadonlySet<string> = new Set(), waitMs = MEANT.waitMs): Promise<string[]> {
    const t = this.#target();
    if (!t || !text.trim() || !tools.length) return [];
    // Families that only make sense whole (her computer, SSH) are for explicit asks, never a guess.
    const cands = tools.filter((x) => !skip.has(x.spec.name) && !WHOLE_FAMILY_IDS.has(familyOf(x).id));
    if (!cands.length || this.resting) return [];
    // Side by side with the tools' vectors; a vector routing already asked for is the same call.
    const mine = this.#within(t, text, waitMs);
    let late = false;
    await Promise.race([this.warm(tools), new Promise<void>((ok) => setTimeout(() => ((late = true), ok()), waitMs).unref?.())]);
    const q = await mine;
    if (late || !q) return [];
    const M = meantFor(t.model);
    const score = new Map<string, number>();
    for (const tool of cands) {
      const v = this.#vecs.get(`${t.model}\0t\0${sig(toolDoc(tool))}`);
      if (v) score.set(tool.spec.name, cosine(q, v));
    }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0]?.[1] ?? 0;
    const out = ranked.filter(([, s]) => s >= M.toolFloor && s >= best - M.margin).slice(0, M.tools).map(([n]) => n);
    // The nearest family: its tools in order of their own nearness.
    let top: { f: Fam; s: number } | undefined;
    for (const f of families(tools)) {
      if (WHOLE_FAMILY_IDS.has(f.id)) continue;
      const v = this.#vecs.get(`${t.model}\0f\0${sig(f.doc)}`);
      const s = v ? cosine(q, v) : 0;
      if (!top || s > top.s) top = { f, s };
    }
    if (top && top.s >= M.familyFloor) {
      const more = top.f.members
        .map((m) => m.spec.name)
        .filter((n) => !skip.has(n) && !out.includes(n))
        .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
        .slice(0, M.familyTools);
      out.push(...more);
    }
    return out;
  }
}
