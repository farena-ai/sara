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
import type { AppContext } from './chat.ts';
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

const canEmbedHere = (p: ProviderConfig): boolean => p.local === true && p.kind === 'openai-compatible' && Boolean(p.baseUrl);

/**
 * Sets the Meaning search job to an embedding model on this computer, once. Returns what it set.
 * `modelsOf` = the models a provider is known to have (no network here: the kept list).
 */
export function adoptMeaningSearch(app: Pick<AppContext, 'settings'>, modelsOf: (providerId: string) => readonly string[]): { providerId: string; model: string } | undefined {
  const s = app.settings.get();
  if (s.meaningAuto === 'done') return undefined;
  if (s.routes?.embeddings) {
    // Set by hand before this existed: nothing to do, now or later.
    app.settings.update({ meaningAuto: 'done' });
    return undefined;
  }
  for (const p of s.providers.filter(canEmbedHere)) {
    const model = pickEmbedModel(modelsOf(p.id));
    if (!model) continue;
    const pick = { providerId: p.id, model };
    app.settings.update({ routes: { ...s.routes, embeddings: pick }, meaningAuto: 'done' });
    return pick;
  }
  return undefined;
}
