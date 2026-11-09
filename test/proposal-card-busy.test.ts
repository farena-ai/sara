// B1 (owner report 2026-11-06): a proposal card's buttons must show that a press was taken while the
// answer is on its way, and ignore further presses until it returns, so a busy Sara never makes the
// card look stuck or take a double press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

class FakeEl {
  tagName: string; className = ''; textContent = ''; type = ''; children: FakeEl[] = []; attrs = new Map<string, string>();
  handlers: (() => void)[] = [];
  classList = {
    add: (c: string) => { if (!this.className.split(' ').includes(c)) this.className = `${this.className} ${c}`.trim(); },
    remove: (c: string) => { this.className = this.className.split(' ').filter((x) => x && x !== c).join(' '); },
    contains: (c: string) => this.className.split(' ').includes(c),
  };
  constructor(tag: string) { this.tagName = tag; }
  append(...n: FakeEl[]) { this.children.push(...n); }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener(_e: string, f: () => void) { this.handlers.push(f); }
  click() { for (const f of this.handlers) f(); }
}
const g = globalThis as unknown as { document: unknown };
g.document = { createElement: (tag: string) => new FakeEl(tag) };

/** The card module in Node, with its naming.js import replaced by a small t() stand-in. */
async function loadCard(): Promise<{ proposalCard: (p: unknown) => unknown }> {
  const stub = "const t = (s, p = {}) => s.replace(/\\{(\\w+)\\}/g, (m, k) => (k in p ? String(p[k]) : m));";
  const src = readFileSync(join(ROOT, 'web', 'proposal-card.js'), 'utf8').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub);
  assert.ok(src.includes(stub), 'naming.js import replaced');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

const buttonsOf = (card: FakeEl) => card.children.find((c) => c.className === 'prop-buttons')!.children;

test('B1: a slow answer marks the card busy, labels the pressed button and ignores other presses until it returns', async () => {
  const { proposalCard } = await loadCard();
  let release!: () => void;
  const calls: string[] = [];
  const card = proposalCard({
    title: 'A goal to keep at together?',
    buttons: [
      { label: 'Use it', onClick: () => { calls.push('use'); return new Promise<void>((r) => (release = r)); } },
      { label: 'Not now', cls: 'ghost', onClick: () => { calls.push('not-now'); return Promise.resolve(); } },
    ],
  }) as unknown as FakeEl;
  const [use, notNow] = buttonsOf(card);
  use.click();
  assert.ok(card.classList.contains('prop-busy'));
  assert.equal(card.attrs.get('aria-busy'), 'true');
  assert.ok(use.classList.contains('prop-pressed'));
  assert.notEqual(use.textContent, 'Use it', 'the pressed button says it is working');
  use.click();
  notNow.click();
  assert.deepEqual(calls, ['use'], 'no double press while the answer is on its way');
  release();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!card.classList.contains('prop-busy'));
  assert.equal(card.attrs.has('aria-busy'), false);
  assert.equal(use.textContent, 'Use it', 'label restored (e.g. after a failure the card is usable again)');
  notNow.click();
  assert.deepEqual(calls, ['use', 'not-now']);
});

test('B1: a failing answer also restores the card', async () => {
  const { proposalCard } = await loadCard();
  const card = proposalCard({ title: 'x', buttons: [{ label: 'Install', onClick: () => Promise.reject(new Error('no')).catch(() => {}) }] }) as unknown as FakeEl;
  const [b] = buttonsOf(card);
  b.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!card.classList.contains('prop-busy'));
  assert.equal(b.textContent, 'Install');
});

test('B1: a plain (non-promise) button such as Edit first never locks the card', async () => {
  const { proposalCard } = await loadCard();
  let n = 0;
  const card = proposalCard({ title: 'x', buttons: [{ label: 'Edit first', onClick: () => void n++ }] }) as unknown as FakeEl;
  const [b] = buttonsOf(card);
  b.click(); b.click();
  assert.equal(n, 2);
  assert.ok(!card.classList.contains('prop-busy'));
});

test('B1: the goal card edited "Use it" goes through the same busy state, and the styling uses theme tokens', () => {
  const js = readFileSync(join(ROOT, 'web', 'agenda.js'), 'utf8');
  assert.match(js, /whileBusy\(card, useEdited, decide\('use'/);
  const css = readFileSync(join(ROOT, 'web', 'screens.css'), 'utf8');
  assert.match(css, /\.prop-card\.prop-busy button/);
  assert.match(css, /\.prop-card \.prop-pressed \{[^}]*var\(--accent\)/);
});
