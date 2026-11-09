// Phase 54: link checker for the Markdown docs. Every relative link and picture in every .md file
// must point at a file or folder that exists in the checked tree, and a #section must match a
// heading in the target file. Web addresses are not fetched (no network). Run it on the public
// copy so links to private files (left out of the public repository) show up as broken:
//   node scripts/public-export.ts && node scripts/check-links.ts outputs/public-export
//   node scripts/check-links.ts            (this checkout)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from './build-docs.ts';

export interface Broken {
  file: string;
  line: number;
  link: string;
  why: string;
}

/** Links and pictures in Markdown (inline links, images, and src/href in inline HTML), outside code. */
export function linksIn(md: string): { line: number; href: string }[] {
  const out: { line: number; href: string }[] = [];
  let fence: string | undefined;
  md.split('\n').forEach((raw, i) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(raw);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = undefined;
      return;
    }
    if (fence) return;
    const line = raw.replace(/`[^`]*`/g, '');
    for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ line: i + 1, href: m[1] });
    for (const m of line.matchAll(/\b(?:src|href)="([^"]+)"/g)) out.push({ line: i + 1, href: m[1] });
  });
  return out;
}

/** Heading anchors of a Markdown file (GitHub style, numbered when repeated). */
export function anchorsOf(md: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const l of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) continue;
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
    if (!h) continue;
    const base = slug(h[1].replace(/`/g, ''));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

// Fixture repositories whose broken links are the point of a test (Documentation Doctor N24, Release Readiness N10).
const BROKEN_ON_PURPOSE = new Set(['test/fixtures/developer/documentation-doctor', 'test/fixtures/developer/release-readiness']);

function mdFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || (dir === root && e.name === 'outputs')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory() && BROKEN_ON_PURPOSE.has(relative(root, p).split('\\').join('/'))) continue;
    if (e.isDirectory()) out.push(...mdFiles(root, p));
    else if (/\.md$/i.test(e.name)) out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

export function checkLinks(root: string, files = mdFiles(root)): Broken[] {
  const broken: Broken[] = [];
  const cache = new Map<string, Set<string>>();
  const anchors = (f: string) => {
    if (!cache.has(f)) cache.set(f, anchorsOf(readFileSync(join(root, f), 'utf8')));
    return cache.get(f)!;
  };
  for (const file of files) {
    const md = readFileSync(join(root, file), 'utf8');
    for (const { line, href } of linksIn(md)) {
      if (/^(https?:|mailto:|data:|tel:)/i.test(href)) continue;
      if (href.startsWith('/')) continue; // in-app links (e.g. /#view=settings) and site-absolute paths
      const [path, hash] = href.split('#');
      let target = file;
      if (path) {
        target = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(path)));
        if (target.startsWith('..')) {
          broken.push({ file, line, link: href, why: 'points outside the repository' });
          continue;
        }
        const abs = join(root, target);
        if (!existsSync(abs)) {
          broken.push({ file, line, link: href, why: 'no such file' });
          continue;
        }
        if (statSync(abs).isDirectory()) continue;
      }
      if (hash && /\.md$/i.test(target) && !anchors(target).has(hash.toLowerCase())) broken.push({ file, line, link: href, why: `no heading #${hash} in ${target}` });
    }
  }
  return broken;
}

/** The one playlist every how-to video belongs to (README, docs/VIDEOS.md, the wizard and the guide link it). */
export const PLAYLIST = 'PLGtrs9BqXtM8';

/**
 * Phase 114 (PL1d): YouTube links and thumbnails, checked offline. A watch link needs an 11-character
 * video id and, when it names a list, the Sara playlist; a thumbnail must belong to a video that is
 * linked somewhere in the same file; a playlist link must be the Sara playlist.
 */
export function checkVideoLinks(file: string, text: string): Broken[] {
  const out: Broken[] = [];
  const lines = text.split('\n');
  const watched = new Set([...text.matchAll(/youtube\.com\/watch\?v=([\w-]+)/g)].map((m) => m[1]));
  lines.forEach((l, i) => {
    for (const m of l.matchAll(/https:\/\/(?:www\.)?youtube\.com\/(watch|playlist)\?([^"'\s)<>]+)/g)) {
      const q = new URLSearchParams(m[2].replace(/&amp;/g, '&'));
      const v = q.get('v');
      const list = q.get('list');
      if (m[1] === 'watch' && !/^[\w-]{11}$/.test(v ?? '')) out.push({ file, line: i + 1, link: m[0], why: 'not an 11-character video id' });
      if ((m[1] === 'playlist' || list) && list !== PLAYLIST) out.push({ file, line: i + 1, link: m[0], why: `not the Sara playlist (${PLAYLIST})` });
    }
    for (const m of l.matchAll(/https:\/\/i\.ytimg\.com\/vi\/([\w-]+)\//g)) {
      if (!watched.has(m[1])) out.push({ file, line: i + 1, link: m[0], why: 'a thumbnail with no link to its video in this file' });
    }
  });
  return out;
}

/** With --online: asks YouTube's oEmbed whether each video still exists. Offline or blocked = skipped, not failed. */
export async function videosOnline(ids: string[]): Promise<{ gone: string[]; skipped: boolean }> {
  const gone: string[] = [];
  for (const id of ids) {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`, { signal: AbortSignal.timeout(8000) });
      if (r.status === 404 || r.status === 400) gone.push(id);
    } catch {
      return { gone, skipped: true };
    }
  }
  return { gone, skipped: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const root = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? ROOT);
  const files = mdFiles(root);
  const broken = checkLinks(root, files);
  // Phase 114 (PL1d): the how-to video links too (offline; --online also asks YouTube).
  const videoFiles = [...files, 'web/help.html', 'web/index.html'].filter((f) => existsSync(join(root, f)));
  const ids = new Set<string>();
  for (const f of videoFiles) {
    const text = readFileSync(join(root, f), 'utf8');
    broken.push(...checkVideoLinks(f, text));
    for (const m of text.matchAll(/youtube\.com\/watch\?v=([\w-]{11})/g)) ids.add(m[1]);
  }
  if (process.argv.includes('--online')) {
    const r = await videosOnline([...ids]);
    for (const id of r.gone) broken.push({ file: 'videos', line: 0, link: id, why: 'YouTube says this video is gone' });
    console.log(r.skipped ? 'Videos: YouTube not reachable, online check skipped.' : `Videos: ${ids.size} checked online.`);
  }
  for (const b of broken) console.log(`BROKEN ${b.file}:${b.line} ${b.link} (${b.why})`);
  console.log(`${files.length} Markdown files and ${ids.size} video links checked in ${root}: ${broken.length ? `${broken.length} broken link(s).` : 'every relative link resolves.'}`);
  process.exit(broken.length ? 1 : 0);
}
