// D1 (docs/design/D1TEACH.md): teach by showing, Sara's side. The extension sends the steps you showed
// it; the server checks them again (no password, card, code or ID value is ever kept, no query
// strings, capped), keeps them per space, writes a skill draft and, on your OK, saves the skill or an
// automation draft that stays switched off until you set it up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { automationsFor } from '../src/automations.ts';
import { createSaraServer } from '../src/server.ts';
import { SkillStore } from '../src/skill-store.ts';
import { SKILL_NAME_RE } from '../src/skills.ts';
import { automationDraftOf, cleanTeaching, skillDraftOf, TaughtStore, TEACH } from '../src/teach.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const EXT_ID = Array.from({ length: 32 }, (_, i) => String.fromCharCode(97 + ((i * 5) % 16))).join('');
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
// A made-up card number and password, built at run time.
const CARD = ['4111', '1111', '1111', '1111'].join(' ');
const PASS = ['hunter', '2', '-', 'Secret'].join('');

const shopSteps = () => [
  { kind: 'go', url: 'https://shop.example/find?session=abc#top' },
  { kind: 'type', target: { tag: 'input', id: 'q', name: 'q', label: 'Search the shop', path: '#q' }, value: 'blue mug' },
  { kind: 'click', target: { tag: 'button', id: 'search-go', text: 'Search', path: '#search-go' } },
  { kind: 'pick', target: { tag: 'select', name: 'size', label: 'Size', path: 'main > select' }, value: 'Medium' },
  // The extension marked it; the server drops the value anyway.
  { kind: 'type', target: { tag: 'input', type: 'password', name: 'pw', label: 'Password' }, secret: true, value: PASS },
  // Not marked (an old or broken extension): the label says card, so no value is kept.
  { kind: 'type', target: { tag: 'input', name: 'cardnumber', label: 'Card number' }, value: CARD },
  { kind: 'type', target: { tag: 'input', name: 'otp', label: 'Verification code' }, value: '123456' },
  { kind: 'type', target: { tag: 'input', name: 'ref', label: 'Order note' }, value: `ref 5555 4444 3333 2222` },
  { kind: 'click', target: { tag: 'a', text: 'Cart\u0007', href: '/cart?token=zzz' } },
  { kind: 'jump', target: { tag: 'div' } },
];

test('cleaning: no secret value survives, addresses lose their query, odd steps are dropped, capped', () => {
  const t = cleanTeaching({ name: 'Order a mug', why: 'When I want another mug', title: 'Mug shop', url: 'https://shop.example/find?x=1', steps: shopSteps() });
  const kinds = t.steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['go', 'type', 'click', 'pick', 'type', 'type', 'type', 'type', 'click']);
  assert.equal(t.steps[0]!.url, 'https://shop.example/find');
  assert.equal(t.startUrl, 'https://shop.example/find');
  for (const i of [4, 5, 6, 7]) {
    assert.equal(t.steps[i]!.secret, true, `step ${i}`);
    assert.equal(t.steps[i]!.value, undefined, `step ${i}`);
  }
  assert.equal(t.steps[8]!.target!.href, '/cart');
  assert.equal(t.steps[8]!.target!.text, 'Cart');
  const all = JSON.stringify(t);
  for (const bad of [PASS, '4111', '123456', '5555', 'session=abc', 'token=zzz']) assert.ok(!all.includes(bad), bad);
  // Only web pages; a step list is needed; long lists are capped.
  assert.equal(cleanTeaching({ steps: [{ kind: 'go', url: 'file:///C:/x' }] }).steps.length, 0);
  const many = Array.from({ length: 200 }, (_, i) => ({ kind: 'click', target: { tag: 'button', text: `B${i}` } }));
  assert.equal(cleanTeaching({ steps: many }).steps.length, TEACH.maxSteps);
  assert.equal(cleanTeaching({ name: 'x'.repeat(500), steps: many }).name.length, 80);
});

test('drafts: a valid skill with numbered steps in words, secrets left to the person; an automation that follows it', () => {
  const t = cleanTeaching({ name: 'Order a mug', why: 'When I want another mug', steps: shopSteps() });
  const d = skillDraftOf(t);
  assert.match(d.name, SKILL_NAME_RE);
  assert.equal(d.name, 'order-a-mug');
  assert.match(d.description, /mug/i);
  assert.ok(d.description.length <= 1024);
  assert.match(d.body, /1\. Open https:\/\/shop\.example\/find/);
  assert.match(d.body, /Type “blue mug” into “Search the shop”/);
  assert.match(d.body, /Click “Search”/);
  assert.match(d.body, /Pick “Medium” in “Size”/);
  assert.match(d.body, /“Password”: ask the person to type it/);
  assert.match(d.body, /browser_open/);
  assert.ok(!d.body.includes(PASS) && !d.body.includes('4111'));
  const a = automationDraftOf(t, 'order-a-mug');
  assert.equal(a.trigger.kind, 'schedule');
  assert.equal(a.actions[0]!.kind, 'task');
  assert.match(a.actions[0]!.prompt!, /order-a-mug/);
  // No name and no why: still a draft.
  const bare = skillDraftOf(cleanTeaching({ title: 'Página de compras', steps: [{ kind: 'click', target: { tag: 'button', text: 'Comprar' } }] }));
  assert.match(bare.name, SKILL_NAME_RE);
  assert.ok(bare.description.length > 10);
});

test('the store: newest first, at most 20, per space file', () => {
  const { dir, cleanup } = tempDir();
  try {
    const s = new TaughtStore(dir, () => new Date('2026-11-18T12:00:00Z'));
    for (let i = 0; i < 25; i++) s.add(cleanTeaching({ name: `T${i}`, steps: [{ kind: 'click', target: { tag: 'button', text: 'Go' } }] }), 'dev');
    const list = s.list();
    assert.equal(list.length, TEACH.keep);
    assert.equal(list[0]!.name, 'T24');
    assert.ok(s.get(list[0]!.id));
    assert.equal(s.remove(list[0]!.id), true);
    assert.equal(new TaughtStore(dir).list().length, TEACH.keep - 1, 'kept on disk');
  } finally {
    cleanup();
  }
});

// ------------------------------------------------------------------ over HTTP
const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-18T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() } as never);
app.skills = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), now: () => clock.now });
const auth = new OwnerAuth(dir, () => clock.now);
const ownerToken = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const json = { 'content-type': 'application/json' };
const ext = (tok: string, body?: unknown, path = '/api/ext/state') =>
  fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...json, origin: EXT_ORIGIN, authorization: `Bearer ${tok}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
let session = '';
async function owner(path: string, method = 'GET', body?: unknown): Promise<Response> {
  if (!session) {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { ...json, origin: base }, body: JSON.stringify({ token: ownerToken }) });
    session = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  }
  return fetch(`${base}${path}`, { method, headers: { ...json, origin: base, cookie: session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function pair(): Promise<string> {
  const s = await fetch(`${base}/api/device/start`, { method: 'POST', headers: { ...json, origin: EXT_ORIGIN }, body: JSON.stringify({ name: 'Sara for Chrome', scope: 'extension' }) });
  const start = (await s.json()) as { code: string; pollToken: string };
  assert.equal((await owner('/api/device/approve', 'POST', { code: start.code, token: ownerToken })).status, 200);
  const p = await fetch(`${base}/api/device/poll`, { method: 'POST', headers: { ...json, origin: EXT_ORIGIN }, body: JSON.stringify({ pollToken: start.pollToken }) });
  return ((await p.json()) as { token: string }).token;
}

test('from the extension to a saved skill and a switched-off automation; secrets never reach the server files', async () => {
  const token = await pair();
  const st = (await (await ext(token)).json()) as { teach: boolean };
  assert.equal(st.teach, true);
  const r = await ext(token, { name: 'Order a mug', why: 'When I want another mug', title: 'Mug shop', url: 'https://shop.example/find', steps: shopSteps() }, '/api/ext/teach');
  assert.equal(r.status, 200, await r.clone().text());
  const sent = (await r.json()) as { id: string; name: string; url: string };
  assert.equal(sent.name, 'Order a mug');
  assert.match(sent.url, /#view=settings:ab-skills$/);
  // Nothing secret on disk, anywhere in the space's file.
  const disk = readFileSync(join(dir, 'taught.json'), 'utf8');
  for (const bad of [PASS, '4111', '123456', 'session=abc']) assert.ok(!disk.includes(bad), bad);
  // The extension token sees no list; the owner does, with a draft.
  assert.equal((await ext(token, undefined, '/api/skills/taught')).status, 403);
  const list = (await (await owner('/api/skills/taught')).json()) as { taught: { id: string; name: string; steps: unknown[]; draft: { name: string; body: string } }[] };
  assert.equal(list.taught.length, 1);
  assert.equal(list.taught[0]!.draft.name, 'order-a-mug');
  // Save it as a skill, with the person's edits.
  const sv = await owner(`/api/skills/taught/${sent.id}`, 'POST', { action: 'skill', draft: { ...list.taught[0]!.draft, description: 'Orders another mug from the mug shop. Use when Alex asks for a mug.' } });
  assert.equal(sv.status, 200, await sv.clone().text());
  const saved = (await sv.json()) as { skill: { scope: string; name: string } };
  assert.equal(saved.skill.name, 'order-a-mug');
  const skill = app.skills!.list().find((s) => s.name === 'order-a-mug');
  assert.ok(skill);
  assert.match(skill!.description, /Alex asks/);
  // Still listed (saved), then an automation draft: created switched off, following the skill.
  const again = (await (await owner('/api/skills/taught')).json()) as { taught: { skillName?: string }[] };
  assert.equal(again.taught[0]!.skillName, 'order-a-mug');
  const au = await owner(`/api/skills/taught/${sent.id}`, 'POST', { action: 'automation' });
  assert.equal(au.status, 200, await au.clone().text());
  const made = (await au.json()) as { automation: { id: number; name: string } };
  const a = automationsFor(app).get(made.automation.id)!;
  assert.equal(a.enabled, false, 'you switch it on yourself');
  assert.match(a.actions[0]!.prompt!, /order-a-mug/);
  // Done: it leaves the list.
  assert.equal(((await (await owner('/api/skills/taught')).json()) as { taught: unknown[] }).taught.length, 0);
});

test('an automation straight away also keeps the skill; discard removes; unknown ids and bad actions refuse', async () => {
  const token = await pair();
  const one = (await (await ext(token, { name: 'Check the parcel', steps: [{ kind: 'go', url: 'https://post.example/track' }, { kind: 'click', target: { tag: 'button', text: 'Track' } }] }, '/api/ext/teach')).json()) as { id: string };
  const au = await owner(`/api/skills/taught/${one.id}`, 'POST', { action: 'automation' });
  assert.equal(au.status, 200, await au.clone().text());
  assert.ok(app.skills!.list().some((s) => s.name === 'check-the-parcel'));
  const two = (await (await ext(token, { name: 'Throw away', steps: [{ kind: 'click', target: { tag: 'button', text: 'X' } }] }, '/api/ext/teach')).json()) as { id: string };
  assert.equal((await owner(`/api/skills/taught/${two.id}`, 'POST', { action: 'nope' })).status, 400);
  assert.equal((await owner(`/api/skills/taught/${two.id}`, 'POST', { action: 'discard' })).status, 200);
  assert.equal((await owner(`/api/skills/taught/${two.id}`, 'POST', { action: 'discard' })).status, 404);
  // Empty recordings are refused.
  assert.equal((await ext(token, { name: 'Nothing', steps: [] }, '/api/ext/teach')).status, 400);
});

test('the switch: Let it record steps you show it, off refuses the extension', async () => {
  const token = await pair();
  assert.equal((await owner('/api/extension', 'PUT', { teach: false })).status, 200);
  assert.equal(((await (await ext(token)).json()) as { teach: boolean }).teach, false);
  assert.equal((await ext(token, { name: 'x', steps: [{ kind: 'click', target: { tag: 'button', text: 'Go' } }] }, '/api/ext/teach')).status, 403);
  assert.equal(((await (await owner('/api/extension')).json()) as { teach: boolean }).teach, false);
  assert.equal((await owner('/api/extension', 'PUT', { teach: true })).status, 200);
});

test('web: the switch on Devices and sign-in and the Shown in your browser section on Skills, with tips and translations', () => {
  const html = read('web', 'index.html');
  const dev = html.slice(html.indexOf('data-page="dh-devices"'));
  assert.ok(dev.slice(0, dev.indexOf('</section>')).includes('id="bx-teach"'));
  const sk = html.slice(html.indexOf('data-page="ab-skills"'));
  const skSec = sk.slice(0, sk.indexOf('</section>'));
  for (const id of ['tch-list', 'tch-status']) assert.ok(skSec.includes(`id="${id}"`), id);
  const tips = JSON.parse(read('web', 'tips.json')).tips;
  assert.ok(tips['bx-teach']);
  assert.match(read('web', 'browser-ext.js'), /'teach'/);
  assert.match(read('web', 'taught.js'), /\/skills\/taught/);
  const es = read('web', 'i18n', 'es.json');
  assert.ok(es.includes('"Shown in your browser":'));
});
