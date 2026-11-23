// Z4: scripts and stylesheets the browser can keep. The app is about 330 small files (ES modules,
// no bundler). Each was sent with "no-cache", so every load asked the server about every file again:
// about 330 round trips answered "not changed", which on a phone or through a tunnel is most of the
// wait. Now the page (index.html, still checked on every load) points at /v/<id>/app.js and
// /v/<id>/style.css ..., where <id> stands for the exact set of files on disk. Modules import each
// other with relative paths, so everything they load is under /v/<id>/ too, and those answers say
// "immutable": the browser reuses them without asking. A change to any script or stylesheet (an
// update, an edit while developing) gives a new <id>, the page points there, and nothing stale is used.
//
// No build step and nothing written to disk: the id is worked out from the files' names, sizes and
// modification times.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** What is versioned: code the page loads. Pictures, JSON and other pages keep their own addresses. */
export const VERSIONED = /\.(?:js|mjs|css)$/;
/** /v/<id>/<path to a script or stylesheet> */
export const VERSIONED_PATH = /^\/v\/([a-z0-9]{8,20})\/((?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*\.(?:js|mjs|css))$/;
/** How long a worked-out id is trusted before the files are looked at again (edits while developing). */
const FRESH_MS = 3000;

const ids = new Map<string, { id: string; at: number }>();

function walk(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) walk(root, full, out);
    else if (st.isFile() && VERSIONED.test(name)) out.push(`${full.slice(root.length + 1).replaceAll('\\', '/')}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
  }
}

/** The id of the scripts and stylesheets under `webRoot` as they are on disk now. */
export function webBuildId(webRoot: string, also: readonly string[] = [], now: number = Date.now()): string {
  const have = ids.get(webRoot);
  if (have && now - have.at < FRESH_MS) return have.id;
  const files: string[] = [];
  try {
    walk(webRoot, webRoot, files);
  } catch {
    /* a folder that can't be read: the id of what could be */
  }
  // Files from elsewhere that the page loads as scripts too (identity.js is made from src/identity.ts).
  for (const file of also) {
    const st = statSync(file, { throwIfNoEntry: false });
    if (st) files.push(`${file}\0${st.size}\0${Math.floor(st.mtimeMs)}`);
  }
  const id = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
  ids.set(webRoot, { id, at: now });
  return id;
}

/** Tests: forget what was worked out. */
export function resetWebBuildIds(): void {
  ids.clear();
  graphs.clear();
}

/**
 * The page with its own scripts and stylesheets pointed at /v/<id>/. Only `src="/x.js"` and
 * `href="/x.css"` from this site (a leading single slash); icons, the manifest, links and anything
 * with a query string are left as they are.
 */
export function versionPage(html: string, id: string, modulesOf?: (entry: string) => readonly string[]): string {
  const entries: string[] = [];
  const out = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")\/((?!v\/|\/)[^"?#]+\.(?:js|mjs|css))(")/g, (_m, a: string, path: string, z: string) => {
    if (/^<script\b/.test(a) && /\btype="module"/.test(a)) entries.push(path);
    return `${a}/v/${id}/${path}${z}`;
  });
  if (!modulesOf || !entries.length || !out.includes('</head>')) return out;
  // The first load after an update: without these the browser finds the modules in waves (app.js,
  // then what it imports, then what those import), one round trip per wave. Named here, they are
  // all asked for at once, alongside app.js.
  const seen = new Set(entries);
  const links: string[] = [];
  for (const entry of entries) {
    for (const mod of modulesOf(entry)) {
      if (seen.has(mod)) continue;
      seen.add(mod);
      links.push(`  <link rel="modulepreload" href="/v/${id}/${mod}" />`);
    }
  }
  return links.length ? out.replace('</head>', () => `${links.join('\n')}\n</head>`) : out;
}

const IMPORT = /(?:^|\n)[ \t]*(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"\n]+)['"]|(?:^|\n)[ \t]*import\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
const graphs = new Map<string, { id: string; mods: string[] }>();

/**
 * Every module `entry` loads when it starts (what it imports, and what those import), as paths under
 * `webRoot`. Found by reading the import lines, which is enough here: a path that is not a real file
 * is left out, and one found by mistake (an import inside a comment) only costs a fetch of a real
 * module. `virtual` names modules the server makes itself (identity.js). Worked out once per id.
 */
export function staticModules(webRoot: string, entry: string, id: string, virtual: readonly string[] = []): string[] {
  const key = `${webRoot}\0${entry}`;
  const have = graphs.get(key);
  if (have?.id === id) return have.mods;
  const mods: string[] = [];
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    let src: string;
    try {
      src = readFileSync(join(webRoot, file), 'utf8');
    } catch {
      continue; // made by the server, or gone: nothing to read
    }
    for (const m of src.matchAll(IMPORT)) {
      const to = posix.normalize(posix.join(posix.dirname(file), m[1] ?? m[2]!));
      if (to.startsWith('..') || seen.has(to) || !VERSIONED.test(to)) continue;
      seen.add(to);
      if (!virtual.includes(to) && !statSync(join(webRoot, to), { throwIfNoEntry: false })?.isFile()) continue;
      mods.push(to);
      queue.push(to);
    }
  }
  graphs.set(key, { id, mods });
  return mods;
}

/** The Cache-Control for a versioned file: kept for a year when it is the current set, checked otherwise. */
export const cacheFor = (current: boolean): string => (current ? 'public, max-age=31536000, immutable' : 'no-cache');
