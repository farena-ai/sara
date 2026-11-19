// W2.5 (docs/design/ROADMAP_W.md): help that answers, in six languages. A prebuilt local index of the
// guide, every "How do I…?" answer, every Settings page and tip and the user docs (scripts/help-index.ts
// writes web/help-index/<lang>.json + docs.json), searched in the browser (web/help-find.js) on /help and
// in the app's Help window; short how-to clips under docs/media linked from the answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appEntries, docSections, translateEntries, buildHelpIndex, isUserDoc, HELP_LANGS } from '../scripts/help-index.ts';
import { prepareHelp, searchHelp, foldHelp } from '../web/help-find.js';
import { howtoIndexMd } from '../src/guide-howto.ts';
import { helpMediaFile } from '../src/help-media.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const INDEX_HTML = `<section class="settings-page" data-page="her-character" data-group="Sara" data-title="Character">
<h3>Name <button type="button" class="tip" data-tip="x">?</button></h3><label>Her name <input id="my-name"></label>
</section>
<section class="settings-page" data-page="dh-backups" data-group="Privacy &amp; system" data-title="Backups">
<label>Keep copies <input id="bk-keep"></label>
</section>`;
const HELP_HTML = `<html><body><main><h1>Sara help</h1>
<h2 id="brain">Choosing a brain</h2>
<p>Pick a <em>model</em> she thinks with.</p>
<ul><li>Local models are free.</li></ul>
<h2 id="howto">How do I…?</h2>
<!-- howto:start -->
<details class="howto-q" id="howto-her-character-rename"><summary>How do I change her name?</summary></details>
<!-- howto:end -->
<h2 id="trouble">Something's wrong</h2>
<p>Restart her.</p>
</main></body></html>`;
const HOWTO = {
  'her-character': [{ id: 'rename', q: 'How do I change her name?', steps: ['Type the new name in Name.', 'It saves by itself.'], show: '#my-name' }],
  planner: [{ id: 'add', q: 'How do I add a to-do?', steps: ['Press Add.'] }],
};
const TIPS: { tips: Record<string, [string, string]>; pages: Record<string, [string, string]> } = { tips: { 'bk-keep': ['How many backups she keeps before the oldest goes.', 'care'] }, pages: { 'dh-backups': ['Copies of everything, made every night.', 'care'] } };
const CLIPS = { 'her-character/rename': { file: 'howto/her-character-rename.webm', seconds: 9, bytes: 1000 } };

test('W2.5: app entries cover How do I answers, Settings pages, tips and guide sections with links', () => {
  const es = appEntries({ indexHtml: INDEX_HTML, helpHtml: HELP_HTML, howto: HOWTO, tips: TIPS, clips: CLIPS });
  const by = (i: string) => es.find((e) => e.i === i);
  const h = by('h:her-character/rename')!;
  assert.equal(h.k, 'howto');
  assert.equal(h.t, 'How do I change her name?');
  assert.deepEqual(h.xs, ['Type the new name in Name.', 'It saves by itself.']);
  assert.equal(h.l, '/#view=settings:her-character&howto=rename');
  assert.equal(h.s, '#my-name');
  assert.equal(h.a, 'howto-her-character-rename', 'the guide anchor of the answer');
  assert.deepEqual(h.ps, ['Settings', 'Sara', 'Character']);
  assert.equal(h.c, 'howto/her-character-rename.webm', 'the clip rides on its answer');
  // A view's answer opens the view.
  assert.equal(by('h:planner/add')!.l, '/#view=planner');
  // A Settings page with its summary, and a tip at its control.
  const p = by('p:dh-backups')!;
  assert.equal(p.t, 'Backups');
  assert.deepEqual(p.xs, ['Copies of everything, made every night.']);
  assert.equal(p.l, '/#view=settings:dh-backups');
  const tip = by('t:bk-keep')!;
  assert.equal(tip.t, 'Keep copies');
  assert.equal(tip.l, '/#view=settings:dh-backups&show=bk-keep');
  assert.deepEqual(tip.ps, ['Settings', 'Privacy & system', 'Backups']);
  // Guide sections open the guide; the How do I index itself is not indexed twice.
  const g = by('g:brain')!;
  assert.equal(g.l, '/help#brain');
  assert.equal(g.t, 'Choosing a brain');
  assert.deepEqual(g.xs, ['Pick a <em>model</em> she thinks with.', 'Local models are free.']);
  assert.ok(by('g:trouble'));
  assert.equal(by('g:howto'), undefined);
});

test('W2.5: each language is built from the app dictionary; untranslated entries are marked English', () => {
  const es = appEntries({ indexHtml: INDEX_HTML, helpHtml: HELP_HTML, howto: HOWTO, tips: TIPS, clips: {} });
  const dict: Record<string, string> = {
    'How do I change her name?': '¿Cómo le cambio el nombre?',
    'Type the new name in Name.': 'Escribe el nombre nuevo en Nombre.',
    'It saves by itself.': 'Se guarda solo.',
    'Choosing a brain': 'Elegir un cerebro',
    'Pick a <em>model</em> she thinks with.': 'Elige un <em>modelo</em> con el que piense.',
    'Local models are free.': 'Los modelos locales son gratis.',
    Settings: 'Ajustes',
    Character: 'Carácter',
  };
  const out = translateEntries(es, dict);
  const h = out.find((e) => e.i === 'h:her-character/rename')!;
  assert.equal(h.t, '¿Cómo le cambio el nombre?');
  assert.equal(h.x, 'Escribe el nombre nuevo en Nombre.\nSe guarda solo.');
  assert.equal(h.te, 'How do I change her name?', 'the English title stays searchable');
  assert.equal(h.e, undefined);
  assert.equal(h.p, 'Ajustes → Sara → Carácter');
  const g = out.find((e) => e.i === 'g:brain')!;
  assert.equal(g.x, 'Elige un modelo con el que piense. Los modelos locales son gratis.', 'tags stripped');
  const todo = out.find((e) => e.i === 'h:planner/add')!;
  assert.equal(todo.e, 1, 'no translation: English, marked');
  assert.equal(todo.t, 'How do I add a to-do?');
  // English itself is never marked.
  assert.ok(translateEntries(es, {}, true).every((e) => !e.e));
});

test('W2.5: user docs are split into sections with GitHub anchors; developer and private docs are left out', () => {
  const md = '# Backups\n\nIntro words.\n\n## Restore a backup\n\nOpen **Settings** and press [Restore](START_HERE.md).\n\n## Where copies go\n\nOff-server too.\n\n## Design (one page)\n\nbackup.ts writes rows.\n\n## Owner routes\n\nGET /api/x\n';
  const s = docSections('docs/BACKUPS.md', md);
  assert.deepEqual(s.map((x) => x.i), ['d:BACKUPS.md', 'd:BACKUPS.md#restore-a-backup', 'd:BACKUPS.md#where-copies-go']);
  const r = s[1];
  assert.equal(r.k, 'doc');
  assert.equal(r.t, 'Restore a backup');
  assert.equal(r.p, 'Backups');
  assert.equal(r.x, 'Open Settings and press Restore.');
  assert.equal(r.l, 'docs/BACKUPS.md#restore-a-backup');
  assert.ok(isUserDoc('docs/BACKUPS.md'));
  for (const f of ['docs/ARCHITECTURE.md', 'docs/BACKLOG.md', 'docs/OWNER_CHECKS.md', 'docs/ROADMAP.md', 'docs/handoffs/x.md', 'docs/design/X.md', 'README.md']) assert.equal(isUserDoc(f), false, f);
});

test('W2.5: the browser search ranks titles first, folds accents and finds English words in a translated index', () => {
  const entries = [
    { i: 'h:a', k: 'howto', t: '¿Cómo hago una copia de seguridad?', te: 'How do I make a backup now?', x: 'Pulsa Copia ahora.', p: 'Ajustes', l: '/#view=settings:dh-backups&howto=now' },
    { i: 't:b', k: 'tip', t: 'Guardar copias', x: 'Cuántas copias de seguridad guarda.', p: 'Ajustes', l: '/#view=settings:dh-backups&show=bk-keep' },
    { i: 'd:c', k: 'doc', t: 'Restore a backup', x: 'Open Settings and restore.', p: 'Backups', l: 'docs/BACKUPS.md#restore-a-backup', e: 1 },
    { i: 'g:d', k: 'guide', t: 'Música', x: 'Canciones.', p: '', l: '/help#music' },
  ];
  const prep = prepareHelp(entries);
  assert.equal(foldHelp('Música Ç'), 'musica c');
  assert.equal(searchHelp(prep, 'copia')[0].i, 'h:a', 'a How do I title beats a tip');
  assert.equal(searchHelp(prep, 'musica')[0].i, 'g:d', 'accents folded');
  assert.equal(searchHelp(prep, 'backup')[0].i, 'h:a', 'the English title still matches');
  assert.ok(searchHelp(prep, 'restore backup').some((h) => h.i === 'd:c'));
  assert.deepEqual(searchHelp(prep, ''), []);
  assert.deepEqual(searchHelp(prep, 'zzzz'), []);
  assert.ok(searchHelp(prep, 'copia', 1).length === 1);
});

test('W2.5: the shipped index exists in all six languages, matches the app and stays small', () => {
  assert.deepEqual(HELP_LANGS, ['en', 'es', 'fr', 'de', 'pt-BR', 'it']);
  const en = JSON.parse(read('web/help-index/en.json'));
  assert.equal(en.lang, 'en');
  const ids = en.entries.map((e: { i: string }) => e.i);
  const howto = JSON.parse(read('web/howto.json')) as Record<string, { id: string }[]>;
  for (const [page, qs] of Object.entries(howto)) for (const q of qs) assert.ok(ids.includes(`h:${page}/${q.id}`), `missing ${page}/${q.id}: run node scripts/help-index.ts`);
  let total = statSync(join(ROOT, 'web/help-index/en.json')).size;
  for (const lang of HELP_LANGS.slice(1)) {
    const f = `web/help-index/${lang}.json`;
    const d = JSON.parse(read(f));
    assert.equal(d.lang, lang);
    assert.deepEqual(d.entries.map((e: { i: string }) => e.i), ids, `${lang} has the same entries`);
    const translated = d.entries.filter((e: { e?: number }) => !e.e).length;
    assert.ok(translated / d.entries.length > 0.8, `${lang}: most entries are translated (${translated}/${d.entries.length})`);
    total += statSync(join(ROOT, f)).size;
  }
  const docs = JSON.parse(read('web/help-index/docs.json'));
  assert.ok(docs.entries.length > 300, 'the user docs are in');
  assert.ok(docs.entries.every((e: { l: string }) => /^docs\/[A-Za-z0-9_]+\.md(#[\p{L}\p{N}_-]+)?$/u.test(e.l)));
  total += statSync(join(ROOT, 'web/help-index/docs.json')).size;
  assert.ok(total < 4_000_000, `index files stay small (${total} bytes)`);
  // Every link opens a real place: a Settings page, a view or a guide section.
  const pages = new Set([...read('web/index.html').matchAll(/data-page="([\w-]+)"/g)].map((m) => m[1]));
  const guideIds = new Set([...read('web/help.html').matchAll(/ id="([\w-]+)"/g)].map((m) => m[1]));
  for (const e of en.entries as { l: string; a?: string }[]) {
    const set = /^\/#view=settings:([\w-]+)/.exec(e.l)?.[1];
    if (set) assert.ok(pages.has(set), e.l);
    const g = /^\/help#([\w-]+)$/.exec(e.l)?.[1];
    if (g) assert.ok(guideIds.has(g), e.l);
    if (e.a) assert.ok(guideIds.has(e.a), e.a);
  }
});

test('W2.5: buildHelpIndex is what the script writes (fresh index)', () => {
  const built = buildHelpIndex(ROOT);
  assert.deepEqual([...built.keys()].sort(), ['web/help-index/de.json', 'web/help-index/docs.json', 'web/help-index/en.json', 'web/help-index/es.json', 'web/help-index/fr.json', 'web/help-index/it.json', 'web/help-index/pt-BR.json']);
  // The app part must be fresh (docs may lag until the release run of the script).
  const shipped = JSON.parse(read('web/help-index/en.json'));
  const fresh = JSON.parse(built.get('web/help-index/en.json')!);
  assert.deepEqual(shipped.entries.filter((e: { k: string }) => e.k === 'howto').map((e: { i: string }) => e.i), fresh.entries.filter((e: { k: string }) => e.k === 'howto').map((e: { i: string }) => e.i));
});

test('W2.5: how-to clips are small, real files tied to real answers, and linked from the answers', () => {
  const clips = JSON.parse(read('docs/media/clips.json')) as Record<string, { file: string; seconds: number; bytes: number }>;
  const howto = JSON.parse(read('web/howto.json')) as Record<string, { id: string }[]>;
  assert.equal(Object.keys(clips).length, 10, 'the top 10 How do I answers');
  let total = 0;
  for (const [key, c] of Object.entries(clips)) {
    const [page, q] = key.split('/');
    assert.ok(howto[page]?.some((x) => x.id === q), `${key} is a real answer`);
    assert.match(c.file, /^howto\/[\w-]+\.(webm|gif)$/);
    const f = join(ROOT, 'docs/media', c.file);
    assert.ok(existsSync(f), c.file);
    const size = statSync(f).size;
    assert.equal(size, c.bytes, `${c.file} bytes match`);
    assert.ok(c.seconds > 2 && c.seconds < 60);
    total += size;
  }
  assert.ok(total < 15 * 1024 * 1024, `clips stay under 15 MB (${total})`);
  // HOW_DO_I.md links each clip (gen-guide writes it from docs/media/clips.json).
  const md = read('docs/HOW_DO_I.md');
  for (const c of Object.values(clips)) assert.ok(md.includes(`(media/${c.file})`), `HOW_DO_I.md links ${c.file}`);
  const one = howtoIndexMd({ planner: [{ id: 'a', q: 'How do I a?', steps: ['Do a.'] }] }, {}, { 'planner/a': { file: 'howto/planner-a.webm', seconds: 8, bytes: 1 } });
  assert.ok(one.includes('1. Do a.\n\n▶ [Watch it (8 s)](media/howto/planner-a.webm)\n\n'), one);
  assert.ok(!howtoIndexMd({ planner: [{ id: 'a', q: 'How do I a?', steps: ['Do a.'] }] }, {}).includes('Watch it'));
});

test('W2.5: /docs/media serves only clip files, never other paths', () => {
  const web = join(ROOT, 'web');
  assert.equal(helpMediaFile(web, '/docs/media/clips.json'), join(ROOT, 'docs', 'media', 'clips.json'));
  assert.equal(helpMediaFile(web, '/docs/media/howto/a-b.webm'), join(ROOT, 'docs', 'media', 'howto', 'a-b.webm'));
  for (const bad of ['/docs/media/../BACKLOG.md', '/docs/media/howto/../../x.webm', '/docs/HOW_DO_I.md', '/docs/media/howto/a.md', '/docs/media/%2e%2e/x.webm', '/docs/media/a/b/c.webm']) assert.equal(helpMediaFile(web, bad), null, bad);
});

test('W2.5: the help page and the Help window search the index; links can open an answer and show its control', () => {
  const help = read('web/help.html');
  assert.match(help, /<script type="module" src="\/help-search\.js"><\/script>/);
  assert.match(help, /id="help-find"/);
  const index = read('web/index.html');
  assert.match(index, /id="hm-q"[^>]*type="search"|type="search"[^>]*id="hm-q"/);
  assert.match(index, /id="hm-hits"/);
  const app = read('web/app.js');
  assert.match(app, /initHelpFind\(/);
  assert.match(app, /howto=/, 'openViewFromHash reads &howto=');
  assert.match(app, /show=/, 'openViewFromHash reads &show=');
  // Local only: no outside service, no fetch except the index files.
  for (const f of ['web/help-find.js', 'web/help-search.js']) {
    const src = read(f);
    for (const m of src.matchAll(/fetch\(([^)]*)\)/g)) assert.match(m[1], /help-index|i18n|clips|^\w+(,|$)/, `${f}: ${m[1]}`);
    assert.doesNotMatch(src, /https?:\/\/(?!github\.com\/farena-ai\/sara)/, `${f} reaches no other host`);
  }
  const howto = read('web/howto.js');
  assert.match(howto, /clipFor\(/, 'How do I blocks show a Watch button when a clip exists');
});

test('W2.5: the module imports cleanly in Node (no DOM at import time)', async () => {
  const m = await import(pathToFileURL(join(ROOT, 'web/help-find.js')).href);
  assert.equal(typeof m.renderHelpHits, 'function');
  assert.equal(typeof m.loadHelpIndex, 'function');
});
