// W2.5 (docs/HELP_SEARCH.md): the how-to clips under docs/media, served at /docs/media/ so the app's
// How do I answers and the guide can play them. Only clip files and their list: never other docs.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OK = /^\/docs\/media\/(?:(howto)\/)?([\w-]+\.(?:webm|gif|png|json))$/;
export const MEDIA_TYPES: Record<string, string> = { webm: 'video/webm', gif: 'image/gif', png: 'image/png', json: 'application/json' };

/** The file for a /docs/media/ path (null for anything else). `webRoot` is the web folder; docs sit next to it. */
export function helpMediaFile(webRoot: string, pathname: string): string | null {
  const m = OK.exec(pathname);
  if (!m) return null;
  const base = resolve(webRoot, '..', 'docs', 'media');
  return m[1] ? join(base, m[1], m[2]) : join(base, m[2]);
}

/** Whether such a file is there (installs without docs/media just have no clips). */
export const helpMediaExists = (file: string | null): file is string => Boolean(file) && existsSync(file!);
