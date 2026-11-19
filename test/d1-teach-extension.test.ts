// D1 (docs/design/D1TEACH.md): "Watch me do this" in the browser extension, without a browser. A tiny
// DOM made here stands in for the page: the recorder turns clicks, typing and picks into steps, never
// reads or keeps a password / card / code value, keeps no query strings, and the steps replay on a
// second (fresh) copy of the page by id, name, label or visible text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const EXT = join(ROOT, 'extension');
const read = (...p: string[]) => readFileSync(join(EXT, ...p), 'utf8');

interface FakeNode {
  nodeType: number;
  nodeValue?: string;
  tagName?: string;
  childNodes: FakeNode[];
  parentNode?: FakeNode;
  attrs?: Record<string, string>;
  type?: string;
  disabled?: boolean;
  readOnly?: boolean;
  options?: { value: string; text: string; selected?: boolean }[];
  events?: string[];
  valueReads?: number;
  value?: string;
  getAttribute?: (n: string) => string | null;
  dispatchEvent?: (e: { type: string }) => boolean;
  click?: () => void;
}
function h(tag: string, attrs: Record<string, string> = {}, kids: (FakeNode | string)[] = []): FakeNode {
  const el: FakeNode = { nodeType: 1, tagName: tag.toUpperCase(), childNodes: [], attrs, events: [], valueReads: 0 };
  el.getAttribute = (n) => (n in attrs ? attrs[n]! : null);
  el.dispatchEvent = (e) => (el.events!.push(e.type), true);
  el.click = () => el.events!.push('click');
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    el.type = tag === 'input' ? (attrs.type ?? 'text').toLowerCase() : tag;
    let v = attrs.value ?? '';
    // Counts every read of .value: a never field must not be read at all.
    Object.defineProperty(el, 'value', { get: () => (el.valueReads!++, v), set: (x: string) => (v = x), enumerable: true });
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
function doc(body: FakeNode) {
  const listeners: Record<string, ((e: { target: FakeNode }) => void)[]> = {};
  return {
    body,
    documentElement: body,
    addEventListener: (type: string, fn: (e: { target: FakeNode }) => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: (e: { target: FakeNode }) => void) => (listeners[type] = (listeners[type] ?? []).filter((x) => x !== fn)),
    fire: (type: string, target: FakeNode) => (listeners[type] ?? []).forEach((fn) => fn({ target })),
    count: (type: string) => (listeners[type] ?? []).length,
  };
}
// A fake shop: search, a size pick, a quantity, a gift checkbox, an account password and a card number.
function shop() {
  const search = h('input', { id: 'q', name: 'q', placeholder: 'Search the shop' });
  const go = h('button', { type: 'submit', id: 'search-go' }, ['Search']);
  const size = sel({ name: 'size', 'aria-label': 'Size' }, [['', 'Pick one'], ['s', 'Small'], ['m', 'Medium']]);
  const qty = h('input', { name: 'qty', 'aria-label': 'How many', type: 'number' });
  const gift = h('input', { type: 'checkbox', id: 'gift', name: 'gift' });
  const pw = h('input', { type: 'password', name: 'pw', 'aria-label': 'Password' });
  const card = h('input', { name: 'cardnumber', autocomplete: 'cc-number', 'aria-label': 'Card number' });
  const csrf = h('input', { type: 'hidden', name: 'csrf', value: 'x' });
  const span = h('span', {}, ['Add to cart']);
  const add = h('button', { class: 'buy' }, [span]);
  const body = h('body', {}, [
    h('form', { id: 'find' }, [search, go]),
    h('main', {}, [h('h1', {}, ['Blue mug']), h('label', { for: 'gift' }, ['Gift wrap']), gift, size, qty, add]),
    h('form', { id: 'account' }, [pw, card, csrf]),
    h('a', { href: '/cart?session=abc#top' }, ['Cart']),
  ]);
  return { body, search, go, size, qty, gift, pw, card, csrf, add, span };
}

const load = async () => {
  await import(pathToFileURL(join(EXT, 'lib', 'fields.js')).href);
  await import(pathToFileURL(join(EXT, 'lib', 'teach.js')).href);
  return (globalThis as Record<string, unknown>).SaraTeach as Record<string, (...a: unknown[]) => unknown> & { MAX_STEPS: number };
};

test('recorder: clicks, typing and picks become steps; the page address has no query or hash', async () => {
  const T = await load();
  const p = shop();
  const d = doc(p.body);
  const steps: Record<string, unknown>[] = [];
  const emit = (s: Record<string, unknown>) => T.addStep(steps, s);
  assert.equal(T.start(d, emit, { href: 'https://shop.example/find?token=SECRET123#x' }), true);
  assert.equal(T.start(d, emit, { href: 'https://shop.example/' }), false, 'once per page');
  p.search.value = 'blue mug';
  d.fire('change', p.search);
  p.search.value = 'blue mugs';
  d.fire('change', p.search); // the same field again: the last value only
  d.fire('click', p.search); // a click into a text field is no step
  d.fire('click', p.go);
  p.size.options![2]!.selected = true;
  p.size.value = 'm';
  d.fire('change', p.size);
  p.qty.value = '2';
  d.fire('change', p.qty);
  d.fire('click', p.gift);
  d.fire('change', p.gift); // a checkbox's change is its click
  d.fire('click', p.span); // a click inside a button is the button
  d.fire('click', p.body); // nothing
  const kinds = steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['go', 'type', 'click', 'pick', 'type', 'click', 'click']);
  assert.deepEqual(steps[0], { kind: 'go', url: 'https://shop.example/find' });
  assert.equal(steps[1]!.value, 'blue mugs');
  assert.deepEqual(steps[1]!.target, { tag: 'input', type: 'text', id: 'q', name: 'q', label: 'Search the shop', path: '#q' });
  assert.equal((steps[2]!.target as Record<string, string>).text, 'Search');
  assert.equal(steps[3]!.value, 'Medium');
  assert.equal((steps[5]!.target as Record<string, string>).label, 'Gift wrap');
  assert.equal((steps[6]!.target as Record<string, string>).text, 'Add to cart');
  assert.equal((steps[6]!.target as Record<string, string>).tag, 'button');
  // A link keeps its address without the query.
  const link = T.clickStep(p.body.childNodes[3], T.labelsOf(d)) as { target: { href: string } };
  assert.equal(link.target.href, '/cart');
  assert.equal(T.stop(), true);
  assert.equal(d.count('click') + d.count('change'), 0, 'stop removes the listeners');
  assert.equal(T.stop(), false);
});

test('recorder: password, card and code fields give a "you type this" step; their value is never read', async () => {
  const T = await load();
  const p = shop();
  const d = doc(p.body);
  const steps: Record<string, unknown>[] = [];
  T.start(d, (s: Record<string, unknown>) => T.addStep(steps, s), { href: 'https://shop.example/account' });
  p.pw.value = 'hunter2-Secret!';
  p.card.value = '4111 1111 1111 1111';
  p.pw.valueReads = 0;
  p.card.valueReads = 0;
  d.fire('change', p.pw);
  d.fire('change', p.card);
  d.fire('click', p.pw);
  d.fire('change', p.csrf); // hidden: ignored
  T.stop();
  assert.equal(p.pw.valueReads, 0, 'the password was never read');
  assert.equal(p.card.valueReads, 0, 'the card number was never read');
  const secret = steps.filter((s) => s.kind === 'type');
  assert.equal(secret.length, 2);
  for (const s of secret) {
    assert.equal(s.secret, true);
    assert.equal('value' in s, false);
  }
  const all = JSON.stringify(steps);
  for (const bad of ['hunter2', '4111', 'csrf']) assert.ok(!all.includes(bad), bad);
  // A long digit run typed into an ordinary field is kept as a secret step too.
  const other = h('input', { name: 'ref', 'aria-label': 'Reference' });
  other.value = '1234 5678 9012 3456';
  assert.deepEqual(T.changeStep(other, new Map()), { kind: 'type', target: { tag: 'input', type: 'text', name: 'ref', label: 'Reference', path: 'input' }, secret: true });
});

test('recorder: steps are capped; the same page twice in a row is one step', async () => {
  const T = await load();
  const steps: Record<string, unknown>[] = [];
  T.addStep(steps, { kind: 'go', url: 'https://a.example/' });
  T.addStep(steps, { kind: 'go', url: 'https://a.example/' });
  assert.equal(steps.length, 1);
  for (let i = 0; i < 100; i++) T.addStep(steps, { kind: 'click', target: { tag: 'button', path: `b${i}` } });
  assert.equal(steps.length, T.MAX_STEPS);
  assert.equal(T.goStep('file:///C:/x.html'), null);
  assert.equal(T.goStep('chrome://settings'), null);
});

test('replay: the recorded flow runs on a fresh copy of the page; secret steps are left for you', async () => {
  const T = await load();
  const first = shop();
  const d1 = doc(first.body);
  const steps: Record<string, unknown>[] = [];
  T.start(d1, (s: Record<string, unknown>) => T.addStep(steps, s), { href: 'https://shop.example/' });
  first.search.value = 'blue mug';
  d1.fire('change', first.search);
  d1.fire('click', first.go);
  first.size.options![1]!.selected = true;
  d1.fire('change', first.size);
  first.pw.value = 'never-this';
  d1.fire('change', first.pw);
  d1.fire('click', first.add);
  T.stop();
  // A fresh page (other element objects, the buy button lost its class): found by id, label, text.
  const again = shop();
  const d2 = doc(again.body);
  const r = (await T.replay(d2, steps, { delay: 0 })) as { done: number[]; needsYou: string[]; missing: number[] };
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.needsYou, ['Password']);
  assert.equal(r.done.length, 4);
  assert.equal(again.search.value, 'blue mug');
  assert.deepEqual(again.search.events, ['input', 'change']);
  assert.deepEqual(again.go.events, ['click']);
  assert.equal(again.size.value, 's');
  assert.deepEqual(again.add.events, ['click']);
  assert.equal(again.pw.value, '', 'the password is never typed');
  assert.deepEqual(again.pw.events, []);
  // Another value for the search step.
  const third = shop();
  await T.replay(doc(third.body), steps, { delay: 0, values: { 1: 'red mug' } });
  assert.equal(third.search.value, 'red mug');
  // A page without the button: the run stops there and says which step.
  const bare = h('body', {}, [h('input', { id: 'q', name: 'q', placeholder: 'Search the shop' })]);
  const r2 = (await T.replay(doc(bare), steps, { delay: 0 })) as { done: number[]; missing: number[] };
  assert.deepEqual(r2.done, [1]);
  assert.deepEqual(r2.missing, [2]);
  // A step aimed at a field that is now a password field is never typed into.
  const sneaky = h('body', {}, [h('input', { id: 'q', name: 'q', type: 'password', placeholder: 'Search the shop' })]);
  const r3 = (await T.replay(doc(sneaky), [{ kind: 'type', target: { tag: 'input', id: 'q', name: 'q', label: 'Search the shop' }, value: 'x' }], { delay: 0 })) as { done: number[]; needsYou: string[] };
  assert.deepEqual(r3.done, []);
  assert.equal(r3.needsYou.length, 1);
});

test('popup, worker and locales: Watch me do this is wired with its own strings in six languages', () => {
  const html = read('popup.html');
  for (const id of ['teach', 'teach-stop', 'teach-card', 'teach-list', 'teach-name', 'teach-why', 'teach-send', 'teach-replay', 'teach-discard']) assert.ok(html.includes(`id="${id}"`), id);
  const popup = read('popup.js');
  assert.match(popup, /lib\/teach\.js/);
  assert.match(popup, /\/api\/ext\/teach/);
  const bg = read('background.js');
  assert.match(bg, /saraTeach/);
  assert.match(bg, /setBadgeText/);
  const en = JSON.parse(read('_locales', 'en', 'messages.json')) as Record<string, { message: string }>;
  for (const k of ['teach', 'teachStop', 'teachRecording', 'teachTitle', 'teachHow', 'teachSecret', 'teachSend', 'teachReplay', 'teachDiscard', 'teachSent', 'teachReplayed', 'teachReplayedYou', 'teachNameLabel', 'teachWhyLabel', 'teachEmpty']) assert.ok(en[k]?.message, k);
  for (const loc of ['de', 'es', 'fr', 'it', 'pt_BR']) {
    const tr = JSON.parse(read('_locales', loc, 'messages.json')) as Record<string, { message: string }>;
    for (const k of ['teach', 'teachSecret', 'teachSend']) assert.notEqual(tr[k]?.message, en[k]!.message, `${loc} ${k}`);
  }
  // Still the same least permissions.
  const m = JSON.parse(read('manifest.json')) as { permissions: string[] };
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'storage']);
});
