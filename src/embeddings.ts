// Phase 38: meaning-based memory search. With the "Meaning search" job pointed at an embedding
// model (e.g. nomic-embed-text on Ollama), each memory note gets a vector, and recall also finds
// notes said in other words ("the lake cabin" ↔ "our Pine Lake trip"). Vectors live next to the
// notes in her own database, made in the background a few at a time. Anything failing (no job set,
// the model unreachable, slow) quietly falls back to word search, which always runs.
import { netFetch } from './net-guard.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from './chat.ts';
import { vaultKeyFor } from './chat.ts';
import type { Memory, MemoryStore } from './memory.ts';
import type { ProviderConfig } from './providers/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  sig TEXT NOT NULL DEFAULT '',
  vec BLOB NOT NULL
);
`;
/** How long a turn waits for the query's vector before going on with word search alone. */
export const QUERY_TIMEOUT_MS = 2500;
const BATCH = 32;
/**
 * Similarity floor and how close to the best match a note must be. Calibrated on nomic-embed-text
 * (scripts/check-modeljobs.ts): right notes score about 0.52 to 0.65, unrelated ones up to about 0.5.
 */
export const MIN_SCORE = 0.5;
const MARGIN = 0.06;
/** Kinds worth finding by meaning (dates and summaries have their own paths). */
const KINDS = new Set(['fact', 'self', 'decision', 'promise', 'milestone', 'reflection', 'summary', 'lesson']);

export interface EmbedTarget {
  config: ProviderConfig;
  key?: string;
  model: string;
}

/** Some embedding models want a task prefix (nomic: search_query / search_document). */
export function prefixed(model: string, kind: 'query' | 'doc', text: string): string {
  if (/nomic-embed/i.test(model)) return `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`;
  if (/mxbai-embed/i.test(model) && kind === 'query') return `Represent this sentence for searching relevant passages: ${text}`;
  return text;
}

/** Calls an OpenAI-compatible /embeddings endpoint (Ollama, LM Studio, OpenAI, …). */
export async function embedTexts(t: EmbedTarget, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  if (t.config.kind !== 'openai-compatible' || !t.config.baseUrl) throw new Error(`${t.config.label} can't make embeddings; pick an OpenAI-compatible provider such as Ollama.`);
  const res = await netFetch(`${t.config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
    body: JSON.stringify({ model: t.model, input: texts }),
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Embeddings failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: { embedding?: number[]; index?: number }[] };
  const data = body.data ?? [];
  if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding) || !d.embedding.length)) throw new Error(`${t.model} didn't return embeddings. Is it an embedding model?`);
  return data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => normalize(Float32Array.from(d.embedding!)));
}

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** The embeddings job, if set and usable. */
export function embedTarget(app: AppContext): EmbedTarget | undefined {
  const s = app.settings.get();
  const r = s.routes?.embeddings;
  const config = r && s.providers.find((p) => p.id === r.providerId);
  if (!r || !config) return undefined;
  return { config, key: app.vault.get(vaultKeyFor(config.id)) ?? undefined, model: r.model };
}

/**
 * S6: the embedding model for something a turn is waiting on (memory's meaning search, the library,
 * recipes, skills, tools). The same as embedTarget, except while meaning rests: after several
 * messages in a row whose vector came late (src/tool-meaning.ts), every one of those would wait
 * for the same slow model, and on a computer that keeps one model loaded each would swap her chat
 * model out. They then use words alone until the rest is over. Indexing in the background and the
 * Settings page keep using embedTarget.
 */
export function turnEmbedTarget(app: AppContext): EmbedTarget | undefined {
  return app.toolMeaning?.resting ? undefined : embedTarget(app);
}

export class MemoryVectors {
  readonly #db: DatabaseSync;
  readonly #mem: MemoryStore;
  readonly #target: () => EmbedTarget | undefined;
  #cache: { model: string; rows: { id: number; vec: Float32Array }[] } | undefined;
  /** The last problem reaching the model (shown on the Models page), cleared on success. */
  lastError: string | undefined;

  constructor(db: DatabaseSync, mem: MemoryStore, target: () => EmbedTarget | undefined) {
    this.#db = db;
    this.#mem = mem;
    this.#target = target;
    db.exec(SCHEMA);
  }

  #candidates(): Memory[] {
    return this.#mem.listAll().filter((m) => KINDS.has(m.kind) && m.supersededBy === null);
  }

  status(): { model: string | null; indexed: number; total: number; error?: string } {
    const t = this.#target();
    const total = this.#candidates().length;
    if (!t) return { model: null, indexed: 0, total };
    const indexed = (this.#db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE model = ?').get(t.model) as { n: number }).n;
    return { model: t.model, indexed: Math.min(indexed, total), total, ...(this.lastError ? { error: this.lastError } : {}) };
  }

  /** Makes vectors for up to BATCH notes that don't have one for the current model. Returns how many. */
  async index(limit = BATCH): Promise<number> {
    const t = this.#target();
    if (!t) return 0;
    // A note's vector is redone when the model changes or the note was edited.
    const sig = (m: Memory) => `${t.model}:${createHash('sha1').update(m.content).digest('hex').slice(0, 12)}`;
    const have = new Map((this.#db.prepare('SELECT memory_id, sig FROM memory_vectors').all() as { memory_id: number; sig: string }[]).map((r) => [r.memory_id, r.sig]));
    const todo = this.#candidates().filter((m) => have.get(m.id) !== sig(m)).slice(0, limit);
    if (!todo.length) return 0;
    try {
      const vecs = await embedTexts(t, todo.map((m) => prefixed(t.model, 'doc', m.content)));
      const put = this.#db.prepare('INSERT INTO memory_vectors (memory_id, model, sig, vec) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, sig = excluded.sig, vec = excluded.vec');
      todo.forEach((m, i) => put.run(m.id, t.model, sig(m), new Uint8Array(vecs[i].buffer)));
      this.#cache = undefined;
      this.lastError = undefined;
      return todo.length;
    } catch (err) {
      this.lastError = (err as Error).message;
      throw err;
    }
  }

  /** Drops vectors of notes that are gone (edits change content, so their vector is redone). */
  forget(memoryId: number): void {
    this.#db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(memoryId);
    this.#cache = undefined;
  }

  #rows(model: string): { id: number; vec: Float32Array }[] {
    if (this.#cache?.model === model) return this.#cache.rows;
    const rows = (this.#db.prepare('SELECT memory_id, vec FROM memory_vectors WHERE model = ?').all(model) as { memory_id: number; vec: Uint8Array }[]).map((r) => ({
      id: r.memory_id,
      vec: new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)),
    }));
    this.#cache = { model, rows };
    return rows;
  }

  /**
   * Notes closest in meaning to the text (best first), above a similarity floor. Empty when the
   * job isn't set or the model doesn't answer in time: word search covers it.
   */
  async related(text: string, k = 4, minScore = MIN_SCORE, timeoutMs = QUERY_TIMEOUT_MS): Promise<{ memory: Memory; score: number }[]> {
    const t = this.#target();
    if (!t || !text.trim()) return [];
    const rows = this.#rows(t.model);
    if (!rows.length) return [];
    let q: Float32Array;
    try {
      [q] = await embedTexts(t, [prefixed(t.model, 'query', text.slice(0, 2000))], AbortSignal.timeout(timeoutMs));
      this.lastError = undefined;
    } catch (err) {
      this.lastError = (err as Error).message;
      return [];
    }
    const all = rows.map((r) => ({ id: r.id, score: cosine(q, r.vec) })).sort((a, b) => b.score - a.score);
    // Above the floor and close to the best match (the rest is usually noise).
    const best = all[0]?.score ?? 0;
    const scored = all.filter((r) => r.score >= minScore && (minScore <= 0 || r.score >= best - MARGIN));
    const out: { memory: Memory; score: number }[] = [];
    for (const s of scored) {
      const m = this.#mem.get(s.id);
      if (m && m.supersededBy === null) out.push({ memory: m, score: s.score });
      if (out.length >= k) break;
    }
    return out;
  }
}
