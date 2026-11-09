// V4b (docs/ops/V4_DESIGN.md → Memory map): what she remembers as a graph. Pure over records that
// already exist in the space's own store: the notes (MemoryStore), how they fade (Phase 76 decay
// policy; archived and replaced notes from the memory tidy, EC13), and the links between them:
//   words     two notes share at least two uncommon words (light stems, as the recall ranking uses)
//   chat      two notes came from the same conversation
//   replaced  a note points at the one that replaced it (superseded_by: a correction or a tidy merge)
//   contradicts  the memory tidy found the two disagree (its proposals; nothing is applied here)
// At most MAP_CAP nodes (pinned, most used and newest first) and MAP_LINK_CAP links (≤ 6 per note).
// The layout is a seeded force layout, cached per store by the set of notes and their updates, so
// the map keeps its shape until something changes. Text is clipped; the Memory page has the rest.
import type { Memory } from './memory.ts';
import { type DecayPolicy, freshness, queryWords, stem } from './memory-rank.ts';

export const MAP_CAP = 150;
export const MAP_LINK_CAP = 400;
const PER_NODE_LINKS = 6;
const TEXT_CHARS = 160;

export type LinkWhy = 'words' | 'chat' | 'replaced' | 'contradicts';
export interface MapNode {
  id: number;
  kind: Memory['kind'];
  text: string;
  x: number;
  y: number;
  /** 0..1: how strongly it stands (freshness and reuse; 1 for pinned notes). */
  weight: number;
  fading: boolean;
  pinned: boolean;
  /** Has the most links (drawn larger, in the accent). */
  hub: boolean;
  happenedOn: string;
}
export interface MapLink { a: number; b: number; why: LinkWhy; w: number }
export interface MemoryMap { nodes: MapNode[]; links: MapLink[]; total: number; shown: number; fading: number; capped: boolean }

export interface MapOptions {
  policy: DecayPolicy;
  today?: string;
  contradictions?: [number, number][];
  cap?: number;
}

/** Fading: archived by the tidy, replaced, or below the decay policy's standing (never pinned). */
export function isFading(m: Memory, policy: DecayPolicy, today?: string): boolean {
  if (m.pinned) return false;
  if (m.archived || m.supersededBy !== null || (m.kind === 'promise' && m.resolvedAt)) return true;
  return Boolean(policy.halfLifeDays) && freshness(m, policy, today) < policy.minStanding;
}

function pickNodes(all: Memory[], cap: number): Memory[] {
  const score = (m: Memory) => (m.pinned ? 1e6 : 0) + Math.min(50, m.useCount) * 1e3 + (m.archived ? -5e5 : 0);
  return [...all].sort((a, b) => score(b) - score(a) || (a.happenedOn < b.happenedOn ? 1 : a.happenedOn > b.happenedOn ? -1 : b.id - a.id)).slice(0, cap);
}

/** The links between the chosen notes (pure; capped per note and overall). */
export function mapLinks(notes: Memory[], contradictions: [number, number][] = []): MapLink[] {
  const ids = new Set(notes.map((m) => m.id));
  const words = new Map<number, Set<string>>();
  const df = new Map<string, number>();
  for (const m of notes) {
    const set = new Set(queryWords(m.content).map(stem));
    words.set(m.id, set);
    for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const common = Math.max(3, Math.ceil(notes.length * 0.15));
  const out: MapLink[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, why: LinkWhy, w: number) => {
    if (a === b || !ids.has(a) || !ids.has(b)) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a: Math.min(a, b), b: Math.max(a, b), why, w });
  };
  // Strong links first: a contradiction the tidy found, a replacement, then shared words, then a chat.
  for (const [a, b] of contradictions) add(a, b, 'contradicts', 1);
  for (const m of notes) if (m.supersededBy !== null) add(m.id, m.supersededBy, 'replaced', 1);
  const pairs: MapLink[] = [];
  for (let i = 0; i < notes.length; i++) {
    const wa = words.get(notes[i].id)!;
    for (let j = i + 1; j < notes.length; j++) {
      const wb = words.get(notes[j].id)!;
      let shared = 0;
      for (const w of wa) if (wb.has(w) && (df.get(w) ?? 0) <= common) shared++;
      if (shared >= 2) pairs.push({ a: notes[i].id, b: notes[j].id, why: 'words', w: Math.min(1, shared / 4) });
      else if (notes[i].conversationId && notes[i].conversationId === notes[j].conversationId) pairs.push({ a: notes[i].id, b: notes[j].id, why: 'chat', w: 0.3 });
    }
  }
  pairs.sort((x, y) => y.w - x.w || (x.why === y.why ? 0 : x.why === 'words' ? -1 : 1));
  const per = new Map<number, number>();
  for (const p of pairs) {
    if (out.length >= MAP_LINK_CAP) break;
    if ((per.get(p.a) ?? 0) >= PER_NODE_LINKS || (per.get(p.b) ?? 0) >= PER_NODE_LINKS) continue;
    const before = out.length;
    add(p.a, p.b, p.why, p.w);
    if (out.length > before) {
      per.set(p.a, (per.get(p.a) ?? 0) + 1);
      per.set(p.b, (per.get(p.b) ?? 0) + 1);
    }
  }
  return out.slice(0, MAP_LINK_CAP);
}

/** A small seeded random (mulberry32): the same notes always start in the same places. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Force layout in the unit square (0.04..0.96), deterministic for the same nodes and links. */
export function layout(ids: number[], links: MapLink[]): Map<number, { x: number; y: number }> {
  const n = ids.length;
  const pos = ids.map((id) => {
    const r = rng(id * 2654435761);
    return { x: 0.15 + r() * 0.7, y: 0.15 + r() * 0.7, dx: 0, dy: 0 };
  });
  const at = new Map(ids.map((id, i) => [id, i]));
  const k = Math.sqrt(1 / Math.max(1, n)) * 0.5;
  let temp = 0.1;
  for (let it = 0; it < 160; it++) {
    for (const p of pos) p.dx = p.dy = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x;
        const dy = pos[i].y - pos[j].y;
        const d2 = Math.max(1e-6, dx * dx + dy * dy);
        const f = (k * k) / d2;
        pos[i].dx += dx * f;
        pos[i].dy += dy * f;
        pos[j].dx -= dx * f;
        pos[j].dy -= dy * f;
      }
    }
    for (const l of links) {
      const a = pos[at.get(l.a)!];
      const b = pos[at.get(l.b)!];
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.max(1e-4, Math.hypot(dx, dy));
      const f = ((d * d) / k) * (0.4 + l.w);
      a.dx -= (dx / d) * f;
      a.dy -= (dy / d) * f;
      b.dx += (dx / d) * f;
      b.dy += (dy / d) * f;
    }
    for (const p of pos) {
      // A soft pull to the middle keeps lone notes on the map.
      // Gravity to the middle (stronger than repulsion far out) keeps the map round, not on its rim.
      p.dx += (0.5 - p.x) * 2.5;
      p.dy += (0.5 - p.y) * 2.5;
      const d = Math.max(1e-6, Math.hypot(p.dx, p.dy));
      // Inside the frame (Fruchterman-Reingold): lone notes can't push the clusters into a dot.
      p.x = Math.min(0.98, Math.max(0.02, p.x + (p.dx / d) * Math.min(d, temp)));
      p.y = Math.min(0.98, Math.max(0.02, p.y + (p.dy / d) * Math.min(d, temp)));
    }
    temp = Math.max(0.002, temp * 0.97);
  }
  // Fit to the box.
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const fit = (v: number, lo: number, hi: number) => (hi - lo < 1e-6 ? 0.5 : 0.04 + ((v - lo) / (hi - lo)) * 0.92);
  return new Map(ids.map((id, i) => [id, { x: round3(fit(pos[i].x, x0, x1)), y: round3(fit(pos[i].y, y0, y1)) }]));
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const cache = new WeakMap<object, { sig: string; map: MemoryMap }>();

/** The map of a list of notes (pure); `owner` keys the layout cache (one per memory store). */
export function buildMemoryMap(all: Memory[], opts: MapOptions, owner?: object): MemoryMap {
  const cap = Math.max(1, Math.min(MAP_CAP, opts.cap ?? MAP_CAP));
  const notes = pickNodes(all, cap);
  const contradictions = opts.contradictions ?? [];
  const sig = `${opts.today ?? ''}|${opts.policy.halfLifeDays}|${opts.policy.minStanding}|${contradictions.map((c) => c.join('-')).join(',')}|${all.length}|${notes.map((m) => `${m.id}.${m.updatedAt}.${m.supersededBy ?? ''}.${m.archived ? 1 : 0}.${m.pinned ? 1 : 0}`).join(',')}`;
  const hit = owner ? cache.get(owner) : undefined;
  if (hit && hit.sig === sig) return hit.map;
  const links = mapLinks(notes, contradictions);
  const pos = layout(notes.map((m) => m.id), links);
  const degree = new Map<number, number>();
  for (const l of links) for (const id of [l.a, l.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const hubAt = [...degree.values()].sort((a, b) => b - a)[Math.min(3, Math.max(0, degree.size - 1))] ?? Infinity;
  const nodes: MapNode[] = notes.map((m) => {
    const fading = isFading(m, opts.policy, opts.today);
    const fresh = freshness(m, opts.policy, opts.today);
    const text = m.content.length > TEXT_CHARS ? `${m.content.slice(0, TEXT_CHARS - 1)}…` : m.content;
    return { id: m.id, kind: m.kind, text, x: pos.get(m.id)!.x, y: pos.get(m.id)!.y, weight: m.pinned ? 1 : round3(Math.min(1, fresh * 0.8 + Math.min(1, m.useCount / 8) * 0.2)), fading, pinned: m.pinned, hub: (degree.get(m.id) ?? 0) >= Math.max(3, hubAt), happenedOn: m.happenedOn };
  });
  const map: MemoryMap = { nodes, links, total: all.length, shown: nodes.length, fading: all.filter((m) => isFading(m, opts.policy, opts.today)).length, capped: all.length > nodes.length };
  if (owner) cache.set(owner, { sig, map });
  return map;
}
