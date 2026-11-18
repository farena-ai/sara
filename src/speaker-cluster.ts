// U3.13 (docs/design/U3SPEAK.md): who spoke when, from voice prints. Pure functions, no model here:
// the speaker add-on (src/speaker-addon.ts) turns short windows of speech into voice prints
// (embeddings); this file groups them. Average-linkage agglomerative clustering on cosine
// similarity with a threshold, so the number of speakers is found, up to MAX_SPEAKERS (extra
// groups go to the nearest one, and the merge is explained). Voices of earlier parts of the same
// upload keep their numbers (prior centers). Windows are smoothed so one odd window inside a turn
// doesn't flip the speaker; a speaker change inside a turn without a pause becomes a new segment.
export const MAX_SPEAKERS = 8;
/** Cosine similarity at or above which two groups are one voice (3D-Speaker ERes2Net, tuned in docs/RESULTS.md). */
export const SAME_VOICE = 0.45;
/** Groups this much above the line still merged are "very alike" and explained as a close call. */
const CLOSE_CALL = 0.12;

export interface Window {
  start: number;
  end: number;
  /** The speech turn (pause to pause) the window belongs to. */
  turn: number;
}
export interface Merge {
  /** Why two voices became one: they sounded alike, or there were more than MAX_SPEAKERS. */
  why: 'alike' | 'too-many';
  /** The speaker number kept (0-based), and how alike the two were (cosine, 0..1). */
  into: number;
  similarity: number;
}
export interface Clustered {
  /** Speaker number per window (0-based; numbers follow first appearance after prior voices). */
  labels: number[];
  /** Each speaker's mean voice print (unit length), index = speaker number. */
  centers: number[][];
  merges: Merge[];
}

export function unit(v: ArrayLike<number>): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
function mean(vs: number[][]): number[] {
  const out = new Array<number>(vs[0].length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i];
  return unit(out);
}

/**
 * Average-linkage agglomerative clustering: merge the two most alike groups while their average
 * similarity is at least `threshold`, then keep merging while there are more than `max` groups.
 * Returns a group per item (0-based, in order of first appearance) and the merges worth explaining.
 */
export function agglomerate(vectors: number[][], opts: { threshold?: number; max?: number } = {}): { labels: number[]; merges: { why: Merge['why']; a: number; b: number; similarity: number }[] } {
  const threshold = opts.threshold ?? SAME_VOICE;
  const max = Math.max(1, opts.max ?? MAX_SPEAKERS);
  const n = vectors.length;
  if (!n) return { labels: [], merges: [] };
  const v = vectors.map(unit);
  // Similarity matrix (Float64 for n up to ~1200: 11 MB).
  const sim = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      let d = 0;
      const a = v[i];
      const b = v[j];
      for (let k = 0; k < a.length; k++) d += a[k] * b[k];
      sim[i * n + j] = sim[j * n + i] = d;
    }
  const size = new Array<number>(n).fill(1);
  const alive = new Array<boolean>(n).fill(true);
  const owner = Array.from({ length: n }, (_, i) => i);
  const merges: { why: Merge['why']; a: number; b: number; similarity: number }[] = [];
  let groups = n;
  // Best partner per group, refreshed after each merge (O(n^2) per merge worst case, fine for a part).
  while (groups > 1) {
    let bi = -1;
    let bj = -1;
    let best = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!alive[j]) continue;
        const s = sim[i * n + j];
        if (s > best) {
          best = s;
          bi = i;
          bj = j;
        }
      }
    }
    if (best < threshold && groups <= max) break;
    const why: Merge['why'] = best < threshold ? 'too-many' : 'alike';
    // Explain merges of big groups only: two real voices that ended up as one.
    if (size[bi] >= 3 && size[bj] >= 3 && (why === 'too-many' || best < threshold + CLOSE_CALL)) merges.push({ why, a: bi, b: bj, similarity: best });
    // Lance-Williams update for average linkage.
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const s = (sim[bi * n + k] * size[bi] + sim[bj * n + k] * size[bj]) / (size[bi] + size[bj]);
      sim[bi * n + k] = sim[k * n + bi] = s;
    }
    size[bi] += size[bj];
    alive[bj] = false;
    for (let k = 0; k < n; k++) if (owner[k] === bj) owner[k] = bi;
    groups--;
  }
  // Stray groups (a few windows: a cough, a cut between two voices, crosstalk) join the most alike
  // big group; in a part with 20 windows or more, a voice needs 3% of them (at least 2) to count.
  const minSize = n >= 20 ? Math.max(2, Math.ceil(n * 0.03)) : 1;
  for (;;) {
    const live = [...Array(n).keys()].filter((i) => alive[i]);
    const small = live.filter((i) => size[i] < minSize).sort((a, b) => size[a] - size[b])[0];
    if (small === undefined || live.length < 2) break;
    const into = live.filter((i) => i !== small).sort((a, b) => sim[small * n + b] - sim[small * n + a])[0];
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === into || k === small) continue;
      const s = (sim[into * n + k] * size[into] + sim[small * n + k] * size[small]) / (size[into] + size[small]);
      sim[into * n + k] = sim[k * n + into] = s;
    }
    size[into] += size[small];
    alive[small] = false;
    for (let k = 0; k < n; k++) if (owner[k] === small) owner[k] = into;
  }
  // Number groups in order of first appearance.
  const num = new Map<number, number>();
  const labels = owner.map((g) => {
    if (!num.has(g)) num.set(g, num.size);
    return num.get(g)!;
  });
  return { labels, merges: merges.map((m) => ({ ...m, a: num.get(owner[m.a]) ?? 0, b: num.get(owner[m.b]) ?? 0 })) };
}

/** Each window takes the label most common among itself and its neighbors in the same turn (a 3-wide vote). */
export function smooth(labels: number[], windows: Window[]): number[] {
  return labels.map((l, i) => {
    const near = [i - 1, i, i + 1].filter((k) => k >= 0 && k < labels.length && windows[k].turn === windows[i].turn).map((k) => labels[k]);
    const count = (x: number) => near.filter((y) => y === x).length;
    return near.reduce((b, x) => (count(x) > count(b) ? x : b), l);
  });
}

/**
 * Clusters the windows' voice prints and numbers the speakers so voices already heard in earlier
 * parts (`prior` centers) keep their numbers; new voices get the next free numbers.
 */
export function clusterVoices(prints: ArrayLike<number>[], windows: Window[], prior: number[][] = [], opts: { threshold?: number; max?: number } = {}): Clustered {
  const threshold = opts.threshold ?? SAME_VOICE;
  const max = opts.max ?? MAX_SPEAKERS;
  const vecs = prints.map(unit);
  const g = agglomerate(vecs, { threshold, max });
  const groups = Math.max(0, ...g.labels.map((l) => l + 1));
  const gc = Array.from({ length: groups }, (_, k) => mean(vecs.filter((_, i) => g.labels[i] === k)));
  // Match groups to prior voices (best pairs first), then new numbers in order of appearance.
  const map = new Array<number>(groups).fill(-1);
  const merges: Merge[] = [];
  const pairs: [number, number, number][] = [];
  for (let k = 0; k < groups; k++) for (let p = 0; p < prior.length; p++) pairs.push([cosine(gc[k], prior[p]), k, p]);
  pairs.sort((a, b) => b[0] - a[0]);
  const used = new Set<number>();
  for (const [s, k, p] of pairs) if (s >= threshold && map[k] < 0 && !used.has(p)) (map[k] = p), used.add(p);
  const centers = prior.map((c) => [...c]);
  for (let k = 0; k < groups; k++) {
    if (map[k] >= 0) continue;
    if (centers.length < max) {
      map[k] = centers.length;
      centers.push(gc[k]);
    } else {
      // No room left: the nearest voice already known.
      let best = 0;
      for (let p = 1; p < centers.length; p++) if (cosine(gc[k], centers[p]) > cosine(gc[k], centers[best])) best = p;
      map[k] = best;
      merges.push({ why: 'too-many', into: best, similarity: cosine(gc[k], centers[best]) });
    }
  }
  for (const m of g.merges) merges.push({ why: m.why, into: map[m.a], similarity: Math.round(m.similarity * 100) / 100 });
  // Centers follow this part too (a running mean keeps them steady over a long upload).
  for (let k = 0; k < groups; k++) {
    const s = map[k];
    if (s < prior.length) centers[s] = unit(centers[s].map((x, i) => x + gc[k][i]));
  }
  return { labels: smooth(g.labels.map((l) => map[l]), windows), centers, merges };
}

/** Windows over speech turns: `len` seconds long every `hop` seconds; a short turn is one window. */
export function windowsOf(turns: { start: number; end: number }[], len = 1.5, hop = 0.75): Window[] {
  const out: Window[] = [];
  turns.forEach((t, turn) => {
    if (t.end - t.start <= len + hop / 2) {
      out.push({ start: t.start, end: t.end, turn });
      return;
    }
    let a = t.start;
    for (; a + len < t.end - hop / 2; a += hop) out.push({ start: a, end: a + len, turn });
    out.push({ start: Math.max(t.start, t.end - len), end: t.end, turn });
  });
  return out;
}

/** Segments from labeled windows: a change of speaker inside a turn cuts it halfway into the overlap. */
export function segmentsOf(windows: Window[], labels: number[]): { start: number; end: number; speaker: number }[] {
  const out: { start: number; end: number; speaker: number }[] = [];
  windows.forEach((w, i) => {
    const last = out[out.length - 1];
    const prev = windows[i - 1];
    if (last && prev && prev.turn === w.turn && last.speaker === labels[i]) last.end = w.end;
    else if (last && prev && prev.turn === w.turn) {
      const cut = (w.start + prev.end) / 2;
      last.end = Math.max(last.start, cut);
      out.push({ start: cut, end: w.end, speaker: labels[i] });
    } else out.push({ start: w.start, end: w.end, speaker: labels[i] });
  });
  return out;
}
