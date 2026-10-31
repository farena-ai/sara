// Phase 54: the tools behind the public repository's front page: the PNG/APNG encoder, the docs
// site's Markdown converter and the link checker.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { changed, crc32, decodePng, encodeApng, encodePng, resize, type Image } from '../scripts/apng.ts';
import { buildSite, inline, linker, pickPages, render, slug } from '../scripts/build-docs.ts';
import { anchorsOf, checkLinks, linksIn } from '../scripts/check-links.ts';
import { codingSummary, librarySummary, memorySummary, newest } from '../scripts/publish-results.ts';
import { tempDir } from './helpers.ts';

function solid(w: number, h: number, rgba: [number, number, number, number]): Image {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { width: w, height: h, data };
}

test('png: crc32, encode → decode round trip (RGB and RGBA), resize', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082);
  const img = solid(7, 5, [10, 200, 30, 255]);
  img.data.set([255, 0, 0, 255], (2 * 7 + 3) * 4);
  const back = decodePng(encodePng(img));
  assert.equal(back.width, 7);
  assert.ok(back.data.equals(img.data));
  const clear = solid(3, 3, [1, 2, 3, 128]);
  assert.ok(decodePng(encodePng(clear)).data.equals(clear.data));
  const small = resize(solid(8, 4, [100, 100, 100, 255]), 4);
  assert.deepEqual([small.width, small.height], [4, 2]);
  assert.deepEqual([...small.data.subarray(0, 4)], [100, 100, 100, 255]);
});

test('apng: one acTL, a full first frame, then only the changed rectangle', () => {
  const a = solid(10, 10, [255, 255, 255, 255]);
  const b = solid(10, 10, [255, 255, 255, 255]);
  b.data.set([0, 0, 0, 255], (4 * 10 + 6) * 4);
  assert.deepEqual(changed(a, b), { x: 6, y: 4, w: 1, h: 1 });
  assert.equal(changed(a, a), undefined);
  const file = encodeApng([{ img: a, ms: 500 }, { img: b, ms: 1500 }]);
  const chunks: string[] = [];
  for (let p = 8; p < file.length; ) {
    const len = file.readUInt32BE(p);
    chunks.push(file.toString('latin1', p + 4, p + 8));
    if (chunks.at(-1) === 'fcTL' && chunks.filter((c) => c === 'fcTL').length === 2) assert.deepEqual([file.readUInt32BE(p + 12), file.readUInt32BE(p + 16), file.readUInt32BE(p + 20)], [1, 1, 6]);
    p += 12 + len;
  }
  assert.deepEqual(chunks, ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);
  // A plain PNG viewer shows the first frame.
  assert.ok(decodePng(file).data.equals(a.data));
});

test('docs site: Markdown blocks, tables, escaping, anchors and link rewriting', () => {
  const { html, headings } = render('# Title\n\nSome *text* and `<code>` & **bold**.\n\n| A | B |\n|---|:-:|\n| `x|y` | [go](INSTALL.md#top) |\n\n- one\n- two\n  - nested\n\n```sh\necho <hi>\n```\n\n> quoted\n\n## Title\n', { link: (h) => h.replace(/\.md/, '.html') });
  assert.deepEqual(headings.map((h) => h.id), ['title', 'title-1']);
  assert.match(html, /<p>Some <em>text<\/em> and <code>&lt;code&gt;<\/code> &amp; <strong>bold<\/strong>\.<\/p>/);
  assert.match(html, /<th>A<\/th><th class="al-center">B<\/th>/);
  assert.match(html, /<td><code>x\|y<\/code><\/td><td class="al-center"><a href="INSTALL\.html#top">go<\/a><\/td>/);
  assert.match(html, /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<pre data-lang="sh"><code>echo &lt;hi&gt;<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.equal(inline('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(slug('Add a tool (the basics)'), 'add-a-tool-the-basics');

  const pages = pickPages(['README.md', 'AGENTS.md', 'docs/INSTALL.md', 'docs/BACKLOG.md', 'docs/handoffs/x.md', 'src/a.ts'], (p) => /BACKLOG|handoffs|AGENTS/.test(p));
  assert.deepEqual(pages.map((p) => p.out), ['index.html', 'docs/INSTALL.html']);
  const assets = new Set<string>();
  const link = linker(pages[0], pages, 'https://github.com/o/r', assets, (p) => p === 'docs/a.png');
  assert.equal(link('docs/INSTALL.md#docker', false), 'docs/INSTALL.html#docker');
  assert.equal(link('docs/a.png', true), 'docs/a.png');
  assert.equal(link('src/main.ts', false), 'https://github.com/o/r/blob/main/src/main.ts');
  assert.equal(link('examples/', false), 'https://github.com/o/r/tree/main/examples');
  assert.deepEqual([...assets], ['docs/a.png']);
  const back = linker(pages[1], pages, 'https://github.com/o/r', assets, () => false);
  assert.equal(back('../README.md', false), '../index.html');
});

test('docs site: builds pages, a search index and the GitHub Pages files', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'README.md'), '# Hello & <Docs>\n\nSee [install](docs/INSTALL.md).\n');
  writeFileSync(join(dir, 'docs', 'INSTALL.md'), '# Install\n\nSee [readme](../README.md).\n\n## Docker\n\nRun it.\n');
  writeFileSync(join(dir, 'docs', 'ARCHITECTURE.md'), '# Architecture\n');
  writeFileSync(join(dir, 'CONTRIBUTING.md'), '# Contributing\n');
  writeFileSync(join(dir, 'docs', 'ALPHA.md'), '# Alpha & <More>\n');
  writeFileSync(join(dir, 'docs', 'ZULU.md'), '# Zulu\n');
  const out = join(dir, 'site');
  const r = buildSite({
    root: dir,
    out,
    repo: 'https://github.com/o/r',
    files: ['docs/ZULU.md', 'CONTRIBUTING.md', 'README.md', 'docs/ALPHA.md', 'docs/ARCHITECTURE.md', 'docs/INSTALL.md'],
  });
  assert.equal(r.pages, 6);
  const index = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(index, /href="docs\/INSTALL\.html">install<\/a>/);
  assert.match(index, /<title>Hello &amp; &lt;Docs&gt; · Sara docs<\/title>/);
  assert.doesNotMatch(index, /rel="prev"/);
  assert.match(index, /<nav class="page-nav" aria-label="Page navigation"><a rel="next" href="docs\/INSTALL\.html">Next: Install →<\/a><\/nav>/);
  assert.match(index, /<script src="assets\/site\.js"><\/script>/);
  assert.doesNotMatch(index, /<script>|style="/, 'no inline scripts or styles (CSP)');
  const install = readFileSync(join(out, 'docs', 'INSTALL.html'), 'utf8');
  assert.match(install, /href="\.\.\/index\.html">readme<\/a>/);
  assert.match(install, /<a rel="prev" href="\.\.\/index\.html">← Previous: Hello &amp; &lt;Docs&gt;<\/a>/);
  assert.match(install, /<a rel="next" href="ARCHITECTURE\.html">Next: Architecture →<\/a>/);
  assert.match(install, /href="\.\.\/assets\/site\.css"/);
  const architecture = readFileSync(join(out, 'docs', 'ARCHITECTURE.html'), 'utf8');
  assert.match(architecture, /<a rel="prev" href="INSTALL\.html">← Previous: Install<\/a>/);
  assert.match(architecture, /<a rel="next" href="\.\.\/CONTRIBUTING\.html">Next: Contributing →<\/a>/);
  const contributing = readFileSync(join(out, 'CONTRIBUTING.html'), 'utf8');
  assert.match(contributing, /<a rel="prev" href="docs\/ARCHITECTURE\.html">← Previous: Architecture<\/a>/);
  assert.match(contributing, /<a rel="next" href="docs\/ALPHA\.html">Next: Alpha &amp; &lt;More&gt; →<\/a>/);
  const alpha = readFileSync(join(out, 'docs', 'ALPHA.html'), 'utf8');
  assert.match(alpha, /<a rel="prev" href="\.\.\/CONTRIBUTING\.html">← Previous: Contributing<\/a>/);
  assert.match(alpha, /<a rel="next" href="ZULU\.html">Next: Zulu →<\/a>/);
  const zulu = readFileSync(join(out, 'docs', 'ZULU.html'), 'utf8');
  assert.doesNotMatch(zulu, /rel="next"/);
  assert.match(zulu, /<a rel="prev" href="ALPHA\.html">← Previous: Alpha &amp; &lt;More&gt;<\/a>/);
  assert.match(readFileSync(join(out, 'assets', 'search-index.js'), 'utf8'), /"u":"docs\/INSTALL\.html#docker"/);
  assert.equal(readFileSync(join(out, '.nojekyll'), 'utf8'), '');

  const singleOut = join(dir, 'single-site');
  buildSite({ root: dir, out: singleOut, repo: 'https://github.com/o/r', files: ['README.md'] });
  assert.doesNotMatch(readFileSync(join(singleOut, 'index.html'), 'utf8'), /class="page-nav"/);
});

test('link checker: finds missing files and headings, ignores code and web addresses', (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'README.md'), '# Top\n\n[ok](docs/A.md#second-part) [gone](docs/B.md) [bad anchor](docs/A.md#nope) [web](https://example.com/x.md)\n`[in code](nowhere.md)`\n<img src="docs/pic.png">\n\n```\n[fenced](nowhere.md)\n```\n[self](#top)\n');
  writeFileSync(join(dir, 'docs', 'A.md'), '# A\n\n## Second part\n');
  assert.deepEqual([...anchorsOf('# A\n## B\n## B\n```\n# not\n```')], ['a', 'b', 'b-1']);
  assert.equal(linksIn('`[x](y.md)`\n[z](w.md)').length, 1);
  const broken = checkLinks(dir, ['README.md', 'docs/A.md']);
  assert.deepEqual(broken.map((b) => `${b.link}: ${b.why}`), ['docs/B.md: no such file', 'docs/A.md#nope: no heading #nope in docs/A.md', 'docs/pic.png: no such file']);
});

test('published results: newest file per kind, summaries keep scores and drop replies', () => {
  assert.equal(newest(['2026-10-25-memory.json', '2026-10-27-memory.json', '2026-10-27-memory.md', '2026-10-27-library-x.json'], 'memory'), '2026-10-27-memory.json');
  assert.equal(newest(['2026-10-27-library-gemma.json'], 'library'), undefined);
  const c = codingSummary({ benchmark: 'HumanEval', mode: 'agent', model: 'm', at: '2026-10-27T09:00:00Z', finished: '2026-10-27T10:00:00Z', python: 'Python 3', platform: 'win32', tasks: 2, pass: 1, pass1: 50, seconds: 120, runs: [{ task: 'H/0', pass: true, seconds: 5, toolCalls: 3 }, { task: 'H/1', pass: false, seconds: 9, toolCalls: 4, error: 'timeout' }] }, 'f.json');
  assert.deepEqual([c.passed, c.tasks, c.minutes, c.failed, c.stopped], [1, 2, 2, ['H/1'], [{ task: 'H/1', error: 'timeout' }]]);
  const m = memorySummary({ date: 'd', model: 'm', sara: '0.1', rows: [{ step: 'a', failures: [] }, { step: 'b', failures: ['x'] }] }, 'f');
  assert.deepEqual([m.passed, m.of], [1, 2]);
  const l = librarySummary({ model: 'm', embed: null, pass: '7/8', results: [{ run: 1, ask: 'q', ok: true }, { run: 1, ask: 'r', ok: false }, { run: 2, ask: 'q', ok: true }] }, '2026-10-27-library.json');
  assert.deepEqual(l.runs.map((r) => `${r.passed}/${r.of}`), ['1/2', '1/1']);
  assert.doesNotMatch(JSON.stringify([c, m, l]), /reply|answer|detail/);
});
