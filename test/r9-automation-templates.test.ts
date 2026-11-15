// R9 "Polish for everyone": shareable automation templates (docs/AUTOMATIONS.md "Templates"). Export
// an automation as JSON without personal data (no ids, emails, tokens, file ids: placeholders
// instead), import from a file or pasted text with a preview and placeholders to fill, and a gallery
// of 10 ready-made templates. Import always shows the preview and needs Allow.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { Automations } from '../src/automations.ts';
import { exportTemplate, fillTemplate, GALLERY, parseTemplate, TemplateError } from '../src/automation-templates.ts';
import { EventTriggers } from '../src/event-triggers.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

function rig(t: TestContext) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-13T15:00:00Z') });
  app.settings.update({ ownerName: 'Alex', timeZone: 'America/Chicago' });
  app.eventTriggers = new EventTriggers(app, app.store.db, { runPrompt: async () => ({ reply: 'ok', tokens: 1 }), notify: async () => undefined, quiet: () => false });
  const auto = new Automations(app, app.store.db, { runTask: async () => ({ reply: 'Done.' }), notify: async () => undefined, quiet: () => false });
  app.automations = auto;
  t.after(() => {
    app.store.close();
    cleanup();
  });
  return { app, auto, dir };
}

const PERSONAL = {
  name: 'Send Kim the Acme hours',
  trigger: { kind: 'email', from: 'billing@acme-corp.example', words: 'hours' },
  actions: [
    { kind: 'draft_email', to: 'kim.lee@acme-corp.example', subject: 'Hours for kim.lee@acme-corp.example', body: 'Hi Kim, token sk-live-9f8e7d6c5b4a3f2e1d0c9b8a and file 1AbCdEfGhIjKlMnOpQrStUvWxYz0123 attached. Call 555-201-3344.' },
    { kind: 'fill', document: 'time sheet', docId: 42, timesheet: { week: 'this', lunchMinutes: 30, regularHours: 8 } },
    { kind: 'notify', text: 'Done for Kim (kim.lee@acme-corp.example).', how: 'phone' },
  ],
};

test('R9.T1 export: no ids, emails, tokens, file ids or phone numbers; placeholders instead', (t) => {
  const { auto } = rig(t);
  const a = auto.create(PERSONAL, { by: 'settings' });
  const tpl = exportTemplate(a);
  const json = JSON.stringify(tpl);
  assert.equal(tpl.sara, 'automation-template');
  assert.equal(tpl.version, 1);
  for (const bad of ['@', 'acme-corp.example', 'sk-live', '1AbCdEfGhIjKlMnOpQrStUvWxYz0123', '555-201-3344', '"docId"', '"id"', 'createdAt', 'conversationId', '"ref"']) assert.ok(!json.includes(bad), `no ${bad} in ${json}`);
  const keys = tpl.placeholders.map((p) => p.key);
  assert.ok(keys.includes('email_1'), keys.join());
  assert.ok(tpl.placeholders.every((p) => p.label && p.kind));
  assert.match(json, /\{\{email_1\}\}/);
  // The rules stay (time sheet rules, words, schedule).
  assert.equal((tpl.actions[1] as { timesheet: { lunchMinutes: number } }).timesheet.lunchMinutes, 30);
  assert.equal((tpl.trigger as { words: string }).words, 'hours');
});

test('R9.T2 import: pasted text is read, checked and scrubbed again; bad input is refused', () => {
  const pasted = JSON.stringify({ sara: 'automation-template', version: 1, name: 'Mine', trigger: { kind: 'schedule', every: 'day', time: '08:00' }, actions: [{ kind: 'notify', text: 'Mail me at me@home.example, key ghp_abcdefghijklmnopqrstuvwxyz0123456789' }], placeholders: [] });
  const r = parseTemplate(pasted);
  const json = JSON.stringify(r);
  assert.ok(!json.includes('me@home.example') && !json.includes('ghp_'), json);
  assert.ok(r.placeholders.some((p) => p.kind === 'email'));
  assert.throws(() => parseTemplate('not json'), TemplateError);
  assert.throws(() => parseTemplate(JSON.stringify({ sara: 'something-else' })), TemplateError);
  assert.throws(() => parseTemplate(JSON.stringify({ sara: 'automation-template', version: 1, name: 'x', trigger: { kind: 'rocket' }, actions: [{ kind: 'notify' }] })), TemplateError);
  assert.throws(() => parseTemplate('x'.repeat(40_001)), TemplateError);
  // A template with a webhook or a watch keeps the kind but never the id: the person picks one.
  const hook = parseTemplate(JSON.stringify({ sara: 'automation-template', version: 1, name: 'Hook', trigger: { kind: 'webhook', hookId: 'wh_77', event: 'push' }, actions: [{ kind: 'notify', text: 'x' }] }));
  assert.ok(!JSON.stringify(hook).includes('wh_77'));
  assert.ok(hook.placeholders.some((p) => p.kind === 'webhook'));
});

test('R9.T3 fill: every placeholder needed, emails checked, the draft passes the normal checks', (t) => {
  const { auto } = rig(t);
  const tpl = exportTemplate(auto.create(PERSONAL, { by: 'settings' }));
  assert.throws(() => fillTemplate(tpl, {}), (e: unknown) => e instanceof TemplateError && /Fill in/.test(e.message));
  const values = Object.fromEntries(tpl.placeholders.map((p) => [p.key, p.kind === 'email' ? 'new.person@example.org' : 'something']));
  assert.throws(() => fillTemplate(tpl, { ...values, email_1: 'not an email' }), TemplateError);
  const draft = fillTemplate(tpl, values);
  const clean = auto.clean(draft);
  assert.equal(clean.actions[0].to, 'new.person@example.org');
  assert.ok(!JSON.stringify(clean).includes('{{'));
});

test('R9.T4 gallery: 10 templates, each previews with sample values', (t) => {
  const { auto } = rig(t);
  assert.equal(GALLERY.length, 10);
  const ids = GALLERY.map((g) => g.id);
  for (const want of ['timesheet', 'bills', 'packages', 'portfolio', 'games', 'invoice-hours', 'school', 'grocery', 'birthdays', 'weekly-review']) assert.ok(ids.includes(want), want);
  for (const g of GALLERY) {
    const tpl = parseTemplate(JSON.stringify(g.template));
    const values = Object.fromEntries(tpl.placeholders.map((p) => [p.key, p.kind === 'email' ? 'school@example.org' : 'time sheet']));
    const p = auto.preview(fillTemplate(tpl, values));
    assert.ok(p.name && p.does.length, g.id);
    assert.ok(!JSON.stringify(g.template).match(/[\w.-]+@[\w-]+\.\w+/), `${g.id} has no address`);
  }
});

test('R9.T5 routes: gallery, export, read, preview, and Allow before it is made', async (t) => {
  const { app, auto, dir } = rig(t);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const g = await call('GET', '/automations/templates');
  assert.equal(g.status, 200);
  assert.equal(g.body.gallery.length, 10);
  const a = auto.create(PERSONAL, { by: 'settings' });
  const ex = await call('GET', `/automations/auto:${a.id}/template`);
  assert.equal(ex.status, 200);
  assert.ok(!JSON.stringify(ex.body).includes('@'));
  const read = await call('POST', '/automations/templates/read', { text: JSON.stringify(ex.body.template) });
  assert.equal(read.status, 200);
  const values = Object.fromEntries((read.body.placeholders as { key: string; kind: string }[]).map((p) => [p.key, p.kind === 'email' ? 'pat@example.org' : 'time sheet']));
  const pv = await call('POST', '/automations/preview', { template: read.body.template, values });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.ok(pv.body.does.length >= 2);
  const before = auto.list().length;
  const no = await call('POST', '/automations', { template: read.body.template, values });
  assert.equal(no.status, 400, 'a template is never made without Allow');
  assert.equal(auto.list().length, before);
  const yes = await call('POST', '/automations', { template: read.body.template, values, allow: true });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.equal(auto.list().length, before + 1);
  const gal = await call('POST', '/automations', { gallery: 'weekly-review', values: {}, allow: true });
  assert.equal(gal.status, 200, JSON.stringify(gal.body));
  const bad = await call('POST', '/automations/templates/read', { text: '{"sara":"nope"}' });
  assert.equal(bad.status, 400);
});
