// R2: the public download page's data (GET /api/public/release, no sign-in). The latest GitHub
// release of the public repository, mapped to one installer per system (web/download-os.js), cached
// for an hour so visitors never hit GitHub's rate limit; when GitHub can't be reached the page still
// links the releases page. Only public release facts leave here (names, links, sizes, version).
import { netFetch } from './net-guard.ts';
import { RELEASE_API } from './updates.ts';
import { releaseAssets, RELEASES_PAGE } from '../web/download-os.js';

export const RELEASE_CACHE_MS = 60 * 60_000;
/** After a failed fetch, try again after this long (a short cache of the failure). */
export const RELEASE_RETRY_MS = 5 * 60_000;

export type ReleaseAssets = ReturnType<typeof releaseAssets>;
export interface ReleaseInfo {
  ok: boolean;
  assets: ReleaseAssets;
  checkedAt: string;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const EMPTY = (): ReleaseAssets => releaseAssets({ html_url: RELEASES_PAGE, assets: [] });

export function createReleaseCache(o: { fetch?: Fetcher; now?: () => number; url?: string } = {}) {
  const now = o.now ?? Date.now;
  let cached: { info: ReleaseInfo; until: number } | undefined;
  let pending: Promise<ReleaseInfo> | undefined;
  async function load(): Promise<ReleaseInfo> {
    const at = new Date(now()).toISOString();
    try {
      const res = await (o.fetch ?? (netFetch as Fetcher))(o.url ?? RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Sara-download-page' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const info = { ok: true, assets: releaseAssets(await res.json()), checkedAt: at };
      cached = { info, until: now() + RELEASE_CACHE_MS };
      return info;
    } catch {
      // Keep the last good answer when there is one; else the releases page only.
      const info = cached?.info.ok ? cached.info : { ok: false, assets: EMPTY(), checkedAt: at };
      cached = { info, until: now() + RELEASE_RETRY_MS };
      return info;
    }
  }
  return {
    async get(): Promise<ReleaseInfo> {
      if (cached && cached.until > now()) return cached.info;
      pending ??= load().finally(() => (pending = undefined));
      return pending;
    },
    clear(): void {
      cached = undefined;
    },
  };
}

let shared: ReturnType<typeof createReleaseCache> | undefined;
/** One cache for every space of this process (a household's servers share it). */
export const sharedReleases = () => (shared ??= createReleaseCache());
