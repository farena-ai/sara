// Phase 124 (2.57.0, docs/store/SARA_STORE.md §6.7, GAP_REVIEW #16): tidying the skills she learned.
// Learned skills (source 'learned') nobody used for 60 days, and older than 60 days, are offered for
// *Archived* once a month on one card: *Archive them* / *Keep them* / *Ask again next month*. Nothing
// happens without the click. Archived is a status, not a delete: the skill stays on disk and in the
// index, out of her list, and *Bring back* returns it. Two ready skills in the same scope that do the
// same job (descriptions close: stored vectors cosine ≥ 0.9, or the word-vector fallback ≥ 0.8, and
// most of their steps shared) are offered as one, at most one such card a month: *Use this* writes
// the merged SKILL.md into the newer one and archives the older; both keep their skill_versions.
// Built-in, imported, store and made skills are never offered (the owner can archive any by hand).
// The merged draft is made here without a model call (the newer skill's steps plus the older one's
// steps it lacks), shown as a before/after diff on the card. One memory_kv key keeps the state.
import { unifiedDiff, wordVector } from './skill-learning.ts';
import type { SkillStore, SkillView } from './skill-store.ts';
import { splitFrontmatter } from './skills.ts';

export const TIDY_DAYS = 60;
export const VECTOR_SAME = 0.9;
export const WORDS_SAME = 0.8;
export const STEPS_SHARED = 0.6;
const KV = 'skillTidy';
const DAY_MS = 86400_000;

export interface TidyState {
  /** The month ("2026-11") each card was last answered (or put off to). */
  archiveMonth?: string;
  mergeMonth?: string;
  /** Pairs the owner said no to ("scope|older|newer"). */
  notSame?: string[];
}
export interface MergeOffer {
  scope: string;
  keep: string;
  older: string;
  score: number;
  draft: string;
  diff: string;
}
export interface TidyCard {
  month: string;
  archive?: { names: string[]; skills: { scope: string; name: string; lastUsedAt: string | null }[] };
  merge?: MergeOffer;
}

const monthOf = (d: Date): string => d.toISOString().slice(0, 7);
function readState(store: SkillStore): TidyState {
  try {
    return JSON.parse(store.kvGet(KV) ?? '{}') as TidyState;
  } catch {
    return {};
  }
}
const writeState = (store: SkillStore, s: TidyState): void => store.kvSet(KV, JSON.stringify(s));

/** Learned skills unused for 60 days (and older than that), ready or on trial. */
export function tidyCandidates(store: SkillStore, now: Date): SkillView[] {
  const cut = now.getTime() - TIDY_DAYS * DAY_MS;
  return store.list().filter((v) => {
    if (v.source !== 'learned' || (v.status !== 'ready' && v.status !== 'trial')) return false;
    if (Date.parse(v.createdAt) > cut) return false;
    const last = store.lastUse(v.scope, v.name) ?? v.lastUsedAt;
    return !last || Date.parse(last) <= cut;
  });
}

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** A skill's steps: its list items and numbered lines, normalised. */
export function stepsOf(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)?.[1] ?? '')
    .map((s) => s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3);
}
function sharedSteps(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const both = a.filter((s) => sb.has(s)).length;
  return both / Math.min(a.length, b.length);
}

/** The merged SKILL.md: the newer skill as it is, plus the older one's steps it lacks. */
export function mergeDraft(newerMd: string, olderBody: string): string {
  const parts = splitFrontmatter(newerMd);
  const body = parts?.body ?? newerMd;
  const have = new Set(stepsOf(body));
  const extra = olderBody.split(/\r?\n/).filter((l) => {
    const s = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)?.[1];
    return s && !have.has(s.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim());
  });
  if (!extra.length) return newerMd;
  const merged = `${body.replace(/\s+$/, '')}\n\n## Also\n\n${extra.map((l) => l.replace(/^\s*(?:\d+[.)])\s+/, '- ')).join('\n')}\n`;
  return parts ? `---\n${parts.front}\n---\n\n${merged}` : merged;
}

/** Near-duplicate pairs among ready skills of the same scope (learned or made by her; never built-in, imported or store skills). */
export function nearDuplicates(store: SkillStore, o: { vectors?: Map<string, ArrayLike<number>>; notSame?: readonly string[] } = {}): MergeOffer[] {
  const pool = store.list().filter((v) => v.status === 'ready' && v.source === 'learned' && v.enabled);
  const vectors = o.vectors ?? store.storedVectors();
  const out: MergeOffer[] = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i];
      const b = pool[j];
      if (a.scope !== b.scope) continue;
      const [older, newer] = Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? [a, b] : [b, a];
      if (o.notSame?.includes(`${a.scope}|${older.name}|${newer.name}`)) continue;
      const va = vectors.get(`${a.scope}|${a.name}`);
      const vb = vectors.get(`${b.scope}|${b.name}`);
      const score = va && vb ? cosine(va, vb) : cosine(wordVector(a.description), wordVector(b.description));
      if (score < (va && vb ? VECTOR_SAME : WORDS_SAME)) continue;
      const bo = store.bodyOf(older).body;
      const bn = store.bodyOf(newer).body;
      if (sharedSteps(stepsOf(bo), stepsOf(bn)) < STEPS_SHARED) continue;
      const newerMd = store.detail(newer.scope, newer.name)?.skillMd ?? bn;
      const draft = mergeDraft(newerMd, bo);
      out.push({ scope: a.scope, keep: newer.name, older: older.name, score: Math.round(score * 1000) / 1000, draft, diff: unifiedDiff(newerMd, draft) });
    }
  }
  return out.sort((x, y) => y.score - x.score);
}

/** This month's card (undefined: nothing to offer, or already answered this month). */
export function tidyCard(store: SkillStore, now: Date, o: { vectors?: Map<string, ArrayLike<number>> } = {}): TidyCard | undefined {
  const st = readState(store);
  const month = monthOf(now);
  const card: TidyCard = { month };
  if (st.archiveMonth !== month) {
    const c = tidyCandidates(store, now);
    if (c.length) card.archive = { names: c.map((v) => v.name), skills: c.map((v) => ({ scope: v.scope, name: v.name, lastUsedAt: store.lastUse(v.scope, v.name) ?? v.lastUsedAt })) };
  }
  if (st.mergeMonth !== month) {
    const m = nearDuplicates(store, { ...(o.vectors ? { vectors: o.vectors } : {}), notSame: st.notSame ?? [] })[0];
    if (m) card.merge = m;
  }
  return card.archive || card.merge ? card : undefined;
}

export type TidyAction = 'archive' | 'keep' | 'later' | 'merge' | 'not-same' | 'merge-later';

/** The owner's answer on the card. */
export function tidyAnswer(store: SkillStore, action: TidyAction, now: Date, o: { vectors?: Map<string, ArrayLike<number>> } = {}): { archived: string[]; merged?: { keep: string; older: string } } {
  const st = readState(store);
  const month = monthOf(now);
  const archived: string[] = [];
  if (action === 'archive' || action === 'keep' || action === 'later') {
    if (action === 'archive') {
      for (const v of tidyCandidates(store, now)) {
        store.archive(v.scope, v.name, 'not used for 60 days');
        archived.push(v.name);
      }
    }
    // Keep them: not again until next month; Ask again next month: the same.
    writeState(store, { ...st, archiveMonth: month });
    return { archived };
  }
  const m = nearDuplicates(store, { ...(o.vectors ? { vectors: o.vectors } : {}), notSame: st.notSame ?? [] })[0];
  if (action === 'merge' && m) {
    const kept = store.get(m.scope, m.keep);
    const parts = splitFrontmatter(m.draft);
    if (kept && parts) {
      store.snapshot(m.scope, m.older, `merged into ${m.keep}`);
      store.save(m.scope, { name: m.keep, description: kept.description, body: parts.body }, { why: `merged with ${m.older}` });
      store.archive(m.scope, m.older, `merged into ${m.keep}`);
      archived.push(m.older);
    }
    writeState(store, { ...st, mergeMonth: month });
    return { archived, merged: { keep: m.keep, older: m.older } };
  }
  if (action === 'not-same' && m) writeState(store, { ...st, mergeMonth: month, notSame: [...(st.notSame ?? []), `${m.scope}|${m.older}|${m.keep}`].slice(-50) });
  else writeState(store, { ...st, mergeMonth: month });
  return { archived };
}
