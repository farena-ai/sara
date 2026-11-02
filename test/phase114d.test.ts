// Phase 114 slice PL1d (2.47.3, docs/design/POLISH.md §6 and §7): docs, README, guide, videos. The
// guide's two paths and its "How do I…?" index generated from web/howto.json (and docs/HOW_DO_I.md from
// the same source), every guide anchor the app links to, the six READMEs in step, the video links, the
// screenshots (listed in a manifest, small, all referenced), the docs site's Start here group, and the
// two leftovers (one "Add a plugin" on an empty Plugins page; the Linux hands command wraps on a phone).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSite, pickPages } from '../scripts/build-docs.ts';
import { checkLinks, checkVideoLinks, linksIn, PLAYLIST } from '../scripts/check-links.ts';
import { howtoAnchor, howtoIndexMd, howtoSections, pageTitles, withHowtoIndex, type HowtoData } from '../src/guide-howto.ts';
import { ROOT } from './helpers.ts';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const howto = () => JSON.parse(read('web/howto.json')) as HowtoData;
const titles = () => pageTitles(read('web/index.html'));
const READMES = ['README.md', 'README.es.md', 'README.fr.md', 'README.de.md', 'README.it.md', 'README.pt-BR.md'];

// ---------- the guide ----------

test('PL1d: the guide opens with the two paths, then Getting started', () => {
  const html = read('web/help.html');
  const h2 = [...html.matchAll(/<h2 id="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(h2.slice(0, 3), ['beginner', 'coder', 'start']);
  const nav = [...html.slice(0, html.indexOf('</nav>')).matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(nav.slice(0, 3), ['beginner', 'coder', 'start']);
  assert.ok(nav.includes('howto'), 'the menu links the How do I…? index');
  // Both paths link the matching video from the playlist.
  for (const id of ['beginner', 'coder']) {
    const sec = html.slice(html.indexOf(`<h2 id="${id}">`), html.indexOf('<h2', html.indexOf(`<h2 id="${id}">`) + 5));
    assert.match(sec, new RegExp(`youtube\\.com/watch\\?v=[\\w-]{11}&amp;list=${PLAYLIST}`), id);
  }
});

test('PL1d: the How do I…? index in the guide lists every entry of howto.json, and is up to date', () => {
  const html = read('web/help.html');
  const data = howto();
  assert.equal(withHowtoIndex(html, data, titles()), html, 'run node scripts/gen-guide.ts');
  let n = 0;
  for (const [page, list] of Object.entries(data)) {
    assert.ok(html.includes(`id="${howtoAnchor(page)}"`), `guide: no heading for ${page}`);
    for (const q of list) {
      n++;
      const at = html.indexOf(`id="${howtoAnchor(page, q.id)}"`);
      assert.ok(at > 0, `guide: no entry for ${page}/${q.id}`);
      const block = html.slice(at, html.indexOf('</details>', at));
      assert.ok(block.includes(`<summary>${q.q.replace(/&/g, '&amp;')}</summary>`), `${page}/${q.id}: question`);
      for (const s of q.steps) assert.ok(block.includes(`<li>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`), `${page}/${q.id}: step "${s}"`);
    }
  }
  assert.equal(n, [...html.matchAll(/<details class="howto-q"/g)].length, 'no extra entries');
  assert.ok(n >= 120, `${n} answers`);
  // Views first, then the Settings groups in menu order; every Settings page has a title.
  const sections = howtoSections(data, titles());
  assert.equal(sections[0].pages[0].id, 'chat');
  assert.deepEqual(sections.slice(1).map((s) => s.heading), ['Her', 'You', 'Models', 'Abilities', 'Connections', 'Data & health', 'Household']);
});

test('PL1d: the guide index needs no new translations (titles and questions are keys the app already has)', () => {
  const html = read('web/help.html');
  const index = html.slice(html.indexOf('<!-- howto:start -->'), html.indexOf('<!-- howto:end -->'));
  const keys = new Set<string>();
  for (const m of index.matchAll(/<(h3|h4|summary|li)\b[^>]*>([^<]*)<\/\1>/g)) keys.add(m[2].replace(/&amp;/g, '&'));
  for (const lang of ['es', 'fr', 'de', 'it', 'pt-BR']) {
    const dict = JSON.parse(read(`web/i18n/${lang}.json`)) as Record<string, string>;
    const missing = [...keys].filter((k) => !dict[k] && !['Chat', 'GitHub', 'Telegram', 'Discord', 'Signal', 'Email', 'Webhooks', 'Home Assistant'].includes(k));
    assert.deepEqual(missing.slice(0, 5), [], `${lang}: ${missing.length} index lines untranslated`);
  }
  // help-i18n.js translates the index's page titles and questions by their text.
  assert.match(read('web/help-i18n.js'), /main h4, main summary/);
});

test('PL1d: docs/HOW_DO_I.md is generated from howto.json and lists every question', () => {
  const md = read('docs/HOW_DO_I.md');
  const data = howto();
  assert.equal(md, howtoIndexMd(data, titles()), 'run node scripts/gen-guide.ts');
  for (const list of Object.values(data)) for (const q of list) assert.ok(md.includes(`**${q.q}**`), q.q);
});

test('PL1d: every guide anchor the app links to exists', () => {
  const anchors = new Set([...read('web/help.html').matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const used = new Map<string, string>();
  const scan = (dir: string, ext: RegExp) => {
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!ext.test(f)) continue;
      const text = read(`${dir}/${f}`);
      for (const m of text.matchAll(/\/help#([\w-]+)/g)) used.set(m[1], `${dir}/${f}`);
      for (const m of text.matchAll(/data-guide="([\w-]+)"/g)) used.set(m[1], `${dir}/${f}`);
    }
  };
  scan('web', /\.(js|html)$/);
  scan('src', /\.ts$/);
  const tips = JSON.parse(read('web/tips.json')) as { tips?: Record<string, [string, string]>; pages?: Record<string, [string, string]> };
  for (const [id, v] of [...Object.entries(tips.tips ?? {}), ...Object.entries(tips.pages ?? {})]) if (v[1]) used.set(v[1], `tips.json ${id}`);
  // app.js TIP_GUIDE_FOR: dialog id → guide section.
  const map = /const TIP_GUIDE_FOR = \{([^}]*)\}/.exec(read('web/app.js'))?.[1] ?? '';
  for (const m of map.matchAll(/:\s*'([\w-]+)'/g)) used.set(m[1], 'app.js TIP_GUIDE_FOR');
  assert.ok(used.size > 20, `${used.size} anchors found`);
  for (const [a, where] of used) assert.ok(anchors.has(a), `${where} links /help#${a}, which the guide doesn't have`);
});

// ---------- the READMEs ----------

const headings = (md: string) => {
  let fence = false;
  const out: string[] = [];
  for (const l of md.split('\n')) {
    if (/^\s*```/.test(l)) fence = !fence;
    else if (!fence && /^#{1,6} /.test(l)) out.push(l.match(/^#+/)![0]);
  }
  return out;
};
const pictures = (md: string) => [...md.matchAll(/docs\/screenshots\/[\w.-]+/g)].map((m) => m[0]);

test('PL1d: the README and its 5 translations have the same sections and the same pictures', () => {
  const en = read('README.md');
  for (const f of READMES.slice(1)) {
    const md = read(f);
    assert.deepEqual(headings(md), headings(en), `${f}: heading levels differ from README.md`);
    assert.deepEqual(pictures(md), pictures(en), `${f}: screenshots differ from README.md`);
  }
  // The structure §6 asks for: Start here with both paths, a short What's new, the tour split in three.
  const h = [...en.matchAll(/^(#{2,4}) (.+)$/gm)].map((m) => `${m[1].length}:${m[2]}`);
  for (const want of ['2:Start here', "3:I just installed it, now what?", "3:I'm here to code", '3:For company', '3:For coding', '3:For both']) assert.ok(h.includes(want), want);
});

test('PL1d: every README has both path buttons, three What\'s new lines and the folded release history', () => {
  for (const f of READMES) {
    const md = read(f);
    const top = md.slice(0, md.indexOf('\n## '));
    assert.match(top, /<a href="docs\/START_HERE\.md"><img src="https:\/\/img\.shields\.io\/badge\/[^"]+" alt="[^"]+"/, `${f}: beginner button`);
    assert.match(top, /<a href="docs\/FOR_CODERS\.md"><img src="https:\/\/img\.shields\.io\/badge\/[^"]+" alt="[^"]+"/, `${f}: coder button`);
    const heads = [...md.matchAll(/^## .+$/gm)];
    const wn = md.slice(heads[3].index!, heads[4].index!);
    assert.equal([...wn.matchAll(/^- \*\*\d+\.\d+(\.\d+)?\*\* · /gm)].length, 3, `${f}: three What's new lines`);
    assert.match(wn, /<details>\n<summary><b>[^<]+<\/b>[^<]*<\/summary>\n\n\| [^\n]+\|\n\|---\|---\|\n\| \*\*\d+\.\d+(\.\d+)?\*\* · /, `${f}: the release table folds under its summary`);
  }
});

test('PL1d: README pictures have meaningful alt text', () => {
  for (const f of READMES) {
    for (const m of read(f).matchAll(/<img src="docs\/screenshots\/[^"]+" alt="([^"]*)"/g)) assert.ok(m[1].length >= 40, `${f}: short alt "${m[1]}"`);
  }
});

// ---------- links and videos ----------

test('PL1d: every relative link in the Markdown resolves (READMEs and the new pages)', () => {
  const files = [...READMES, 'docs/START_HERE.md', 'docs/FOR_CODERS.md', 'docs/HOW_DO_I.md', 'docs/VIDEOS.md'];
  assert.deepEqual(checkLinks(ROOT, files), []);
});

test('PL1d: the playlist and video links are well formed (offline)', () => {
  const files = [...READMES, 'docs/START_HERE.md', 'docs/FOR_CODERS.md', 'docs/VIDEOS.md', 'web/help.html', 'web/index.html'];
  const ids = new Set<string>();
  for (const f of files) {
    const text = read(f);
    assert.deepEqual(checkVideoLinks(f, text), [], f);
    for (const m of text.matchAll(/watch\?v=([\w-]{11})/g)) ids.add(m[1]);
  }
  assert.equal(ids.size, 4, 'the four how-to videos');
  for (const f of READMES) assert.ok(read(f).includes(`playlist?list=${PLAYLIST}`), `${f}: the playlist link`);
  // The check catches the usual mistakes.
  const bad = checkVideoLinks('x.md', '[a](https://www.youtube.com/watch?v=short&list=PLother) <img src="https://i.ytimg.com/vi/AAAAAAAAAAA/mqdefault.jpg">');
  assert.deepEqual(bad.map((b) => b.why.split(' ')[0]), ['not', 'not', 'a']);
});

// ---------- screenshots ----------

test('PL1d: screenshots are listed in the manifest, from the 2.47.2 UI, small and all used', () => {
  const dir = join(ROOT, 'docs', 'screenshots');
  const manifest = JSON.parse(read('docs/screenshots/manifest.json')) as { files: Record<string, { ui: string; what: string; bytes: number }> };
  const used = new Set<string>();
  for (const f of [...READMES, ...readdirSync(join(ROOT, 'docs')).filter((x) => x.endsWith('.md')).map((x) => `docs/${x}`), 'docs/launch/social-preview.html']) {
    for (const m of read(f).matchAll(/screenshots\/([\w.-]+\.(?:png|webp|jpe?g|gif))/g)) used.add(m[1]);
  }
  const files = readdirSync(dir).filter((f) => /\.(png|webp|jpe?g|gif)$/.test(f));
  for (const f of files) assert.ok(used.has(f), `docs/screenshots/${f} is not used anywhere`);
  for (const f of used) {
    assert.ok(existsSync(join(dir, f)), `missing docs/screenshots/${f}`);
    const m = manifest.files[f];
    assert.ok(m && m.what.length > 10, `${f}: not in manifest.json`);
    const size = statSync(join(dir, f)).size;
    if (f !== 'demo.png') assert.ok(size < 300 * 1024, `${f}: ${size} bytes (keep under 300 KB)`);
  }
  // The views PL1d retook (Today desktop and phone, the dials, How do I, coding with steps, the first-run question).
  for (const f of ['today.webp', 'phone.webp', 'dials.webp', 'howto.webp', 'coding.webp', 'first-run.webp']) assert.equal(manifest.files[f]?.ui, '2.47.2', f);
});

// ---------- the docs site ----------

test('PL1d: the docs site starts with the two paths, the How do I…? index and the videos', () => {
  const pages = pickPages(['README.md', 'docs/INSTALL.md', 'docs/START_HERE.md', 'docs/FOR_CODERS.md', 'docs/HOW_DO_I.md', 'docs/VIDEOS.md', 'docs/SUPPORT.md', 'docs/TODAY.md', 'docs/CHATS.md', 'docs/BACKLOG.md'], (p) => /BACKLOG/.test(p));
  assert.deepEqual(pages.filter((p) => p.group === 'Start here').map((p) => p.src), ['README.md', 'docs/START_HERE.md', 'docs/FOR_CODERS.md', 'docs/HOW_DO_I.md', 'docs/VIDEOS.md', 'docs/SUPPORT.md']);
  for (const src of ['docs/TODAY.md', 'docs/CHATS.md']) assert.equal(pages.find((p) => p.src === src)?.group, 'Using Sara', src);
  assert.ok(!pages.some((p) => p.src === 'docs/BACKLOG.md'), 'private pages stay out');
});

test('PL1d: the docs site builds from the real docs, with the new pages and their pictures', () => {
  const out = mkdtempSync(join(tmpdir(), 'sara-docs-'));
  try {
    const files = [...READMES, ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`), ...readdirSync(join(ROOT, 'docs', 'screenshots')).map((f) => `docs/screenshots/${f}`)];
    const r = buildSite({ root: ROOT, out, repo: 'https://github.com/farena-ai/sara', files });
    assert.ok(r.pages > 40 && r.assets >= 10, JSON.stringify(r));
    const start = readFileSync(join(out, 'docs', 'START_HERE.html'), 'utf8');
    assert.match(start, /<img src="screenshots\/first-run\.webp"/);
    const index = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(index, /href="docs\/START_HERE\.html"/);
    assert.ok(existsSync(join(out, 'docs', 'screenshots', 'coding.webp')));
    assert.ok(!existsSync(join(out, 'docs', 'BACKLOG.html')), 'private pages are not built');
    const howtoPage = readFileSync(join(out, 'docs', 'HOW_DO_I.html'), 'utf8');
    assert.ok(howtoPage.includes('How do I change her name?'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('PL1d: the new pages never link private docs', () => {
  for (const f of ['docs/START_HERE.md', 'docs/FOR_CODERS.md', 'docs/HOW_DO_I.md', 'docs/VIDEOS.md']) {
    for (const { href } of linksIn(read(f))) assert.doesNotMatch(href, /ops\/|handoffs\/|OWNER_CHECKS|DECISIONS|BACKLOG|SOURCE_OF_TRUTH|ROADMAP/, `${f} → ${href}`);
  }
});

// ---------- the leftovers ----------

test('PL1d: an empty Plugins page shows one Add a plugin (the empty state\'s), not two', () => {
  const src = read('web/plugins.js');
  const at = src.indexOf('function renderList()');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /#plg-add'\)\?\.closest\('\.add-row'\)/);
  assert.match(body, /top\.hidden = !state\.plugins\.length/);
  assert.match(read('web/index.html'), /<div class="add-row skl-top"><button id="plg-add"/);
});

test('PL1d: the Linux hands command wraps inside its box on a phone', () => {
  const css = read('web/style.css');
  const rule = /\.cu-get pre \{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(rule, /white-space: pre-wrap/);
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.match(read('web/index.html'), /id="cu-get"[\s\S]*?<pre><code>sara hands --server/);
});
