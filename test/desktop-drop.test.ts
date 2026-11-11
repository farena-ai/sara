// Drop anywhere on her window (files, folders, pictures, text, links), Save to my PC for the documents
// she makes (the desktop apps' Save dialog, Downloads, a folder of her documents), and dragging a
// document card out to the desktop (docs/desktop.md → Drop files in, save her documents out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain browser JavaScript, no types
import { collectDropped, dragOutData, dropText, saveUrlOk, sortDropped } from '../web/drop-files.js';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const MB = 1024 * 1024;
const file = (name: string, size: number, type = '') => ({ name, size, type });
const isDoc = (f: { name: string }) => /\.(pdf|docx|txt|md|csv)$/i.test(f.name);

test('drop: documents and pictures are taken, too-big files say the limit plainly, others are named', () => {
  const limits = { maxBytes: 50 * MB, maxOtherBytes: 100 * MB, isDoc };
  const r: { take: { name: string }[]; tooBig: unknown[]; unreadable: string[] } = sortDropped([file('Report.pdf', 2 * MB, 'application/pdf'), file('cat.jpg', 3 * MB, 'image/jpeg'), file('Huge.pdf', 80 * MB, 'application/pdf'), file('setup.exe', 1 * MB)], limits);
  assert.deepEqual(r.take.map((f: { name: string }) => f.name), ['Report.pdf', 'cat.jpg']);
  assert.deepEqual(r.tooBig, [{ name: 'Huge.pdf', mb: 50 }]);
  assert.deepEqual(r.unreadable, ['setup.exe']);
  // A non-PDF over the in-memory limit needs to be a PDF, even when the owner's limit is higher.
  const big = sortDropped([file('notes.txt', 120 * MB, 'text/plain')], { maxBytes: 500 * MB, maxOtherBytes: 100 * MB, isDoc });
  assert.deepEqual(big.tooBig, [{ name: 'notes.txt', mb: 100 }]);
  // Without limits from the server (older server, signed out) nothing is refused for its size here.
  assert.equal(sortDropped([file('Huge.pdf', 900 * MB)], { isDoc }).take.length, 1);
});

test('drop: text and links from a browser or another app', () => {
  const dt = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (k: string) => data[k] ?? '' });
  assert.deepEqual(dropText(dt({ 'text/uri-list': '# comment\r\nhttps://example.org/a\r\nhttps://example.org/b', 'text/plain': 'https://example.org/a' })), { text: 'https://example.org/a\nhttps://example.org/b', link: true });
  assert.deepEqual(dropText(dt({ 'text/plain': '  Some words from a page.  ' })), { text: 'Some words from a page.', link: false });
  assert.deepEqual(dropText(dt({ 'text/uri-list': 'javascript:alert(1)' })), { text: '', link: false }, 'only web links');
  assert.deepEqual(dropText(dt({})), { text: '', link: false });
});

test('drop: a folder gives its files (hidden ones left out), up to the limit, and says when it stopped', async () => {
  const f = (name: string) => ({ isFile: true, isDirectory: false, name, file: (ok: (x: unknown) => void) => ok(file(name, 10)) });
  const dir = (name: string, kids: unknown[]) => ({
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false;
      return { readEntries: (ok: (x: unknown[]) => void) => ok(done ? [] : ((done = true), kids)) };
    },
  });
  const tree = dir('Reports', [f('a.pdf'), f('.DS_Store'), dir('2026', [f('b.docx'), dir('.git', [f('HEAD')]), f('c.md')]), f('d.txt')]);
  const items = [{ kind: 'file', webkitGetAsEntry: () => tree }, { kind: 'file', webkitGetAsEntry: () => f('e.csv') }];
  const all = await collectDropped(items, { max: 20 });
  assert.deepEqual(all.files.map((x: { name: string }) => x.name).sort(), ['a.pdf', 'b.docx', 'c.md', 'd.txt', 'e.csv']);
  assert.equal(all.more, false);
  assert.deepEqual(all.folders, ['Reports']);
  const few = await collectDropped(items, { max: 2 });
  assert.equal(few.files.length, 2);
  assert.equal(few.more, true);
});

test('drop: the overlay covers the whole window, in the browser too, and never sends by itself', () => {
  const js = read('web', 'drop.js');
  const app = read('web', 'app.js');
  assert.match(js, /t\('Drop to give these to Sara'\)/);
  assert.match(js, /window\.addEventListener\('dragenter'/);
  assert.match(js, /window\.addEventListener\('drop'/);
  assert.match(js, /\{n\} MB/, 'the overlay says the size limit');
  assert.doesNotMatch(js, /send\(|requestSubmit|\.click\(\)/, 'nothing is sent from a drop');
  // app.js: one hook (the old drop on #chat only is gone, so a drop is never taken twice).
  assert.match(app, /initDrop\(\{/);
  assert.doesNotMatch(app, /\$\('#chat'\)\.addEventListener\(ev,/);
  // Her own drags (a conversation onto a project, a document card) don't open the overlay.
  assert.match(js, /dragstart/);
});

test('quick ask: files dropped there go to the main window as attachments (Windows)', () => {
  const html = read('desktop', 'shared', 'quick-ask.html');
  const cpp = read('desktop', 'windows', 'src', 'main.cpp');
  assert.match(html, /postMessageWithAdditionalObjects\(\{ m: 'qa', a: 'files' \}/);
  assert.match(html, /Drop to give these to Sara/);
  assert.match(cpp, /a == L"files"[\s\S]{0,200}takeFiles\(/);
  assert.match(cpp, /sarasave::messageFiles\(/);
  // Folders from Send To, Sara.exe <folder> and the quick ask: their files (up to the limit).
  assert.match(cpp, /realFiles\(sarasave::expandFolders\(paths, kMaxFiles\)\)/);
});

test('save to my PC: only her own document and file addresses, and the drag-out format', () => {
  assert.equal(saveUrlOk('/api/library/made/12/file'), true);
  assert.equal(saveUrlOk('/api/library/7/file'), true);
  assert.equal(saveUrlOk('/api/files/abc-1'), true);
  assert.equal(saveUrlOk('/api/library/made/12/file?inline=1'), false);
  assert.equal(saveUrlOk('https://evil.example/api/files/x'), false);
  assert.equal(saveUrlOk('/api/settings'), false);
  assert.equal(saveUrlOk('/api/library/../settings/file'), false);
  assert.equal(dragOutData({ url: '/api/library/made/3/file', name: 'Report: Q4.docx', format: 'docx' }, 'http://127.0.0.1:7999'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document:Report_ Q4.docx:http://127.0.0.1:7999/api/library/made/3/file');
});

test('save to my PC: the cards, file chips and Library page offer it in the app; the web keeps plain downloads', () => {
  const card = read('web', 'doc-card.js');
  const app = read('web', 'app.js');
  const lib = read('web', 'library.js');
  const js = read('web', 'save-to-pc.js');
  assert.match(card, /addSaveButtons\(/);
  assert.match(card, /dragOut\(card,/);
  assert.match(card, /dl\.setAttribute\('download'/, 'the Download link stays');
  assert.match(app, /addSaveButtons\(/);
  assert.match(app, /autoSaveMade\(ev\)/, 'a new document she makes in the live chat (not on reload)');
  assert.match(app, /fillSaveSettings\(p\)/);
  assert.match(lib, /addSaveButtons\(/);
  for (const s of ['Save to…', 'Save to Downloads', 'Show in folder', 'Put her documents in a folder automatically', 'Saved {name} to {folder}']) assert.ok(js.includes(`t('${s}'`), s);
  assert.match(js, /p\?\.saveFiles/, 'only an app that can save (older apps and the web: nothing changes)');
});

test('save to my PC (Windows): WebView2 downloads to the chosen path, paths stay in the app', () => {
  const cpp = read('desktop', 'windows', 'src', 'save-files.cpp');
  const main = read('desktop', 'windows', 'src', 'main.cpp');
  const cmake = read('desktop', 'windows', 'CMakeLists.txt');
  assert.match(cmake, /src\/save-files\.cpp/);
  assert.match(cpp, /add_DownloadStarting/);
  assert.match(cpp, /put_ResultFilePath/);
  assert.match(cpp, /GetDeferral/);
  assert.match(cpp, /IFileSaveDialog/);
  assert.match(cpp, /FOS_PICKFOLDERS/);
  assert.match(cpp, /SHOpenFolderAndSelectItems/);
  assert.match(cpp, /saveLastDir/, 'remembers the last folder');
  assert.match(cpp, /L"\/api\/library\/made\/"/);
  // The page gets a short label and a token, never the full path.
  assert.match(cpp, /folderLabel\(/);
  assert.doesNotMatch(cpp, /\\"path\\":/);
  assert.match(main, /sarasave::attach\(/);
  assert.match(main, /kind\.rfind\(L"save", 0\) == 0[\s\S]{0,80}sarasave::onCall\(/);
  assert.match(main, /sarasave::prefsJson\(\)/);
  // A second save without a click is a "multiple automatic downloads": allowed only while one is asked for.
  assert.match(main, /COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS && sarasave::pending\(\)/);
});

test('library settings: members see the size limits a drop is checked against', () => {
  const ts = read('src', 'routes', 'library.ts');
  assert.match(ts, /owner: !opts\.member, maxBytes, maxOtherBytes: MAX_DOC_BYTES/);
});
