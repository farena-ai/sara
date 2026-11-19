// W2.5 (docs/design/ROADMAP_W.md, docs/HELP_SEARCH.md): the help search index. A prebuilt, local index
// of everything that answers a question, searched in the browser by web/help-find.js (on /help and in
// the app's Help window); no outside service.
//   - web/help-index/<lang>.json (en, es, fr, de, pt-BR, it): every "How do I…?" answer (web/howto.json),
//     every Settings page (its summary from web/tips.json), every tip at its control and every guide
//     section (web/help.html), translated with the app's own dictionaries (web/i18n/<lang>.json).
//     An entry with no translation keeps its English and is marked `e: 1` (shown as "English").
//   - web/help-index/docs.json: the user docs (docs/*.md, public and user-facing), one entry per section,
//     English only (the docs are written in English).
//   node scripts/help-index.ts           writes them (a release step, next to npm run guide)
//   node scripts/help-index.ts --check   says whether they are out of date (exit 1)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRIVATE } from './public-export.ts';
import { render, textOf } from './build-docs.ts';
import { helpBlocks, norm, decode, SAME_OK } from './i18n-extract.ts';
import { pageTitles, VIEW_TITLES, howtoAnchor, HOWTO_START, HOWTO_END, type HowtoData } from '../src/guide-howto.ts';

export const HELP_LANGS = ['en', 'es', 'fr', 'de', 'pt-BR', 'it'] as const;

/** One searchable thing, before translation: English keys (each a key of web/i18n/<lang>.json). */
export interface HelpSource {
  /** Stable id: h:<page>/<q>, p:<page>, t:<control>, g:<guide id>. */
  i: string;
  k: 'howto' | 'page' | 'tip' | 'guide';
  t: string;
  /** Text pieces (steps, summary, tip, guide blocks as HTML). */
  xs: string[];
  /** Where it is, as key pieces (Settings → group → page). */
  ps?: string[];
  /** Opens it: /#view=… (the app) or /help#… (the guide). */
  l: string;
  /** "Show me": the control to pulse. */
  s?: string;
  /** The answer's anchor in the guide's How do I index. */
  a?: string;
  /** A how-to clip under docs/media. */
  c?: string;
}
/** One entry as shipped (translated). */
export interface HelpEntry {
  i: string;
  k: string;
  t: string;
  x: string;
  p?: string;
  l: string;
  s?: string;
  a?: string;
  c?: string;
  /** The English title, when the title is translated (English words still find it). */
  te?: string;
  /** 1 = no translation, shown in English. */
  e?: 1;
}
export interface ClipInfo {
  file: string;
  seconds: number;
  bytes: number;
}

const unq = (s: string) => decode(s).replace(/&#39;/g, "'");
const strip = (h: string) => norm(unq(h.replace(/<[^>]+>/g, ' ')));
/** A view id's link: Planner tabs open the Planner, the chat opens the app. */
const viewLink = (id: string) => (id === 'chat' ? '/' : `/#view=${id.split('-')[0]}`);

/** Entries for the app side: How do I answers, Settings pages, tips and guide sections. */
export function appEntries(o: { indexHtml: string; helpHtml: string; howto: HowtoData; tips: { tips: Record<string, [string, string]>; pages: Record<string, [string, string]> }; clips: Record<string, ClipInfo> }): HelpSource[] {
  const out: HelpSource[] = [];
  const titles = pageTitles(o.indexHtml);
  const where = (page: string) => (titles[page] ? ['Settings', titles[page].group, titles[page].title] : VIEW_TITLES[page] ? [VIEW_TITLES[page]] : []);
  for (const [page, qs] of Object.entries(o.howto)) {
    for (const q of qs) {
      const e: HelpSource = { i: `h:${page}/${q.id}`, k: 'howto', t: q.q, xs: q.steps, ps: where(page), l: titles[page] ? `/#view=settings:${page}&howto=${q.id}` : viewLink(page), a: howtoAnchor(page, q.id) };
      if (q.show) e.s = q.show;
      const clip = o.clips[`${page}/${q.id}`];
      if (clip) e.c = clip.file;
      out.push(e);
    }
  }
  // Settings pages and where each control sits.
  const ranges: { page: string; start: number; end: number }[] = [];
  for (const m of o.indexHtml.matchAll(/<section\b[^>]*\bdata-page="([\w-]+)"[^>]*>[\s\S]*?<\/section>/g)) {
    ranges.push({ page: m[1], start: m.index!, end: m.index! + m[0].length });
    if (!titles[m[1]]) continue;
    const sum = o.tips.pages[m[1]]?.[0];
    out.push({ i: `p:${m[1]}`, k: 'page', t: titles[m[1]].title, xs: sum ? [sum] : [], ps: ['Settings', titles[m[1]].group], l: `/#view=settings:${m[1]}` });
  }
  for (const [id, [text]] of Object.entries(o.tips.tips)) {
    const at = o.indexHtml.indexOf(`id="${id}"`);
    const r = ranges.find((x) => at >= x.start && at < x.end);
    if (at < 0 || !r || !titles[r.page]) continue;
    // No label found: the tip itself is the title (never four hits all called after the page).
    const label = labelBefore(o.indexHtml, at, r.start);
    out.push({ i: `t:${id}`, k: 'tip', t: label || text, xs: label ? [text] : [], ps: where(r.page), l: `/#view=settings:${r.page}&show=${id}` });
  }
  // Guide sections (h2/h3 with an id), without the How do I index (answered above).
  const main = o.helpHtml.slice(o.helpHtml.indexOf('<main>'), o.helpHtml.indexOf('</main>'));
  const a = main.indexOf(HOWTO_START);
  const b = main.indexOf(HOWTO_END);
  const body = (a >= 0 && b > a ? main.slice(0, a) + main.slice(b + HOWTO_END.length) : main).replace(/<!--[\s\S]*?-->/g, '');
  const parts = body.split(/(?=<h[23] id=")/);
  for (const part of parts) {
    const m = /^<h[23] id="([\w-]+)"[^>]*>([^<]*)<\/h[23]>/.exec(part);
    if (!m || m[1] === 'howto') continue;
    const blocks = helpBlocks(part.slice(m[0].length)).filter((k) => /\p{L}/u.test(k)).slice(0, 4);
    out.push({ i: `g:${m[1]}`, k: 'guide', t: norm(unq(m[2])), xs: blocks, l: `/help#${m[1]}` });
  }
  return out;
}

/** The words of the label (or heading) just before a control, inside its page. */
function labelBefore(html: string, at: number, from: number): string {
  const before = html.slice(Math.max(from, at - 600), at);
  const ls = before.lastIndexOf('<label');
  const le = before.lastIndexOf('</label>');
  if (ls > le) return strip(before.slice(ls).replace(/<button[^>]*class="tip"[\s\S]*?<\/button>/g, '').replace(/<[^>]*$/, '')).slice(0, 80);
  const h = /<(h3|h4|summary|strong)\b[^>]*>((?:(?!<\/?\1)[\s\S])*?)<\/\1>(?![\s\S]*<(h3|h4|summary|strong)\b)/.exec(before);
  return h ? strip(h[2].replace(/<button[^>]*class="tip"[\s\S]*?<\/button>/g, '')).slice(0, 80) : '';
}

/** Translates the entries with one language's dictionary (`english` = the English file: nothing marked). */
export function translateEntries(src: HelpSource[], dict: Record<string, string>, english = false): HelpEntry[] {
  const tr = (s: string) => (english ? s : dict[s]);
  return src.map((s) => {
    const title = tr(s.t);
    const pieces = s.xs.map((x) => tr(x));
    // A title that stays the same in every language (Hey Sara, GitHub) is not missing.
    const missing = !english && ((!title && !SAME_OK.test(s.t)) || pieces.some((p) => !p));
    const join = s.k === 'howto' ? '\n' : ' ';
    const x = s.xs.map((x0, n) => strip(pieces[n] ?? x0)).join(join);
    const e: HelpEntry = { i: s.i, k: s.k, t: title ?? s.t, x: x.length > 600 ? `${x.slice(0, 597)}…` : x, l: s.l };
    if (s.ps?.length) e.p = s.ps.map((p) => tr(p) ?? p).join(' → ');
    if (s.s) e.s = s.s;
    if (s.a) e.a = s.a;
    if (s.c) e.c = s.c;
    if (!english && title && title !== s.t && (s.k === 'howto' || s.k === 'page')) e.te = s.t;
    if (missing) e.e = 1;
    return e;
  });
}

/** Developer and project docs: public, but not help for a person using Sara. */
const NOT_HELP = new Set(['ARCHITECTURE', 'API', 'EXTENDING', 'RESULTS', 'REAL_RUNS', 'TRANSLATING', 'GOOD_FIRST_ISSUES', 'ROADMAP', 'ROADMAP.public', 'CREDITS', 'QUALITY', 'CHECKS', 'NPM_PUBLISH', 'PACKAGING', 'INSTALL_MATRIX', 'SECURITY_REVIEW_U5', 'STORE_LISTINGS', 'THREAT_MODEL', 'DEVELOPER_ADDONS', 'PERFORMANCE', 'HOW_DO_I', 'WHATS_NEW', 'clients', 'KUBERNETES', 'SCIM', 'COMPLIANCE', 'EXTENSION_PRIVACY', 'DISCLOSURES']);
/** Is this file a user doc for the index? (docs/*.md, public, not developer-facing.) */
export function isUserDoc(rel: string): boolean {
  const m = /^docs\/([^/]+)\.md$/.exec(rel);
  return Boolean(m) && !NOT_HELP.has(m![1]) && !PRIVATE.some((re) => re.test(rel));
}

const DEV_HEADING = /\b(design|tables?|routes?|api|endpoints?|tests?|testing|implementation|internals|schema|developers?|for coders|code map|source files?|how it works inside)\b/i;
/** One entry per section of a user doc (the part before the first ## heading is the page's own entry). */
export function docSections(rel: string, md: string): HelpEntry[] {
  const file = rel.replace(/^docs\//, '');
  const page = /^#\s+(.+)$/m.exec(md)?.[1].replace(/[`*]/g, '').trim() ?? file;
  const { html, headings } = render(md);
  const out: HelpEntry[] = [];
  for (const part of html.split(/(?=<h[1-3] id=")/)) {
    const m = /^<h([1-3]) id="([^"]+)">/.exec(part);
    const head = m ? headings.find((h) => h.id === m[2]) : undefined;
    const top = !head || head.level === 1;
    const rest = m ? part.replace(/^<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/, '') : part;
    const x = textOf(rest).replace(/\s+([.,;:!?)])/g, '$1').replace(/\(\s+/g, '(');
    if (!x && top) continue;
    // Sections for builders (design notes, tables, routes) are not help.
    if (!top && DEV_HEADING.test(head!.text)) continue;
    const id = top ? `d:${file}` : `d:${file}#${head!.id}`;
    if (out.some((e) => e.i === id)) continue;
    out.push({ i: id, k: 'doc', t: top ? page : head!.text.replace(/[`*]/g, ''), x: x.length > 500 ? `${x.slice(0, 497)}…` : x, p: page, l: top ? `docs/${file}` : `docs/${file}#${head!.id}` });
  }
  return out;
}

/** Every index file's text (relative path → JSON text). */
export function buildHelpIndex(root: string): Map<string, string> {
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const clipsFile = join(root, 'docs', 'media', 'clips.json');
  const clips = existsSync(clipsFile) ? (JSON.parse(readFileSync(clipsFile, 'utf8')) as Record<string, ClipInfo>) : {};
  const src = appEntries({ indexHtml: read('web/index.html'), helpHtml: read('web/help.html'), howto: JSON.parse(read('web/howto.json')), tips: JSON.parse(read('web/tips.json')), clips });
  const out = new Map<string, string>();
  const json = (o: unknown) => `${JSON.stringify(o)}\n`;
  for (const lang of HELP_LANGS) {
    const dict = lang === 'en' ? {} : (JSON.parse(read(`web/i18n/${lang}.json`)) as Record<string, string>);
    const entries = translateEntries(src, dict, lang === 'en');
    out.set(`web/help-index/${lang}.json`, json({ v: 1, lang, entries }));
  }
  const docs: HelpEntry[] = [];
  for (const f of readdirSync(join(root, 'docs')).sort()) {
    const rel = `docs/${f}`;
    if (isUserDoc(rel)) docs.push(...docSections(rel, read(rel)));
  }
  out.set('web/help-index/docs.json', json({ v: 1, lang: 'en', entries: docs }));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const built = buildHelpIndex(ROOT);
  if (process.argv.includes('--check')) {
    const stale = [...built].filter(([rel, text]) => !existsSync(join(ROOT, rel)) || readFileSync(join(ROOT, rel), 'utf8') !== text).map(([rel]) => rel);
    if (stale.length) {
      console.error(`The help index is out of date: ${stale.join(', ')}.\nRun: node scripts/help-index.ts, then commit web/help-index/.`);
      process.exit(1);
    }
    console.log('The help index is up to date.');
  } else {
    mkdirSync(join(ROOT, 'web', 'help-index'), { recursive: true });
    let bytes = 0;
    for (const [rel, text] of built) {
      writeFileSync(join(ROOT, rel), text);
      bytes += Buffer.byteLength(text);
    }
    const counts = [...built].map(([rel, text]) => `${rel.split('/').pop()} ${(JSON.parse(text) as { entries: HelpEntry[] }).entries.filter((e) => !e.e).length}/${(JSON.parse(text) as { entries: HelpEntry[] }).entries.length}`);
    console.log(`Wrote the help index (${Math.round(bytes / 1024)} KB): ${counts.join(', ')} (translated/all)`);
  }
}
