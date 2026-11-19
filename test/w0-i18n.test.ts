// W0.2 (docs/design/ROADMAP_W.md): every message the owner sees reads in her app language. Errors
// built with values keep their English template (enf → errorKey + params), and a source scan fails
// on new English that the app cannot translate: owner route fields, HttpError template literals,
// literal text in web code, the quick-ask bubble.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { send } from '../src/http.ts';
import { en, enf, keyedText, tr } from '../src/i18n.ts';
import { eveningChecklist } from '../src/movein/evening.ts';
import { makeApp, tempDir } from './helpers.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;
const dicts = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(read('web', 'i18n', `${l}.json`)) as Record<string, string>]));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Languages with no translation for this English key. */
const untranslated = (key: string) => LANGS.filter((l) => !(typeof dicts[l][norm(key)] === 'string' && dicts[l][norm(key)].trim()));

function fakeRes() {
  const out = { status: 0, body: '' };
  const res = { writeHead: (s: number) => ((out.status = s), res), end: (b: string) => void (out.body = b) } as unknown as ServerResponse;
  return { res, out };
}

test('W0.2 enf: an error with values keeps its template; send() adds errorKey + params for the app', () => {
  const msg = enf('There is no app "{name}". app_list shows the kept apps.', { name: 'Quiz' });
  assert.equal(msg, 'There is no app "Quiz". app_list shows the kept apps.', 'the model and logs still read English');
  assert.deepEqual(keyedText(msg), { key: 'There is no app "{name}". app_list shows the kept apps.', params: { name: 'Quiz' } });
  const { res, out } = fakeRes();
  send(res, 404, { error: msg });
  const body = JSON.parse(out.body);
  assert.equal(body.error, msg);
  assert.equal(body.errorKey, 'There is no app "{name}". app_list shows the kept apps.');
  assert.match(tr(body.errorKey, 'de', body.params), /Quiz/);
  assert.notEqual(tr(body.errorKey, 'de', body.params), msg, 'German reads German');
  // Success bodies and plain errors are untouched.
  const ok = fakeRes();
  send(ok.res, 200, { error: msg });
  assert.equal(JSON.parse(ok.out.body).errorKey, undefined);
  const plain = fakeRes();
  send(plain.res, 400, { error: 'Something else.' });
  assert.equal(JSON.parse(plain.out.body).errorKey, undefined);
});

test('W0.2 My apps: engine errors reach the page with their template (no English-only messages)', async () => {
  const src = read('src', 'my-apps.ts');
  assert.doesNotMatch(src, /\bfail\(\s*`/, 'fail(`…${x}…`) cannot be translated: use enf(template, params)');
  assert.doesNotMatch(src, /\bfail\(\s*'/, "fail('…') is invisible to i18n-extract: wrap it in en()");
  const canvas = read('src', 'canvas.ts');
  assert.doesNotMatch(canvas, /\bfail\(\s*[`']/, 'live views: same rule');
  for (const f of ['my-apps.js', 'canvas-card.js', 'journal.js']) assert.match(read('web', f), /serverText\(data/, `${f} shows server errors with serverText (errorKey + params)`);
});

test('W0.2 live checklist (Move-in evening): "Still to do" lines carry templates the app translates', () => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-19T12:00:00Z') });
  try {
    const ev = eveningChecklist(app, { needsYou: [
      { key: 'keys', count: 2, text: 'Paste keys: A, B (Settings → Models & usage / Voice). Keys never move with a bundle.', tkey: en('Paste keys: {names} (Settings → Models & usage / Voice). Keys never move with a bundle.'), params: { names: 'A, B' } },
      { key: 'held-medical', count: 3, text: 'x', tkey: 'Health/medical: {n} items held. Import the bundle again and say yes to bring them.', params: { n: 3 } },
      { key: 'odd', count: 1, text: 'An old line from an older report.' },
    ] }, undefined);
    const keys = ev.todo.find((x) => x.kind === 'keys')!;
    assert.deepEqual(keys.parts, [{ key: 'Paste keys: {names} (Settings → Models & usage / Voice). Keys never move with a bundle.', params: { names: 'A, B' } }]);
    assert.equal(ev.todo.find((x) => x.kind === 'odd')!.parts, undefined, 'old reports fall back to t(why)');
    for (const p of ev.todo.flatMap((x) => x.parts ?? [])) assert.deepEqual(untranslated(p.key), [], p.key);
    const web = read('web', 'movein.js');
    assert.match(web, /x\.parts\?\.length \? x\.parts\.map\(\(p\) => t\(p\.key, p\.params\)\)/);
    assert.match(web, /return l\.tkey \? t\(l\.tkey, l\.params\) : t\(l\.text\);/);
  } finally {
    app.store.close();
    cleanup();
  }
});

test('W0.2 D8 second opinion: one point reads singular, in every language', () => {
  const web = read('web', 'second-opinion.js');
  assert.match(web, /r\.differ === 1 \? t\('Second opinion: 1 point differs'\)/);
  assert.deepEqual(untranslated('Second opinion: 1 point differs'), []);
  assert.deepEqual(untranslated('Second opinion: {n} points differ'), []);
});

test('W0.2 quick-ask bubble: loads the owner language and every text it shows is translated', () => {
  const page = read('desktop', 'shared', 'quick-ask.html');
  assert.match(page, /fetch\('\/i18n\/' \+ lang \+ '\.json'/);
  assert.match(page, /await loadWords\(session\)/);
  const keys = new Set<string>();
  for (const m of page.matchAll(/(?<![\w$.])t\('((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'").replace(/\\u2019/g, '’'));
  const body = page.slice(page.indexOf('<body')).replace(/<script\b[\s\S]*?<\/script>/g, ' ');
  for (const m of body.matchAll(/>([^<]+)</g)) if (/[A-Za-z]{2}/.test(m[1]) && norm(m[1]) !== 'Sara') keys.add(norm(m[1]));
  for (const m of body.matchAll(/\s(?:placeholder|title|aria-label)="([^"]*)"/g)) keys.add(norm(m[1]));
  assert.ok(keys.size > 40, `found ${keys.size} texts`);
  const missing = [...keys].filter((k) => untranslated(k).length);
  assert.deepEqual(missing, []);
  // Text she builds in code goes through t(): no English glued to a value.
  const script = page.slice(page.indexOf('<script'));
  assert.doesNotMatch(script, /(?:textContent|placeholder|title) = '[A-Z][a-z]+ [^']*'/);
  assert.doesNotMatch(script, /esc\('[A-Z][a-z]+[^']*'\)/);
});

// ---------- the guard: new English that cannot be translated fails here ----------

/** Technical or not-for-the-owner text, by file and the start of the text (each with its reason). */
const ALLOWED: [file: string, start: string, why: string][] = [
  ['board.ts', 'Send the invitations', 'the demo board seed (demo stays English)'],
  ['board.ts', 'Find three lemonade recipes', 'demo seed'],
  ['board.ts', 'Borrow folding chairs', 'demo seed'],
  ['board.ts', 'Book the bouncy castle', 'demo seed'],
  ['board.ts', 'Pick a date', 'demo seed'],
  ['board.ts', 'Saved note "Three lemonades"', 'demo seed'],
];
const FIELD = /\b(error|message|text|warning|note|hint|reason|label|title|detail|summary)\s*:\s*(?:(?:en|tr|trOwner)\()*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
const looksEnglish = (s: string) => /[A-Z][a-z]+ [a-z]+/.test(s) || /^[A-Z][a-z]+[.!]$/.test(s);

test('W0.2 guard: owner route fields (error/message/reason/text…) are English the app can translate', () => {
  const dir = join(ROOT, 'src', 'routes');
  const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    read('src', 'routes', f).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(FIELD)) {
        const s = m[2].slice(1, -1).replace(/\\(['`\\])/g, '$1');
        if (!looksEnglish(s) || ALLOWED.some(([af, start]) => af === f && s.startsWith(start))) continue;
        if (m[2].startsWith('`') && s.includes('${')) bad.push(`${f}:${i + 1} built with \${…}: use en('… {x} …') + params (or enf): ${s.slice(0, 90)}`);
        else if (untranslated(s).length) bad.push(`${f}:${i + 1} no ${untranslated(s).join('/')} translation (wrap it in en() and run i18n-extract --missing): ${s.slice(0, 90)}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});

test('W0.2 guard: no HttpError message is a template literal with values (use { params } or enf)', () => {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.ts') ? [join(d, e.name)] : []));
  const bad: string[] = [];
  for (const f of walk(join(ROOT, 'src'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/new HttpError\(\s*\d+\s*,\s*`[^`]*\$\{/.test(line)) bad.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('W0.2 guard: web code puts no literal English on the page without t()', () => {
  const ALLOW_WEB = new Set(['settings-overview.js:Ctrl K']);
  const bad: string[] = [];
  for (const f of readdirSync(join(ROOT, 'web')).filter((x) => x.endsWith('.js'))) {
    read('web', f).split('\n').forEach((line, i) => {
      const hits = [
        ...line.matchAll(/(?:textContent|innerText|placeholder|title)\s*=\s*'([A-Z][a-z]+ [^']*)'/g),
        ...line.matchAll(/\bel\(\s*'[a-z0-9]+'\s*,\s*'[^']*'\s*,\s*['`]([A-Z][a-z]+ [^'`]*)['`]/g),
      ];
      for (const m of hits) if (!ALLOW_WEB.has(`${f}:${m[1]}`)) bad.push(`${f}:${i + 1} ${m[1].slice(0, 80)}`);
    });
  }
  assert.deepEqual(bad, []);
  // Error helpers show the server's message through serverText (errorKey + params), not raw English.
  const raw: string[] = [];
  // myapp-data.js runs inside a kept app's sandbox (no Sara words); reception-chat.js is the public
  // receptionist with its own visitor-language words.
  for (const f of readdirSync(join(ROOT, 'web')).filter((x) => x.endsWith('.js') && x !== 'myapp-data.js' && x !== 'reception-chat.js')) {
    if (/throw (?:Object\.assign\()?new Error\((?:data|d|j)\.error (?:\?\?|\|\|)/.test(read('web', f))) raw.push(f);
  }
  assert.deepEqual(raw, []);
});
