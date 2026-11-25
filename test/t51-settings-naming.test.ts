// D7: the pass that puts her name and the app language into the page's own words leaves the closed
// Settings window for later: it is named when it opens, or when the command bar reads it. Behaviour
// test on a small stand-in page (web/naming.js as it is served).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, tempDir } from './helpers.ts';

type Filter = { acceptNode: (n: Nd) => number };
type Nd = El | Tx;

class Tx {
  nodeType = 3;
  nodeValue: string;
  parentElement: El | null = null;
  constructor(v: string) {
    this.nodeValue = v;
  }
}

class El {
  nodeType = 1;
  localName: string;
  attrs = new Map<string, string>();
  children: Nd[] = [];
  parentElement: El | null = null;
  constructor(tag: string, attrs: Record<string, string> = {}, kids: (Nd | string)[] = []) {
    this.localName = tag;
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    for (const k of kids) this.append(typeof k === 'string' ? new Tx(k) : k);
  }
  append(n: Nd) {
    n.parentElement = this;
    this.children.push(n);
  }
  get open() {
    return this.attrs.has('open');
  }
  hasAttribute(a: string) {
    return this.attrs.has(a);
  }
  getAttribute(a: string) {
    return this.attrs.get(a) ?? null;
  }
  setAttribute(a: string, v: string) {
    this.attrs.set(a, v);
  }
  /** Enough of CSS for naming.js: `#id`, `.class`, `tag` and `[attr]`; anything longer never matches. */
  matches(sel: string): boolean {
    return sel.split(',').some((s) => {
      s = s.trim();
      if (/[\s>]/.test(s)) return false;
      if (s.startsWith('#')) return this.attrs.get('id') === s.slice(1);
      if (s.startsWith('.')) return (this.attrs.get('class') ?? '').split(' ').includes(s.slice(1));
      if (/^\[[\w-]+\]$/.test(s)) return this.attrs.has(s.slice(1, -1));
      return this.localName === s;
    });
  }
  closest(sel: string): El | null {
    for (let e: El | null = this; e; e = e.parentElement) if (e.matches(sel)) return e;
    return null;
  }
  get text(): string {
    return this.children.map((c) => (c instanceof Tx ? c.nodeValue : c.text)).join('');
  }
}

function walker(root: El, _what: number, filter?: Filter) {
  const list: Nd[] = [];
  const visit = (e: El) => {
    for (const c of e.children) {
      if (c instanceof El && filter?.acceptNode(c) === 2) continue;
      list.push(c);
      if (c instanceof El) visit(c);
    }
  };
  visit(root);
  let i = 0;
  return { nextNode: () => list[i++] ?? null };
}

type Naming = {
  setIdentity(i: { name: string; pronouns?: string }): void;
  setLanguage(code: string): Promise<string>;
  nameNow(root?: unknown): void;
};

async function page() {
  const settings = new El('dialog', { id: 'settings' }, [new El('label', {}, ["Sara's voice"]), new El('button', { title: 'Ask Sara' }, ['?'])]);
  const chat = new El('p', { id: 'hello' }, ['Ask Sara']);
  const body = new El('body', {}, [chat, settings]);
  let fire: ((records: unknown[]) => void) | null = null;
  const g = globalThis as Record<string, unknown>;
  g.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  g.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  g.MutationObserver = class {
    constructor(cb: (r: unknown[]) => void) {
      fire = cb;
    }
    observe() {}
    disconnect() {}
  };
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  const find = (e: El, sel: string): El | null => {
    for (const c of e.children) if (c instanceof El) {
      if (c.matches(sel)) return c;
      const d = find(c, sel);
      if (d) return d;
    }
    return null;
  };
  g.document = { documentElement: { lang: 'en' }, body, title: '', querySelector: (s: string) => find(body, s), createTreeWalker: walker };
  g.fetch = async () => new Response(JSON.stringify({ "Sara's voice": 'La voz de Sara', 'Ask Sara': 'Pregunta a Sara' }), { status: 200 });
  const src = readFileSync(join(ROOT, 'web', 'naming.js'), 'utf8').replace("'./identity.js'", JSON.stringify(pathToFileURL(join(ROOT, 'src', 'identity.ts')).href));
  const tmp = tempDir();
  const file = join(tmp.dir, 'naming.mjs');
  writeFileSync(file, src);
  try {
    const n = (await import(`${pathToFileURL(file).href}?${Math.random()}`)) as Naming;
    const open = (on: boolean) => {
      if (on) settings.setAttribute('open', '');
      else settings.attrs.delete('open');
      fire?.([{ type: 'attributes', attributeName: 'open', target: settings }]);
    };
    return { n, chat, settings, open };
  } finally {
    tmp.cleanup();
  }
}

test('t51: a closed Settings is named when it opens, not in the pass over the page', async () => {
  const { n, chat, settings, open } = await page();
  n.setIdentity({ name: 'Max', pronouns: 'he' });
  assert.equal(chat.text, 'Ask Max', 'the page outside Settings is named at once');
  assert.equal(settings.text, "Sara's voice?", 'closed Settings waits');
  open(true);
  assert.equal(settings.text, "Max's voice?");
  assert.equal((settings.children[1] as El).getAttribute('title'), 'Ask Max', 'attributes too');
  open(false);
  // A rename while it is closed: named again on the next open, and only then.
  n.setIdentity({ name: 'Leo', pronouns: 'he' });
  assert.equal(chat.text, 'Ask Leo');
  assert.equal(settings.text, "Max's voice?");
  open(true);
  assert.equal(settings.text, "Leo's voice?");
});

test('t51: nameNow names a closed Settings for readers (the command bar), once per pass', async () => {
  const { n, settings } = await page();
  n.setIdentity({ name: 'Max', pronouns: 'he' });
  n.nameNow();
  assert.equal(settings.text, "Max's voice?");
  // Already named: a second call leaves it alone (a hand-made change stays).
  (settings.children[0] as El).children[0] = Object.assign(new Tx('changed'), { parentElement: settings.children[0] as El });
  n.nameNow();
  assert.equal(settings.text, 'changed?');
  // A new language: the page now, Settings when read.
  const button = settings.children[1] as El;
  assert.equal(button.getAttribute('title'), 'Ask Max');
  await n.setLanguage('es');
  assert.equal(button.getAttribute('title'), 'Ask Max');
  n.nameNow();
  assert.equal(button.getAttribute('title'), 'Pregunta a Max');
});

test('t51: an open Settings is named with the page (a language picked in Settings)', async () => {
  const { n, chat, settings, open } = await page();
  open(true);
  await n.setLanguage('es');
  assert.equal(chat.text, 'Pregunta a Sara');
  assert.equal(settings.text, 'La voz de Sara?');
  // It counts as named for this pass: closing and opening again does not walk it again.
  (settings.children[0] as El).children[0] = Object.assign(new Tx('kept'), { parentElement: settings.children[0] as El });
  open(false);
  open(true);
  assert.equal(settings.text, 'kept?');
});

test('t51: Settings is named before it shows and before the command bar searches it', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /async function openSettings\(tab, opts = \{\}\) \{\n {2}nameNow\(\);/);
  assert.match(app, /searchSettings: \(q\) => \{\n {4}nameNow\(\);/);
});
