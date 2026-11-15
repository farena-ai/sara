// SETTINGS3 (design only): an inventory of every Settings page, for docs/design/SETTINGS3-inventory.md.
// Reads web/index.html, web/tips.json and the nav order in web/settings-nav.js; no dependencies.
//   node scripts/settings3-inventory.mjs            -> prints the markdown
//   node scripts/settings3-inventory.mjs --json     -> prints the raw records
//   node scripts/settings3-inventory.mjs --write    -> writes docs/design/SETTINGS3-inventory.md
// A "setting" is a visible input/select/textarea in the page markup (like scripts/tip-coverage.ts, but
// its free-text-box exemptions count here too); controls built by JS at run time are not in the
// markup, so pages with JS hosts are flagged "built at run time" instead of looking empty.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
const tips = JSON.parse(readFileSync(join(ROOT, 'web/tips.json'), 'utf8'));
const navSrc = readFileSync(join(ROOT, 'web/settings-nav.js'), 'utf8');
const map = JSON.parse(readFileSync(join(ROOT, 'docs/design/settings3-map.json'), 'utf8'));

const ORDER = [...(/const SETTINGS_ORDER = \[([\s\S]*?)\];/.exec(navSrc)?.[1] ?? '').matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
const GROUPS = [...(/const SETTINGS_GROUPS = \[([\s\S]*?)\];/.exec(navSrc)?.[1] ?? '').matchAll(/name: '([^']+)'/g)].map((m) => m[1]);
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const plain = (s) => unesc(s.replace(/<button[^>]*class="tip"[^>]*>\?<\/button>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The body of the <section> that starts at `at` (nesting counted). */
function sectionBody(at) {
  const re = /<section\b|<\/section>/g;
  re.lastIndex = at + 1;
  let depth = 1;
  for (let m; (m = re.exec(html)); ) {
    depth += m[0] === '</section>' ? -1 : 1;
    if (!depth) return html.slice(html.indexOf('>', at) + 1, m.index);
  }
  return '';
}

function controls(body) {
  const out = [];
  for (const c of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = c[2];
    if (/type="(hidden|file|submit|button)"/.test(attrs) || /\bhidden\b/.test(attrs.replace(/data-[\w-]+="[^"]*"/g, ''))) continue;
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? '';
    if (!id && /type="radio"/.test(attrs)) continue;
    if (/^settings-search$/.test(id)) continue; // tip-coverage also skips SKIP_ID boxes; here every row counts
    const kind = c[1] === 'input' ? (/type="(\w+)"/.exec(attrs)?.[1] ?? 'text') : c[1];
    // The row's label: the text of the enclosing <label> (or the text just before the control).
    const before = body.slice(Math.max(0, c.index - 600), c.index);
    const ls = before.lastIndexOf('<label');
    const le = before.lastIndexOf('</label>');
    let label = '';
    if (ls > le) {
      const end = body.indexOf('</label>', c.index);
      label = plain(body.slice(c.index - (before.length - ls), end > 0 ? end : c.index + 200).replace(/<select[\s\S]*?<\/select>/g, ''));
    }
    // The card it sits in (the last <h3> above it) and, for a select, the option shown first.
    const h3 = [...body.slice(0, c.index).matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].pop();
    const sel = c[1] === 'select' ? body.slice(c.index, body.indexOf('</select>', c.index)) : '';
    const opt = /<option\b[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/.exec(sel) ?? /<option\b[^>]*>([\s\S]*?)<\/option>/.exec(sel);
    out.push({ id, kind, label: label.slice(0, 80), section: h3 ? plain(h3[1]) : '', value: opt ? plain(opt[1]).slice(0, 60) : '' });
  }
  return out;
}

const pages = [];
for (const m of html.matchAll(/<section class="settings-page([^"]*)" data-page="([^"]+)" data-group="([^"]+)" data-title="([^"]+)"([^>]*)>/g)) {
  const body = sectionBody(m.index);
  const ctl = controls(body);
  const headings = [...body.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/g)].map((h) => plain(h[1])).filter(Boolean);
  const buttons = [...body.matchAll(/<button\b(?![^>]*class="tip")[^>]*>([\s\S]*?)<\/button>/g)].map((b) => plain(b[1])).filter(Boolean);
  // JS hosts: empty containers with an id that a module fills in (lists, cards, forms).
  const hosts = [...body.matchAll(/<(div|ul|ol|section|table|tbody)\b([^>]*\bid="([\w-]+)"[^>]*)>\s*<\/\1>/g)].map((h) => h[3]);
  const folds = (body.match(/<details\b/g) ?? []).length;
  const words = plain(body).split(' ').filter(Boolean).length;
  const id = m[2];
  const flags = m[5] + m[1];
  pages.push({
    id,
    group: unesc(m[3]),
    title: unesc(m[4]),
    who: /data-owner-only/.test(flags) ? 'owner' : /data-member-only/.test(flags) ? 'member' : 'all',
    where: id === 'desktop-app' ? 'desktop app' : id === 'you-adult' ? 'web only' : '',
    inNav: id !== 'ab-recipes',
    order: ORDER.indexOf(id),
    lead: tips.pages?.[id]?.[0] ?? '',
    controls: ctl,
    headings,
    buttons,
    hosts,
    folds,
    words,
  });
}

// Heuristic shape of a page (checked by hand in the design; the map's tier is the judgement).
for (const p of pages) {
  const n = p.controls.length;
  p.shape = !p.inNav ? 'alias (redirect)' : n === 0 && p.hosts.length === 0 ? 'link/text only' : n <= 2 && p.hosts.length ? 'built at run time' : n <= 2 ? 'thin' : n >= 25 ? 'dense' : 'normal';
}

const missing = pages.filter((p) => !map.pages[p.id]);
const extra = Object.keys(map.pages).filter((id) => !pages.some((p) => p.id === id));
if (missing.length || extra.length) {
  console.error(`settings3-map.json out of date: missing ${missing.map((p) => p.id).join(', ') || '-'}; unknown ${extra.join(', ') || '-'}`);
  process.exitCode = 1;
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(pages, null, 1));
} else {
  const total = pages.reduce((s, p) => s + p.controls.length, 0);
  const byGroup = new Map();
  for (const p of pages) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p]);
  const gRank = (g) => (GROUPS.indexOf(g) < 0 ? 99 : GROUPS.indexOf(g));
  const lines = [];
  const L = (s = '') => lines.push(s);
  const cell = (s) => String(s).replace(/\|/g, '\\|');
  L('# SETTINGS3 inventory: every Settings page today');
  L();
  L('Generated by `node scripts/settings3-inventory.mjs --write` from `web/index.html`, `web/tips.json`,');
  L('`web/settings-nav.js` and the judgement file `docs/design/settings3-map.json` (tier, overlap, new home).');
  L('Do not edit by hand. Companion to `docs/design/SETTINGS3.md`.');
  L();
  L(`**${pages.length} pages** (${pages.filter((p) => p.inNav).length} in the nav; \`ab-recipes\` is a redirect to Skills), **${total} settings in the page markup**`);
  L(`(the tip-coverage count of 881 also includes the settings-like dialogs: Planner, Team, Studio…), ${GROUPS.length} groups.`);
  L('A "setting" = a visible input, select or textarea in the markup (as `scripts/tip-coverage.ts`, plus the free-text and search boxes it exempts). *Built at run time* = the');
  L('page fills its rows from JS (lists, cards, setup forms), so the markup count is low on purpose.');
  L();
  L('## Summary by group');
  L();
  L('| Group | Pages | Settings | Everyday | Sometimes | Advanced | Thin / link-only |');
  L('|---|---:|---:|---:|---:|---:|---:|');
  for (const [g, list] of [...byGroup].sort(([a], [b]) => gRank(a) - gRank(b))) {
    const tier = (t) => list.filter((p) => map.pages[p.id]?.tier === t).length;
    L(`| ${g} | ${list.length} | ${list.reduce((s, p) => s + p.controls.length, 0)} | ${tier('everyday')} | ${tier('sometimes')} | ${tier('advanced')} | ${list.filter((p) => /thin|link/.test(p.shape)).length} |`);
  }
  L();
  L('Tiers: **everyday** = most people touch it in their first weeks; **sometimes** = set once, revisited rarely;');
  L('**advanced** = coders, admins, server owners, or a safety net nobody opens until they need it.');
  L();
  L('## Every page');
  L();
  L('| # | Group | Page (id) | Who | Settings | Sections (h3) | Shape | Tier | Overlaps with | Proposed home |');
  L('|---:|---|---|---|---:|---|---|---|---|---|');
  let i = 0;
  for (const [, list] of [...byGroup].sort(([a], [b]) => gRank(a) - gRank(b))) {
    for (const p of list.sort((a, b) => (a.order < 0 ? 999 : a.order) - (b.order < 0 ? 999 : b.order))) {
      const mp = map.pages[p.id] ?? {};
      const secs = p.headings.length ? `${p.headings.length}: ${p.headings.slice(0, 4).join(' · ')}${p.headings.length > 4 ? ' …' : ''}` : '-';
      L(`| ${++i} | ${p.group} | **${cell(p.title)}** (\`${p.id}\`) | ${p.who}${p.where ? `, ${p.where}` : ''} | ${p.controls.length} | ${cell(secs)} | ${p.shape}${p.folds ? `, ${p.folds} fold${p.folds > 1 ? 's' : ''}` : ''} | ${mp.tier ?? '?'} | ${(mp.overlap ?? []).map((x) => `\`${x}\``).join(' ') || '-'} | ${cell(mp.to ?? '?')} |`);
    }
  }
  L();
  L('## Overlaps (several pages about one thing)');
  L();
  for (const o of map.overlaps) L(`- **${o.topic}:** ${o.pages.map((x) => `\`${x}\` ${pages.find((p) => p.id === x)?.title ?? '?'}`).join(', ')}. ${o.note}`);
  L();
  L('## Thin, link-only and run-time pages');
  L();
  L('| Page | Settings in markup | Run-time hosts | Buttons | Lead line |');
  L('|---|---:|---|---|---|');
  for (const p of pages.filter((x) => /thin|link|run time|alias/.test(x.shape))) L(`| ${cell(p.title)} (\`${p.id}\`) | ${p.controls.length} | ${p.hosts.slice(0, 4).join(', ') || '-'} | ${cell(p.buttons.slice(0, 3).join(' · ') || '-')} | ${cell(p.lead.slice(0, 90))} |`);
  L();
  L('## Densest pages (candidates for an Advanced fold)');
  L();
  L('| Page | Settings | Sections | Words of text |');
  L('|---|---:|---:|---:|');
  for (const p of [...pages].sort((a, b) => b.controls.length - a.controls.length).slice(0, 15)) L(`| ${cell(p.title)} (\`${p.id}\`) | ${p.controls.length} | ${p.headings.length} | ${p.words} |`);
  const md = lines.join('\n') + '\n';
  if (process.argv.includes('--write')) writeFileSync(join(ROOT, 'docs/design/SETTINGS3-inventory.md'), md);
  else console.log(md);
}
