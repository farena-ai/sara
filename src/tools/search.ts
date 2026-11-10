// Web search tool. The owner picks a search backend and supplies their own key (or a SearXNG URL).
import { netFetch } from '../net-guard.ts';
import { clip, num, str, ToolError, type Tool } from './types.ts';

export type SearchProvider = 'brave' | 'tavily' | 'ollama' | 'searxng';
export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['brave', 'tavily', 'ollama', 'searxng'];

export interface SearchConfig {
  provider: SearchProvider;
  /** SearXNG base URL (e.g. http://127.0.0.1:8888). */
  url?: string;
  apiKey?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const searchVaultKey = (p: SearchProvider) => `search:${p}`;

export async function runSearch(cfg: SearchConfig, query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
  const sig = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const fail = async (res: Response): Promise<never> => {
    throw new ToolError(`Search failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 200)}`);
  };
  switch (cfg.provider) {
    case 'brave': {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(count));
      const res = await netFetch(u, { headers: { accept: 'application/json', 'x-subscription-token': cfg.apiKey ?? '' }, signal: sig });
      if (!res.ok) await fail(res);
      const body = (await res.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
      return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? '' }));
    }
    case 'tavily': {
      const res = await netFetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey ?? ''}` },
        body: JSON.stringify({ query, max_results: count }),
        signal: sig,
      });
      if (!res.ok) await fail(res);
      const body = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
      return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
    }
    case 'ollama': {
      const res = await netFetch('https://ollama.com/api/web_search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey ?? ''}` },
        body: JSON.stringify({ query, max_results: count }),
        signal: sig,
      });
      if (!res.ok) await fail(res);
      const body = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
      return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
    }
    case 'searxng': {
      if (!cfg.url) throw new ToolError('SearXNG URL is not set.');
      const u = new URL('search', cfg.url.endsWith('/') ? cfg.url : `${cfg.url}/`);
      u.searchParams.set('q', query);
      u.searchParams.set('format', 'json');
      const res = await netFetch(u, { headers: { accept: 'application/json' }, signal: sig });
      if (!res.ok) await fail(res);
      const body = (await res.json()) as { results?: { title: string; url: string; content?: string }[] };
      return (body.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
    }
  }
}

export function formatResults(results: SearchResult[]): string {
  if (!results.length) return 'No results.';
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, ' ').trim().slice(0, 400)}`).join('\n\n');
}

/** Configured searches only: `getConfig` returns undefined when the owner hasn't set one up. */
export function createWebSearchTool(getConfig: () => SearchConfig | undefined): Tool {
  return {
    defaultPermission: 'auto',
    isAvailable: () => Boolean(getConfig()),
    spec: {
      name: 'web_search',
      description: 'Search the web. Returns titles, URLs and snippets; use web_fetch to read a result. Use it to find pages ("site:example.com topic" searches one site) instead of guessing addresses. For research, guides or learning a topic, use research_start.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, count: { type: 'integer', description: 'Results, default 5, max 10' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `search "${String(a.query ?? '')}"`,
    async run(args, ctx) {
      const cfg = getConfig();
      if (!cfg) throw new ToolError('Web search is not set up. The owner can add it in Settings.');
      const count = Math.min(10, Math.max(1, Math.floor(num(args, 'count', 5))));
      const results = await runSearch(cfg, str(args, 'query'), count, ctx.signal);
      // 3.1.2: addresses search gave are never refused as guesses.
      ctx.webTurn?.noteFound(results.map((r) => r.url));
      return clip(formatResults(results), 20_000);
    },
  };
}
