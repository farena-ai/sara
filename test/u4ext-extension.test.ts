// U4.25 (docs/EXTENSION.md): the browser extension's own logic, without a browser. A tiny DOM made
// here (elements with tagName / childNodes / getAttribute, text nodes) stands in for the page:
// readable page text (what is skipped, the cap), the form fields it lists and the ones it never fills
// (passwords, payment cards, one-time codes), the per-site off switch, the server address and the
// manifests / locales / packaging.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const EXT = join(ROOT, 'extension');
const read = (...p: string[]) => readFileSync(join(EXT, ...p), 'utf8');

// ------------------------------------------------------------------ a tiny DOM
interface FakeNode {
  nodeType: number;
  nodeValue?: string;
  tagName?: string;
  childNodes: FakeNode[];
  parentNode?: FakeNode;
  attrs?: Record<string, string>;
  hidden?: boolean;
  value?: string;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  options?: { value: string; text: string; selected?: boolean }[];
  events?: string[];
  getAttribute?: (n: string) => string | null;
  dispatchEvent?: (e: { type: string }) => boolean;
}
function h(tag: string, attrs: Record<string, string> = {}, kids: (FakeNode | string)[] = []): FakeNode {
  const el: FakeNode = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], attrs, events: [] };
  el.getAttribute = (n) => (n in attrs ? attrs[n]! : null);
  el.dispatchEvent = (e) => (el.events!.push(e.type), true);
  if ('hidden' in attrs) el.hidden = true;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    el.type = tag === 'input' ? (attrs.type ?? 'text').toLowerCase() : tag;
    el.value = attrs.value ?? '';
    el.disabled = 'disabled' in attrs;
    el.readOnly = 'readonly' in attrs;
  }
  for (const k of kids) {
    const n: FakeNode = typeof k === 'string' ? { nodeType: 3, nodeValue: k, childNodes: [] } : k;
    n.parentNode = el;
    el.childNodes.push(n);
  }
  return el;
}
function sel(attrs: Record<string, string>, opts: [string, string][]): FakeNode {
  const el = h('select', attrs);
  el.options = opts.map(([value, text]) => ({ value, text }));
  return el;
}
function doc(body: FakeNode, title = 'A page') {
  const all = (n: FakeNode, out: FakeNode[] = []) => {
    if (n.nodeType === 1) out.push(n);
    for (const c of n.childNodes) all(c, out);
    return out;
  };
  return { title, body, documentElement: body, location: { href: 'https://shop.example/checkout' }, elementsOf: () => all(body) };
}

const load = async (file: string, name: string) => {
  await import(pathToFileURL(join(EXT, 'lib', file)).href);
  return (globalThis as Record<string, unknown>)[name] as Record<string, (...a: unknown[]) => unknown>;
};

// ------------------------------------------------------------------ readable text
test('readable text: the article only, no scripts, menus, hidden parts or form controls; capped', async () => {
  const X = await load('extract.js', 'SaraExtract');
  const page = h('body', {}, [
    h('nav', {}, ['Home Shop Cart']),
    h('script', {}, ['var secret = 1;']),
    h('main', {}, [
      h('h1', {}, ['Big   news']),
      h('p', {}, ['First ', h('b', {}, ['bold']), ' line.']),
      h('div', { 'aria-hidden': 'true' }, ['Ad text']),
      h('p', { hidden: '' }, ['Hidden part']),
      h('style', {}, ['.x{}']),
      h('form', {}, [h('input', { value: 'typed' })]),
      h('p', {}, ['Second line.']),
    ]),
    h('footer', {}, ['Copyright']),
  ]);
  const d = doc(page);
  const t = X.readableText(d as never) as string;
  assert.equal(t, 'Big news\nFirst bold line.\nSecond line.');
  for (const bad of ['Home Shop', 'secret', 'Ad text', 'Hidden part', 'typed', 'Copyright', '.x{}']) assert.ok(!t.includes(bad), bad);
  // No article: the whole body (still without menus).
  const plain = doc(h('body', {}, [h('header', {}, ['Logo']), h('p', {}, ['Only text'])]));
  assert.equal(X.readableText(plain as never), 'Only text');
  // The cap: a long page is cut with an ellipsis at max characters.
  const long = doc(h('body', {}, [h('p', {}, ['word '.repeat(5000)])]));
  const cut = X.readableText(long as never, { max: 300 }) as string;
  assert.ok(cut.length <= 300 && cut.endsWith('…'), String(cut.length));
  assert.equal(X.MAX_TEXT, 20000);
});

// ------------------------------------------------------------------ form fields
test('form fields: listed with their labels; passwords, cards, one-time codes and hidden fields never', async () => {
  const F = await load('fields.js', 'SaraFields');
  const kinds: [Record<string, string>, string][] = [
    [{ type: 'password', name: 'pw' }, 'never'],
    [{ name: 'cc-number', autocomplete: 'cc-number' }, 'never'],
    [{ name: 'card', placeholder: 'Card number' }, 'never'],
    [{ name: 'cvc' }, 'never'],
    [{ name: 'exp', 'aria-label': 'Expiry date' }, 'never'],
    [{ name: 'otp', autocomplete: 'one-time-code' }, 'never'],
    [{ name: 'code', 'aria-label': 'Verification code' }, 'never'],
    [{ name: 'twofa', placeholder: '2FA code' }, 'never'],
    [{ name: 'ssn', placeholder: 'Social security number' }, 'never'],
    [{ type: 'hidden', name: 'csrf' }, 'skip'],
    [{ type: 'submit', name: 'go' }, 'skip'],
    [{ type: 'file', name: 'upload' }, 'skip'],
    [{ name: 'first', disabled: '' }, 'skip'],
    [{ name: 'first_name', autocomplete: 'given-name' }, 'ok'],
    [{ name: 'email', type: 'email' }, 'ok'],
  ];
  for (const [attrs, want] of kinds) {
    const el = h('input', attrs);
    assert.equal(F.classify(F.describe(el as never, null as never) as never), want, JSON.stringify(attrs));
  }
  const form = h('form', {}, [
    h('label', { for: 'fn' }, ['First name']),
    h('input', { id: 'fn', name: 'first_name' }),
    h('label', {}, ['Email ', h('input', { name: 'mail', type: 'email' })]),
    h('input', { name: 'password', type: 'password' }),
    h('input', { name: 'cardnumber', autocomplete: 'cc-number' }),
    sel({ name: 'state', 'aria-label': 'State' }, [['', 'Pick one'], ['TX', 'Texas'], ['CA', 'California']]),
    h('textarea', { name: 'notes', placeholder: 'Anything else?' }),
  ]);
  const d = doc(form);
  const listed = F.collect(d as never) as { fields: { ref: string; label: string; never?: boolean }[]; elements: FakeNode[] };
  assert.deepEqual(listed.fields.map((f) => [f.ref, f.label, Boolean(f.never)]), [
    ['f0', 'First name', false],
    ['f1', 'Email', false],
    ['f2', 'password', true],
    ['f3', 'cardnumber', true],
    ['f4', 'State', false],
    ['f5', 'Anything else?', false],
  ]);
  // Real pages give NodeLists (no .map): the readers only iterate childNodes.
  for (const f of ['extract.js', 'fields.js']) assert.ok(!/(?<!from)\(\w+\.childNodes \|\| \[\]\)\.(map|filter|forEach)\(|\.childNodes\.(map|filter|forEach)\(/.test(read('lib', f)), f);
  // Never fields go to the server with no value and no id beyond their label.
  assert.ok(!('value' in listed.fields[2]!));
  // Filling: only approved refs, never a password/card field even when told to, selects pick by text or value.
  const r = F.applyFills(listed.elements as never, [
    { ref: 'f0', value: 'Alex' },
    { ref: 'f2', value: 'hunter2' },
    { ref: 'f3', value: '4111' },
    { ref: 'f4', value: 'Texas' },
    { ref: 'f9', value: 'nowhere' },
  ] as never) as { filled: string[]; refused: string[] };
  assert.deepEqual(r.filled, ['f0', 'f4']);
  assert.deepEqual(r.refused.sort(), ['f2', 'f3', 'f9']);
  const els = listed.elements;
  assert.equal(els[0]!.value, 'Alex');
  assert.deepEqual(els[0]!.events, ['input', 'change']);
  assert.equal(els[2]!.value, '', 'the password field stays empty');
  assert.equal(els[3]!.value, '');
  assert.equal(els[4]!.value, 'TX');
});

// ------------------------------------------------------------------ common (popup + background)
test('common: server address, per-site off switch, the ask body is capped and goes only to the paired server', async () => {
  const C = await import(pathToFileURL(join(EXT, 'lib', 'common.js')).href);
  assert.equal(C.normalizeServer(' sara.example.com/chat '), 'https://sara.example.com');
  assert.equal(C.normalizeServer('http://127.0.0.1:7860/'), 'http://127.0.0.1:7860');
  assert.equal(C.normalizeServer('ftp://x'), '');
  assert.equal(C.normalizeServer('javascript:alert(1)'), '');
  assert.equal(C.originPattern('https://sara.example.com'), 'https://sara.example.com/*');
  assert.equal(C.siteKey('https://www.Shop.example/a?b'), 'shop.example');
  assert.equal(C.siteKey('chrome://settings'), '');
  const off = C.toggleSite([], 'https://news.example/x', true);
  assert.deepEqual(off, ['news.example']);
  assert.equal(C.isOff(off, 'https://www.news.example/y'), true);
  assert.equal(C.isOff(off, 'https://other.example/'), false);
  assert.deepEqual(C.toggleSite(off, 'https://news.example/z', false), []);
  assert.equal(C.pageAllowed('chrome://extensions'), false);
  assert.equal(C.pageAllowed('https://a.example'), true);
  const body = C.askBody({ mode: 'ask', question: 'q'.repeat(5000), url: 'https://a.example/p', title: 't'.repeat(900), selection: 's'.repeat(9000), text: 'x'.repeat(50000) });
  assert.equal(body.question.length, 2000);
  assert.equal(body.title.length, 200);
  assert.equal(body.selection.length, 4000);
  assert.equal(body.text.length, 20000);
  // Requests carry the device token, no cookies, and only ever go to the paired server.
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const conf = { server: 'https://sara.example.com', token: ['sara', 'dev', 'fake'].join('_') };
  assert.deepEqual(await C.saraCall(conf, '/api/ext/state', undefined, fakeFetch), { ok: true });
  assert.equal(seen[0]!.url, 'https://sara.example.com/api/ext/state');
  assert.equal(seen[0]!.init.credentials, 'omit');
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, `Bearer ${conf.token}`);
  await assert.rejects(C.saraCall(conf, 'https://evil.example/api', undefined, fakeFetch), /paired/);
  await assert.rejects(C.saraCall({ server: '', token: '' }, '/api/ext/state', undefined, fakeFetch), /paired/);
});

// ------------------------------------------------------------------ manifests, locales, no remote code
test('manifest (MV3, least permissions), locales in six languages, no remote code or other hosts', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.default_locale, 'en');
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'storage']);
  assert.equal(m.host_permissions, undefined, 'no page access up front');
  assert.deepEqual(m.optional_host_permissions, ['http://*/*', 'https://*/*'], 'only the Sara server, asked at pairing');
  assert.equal(m.background.service_worker, 'background.js');
  assert.equal(m.action.default_popup, 'popup.html');
  assert.equal(m.content_scripts, undefined, 'nothing runs on pages until you click');
  const en = JSON.parse(read('_locales', 'en', 'messages.json'));
  const keys = Object.keys(en).sort();
  assert.ok(keys.length > 30);
  for (const loc of ['es', 'fr', 'de', 'pt_BR', 'it']) {
    const tr = JSON.parse(read('_locales', loc, 'messages.json'));
    assert.deepEqual(Object.keys(tr).sort(), keys, loc);
    if (loc === 'pt_BR') assert.ok(keys.filter((k) => tr[k].message === en[k].message && /[a-z]{4}/.test(en[k].message)).length <= 3, 'pt-BR is translated');
  }
  // Every t('key') in the extension exists in English.
  const used = new Set<string>();
  for (const f of readdirSync(EXT, { recursive: true }) as string[]) {
    if (!/\.(js|html)$/.test(f)) continue;
    const src = read(f);
    for (const x of src.matchAll(/\bt\('([a-zA-Z0-9_]+)'/g)) used.add(x[1]!);
    for (const x of src.matchAll(/data-t="([a-zA-Z0-9_]+)"/g)) used.add(x[1]!);
    assert.ok(!/<script[^>]+src="https?:/.test(src), `${f}: no remote scripts`);
    assert.ok(!/\beval\(|new Function\(/.test(src), `${f}: no eval`);
    // The only network call goes through saraCall (to the paired server).
    if (f !== join('lib', 'common.js')) assert.ok(!/\bfetch\(/.test(src), `${f}: fetch only in lib/common.js`);
  }
  for (const k of used) assert.ok(k in en, `missing locale key ${k}`);
});

test('packaging: Chrome/Edge and Firefox zips, never published; install steps in docs/EXTENSION.md', async () => {
  const { buildManifest, packFiles } = await import(pathToFileURL(join(ROOT, 'scripts', 'pack-extension.ts')).href);
  const base = JSON.parse(read('manifest.json'));
  const ff = buildManifest(base, 'firefox');
  assert.deepEqual(ff.background, { scripts: ['background.js'], type: 'module' });
  assert.match(ff.browser_specific_settings.gecko.id, /@/);
  assert.equal(buildManifest(base, 'chrome').background.service_worker, 'background.js');
  const files = packFiles('chrome') as { path: string }[];
  assert.ok(files.some((f) => f.path === 'manifest.json'));
  assert.ok(files.some((f) => f.path === '_locales/de/messages.json'));
  assert.ok(!files.some((f) => /\.test\.|README/.test(f.path)));
  const doc = readFileSync(join(ROOT, 'docs', 'EXTENSION.md'), 'utf8');
  for (const w of ['Load unpacked', 'about:debugging', 'outputs/extension', 'not published', 'Devices and sign-in']) assert.ok(doc.includes(w), w);
  assert.ok(existsSync(join(ROOT, 'scripts', 'pack-extension.ts')));
});
