// T56: a second look at her change against what was asked, once per coding turn (src/spec-review.ts).
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import type { ChatRequest, Provider, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import type { Receipt } from '../src/receipts.ts';
import { parseSpecReview, reviewMaterial, SPEC_REVIEW_PROMPT, SpecReview, specReviewNote } from '../src/spec-review.ts';
import { resetEditGuard } from '../src/tools/edit-guard.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { call, makeApp, tempDir, text, type TestApp } from './helpers.ts';

const R = (name: string, args: Record<string, unknown>, output = '', status: Receipt['status'] = 'ok'): Receipt => ({ name, status, args, output }) as Receipt;
const RECEIPTS = [
  R('read_file', { path: 'README.md' }, '1| Totals are rounded half up to the cent.\n2| Tax applies after the discount.'),
  R('read_file', { path: 'src/money.js' }, '1| export const roundCents = (x) => Math.floor(x);'),
  R('edit_file', { path: 'src/money.js', old_string: 'Math.floor(x)', new_string: 'Math.round(x)' }, 'Edited src/money.js (1 replacement).'),
  R('shell', { command: 'node --test' }, '[exit code 0]\n# pass 4'),
];

test('T56: the reviewer gets the request, the documents she read, her edits and the last test output', () => {
  const m = reviewMaterial('Fix the cart totals', RECEIPTS)!;
  assert.equal(m.edits, 1);
  assert.match(m.text, /## The request\nFix the cart totals/);
  assert.match(m.text, /--- README\.md\n1\| Totals are rounded half up/);
  assert.equal(m.text.includes('--- src/money.js\n1| export'), false, 'code she read is not a document');
  assert.match(m.text, /--- src\/money\.js \(replaced\)\n- Math\.floor\(x\)\n\+ Math\.round\(x\)/);
  assert.match(m.text, /## Last test output \(node --test\)\n\[exit code 0\]/);
  // Nothing changed: nothing to review.
  assert.equal(reviewMaterial('What does this do?', [RECEIPTS[0]!, RECEIPTS[1]!]), undefined);
  // A failed edit is not an edit.
  assert.equal(reviewMaterial('x', [R('edit_file', { path: 'a.js' }, 'old_string was not found', 'error')]), undefined);
});

test('T56: only well-formed ISSUE lines count; OK and chatter give nothing', () => {
  assert.deepEqual(parseSpecReview('OK'), []);
  assert.deepEqual(parseSpecReview('Looks good to me overall!'), []);
  assert.deepEqual(parseSpecReview('ISSUE: "rounded half up" | Math.round rounds -0.5 towards zero, not away from it'), [{ from: 'rounded half up', what: 'Math.round rounds -0.5 towards zero, not away from it' }]);
  assert.equal(parseSpecReview('1. ISSUE: "Tax applies after the discount" | tax is still taken from the subtotal\n- ISSUE: only one part\nISSUE: x | y').length, 1);
  assert.equal(parseSpecReview(Array.from({ length: 9 }, (_, i) => `ISSUE: "rule number ${i}" | the code does not do rule ${i}`).join('\n')).length, 6);
  const note = specReviewNote([{ from: 'rounded half up', what: 'it rounds down' }], 'review-model', 'Alex');
  assert.match(note, /^\[Note from the app, not from Alex: before you finish, review-model read your change/);
  assert.match(note, /A reviewer can be wrong\./);
  assert.match(SPEC_REVIEW_PROMPT, /Only report what you can point to/);
});

test('T56: one review a turn; none in a goal round, without a step left, or for a private chat with no model at home', async (t) => {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation({ title: 'x', mode: 'coding' });
  let calls = 0;
  const base = { request: 'Fix the cart totals', receipts: RECEIPTS, ownerName: 'Alex', route: [], canStep: true, goalOrLoop: false, call: async () => (calls++, 'ISSUE: "rounded half up" | the code rounds half to even for negative values') };
  const sr = new SpecReview();
  const found = await sr.run(app, conv, base);
  assert.equal(found?.issues.length, 1);
  assert.equal(await sr.run(app, conv, base), undefined, 'once a turn');
  assert.equal(calls, 1);
  assert.equal(await new SpecReview().run(app, conv, { ...base, goalOrLoop: true }), undefined);
  assert.equal(await new SpecReview().run(app, conv, { ...base, canStep: false }), undefined);
  assert.equal(await new SpecReview().run(app, conv, { ...base, call: async () => 'OK' }), undefined, 'a clean review adds no step');
  assert.equal(await new SpecReview().run(app, conv, { ...base, call: async () => Promise.reject(new Error('down')) }), undefined, 'a failed review never holds the reply');
  const { call: _c, ...noCall } = base;
  assert.equal(await new SpecReview().run(app, { ...conv, private: true }, noCall), undefined);
});

test('T56: in a coding turn the review finds a gap, she gets it once, fixes it, and the turn ends', async (t) => {
  resetEditGuard();
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-27T12:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.codeReview = true;
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: '2026-11-01T00:00:00Z', toolPermissions: { shell: 'auto' }, precise: { checks: { review: true } } } as never);
  const conv = app.store.createConversation({ title: 'x', mode: 'coding', workspace: 'proj' });
  const w = workspaceDir(dir, 'proj');
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, 'README.md'), 'Totals are rounded half up to the cent.\n');
  writeFileSync(join(w, 'money.js'), 'export const roundCents = (x) => Math.floor(x);\n');
  const notes: string[] = [];
  const reviews: string[] = [];
  let n = 0;
  const script = (req: ChatRequest): StreamEvent[] => {
    const sys = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    if (sys.includes('You review a code change against what was asked')) {
      reviews.push(String(req.messages.at(-1)!.content));
      return text('ISSUE: "rounded half up" | Math.trunc drops the half instead of rounding it up');
    }
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    if (lastUser && /\[Note from the app/.test(lastUser.content)) notes.push(lastUser.content);
    n++;
    if (n === 1) return [call('r1', 'read_file', { path: 'README.md' })];
    if (n === 2) return [call('e1', 'edit_file', { path: 'money.js', old_string: 'Math.floor(x)', new_string: 'Math.trunc(x)' })];
    if (n === 3) return text('I changed the rounding.');
    if (n === 4) return [call('e2', 'edit_file', { path: 'money.js', old_string: 'Math.trunc(x)', new_string: 'Math.round(x)' })];
    return text('The reviewer was right: it now rounds half up.');
  };
  app.providerFactory = (config: ProviderConfig): Provider => ({
    config,
    listModels: async () => ['m'],
    async *stream(req: ChatRequest) {
      yield* script(req);
    },
  });
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'Fix the rounding of totals')) evs.push(ev);
  assert.equal(reviews.length, 1, 'reviewed once, not again after her fix');
  assert.match(reviews[0]!, /--- README\.md/);
  assert.match(reviews[0]!, /\+ Math\.trunc\(x\)/);
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /read your change against the request and found one possible gap/);
  assert.ok(evs.some((e) => e.type === 'notice' && e.kind === 'lookup' && /reviewed the change/.test(e.text)));
  assert.equal(n, 5);
  // Switched off in the settings: no review call.
  app.settings.update({ precise: { checks: { review: false } } } as never);
  n = 1;
  reviews.length = 0;
  for await (const _ of runTurn(app, conv.id, 'Again')) void _;
  assert.equal(reviews.length, 0);
});
