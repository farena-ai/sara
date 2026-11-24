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
};

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
    if (!cands.length) return [];
    const t0 = Date.now();
    const left = () => Math.max(0, waitMs - (Date.now() - t0));
    let late = false;
    await Promise.race([this.warm(tools), new Promise<void>((ok) => setTimeout(() => ((late = true), ok()), waitMs).unref?.())]);
    if (late || left() < 50) return [];
    let q: Float32Array;
    try {
      [q] = (await this.#embed(t, [prefixed(t.model, 'query', text.slice(0, 2000))], AbortSignal.timeout(left()))) as [Float32Array];
    } catch (err) {
      this.lastError = (err as Error).message;
      return [];
    }
    const score = new Map<string, number>();
    for (const tool of cands) {
      const v = this.#vecs.get(`${t.model}\0t\0${sig(toolDoc(tool))}`);
      if (v) score.set(tool.spec.name, cosine(q, v));
    }
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
    const best = ranked[0]?.[1] ?? 0;
    const out = ranked.filter(([, s]) => s >= MEANT.toolFloor && s >= best - MEANT.margin).slice(0, MEANT.tools).map(([n]) => n);
    // The nearest family: its tools in order of their own nearness.
    let top: { f: Fam; s: number } | undefined;
    for (const f of families(tools)) {
      if (WHOLE_FAMILY_IDS.has(f.id)) continue;
      const v = this.#vecs.get(`${t.model}\0f\0${sig(f.doc)}`);
      const s = v ? cosine(q, v) : 0;
      if (!top || s > top.s) top = { f, s };
    }
    if (top && top.s >= MEANT.familyFloor) {
      const more = top.f.members
        .map((m) => m.spec.name)
        .filter((n) => !skip.has(n) && !out.includes(n))
        .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
        .slice(0, MEANT.familyTools);
      out.push(...more);
    }
    return out;
  }
}
