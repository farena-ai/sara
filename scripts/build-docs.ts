// Phase 54: the docs site. Turns the public Markdown (README, CONTRIBUTING, SECURITY, docs/*.md…)
// into a static website with a sidebar, a search box (a small index searched in the browser), light
// and dark themes, and relative links only, so it works from a folder, from file:// and on GitHub
// Pages. No dependencies: the Markdown converter below is Sara's own.
//   node scripts/build-docs.ts [--out outputs/site] [--repo https://github.com/farena-ai/sara]
// Nothing is deployed. To publish on GitHub Pages later, push the folder's contents to a gh-pages
// branch or point Pages at it (an empty .nojekyll file is included).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PRIVATE } from './public-export.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------------
// Markdown → HTML

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GitHub-style heading anchor: lower case, punctuation dropped, spaces to dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

export interface RenderOptions {
  /** Rewrites a link or image target (relative paths to pages, assets or the repository). */
  link?: (href: string, image: boolean) => string;
}

/** Inline Markdown: code, images, links, bold, italic, strike; HTML-escaped otherwise. */
export function inline(src: string, opts: RenderOptions = {}): string {
  const link = opts.link ?? ((h: string) => h);
  const codes: string[] = [];
  // Code spans first, so nothing inside them is touched.
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t, code: string) => {
    codes.push(`<code>${esc(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Inline HTML that READMEs commonly use (<br>, <img …>, <a …>, <b>, <kbd>, <sup>) stays; any other
  // "<" is escaped.
  const keep: string[] = [];
  s = s.replace(/<\/?(br|img|a|b|i|em|strong|kbd|sup|sub|span|picture|source)\b[^>]*>/gi, (m) => {
    keep.push(m);
    return `\u0001${keep.length - 1}\u0001`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, alt: string, href: string, title?: string) => `<img src="${esc(link(href, true))}" alt="${alt}"${title ? ` title="${title}"` : ''} loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_m, label: string, href: string) => {
    const h = link(href.replace(/&amp;/g, '&'), false);
    const ext = /^https?:/.test(h) ? ' rel="noopener"' : '';
    return `<a href="${esc(h)}"${ext}>${label}</a>`;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_m, pre: string, url: string) => `${pre}<a href="${url}" rel="noopener">${url}</a>`);
  s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => {
    const tag = keep[Number(i)];
    // Rewrite src/href inside kept HTML too.
    return tag.replace(/\b(src|href)="([^"]+)"/g, (_x, attr: string, v: string) => `${attr}="${esc(link(v, attr === 'src'))}"`);
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

const BLOCK_HTML = /^\s*<\/?(p|div|details|summary|picture|table|thead|tbody|tr|td|th|img|br|hr|center|h[1-6])\b/i;

/** Block Markdown: headings, paragraphs, lists (nested by indent), quotes, fences, tables, rules. */
export function render(md: string, opts: RenderOptions = {}): { html: string; headings: Heading[] } {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const il = (s: string) => inline(s, opts);
  let i = 0;
  const isBlank = (l: string | undefined) => l === undefined || !l.trim();
  const startsBlock = (l: string) => /^\s{0,3}(#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$|\|)/.test(l) || BLOCK_HTML.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    // Fenced code.
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[2][0]}{${fence[2].length},}\\s*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++].slice(fence[1].length));
      i++;
      out.push(`<pre${fence[3] ? ` data-lang="${esc(fence[3])}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    // Headings.
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1].length;
      const base = slug(h[2]) || 'section';
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      const text = h[2].replace(/`/g, '').replace(/\*\*/g, '');
      headings.push({ level, text, id });
      out.push(`<h${level} id="${id}">${il(h[2])} <a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`);
      i++;
      continue;
    }
    // Rules.
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    // Raw HTML blocks (README picture rows and similar): kept up to the next blank line.
    if (BLOCK_HTML.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
      out.push(il(body.join('\n')));
      continue;
    }
    // Tables.
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l: string) => {
        const t = l.trim().replace(/^\|/, '').replace(/\|$/, '');
        const parts: string[] = [];
        let cur = '';
        let inCode = false;
        for (let k = 0; k < t.length; k++) {
          const c = t[k];
          if (c === '`') inCode = !inCode;
          if (c === '\\' && t[k + 1] === '|') {
            cur += '|';
            k++;
          } else if (c === '|' && !inCode) {
            parts.push(cur.trim());
            cur = '';
          } else cur += c;
        }
        parts.push(cur.trim());
        return parts;
      };
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]));
      const td = (tag: string, c: string, k: number) => `<${tag}${align[k] ? ` style-align="${align[k]}"` : ''}>${il(c)}</${tag}>`;
      out.push(`<div class="table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_c, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    // Quotes.
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${render(body.join('\n'), opts).html}</blockquote>`);
      continue;
    }
    // Lists (one level of nesting per indent step; items can wrap onto following lines).
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const { html, next } = list(lines, i, il, opts);
      out.push(html);
      i = next;
      continue;
    }
    // Paragraph.
    const body: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) body.push(lines[i++].trim());
    out.push(`<p>${il(body.join('\n')).replace(/ {2,}\n|\\\n/g, '<br>\n')}</p>`);
  }
  // Table cell alignment without inline styles (the site's CSP-friendly CSS reads a class).
  const html = out.join('\n').replace(/ style-align="(\w+)"/g, ' class="al-$1"');
  return { html, headings };
}

function list(lines: string[], start: number, il: (s: string) => string, opts: RenderOptions): { html: string; next: number } {
  const first = /^(\s*)([-*+]|\d+[.)])\s+/.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: string[] = [];
  let i = start;
  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const body: string[] = [m[3]];
    i++;
    const sub: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        // A blank line ends the item unless more indented content follows.
        if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && (lines[i + 1].match(/^\s*/)![0].length > indent)) {
          sub.push('');
          i++;
          continue;
        }
        break;
      }
      const lead = l.match(/^\s*/)![0].length;
      if (lead <= indent && /^(\s*)([-*+]|\d+[.)])\s+/.test(l)) break;
      if (lead <= indent && !sub.length && /^\s{0,3}(#{1,6}\s|```|>|\|)/.test(l)) break;
      if (lead > indent && (sub.length || /^(\s*)([-*+]|\d+[.)])\s+|^\s*(```|~~~)/.test(l))) sub.push(l.slice(Math.min(lead, indent + 2)));
      else body.push(l.trim());
      i++;
    }
    const nested = sub.length ? render(sub.join('\n'), opts).html : '';
    items.push(`<li>${il(body.join('\n'))}${nested}</li>`);
  }
  const startNo = ordered ? Number(first[2].replace(/\D/g, '')) : 1;
  const tag = ordered ? 'ol' : 'ul';
  return { html: `<${tag}${ordered && startNo !== 1 ? ` start="${startNo}"` : ''}>${items.join('')}</${tag}>`, next: i };
}

/** Plain text of rendered HTML, for the search index. */
export function textOf(html: string): string {
  return html
    .replace(/<a class="anchor"[^>]*>#<\/a>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// The site

export interface Page {
  /** Source path relative to the repository, e.g. "docs/INSTALL.md". */
  src: string;
  /** Output path relative to the site, e.g. "docs/INSTALL.html". */
  out: string;
  title: string;
  group: string;
}

/** Sidebar groups, in order; files not listed go to "More". */
const GROUPS: [string, string[]][] = [
  ['Start here', ['README.md', 'docs/INSTALL.md', 'docs/REQUIREMENTS.md', 'docs/CHOOSING_A_MODEL.md', 'docs/COSTS.md', 'docs/PHONE.md', 'docs/clients.md', 'docs/desktop.md', 'docs/MAC_APP_REMOTE.md', 'docs/SERVERS.md', 'docs/MOVING.md', 'docs/FAQ.md', 'docs/DISCLOSURES.md']],
  ['Using Sara', ['docs/IMPORT.md', 'docs/GROUP_CHATS.md', 'docs/VIDEO_CALLS.md', 'docs/MOMENTS.md', 'docs/LIBRARY.md', 'docs/HOUSEHOLD.md', 'docs/PRIVATE_LOCAL.md', 'docs/SSH.md']],
  ['Connect other things', ['docs/OTHER_APPS.md', 'docs/HOME_ASSISTANT.md', 'docs/VOICE_ASSISTANTS.md', 'docs/ALEXA.md', 'docs/PACKAGING.md']],
  ['Build with Sara', ['docs/EXTENDING.md', 'docs/ARCHITECTURE.md', 'docs/RESULTS.md', 'docs/TRANSLATING.md']],
  ['Contribute', ['CONTRIBUTING.md', 'docs/GOOD_FIRST_ISSUES.md', 'CODE_OF_CONDUCT.md']],
  ['Safety and security', ['docs/SECURITY_CHECKLIST.md', 'docs/PRIVACY.md', 'docs/COMPLIANCE.md', 'SECURITY.md', 'docs/THREAT_MODEL.md']],
  // docs/ROADMAP.md is the public roadmap (the export publishes docs/ROADMAP.public.md under that name).
  ['Project', ['docs/ROADMAP.md', 'docs/ROADMAP.public.md', 'CHANGELOG.md', 'docs/CREDITS.md']],
];

export const outPath = (src: string) => (src === 'README.md' ? 'index.html' : src.replace(/\.md$/i, '.html'));

/** Which Markdown files become pages: the public, tracked README/root docs and docs/*.md. */
export function pickPages(files: string[], isPrivate: (p: string) => boolean): Page[] {
  const wanted = files.filter((f) => (/^[^/]+\.md$/i.test(f) && !/^AGENTS\.md$/i.test(f)) || /^docs\/[^/]+\.md$/i.test(f)).filter((f) => !isPrivate(f));
  const order = GROUPS.flatMap(([g, list]) => list.map((src) => ({ g, src })));
  const pages: Page[] = [];
  for (const { g, src } of order) if (wanted.includes(src)) pages.push({ src, out: outPath(src), title: '', group: g });
  for (const src of wanted.sort()) if (!pages.some((p) => p.src === src)) pages.push({ src, out: outPath(src), title: '', group: 'More' });
  return pages;
}

/** Relative URL from one site path to another. */
export function rel(from: string, to: string): string {
  const r = posix.relative(posix.dirname(from), to);
  return r || posix.basename(to);
}

/**
 * Link rewriting for a page: links to other pages go to their .html, images and other files we copy
 * stay relative, anything else in the repository goes to the repository on GitHub.
 */
export function linker(page: Page, pages: Page[], repo: string, assets: Set<string>, exists: (p: string) => boolean): (href: string, image: boolean) => string {
  return (href, image) => {
    if (/^(https?:|mailto:|#|data:)/i.test(href)) return href;
    const [path, hash] = href.split('#') as [string, string | undefined];
    const target = posix.normalize(posix.join(posix.dirname(page.src), decodeURIComponent(path))).replace(/^\.\//, '');
    const toPage = pages.find((p) => p.src === target);
    if (toPage) return `${rel(page.out, toPage.out)}${hash ? `#${hash}` : ''}`;
    if (/\.(png|jpe?g|gif|svg|webp|apng)$/i.test(target) && exists(target)) {
      assets.add(target);
      return rel(page.out, target);
    }
    if (target.startsWith('..')) return href;
    const kind = image ? 'raw' : target.endsWith('/') || !/\.[\w]+$/.test(target) ? 'tree' : 'blob';
    return `${repo}/${kind}/main/${target.replace(/\/$/, '')}${hash ? `#${hash}` : ''}`;
  };
}

const CSS = `:root{--bg:#fbfaf8;--fg:#1f2328;--muted:#5d6670;--line:#e3e0da;--side:#f3f1ed;--accent:#b4436c;--code:#f1eee9;--mark:#ffe8a3}
:root[data-theme=dark]{--bg:#16171b;--fg:#e6e6e6;--muted:#a0a4ab;--line:#2c2e35;--side:#1c1d22;--accent:#f08cb0;--code:#23252c;--mark:#5c4a12}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#16171b;--fg:#e6e6e6;--muted:#a0a4ab;--line:#2c2e35;--side:#1c1d22;--accent:#f08cb0;--code:#23252c;--mark:#5c4a12}}
*{box-sizing:border-box}html{scroll-padding-top:16px}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}a:hover{text-decoration-thickness:2px}
.wrap{display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
nav.side{background:var(--side);border-right:1px solid var(--line);padding:20px 18px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;color:var(--fg);text-decoration:none;margin-bottom:14px}
.brand img{width:34px;height:34px;border-radius:50%}
.search{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.results{list-style:none;margin:8px 0 0;padding:0;font-size:14px}.results li{margin:0 0 8px}.results small{display:block;color:var(--muted)}
.results mark{background:var(--mark);color:inherit}
nav.side h4{margin:18px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
nav.side ul.pages{list-style:none;margin:0;padding:0}nav.side ul.pages a{display:block;padding:3px 8px;border-radius:6px;color:var(--fg);text-decoration:none;font-size:15px}
nav.side ul.pages a:hover{background:var(--line)}nav.side ul.pages a[aria-current]{background:var(--accent);color:#fff}
.theme{margin-top:20px;background:none;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 10px;font:inherit;font-size:14px;cursor:pointer}
main{padding:32px 48px 80px;max-width:980px}
main h1{font-size:2.1em;line-height:1.2;margin-top:0}main h2{margin-top:2em;padding-bottom:.25em;border-bottom:1px solid var(--line)}
.anchor{opacity:0;text-decoration:none;font-weight:400;margin-left:4px}h1:hover .anchor,h2:hover .anchor,h3:hover .anchor,h4:hover .anchor{opacity:.6}
code{background:var(--code);padding:.1em .35em;border-radius:5px;font:.9em ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:var(--code);padding:14px 16px;border-radius:10px;overflow:auto;line-height:1.45}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.2em 1em;border-left:4px solid var(--accent);color:var(--muted)}
.table{overflow-x:auto}table{border-collapse:collapse;margin:1em 0;font-size:15px}th,td{border:1px solid var(--line);padding:6px 10px;vertical-align:top;text-align:left}
th{background:var(--side)}.al-center{text-align:center}.al-right{text-align:right}
img{max-width:100%;height:auto}hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.page-nav{display:flex;justify-content:space-between;gap:1em;margin-top:3em;padding-top:1em;border-top:1px solid var(--line);flex-wrap:wrap}.page-nav a{max-width:48%;text-decoration:none}.page-nav a[rel=next]{margin-left:auto;text-align:right}
.foot{margin-top:4em;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:1em}
.menu{display:none}
@media (max-width:860px){.wrap{display:block}nav.side{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}
nav.side .collapsible{display:none}nav.side.open .collapsible{display:block}.menu{display:inline-block;margin-left:auto;background:none;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:4px 10px;font:inherit}
main{padding:20px 18px 60px}.page-nav a{max-width:100%}}`;

const JS = `(()=>{
const root=document.documentElement,base=document.body.dataset.base||'';
const saved=localStorage.getItem('sara-docs-theme');if(saved)root.dataset.theme=saved;
const btn=document.querySelector('.theme');
const label=()=>{const dark=root.dataset.theme?root.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;btn.textContent=dark?'☀ Light theme':'☾ Dark theme';return dark};
if(btn){label();btn.addEventListener('click',()=>{const dark=label();root.dataset.theme=dark?'light':'dark';localStorage.setItem('sara-docs-theme',root.dataset.theme);label()})}
const menu=document.querySelector('.menu');if(menu)menu.addEventListener('click',()=>document.querySelector('nav.side').classList.toggle('open'));
const box=document.querySelector('.search'),list=document.querySelector('.results');
const idx=window.SARA_DOCS||[];
const escH=s=>s.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function find(q){const words=q.toLowerCase().split(/\\s+/).filter(w=>w.length>1);if(!words.length)return[];
const out=[];for(const e of idx){const t=e.t.toLowerCase(),h=e.h.toLowerCase(),p=e.p.toLowerCase();let s=0,ok=true;
for(const w of words){const inH=h.includes(w)||p.includes(w),inT=t.includes(w);if(!inH&&!inT){ok=false;break}s+=(inH?10:0)+(inT?1+Math.min(5,t.split(w).length-1):0)}
if(ok)out.push({e,s})}return out.sort((a,b)=>b.s-a.s).slice(0,12)}
function snip(t,q){const w=q.toLowerCase().split(/\\s+/).filter(x=>x.length>1);const i=Math.max(0,t.toLowerCase().indexOf(w[0]||''));
let s=escH(t.slice(Math.max(0,i-60),i+120));for(const x of w)s=s.replace(new RegExp('('+x.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')+')','ig'),'<mark>$1</mark>');return (i>60?'…':'')+s+'…'}
if(box)box.addEventListener('input',()=>{const q=box.value.trim();list.innerHTML='';
for(const {e} of find(q)){const li=document.createElement('li');li.innerHTML='<a href="'+base+e.u+'">'+escH(e.h)+'</a><small>'+escH(e.p)+' · '+snip(e.t,q)+'</small>';list.append(li)}
if(q&&!list.children.length){const li=document.createElement('li');li.textContent='Nothing found.';list.append(li)}});
})();`;

function pageHtml(page: Page, pages: Page[], body: string, repo: string): string {
  const up = rel(page.out, 'x').replace(/x$/, '');
  const at = pages.indexOf(page);
  const previous = at > 0 ? pages[at - 1] : undefined;
  const next = at >= 0 && at + 1 < pages.length ? pages[at + 1] : undefined;
  const groups = [...new Set(pages.map((p) => p.group))];
  const nav = groups
    .map((g) => `<h4>${esc(g)}</h4><ul class="pages">${pages.filter((p) => p.group === g).map((p) => `<li><a href="${rel(page.out, p.out)}"${p === page ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul>`)
    .join('');
  const pageNav = previous || next
    ? `<nav class="page-nav" aria-label="Page navigation">${previous ? `<a rel="prev" href="${rel(page.out, previous.out)}">← Previous: ${esc(previous.title)}</a>` : ''}${next ? `<a rel="next" href="${rel(page.out, next.out)}">Next: ${esc(next.title)} →</a>` : ''}</nav>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'">
<title>${esc(page.title)} · Sara docs</title>
<link rel="stylesheet" href="${up}assets/site.css">
<link rel="icon" href="${up}assets/icon.png">
</head>
<body data-base="${up}">
<div class="wrap">
<nav class="side" aria-label="Documentation">
<div class="brand-row"><a class="brand" href="${up}index.html"><img src="${up}assets/icon.png" alt="">Sara docs</a><button class="menu" type="button" aria-label="Menu">☰</button></div>
<input class="search" type="search" placeholder="Search the docs" aria-label="Search the docs">
<ul class="results"></ul>
<div class="collapsible">${nav}<button class="theme" type="button">Theme</button></div>
</nav>
<main>
${body}
${pageNav}
<p class="foot">Built from <a href="${repo}/blob/main/${page.src}" rel="noopener">${esc(page.src)}</a> by <code>node scripts/build-docs.ts</code>. Sara is MIT-licensed.</p>
</main>
</div>
<script src="${up}assets/search-index.js"></script>
<script src="${up}assets/site.js"></script>
</body>
</html>
`;
}

export function buildSite(opts: { root: string; out: string; repo: string; files: string[] }): { pages: number; assets: number; entries: number } {
  const isPrivate = (p: string) => PRIVATE.some((re) => re.test(p));
  const pages = pickPages(opts.files, isPrivate);
  const md = new Map(pages.map((p) => [p.src, readFileSync(join(opts.root, p.src), 'utf8')]));
  for (const p of pages) p.title = /^#\s+(.+)$/m.exec(md.get(p.src)!)?.[1].replace(/[`*]/g, '').trim() ?? p.src;
  const index: { u: string; p: string; h: string; t: string }[] = [];
  const assets = new Set<string>();
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(join(opts.out, 'assets'), { recursive: true });
  for (const page of pages) {
    const link = linker(page, pages, opts.repo, assets, (p) => existsSync(join(opts.root, p)) && opts.files.includes(p));
    const { html, headings } = render(md.get(page.src)!, { link });
    const file = join(opts.out, page.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, pageHtml(page, pages, html, opts.repo));
    // One search entry per section (heading to the next heading).
    const parts = html.split(/(?=<h[1-4] id=")/);
    for (const part of parts) {
      const m = /^<h[1-4] id="([^"]+)">/.exec(part);
      const head = m ? headings.find((h) => h.id === m[1]) : undefined;
      const t = textOf(part).slice(0, 1500);
      if (!t) continue;
      index.push({ u: `${page.out}${head ? `#${head.id}` : ''}`, p: page.title, h: head?.text ?? page.title, t });
    }
  }
  for (const a of assets) {
    mkdirSync(dirname(join(opts.out, a)), { recursive: true });
    copyFileSync(join(opts.root, a), join(opts.out, a));
  }
  writeFileSync(join(opts.out, 'assets', 'site.css'), CSS);
  writeFileSync(join(opts.out, 'assets', 'site.js'), JS);
  writeFileSync(join(opts.out, 'assets', 'search-index.js'), `window.SARA_DOCS=${JSON.stringify(index)};\n`);
  if (existsSync(join(opts.root, 'web', 'icon-192.png'))) copyFileSync(join(opts.root, 'web', 'icon-192.png'), join(opts.out, 'assets', 'icon.png'));
  writeFileSync(join(opts.out, '.nojekyll'), '');
  writeFileSync(join(opts.out, '404.html'), `<!doctype html><meta charset="utf-8"><title>Not found · Sara docs</title><link rel="stylesheet" href="assets/site.css"><main><h1>Page not found</h1><p><a href="index.html">Back to the docs</a></p></main>\n`);
  return { pages: pages.length, assets: assets.size, entries: index.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({ options: { out: { type: 'string', default: join('outputs', 'site') }, repo: { type: 'string', default: 'https://github.com/farena-ai/sara' }, root: { type: 'string' } } });
  const root = resolve(opt.root ?? ROOT);
  const out = resolve(ROOT, opt.out!);
  if (!out.startsWith(join(ROOT, 'outputs'))) throw new Error('The site goes under outputs/.');
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    // Not a git checkout (e.g. the public-export copy): every file there is public.
    const walk = (d: string, pre = ''): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === '.git' ? [] : e.isDirectory() ? walk(join(d, e.name), `${pre}${e.name}/`) : [`${pre}${e.name}`]));
    files = walk(root);
  }
  const r = buildSite({ root, out, repo: opt.repo!, files });
  console.log(`Docs site: ${r.pages} pages, ${r.assets} pictures, ${r.entries} search entries → ${out}`);
  console.log(`Open ${join(out, 'index.html')} in a browser. Nothing was published.`);
}
