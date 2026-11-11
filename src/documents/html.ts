// make_document → HTML, and the preview the chat's Open button shows for every format. A single
// self-contained page: styles inline, pictures as data: addresses, no scripts and nothing loaded
// from anywhere else (the preview is also served with a CSP that forbids it).
import type { Block, Run } from './markdown.ts';
import { docBlocks, type DocSpec, type ImageLookup, sectionLevel, sheetsOf, slidesOf } from './spec.ts';
import { THEMES } from './theme.ts';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runsHtml(runs: Run[]): string {
  return runs
    .map((r) => {
      let h = esc(r.text).replace(/\n/g, '<br>');
      if (r.code) h = `<code>${h}</code>`;
      if (r.italic) h = `<em>${h}</em>`;
      if (r.bold) h = `<strong>${h}</strong>`;
      if (r.href) h = `<a href="${esc(r.href)}" rel="noopener noreferrer" target="_blank">${h}</a>`;
      return h;
    })
    .join('');
}

const dataUrl = (image: ImageLookup, ref: string): string | undefined => {
  const p = image(ref);
  return p ? `data:${p.mime};base64,${p.bytes.toString('base64')}` : undefined;
};

function blocksHtml(blocks: Block[], spec: DocSpec, image: ImageLookup): string {
  const out: string[] = [];
  const open: ('ul' | 'ol')[] = [];
  const closeTo = (depth: number) => {
    while (open.length > depth) out.push(`</${open.pop()}>`);
  };
  let first = true;
  let prev: Block | undefined;
  for (const b of blocks) {
    if (b.t !== 'li') closeTo(0);
    switch (b.t) {
      case 'h': {
        const isTitle = first && b.level === 1 && spec.template !== 'letter';
        out.push(isTitle ? `<h1 class="title">${runsHtml(b.runs)}</h1>` : `<h${sectionLevel(b.level) + 1}>${runsHtml(b.runs)}</h${sectionLevel(b.level) + 1}>`);
        break;
      }
      case 'p':
        out.push(`<p${spec.template === 'resume' && prev?.t === 'h' && prev.level === 1 ? ' class="contact"' : ''}>${runsHtml(b.runs)}</p>`);
        break;
      case 'li': {
        const tag = b.ordered ? 'ol' : 'ul';
        closeTo(b.depth + 1);
        if (open.length === b.depth + 1 && open[b.depth] !== tag) closeTo(b.depth);
        while (open.length < b.depth + 1) {
          open.push(tag);
          out.push(tag === 'ol' ? `<ol start="${b.num}">` : '<ul>');
        }
        out.push(`<li>${runsHtml(b.runs)}</li>`);
        break;
      }
      case 'quote':
        out.push(`<blockquote>${runsHtml(b.runs)}</blockquote>`);
        break;
      case 'code':
        out.push(`<pre><code>${esc(b.text)}</code></pre>`);
        break;
      case 'hr':
        out.push('<hr>');
        break;
      case 'break':
        out.push('<div class="page-break"></div>');
        break;
      case 'img': {
        const src = dataUrl(image, b.ref);
        out.push(src ? `<figure><img src="${src}" alt="${esc(b.alt)}">${b.alt ? `<figcaption>${esc(b.alt)}</figcaption>` : ''}</figure>` : b.alt ? `<p><em>[${esc(b.alt)}]</em></p>` : '');
        break;
      }
      case 'table':
        out.push(`<table><thead><tr>${b.head.map((c) => `<th>${runsHtml(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${b.head.map((_, i) => `<td>${runsHtml(r[i] ?? [])}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        break;
    }
    if (b.t !== 'break') first = false;
    prev = b;
  }
  closeTo(0);
  return out.join('\n');
}

function css(spec: DocSpec): string {
  const th = THEMES[spec.template];
  return `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef0f3;font:${th.body + 1.5}px/${th.lead} Calibri,"Segoe UI",Arial,sans-serif;color:#1f2937}
.page{max-width:820px;margin:24px auto;background:#fff;padding:56px 64px;box-shadow:0 1px 4px rgba(0,0,0,.12)}
h1.title{font-size:${th.title + 6}px;margin:0 0 18px;color:#111827;text-align:${th.titleAlign};${th.titleRule ? `border-bottom:3px solid #${th.accent};padding-bottom:10px;` : ''}}
h2,h3,h4{color:#${th.accent};margin:1.2em 0 .4em}${th.sectionRule ? `h2{text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #b6c2d1;padding-bottom:3px}h3{margin-top:.8em}` : ''}
h2{font-size:${th.h1 + 4}px}h3{font-size:${th.h2 + 3}px}h4{font-size:${th.h3 + 2}px}
p{margin:0 0 ${th.after + 3}px}p.contact{text-align:center;color:#6b7280}a{color:#0b5cad}ul,ol{margin:0 0 8px;padding-left:26px}li::marker{color:#${th.accent}}
blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid #${th.accent};color:#4b5563;font-style:italic}
pre{background:#f3f4f6;padding:10px 12px;overflow:auto;font-size:12px}code{font-family:Consolas,monospace;background:#f3f4f6;padding:0 2px}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:.95em}th,td{border:1px solid #d1d5db;padding:5px 8px;text-align:left;vertical-align:top}th{background:#${th.head}}
figure{margin:12px 0;text-align:center}img{max-width:100%;max-height:420px}figcaption{color:#6b7280;font-style:italic;font-size:.9em}
hr{border:0;border-top:1px solid #d1d5db;margin:14px 0}.page-break{border-top:1px dashed #c7cbd1;margin:28px -64px}
.sheet h2{margin-top:0}.slide{aspect-ratio:16/9;max-width:820px;margin:18px auto;background:#fff;font-size:19px;box-shadow:0 1px 4px rgba(0,0,0,.15);padding:28px 40px;position:relative;overflow:hidden;border-top:8px solid #${th.accent}}
.slide.cover{background:#${th.accent};color:#fff;display:flex;flex-direction:column;justify-content:center;text-align:center}.slide h2{font-size:30px;margin:.3em 0 .6em}.slide.cover h2{color:#fff;font-size:40px;border:0}.slide .notes{font-size:13px}
.slide .num{position:absolute;right:16px;bottom:10px;color:#9ca3af;font-size:12px}.slide .pic{float:right;max-width:38%;max-height:70%;margin-left:16px}.slide li.d1{margin-left:22px}.slide li.d2{margin-left:44px}.notes{color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;margin-top:10px;padding-top:6px}
@media (max-width:600px){.page{padding:24px 20px;margin:0}.slide{padding:16px 18px}.page-break{margin:20px -20px}}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}.page-break{page-break-after:always;border:0;margin:0}}`;
}

const shell = (spec: DocSpec, body: string) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(spec.title)}</title><style>${css(spec)}</style></head><body>${body}</body></html>\n`;

/** The document as one HTML page (the html format, and the preview of Word, PDF and Markdown). */
export function makeHtml(spec: DocSpec, image: ImageLookup): string {
  return shell(spec, `<main class="page">${blocksHtml(docBlocks(spec), spec, image)}</main>`);
}

/** What the Open button shows: the page, the sheets as tables, or the slides. */
export function previewHtml(spec: DocSpec, image: ImageLookup): string {
  if (spec.format === 'xlsx' || spec.format === 'csv') {
    const sheets = sheetsOf(spec);
    return shell(spec, sheets.map((s) => `<section class="page sheet"><h2>${esc(s.name)}</h2><table>${s.rows.slice(0, 1000).map((r, i) => `<tr>${r.map((v) => (i === 0 && s.rows.length > 1 ? `<th>${esc(String(v ?? ''))}</th>` : `<td>${esc(String(v ?? ''))}</td>`)).join('')}</tr>`).join('')}</table></section>`).join(''));
  }
  if (spec.format === 'pptx') {
    const slides = slidesOf(spec);
    return shell(spec, slides.map((s, i) => {
      const pic = s.image ? dataUrl(image, s.image) : undefined;
      if (s.cover) return `<section class="slide cover"><h2>${esc(s.title)}</h2>${s.subtitle ? `<p>${esc(s.subtitle)}</p>` : ''}</section>`;
      const lines = s.lines.map((l) => (l.bullet ? `<li style-depth="${l.depth}">${runsHtml(l.runs)}</li>` : `<p>${runsHtml(l.runs)}</p>`)).join('').replace(/ style-depth="(\d)"/g, (_, d) => (d === '0' ? '' : ` class="d${d}"`));
      return `<section class="slide"><h2>${esc(s.title)}</h2>${pic ? `<img class="pic" src="${pic}" alt="">` : ''}<ul>${lines}</ul>${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ''}<span class="num">${i + 1} / ${slides.length}</span></section>`;
    }).join(''));
  }
  return makeHtml(spec, image);
}
