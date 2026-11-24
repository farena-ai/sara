// S1 (docs/ROADMAP_AFTER_3.40.md): Meaning search without setup.
//
// Picking tools and research asks by what a message means (src/tool-meaning.ts), and memory that
// finds things said in other words, all need the "Meaning search" job, which was off until someone
// set it by hand. Most people never did. Now, when an embedding model is already on this computer
// (a local provider lists one), the job is set to it once.
//
// Once: `meaningAuto: 'done'` is written with it, so a person who then turns Meaning search off in
// Settings keeps it off. Only a model on this computer (nothing a person wrote leaves it because of
// this); never a download; never when the job is already set.
//
// T48: before adopting, each candidate is timed with one real short embedding (after one warm-up
// call, which includes loading the model). On a server without a graphics card bge-m3 took 30 to
// 60 s a sentence, so it was adopted and then never finished its index. The best-named one that
// answers in time is taken; if none does, none is, and why is kept for Settings.
import type { AppContext } from './chat.ts';
import { vaultKeyFor } from './chat.ts';
import { embedPace, embedTarget, type EmbedTarget, embedTexts } from './embeddings.ts';
import { isCloudModelName } from './model-names.ts';
import type { ProviderConfig } from './providers/types.ts';

/** Best first: bge-m3 works in many languages; nomic-embed-text is smaller and English; then any other. */
const PREFER: RegExp[] = [/(^|\/)bge-m3\b/i, /nomic-embed-text/i, /mxbai-embed|arctic-embed|embeddinggemma|qwen3-embedding/i, /embed|(^|\/)bge-|(^|\/)e5-|(^|\/)gte-|minilm/i];

/** The embedding model to use from a list of model names, if there is one. */
export function pickEmbedModel(models: readonly string[]): string | undefined {
  for (const re of PREFER) {
    const m = models.find((x) => re.test(x) && !isCloudModelName(x));
    if (m) return m;
  }
  return undefined;
}

/** Every embedding model in the list, best-named first (at most `max`). */
export function embedCandidates(models: readonly string[], max = 3): string[] {
  const out: string[] = [];
  for (const re of PREFER) for (const m of models) if (re.test(m) && !isCloudModelName(m) && !out.includes(m)) out.push(m);
  return out.slice(0, max);
}

const canEmbedHere = (p: ProviderConfig): boolean => p.local === true && p.kind === 'openai-compatible' && Boolean(p.baseUrl);

/**
 * Sets the Meaning search job to an embedding model on this computer, once. Returns what it set.
 * `modelsOf` = the models a provider is known to have (no network here: the kept list).
 */
export function adoptMeaningSearch(app: Pick<AppContext, 'settings'>, modelsOf: (providerId: string) => readonly string[]): { providerId: string; model: string } | undefined {
  const providers = adoptable(app);
  for (const p of providers ?? []) {
    const model = pickEmbedModel(modelsOf(p.id));
    if (model) return adopt(app, { providerId: p.id, model });
  }
  return undefined;
}

/** The providers to look in, or undefined when Meaning search is no longer hers to set. */
function adoptable(app: Pick<AppContext, 'settings'>): ProviderConfig[] | undefined {
  const s = app.settings.get();
  if (s.meaningAuto === 'done') return undefined;
  if (s.routes?.embeddings) {
    // Set by hand before this existed: nothing to do, now or later.
    app.settings.update({ meaningAuto: 'done' });
    return undefined;
  }
  return s.providers.filter(canEmbedHere);
}

function adopt(app: Pick<AppContext, 'settings'>, pick: { providerId: string; model: string }): { providerId: string; model: string } {
  app.settings.update({ routes: { ...app.settings.get().routes, embeddings: pick }, meaningAuto: 'done' });
  return pick;
}

/**
 * How long one short sentence may take once the model is loaded (`limitMs`), how long the warm-up
 * call that loads it may take (`warmMs`), and how long to wait before timing again after none was
 * quick enough (`retryMs`; sooner when the list of models changes).
 */
export const ADOPT_PACE = { limitMs: 4000, warmMs: 90_000, retryMs: 12 * 60 * 60_000 };
const SAMPLE = 'A short sentence to see how quickly this model answers.';

export type Embed = (t: EmbedTarget, texts: string[], signal: AbortSignal) => Promise<unknown>;

/** Why nothing was adopted the last time (per companion), for Settings. */
export interface AdoptNote {
  at: number;
  /** The models tried, each too slow (or not answering). */
  tooSlow: string[];
  key: string;
}
const notes = new WeakMap<object, AdoptNote>();
/** Timing now (it can take minutes on a slow computer): a second ask waits for the next round. */
const timing = new WeakSet<object>();

/** The Meaning search model is too slow for this computer: its index rests, or the last index call said so. */
export function meaningTooSlow(app: AppContext): boolean {
  const t = embedTarget(app);
  return Boolean(t && (embedPace(t).resting || /too slow on this computer/.test(app.vectors?.lastError ?? '')));
}

export function meaningAdoptNote(app: Pick<AppContext, 'settings'>): AdoptNote | undefined {
  return notes.get(app.settings);
}

/** One warm-up call, then one timed call: its time in ms, or null when it failed or ran out of time. */
export async function timeEmbed(t: EmbedTarget, embed: Embed = embedTexts, now: () => number = Date.now): Promise<number | null> {
  try {
    await embed(t, [SAMPLE], AbortSignal.timeout(ADOPT_PACE.warmMs));
    const t0 = now();
    await embed(t, [SAMPLE], AbortSignal.timeout(ADOPT_PACE.limitMs));
    const ms = now() - t0;
    return ms <= ADOPT_PACE.limitMs ? ms : null;
  } catch {
    return null;
  }
}

/**
 * adoptMeaningSearch, but each candidate (best-named first) is timed first and the first one quick
 * enough is set. None quick enough: none is set, and why is kept (meaningAdoptNote) and not timed
 * again for a while unless the models change. `embed` is the call to time (tests pass their own).
 */
export async function adoptMeaningSearchTimed(
  app: Pick<AppContext, 'settings' | 'vault'>,
  modelsOf: (providerId: string) => readonly string[],
  opts: { embed?: Embed; now?: () => number } = {},
): Promise<{ providerId: string; model: string } | undefined> {
  const providers = adoptable(app);
  if (!providers) return undefined;
  const now = opts.now ?? Date.now;
  const lists = providers.map((p) => ({ p, models: embedCandidates(modelsOf(p.id)) })).filter((x) => x.models.length);
  if (!lists.length) return undefined;
  const key = lists.map((x) => `${x.p.id}:${x.models.join(',')}`).join('|');
  const last = notes.get(app.settings);
  if ((last && last.key === key && now() - last.at < ADOPT_PACE.retryMs) || timing.has(app.settings)) return undefined;
  timing.add(app.settings);
  try {
    const tooSlow: string[] = [];
    for (const { p, models } of lists) {
      for (const model of models) {
        const target: EmbedTarget = { config: p, key: app.vault.get(vaultKeyFor(p.id)) ?? undefined, model };
        if ((await timeEmbed(target, opts.embed, now)) !== null) {
          notes.delete(app.settings);
          // The owner may have set it by hand while this was timing.
          return adoptable(app) ? adopt(app, { providerId: p.id, model }) : undefined;
        }
        tooSlow.push(model);
      }
    }
    notes.set(app.settings, { at: now(), tooSlow, key });
    return undefined;
  } finally {
    timing.delete(app.settings);
  }
}
