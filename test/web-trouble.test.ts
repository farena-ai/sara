// 3.3.0 easy mode (ezfirst): the chat bubble and Today rows of her own trouble (web/trouble.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { slowBubble, troubleBubble, troubleText } = await import(new URL('../web/trouble.js', import.meta.url).href);

type Node = { tag: string; cls: string; text: string; kids: Node[]; dataset: Record<string, string>; type?: string; disabled?: boolean; textContent: string; on: Record<string, () => unknown>; append: (...k: (Node | string)[]) => void; addEventListener: (e: string, f: () => unknown) => void };
const el = (tag: string, cls = '', text = ''): Node => {
  const n: Node = { tag, cls, text, kids: [], dataset: {}, on: {}, get textContent() { return this.text; }, set textContent(v) { this.text = v; }, append: (...k) => void n.kids.push(...(k.filter((x) => typeof x !== 'string') as Node[])), addEventListener: (e, f) => void (n.on[e] = f) };
  return n;
};
const t = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(p[k] ?? ''));
const flat = (n: Node): Node[] => [n, ...n.kids.flatMap(flat)];

test('web trouble: the bubble has her words, one Fix it that opens the page, and Try again', async () => {
  const tr = { id: 'model:p', kind: 'unreachable', key: 'I can’t reach my AI service ({service}) right now.', params: { service: 'Ollama Cloud' }, text: 'x', fix: { label: 'Fix it', page: 'models-providers' }, retry: true };
  let opened = '';
  let tried = 0;
  const b = troubleBubble(tr, { el, t, onFix: (p: string) => (opened = p), onRetry: async () => void tried++, detail: "Couldn't reach Ollama Cloud at ollama.com." });
  const all = flat(b);
  assert.equal(all.find((n) => n.cls === 'trouble-text')?.text, 'I can’t reach my AI service (Ollama Cloud) right now.');
  const buttons = all.filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((x) => x.text), ['Fix it', 'Try again']);
  assert.equal(buttons.filter((x) => x.cls === 'small').length, 1, 'one main button');
  buttons[0].on.click();
  assert.equal(opened, 'models-providers');
  await buttons[1].on.click();
  assert.equal(tried, 1);
  assert.equal(buttons[1].text, 'Try again', 'back to Try again after the attempt');
  assert.ok(all.some((n) => n.tag === 'details'), 'the service words are folded away');
  // Not model trouble: no Try again.
  const mail = troubleBubble({ ...tr, kind: 'mail', retry: false, fix: { label: 'Sign in again', page: 'ab-mail' } }, { el, t, onFix: () => {}, onRetry: async () => {} });
  assert.deepEqual(flat(mail).filter((n) => n.tag === 'button').map((x) => x.text), ['Sign in again']);
  assert.equal(troubleText({ text: 'plain' }, t), 'plain');
});

test('web trouble: Today lists the notices first, with their fix', () => {
  const today = readFileSync(new URL('../web/today.js', import.meta.url), 'utf8');
  assert.match(today, /NEEDS_RANK = \['trouble', /, 'trouble ranks first in Needs you');
  assert.match(today, /troubleNeeds\(n\.trouble\)/);
  assert.match(today, /function renderTrouble\(d\)/, 'a banner first on Today');
  assert.match(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'), /id="td-trouble"/);
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(app, /ev\.trouble/, 'the chat shows the trouble bubble for a failed reply');
});

test('web trouble (3.4.5): a slow model: her words, Fix it (Which model does what), Keep waiting removes it, Stop stops', () => {
  const tr = { id: 'slow:srv', kind: 'slow', key: '{model} on {service} runs on the processor and is very slow for a chat this long. Fix it: pick a faster model.', params: { model: 'qwen3.5:4b', service: 'Ollama on the server' }, text: 'x', fix: { label: 'Fix it', page: 'models-routes' }, retry: false };
  let opened = '';
  let stopped = 0;
  const mk = () => {
    const b = slowBubble(tr, { el, t, onFix: (p: string) => (opened = p), onStop: () => void stopped++ }) as Node & { removed?: boolean; remove?: () => void };
    b.remove = () => void (b.removed = true);
    return b;
  };
  const b = mk();
  const all = flat(b);
  assert.equal(all.find((n) => n.cls === 'trouble-text')?.text, 'qwen3.5:4b on Ollama on the server runs on the processor and is very slow for a chat this long. Fix it: pick a faster model.');
  const buttons = all.filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((x) => x.text), ['Fix it', 'Keep waiting', 'Stop']);
  buttons[0].on.click();
  assert.equal(opened, 'models-routes');
  buttons[1].on.click();
  assert.equal(b.removed, true);
  assert.equal(stopped, 0);
  const b2 = mk();
  flat(b2).filter((n) => n.tag === 'button')[2].on.click();
  assert.equal(stopped, 1);
  assert.equal(b2.removed, true);
  assert.match(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), /ev\.type === 'slow'[\s\S]{0,300}slowBubble\(ev\.trouble/);
});
