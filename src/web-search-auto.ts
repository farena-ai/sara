// 3.3.0 easy mode (ezfirst): web search without a second setup. An Ollama Cloud key also works for
// Ollama web search (https://ollama.com/api/web_search), so connecting Ollama Cloud with a key turns
// web search on with that key when no search is set up yet (the other services' keys don't give
// Sara a search). And when search is off, she never promises to look things up: a message that asks
// her to search the web gets a plain notice with one button (Turn on web search), in one tap when
// an Ollama Cloud key is already there.
import type { AppContext } from './chat.ts';
import { vaultKeyFor } from './chat.ts';
import { searchConfig } from './integrations.ts';
import type { ProviderConfig } from './providers/types.ts';
import { searchVaultKey } from './tools/search.ts';

/** Ollama Cloud: its own preset (ollama-cloud…) or any provider at ollama.com. */
export function isOllamaCloud(config: Pick<ProviderConfig, 'id' | 'baseUrl'>): boolean {
  if (/^ollama-cloud(-\d+)?$/.test(config.id)) return true;
  try {
    return /(^|\.)ollama\.com$/i.test(new URL(String(config.baseUrl ?? '')).hostname);
  } catch {
    return false;
  }
}

/** The key of a connected Ollama Cloud provider, if any (it also works for Ollama web search). */
export function ollamaCloudKey(app: AppContext): string | undefined {
  for (const p of app.settings.get().providers) {
    if (!isOllamaCloud(p)) continue;
    const k = app.vault.get(vaultKeyFor(p.id));
    if (k) return k;
  }
  return undefined;
}

/**
 * After a provider was saved: an Ollama Cloud key turns Ollama web search on with the same key,
 * unless he already set up a search (his choice stays). True when it turned it on.
 */
export function autoWebSearch(app: AppContext, config: Pick<ProviderConfig, 'id' | 'baseUrl'>, apiKey: unknown): boolean {
  if (typeof apiKey !== 'string' || !apiKey.trim() || !isOllamaCloud(config)) return false;
  if (app.settings.get().search) return false;
  app.vault.set(searchVaultKey('ollama'), apiKey.trim());
  app.settings.update({ search: { provider: 'ollama' } });
  return true;
}

/** Turns on Ollama web search with the connected Ollama Cloud key (the one-tap button). */
export function useOllamaKeyForSearch(app: AppContext): boolean {
  const key = ollamaCloudKey(app);
  if (!key) return false;
  app.vault.set(searchVaultKey('ollama'), key);
  app.settings.update({ search: { provider: 'ollama' } });
  return true;
}

/** "Look it up", "search the web", "find me a guide", "research…", "latest news on…". */
// T43 (E5): words that are an ask, not words that only appear. "My brother does research", "I built a
// website", "I was online all day" and "I can't find a reason" all used to bring the notice up.
const ASK = "(?:^|[.!?:;,]\\s*|\\b(?:please|pls|can you|could you|would you|will you|you to|go|and|then|now)\\s+)";
const WANTS_WEB = new RegExp(
  [
    '\\blook (?:it|this|that|them) ?up\\b|\\blook up\\b',
    '\\bsearch (?:for|the web|online|the internet)\\b|\\bgoogle (?:it|this|that|for)\\b',
    ASK + '(?:look (?:for|into)|find (?:me|out about|out (?:what|who|when|where|how|if|whether))|research)\\b(?!\\s+(?:is|was|shows|says|suggests|paper|papers|lab|team|grant|job)\\b)',
    '\\b(?:search|look|check|find|see|read)\\b[^.!?]{0,40}\\b(?:on ?line|on the (?:web|internet)|(?:their|the|its|his|her) web ?site)\\b',
    '\\blatest news\\b|\\bnews (?:about|on)\\b|\\bguides? (?:to|for|on)\\b|\\breviews? (?:of|for)\\b',
  ].join('|'),
  'i',
);

/** True when he asks her to look something up on the web. */
export function wantsWeb(text: string): boolean {
  return WANTS_WEB.test(String(text ?? '').slice(0, 2000));
}

/** Web search is off and the message asks for it: what the turn says (and tells her). */
export function webSearchOff(app: AppContext, text: string): { oneTap: boolean } | null {
  if (searchConfig(app.settings, app.vault) || !wantsWeb(text)) return null;
  return { oneTap: Boolean(ollamaCloudKey(app)) };
}
