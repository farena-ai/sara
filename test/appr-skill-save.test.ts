// 3.0.3: saving or changing her own skills needs no OK by default (the step shows it with Open and
// Undo); skill_run still asks; an explicit setting and an admin's pin still win; a member's space keeps
// asking; a whole-page Tools save no longer pins the old default. And the approval card is always within
// reach: run cards never shrink in the chat column, the waiting card opens and scrolls into view, the
// "Waiting for your OK" line, her panel and Ctrl K answer with the card's own marked buttons.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { migrateSkillSaveDefault, type Settings } from '../src/settings.ts';
import { SkillStore } from '../src/skill-store.ts';
import { createSkillTools } from '../src/skill-tools.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-09T12:00:00Z');

function setup(t: { after: (fn: () => void) => void }, opts: { member?: boolean } = {}): { app: TestApp; skills: SkillStore; dir: string } {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  const skills = new SkillStore(app.store.db, { companionDir: join(dir, 'skills'), sharedDir: join(dir, 'skills-shared'), workspacesRoot: join(dir, 'workspaces'), trustFile: join(dir, 'skills-trust.json'), now: () => NOW });
  app.skills = skills;
  for (const tl of createSkillTools(() => app, { member: Boolean(opts.member) })) app.tools.add(tl);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: NOW.toISOString() });
  t.after(() => {
    setPolicy(new PolicyStore());
    app.store.close();
    cleanup();
  });
  return { app, skills, dir };
}

test('appr: skill_save, recipe_save and skill_update are allowed by default; skill_run still asks', (t) => {
  const { app } = setup(t);
  for (const n of ['skill_save', 'recipe_save', 'skill_update']) assert.equal(app.tools.permission(n, undefined), 'auto', n);
  assert.equal(app.tools.permission('skill_run', undefined), 'ask');
  // An explicit choice stays.
  assert.equal(app.tools.permission('skill_save', { skill_save: 'ask' }), 'ask');
  assert.equal(app.tools.permission('skill_update', { skill_update: 'never' }), 'never');
  // The admin's pin beats the default.
  const pol = new PolicyStore(app.dataDir);
  pol.set({ pins: { tools: { skill_save: 'ask', skill_update: 'ask' } } } as never);
  setPolicy(pol);
  assert.equal(app.tools.permission('skill_save', undefined), 'ask');
  assert.equal(app.tools.permission('skill_update', undefined), 'ask');
});

test('appr: a household member\'s space keeps asking before a skill save', (t) => {
  const { app } = setup(t, { member: true });
  assert.equal(app.tools.permission('skill_save', undefined), 'ask');
  assert.equal(app.tools.permission('skill_update', undefined), 'ask');
});

test('appr: the one-time move drops the old default a whole-page save pinned, keeps real choices', () => {
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`tool_${i}`, 'auto'])) as Settings['toolPermissions'];
  const page = migrateSkillSaveDefault({ providers: [], toolPermissions: { ...many, skill_save: 'ask', skill_update: 'ask', recipe_save: 'ask', skill_run: 'ask', web_fetch: 'never' } } as Settings)!;
  assert.equal(page.skillSaveDefault, 'auto');
  assert.equal(page.toolPermissions!.skill_save, undefined);
  assert.equal(page.toolPermissions!.skill_update, undefined);
  assert.equal(page.toolPermissions!.recipe_save, undefined);
  assert.equal(page.toolPermissions!.skill_run, 'ask', 'skill_run is untouched');
  assert.equal(page.toolPermissions!.web_fetch, 'never');
  // A short list is the owner's own picks: kept.
  const own = migrateSkillSaveDefault({ providers: [], toolPermissions: { skill_save: 'ask' } } as Settings)!;
  assert.equal(own.toolPermissions!.skill_save, 'ask');
  // 'never' is always a real choice.
  assert.equal(migrateSkillSaveDefault({ providers: [], toolPermissions: { ...many, skill_save: 'never' } } as Settings)!.toolPermissions!.skill_save, 'never');
  // Once only.
  assert.equal(migrateSkillSaveDefault({ providers: [], skillSaveDefault: 'auto', toolPermissions: { ...many, skill_save: 'ask' } } as Settings), undefined);
  assert.deepEqual(migrateSkillSaveDefault({ providers: [] } as Settings), { skillSaveDefault: 'auto' });
});

test('appr: a skill save in a reply runs without an approval and shows as a step that names it', async (t) => {
  const { app, skills } = setup(t);
  const conv = app.store.createConversation();
  app.script.push([call('c1', 'skill_save', { name: 'deploy-the-app', description: 'Deploy the app. Use when Alex asks to ship it.', body: '# Deploy\n\n1. Run the tests.\n' })], text('Saved it.'));
  const events: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'learn how we deploy the app as a skill')) events.push(ev);
  assert.equal(events.filter((e) => e.type === 'approval').length, 0, 'no approval card');
  const result = events.find((e) => e.type === 'tool_result') as { output?: string; status?: string } | undefined;
  assert.ok(result, JSON.stringify(events.map((e) => e.type)));
  assert.match(String(result!.output), /^Saved skill "deploy-the-app"/);
  assert.ok(skills.get('companion', 'deploy-the-app'));
  // A change keeps the old version (Undo restores it), still without a card.
  app.script.push([call('c2', 'skill_update', { name: 'deploy-the-app', body: '# Deploy\n\n1. Run the tests.\n2. Tag it.\n', why: 'tagging was missing' })], text('Changed it.'));
  const ev2: ChatEvent[] = [];
  for await (const ev of runTurn(app, conv.id, 'add the tag step')) ev2.push(ev);
  assert.equal(ev2.filter((e) => e.type === 'approval').length, 0);
  assert.equal(skills.detail('companion', 'deploy-the-app')!.versions.length, 1);
  // With "Ask me first" chosen in Settings, it asks again.
  app.settings.update({ toolPermissions: { skill_update: 'ask' } });
  app.script.push([call('c3', 'skill_update', { name: 'deploy-the-app', body: '# Deploy\n', why: 'shorter' })], text('Asked.'));
  const ac = new AbortController();
  let asked = false;
  for await (const ev of runTurn(app, conv.id, 'make it shorter', ac.signal)) {
    if (ev.type === 'approval') {
      asked = true;
      ac.abort();
    }
  }
  assert.ok(asked, 'an explicit Ask me first is respected');
});

test('appr: Settings → Tools saves only real choices (the page sends every tool)', async (t) => {
  const { app, dir } = setup(t);
  const auth = new OwnerAuth(dir, () => NOW);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const put = (permissions: Record<string, string>) => fetch(`${base}/tools`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ permissions }) });
  assert.equal((await put({ skill_save: 'auto', skill_run: 'ask', skill_update: 'ask' })).status, 200);
  const saved = app.settings.get().toolPermissions ?? {};
  assert.equal(saved.skill_save, undefined, 'the shown default is not pinned');
  assert.equal(saved.skill_run, undefined);
  assert.equal(saved.skill_update, 'ask', 'a change is kept');
  // A kept choice stays kept, even when it matches the default again.
  assert.equal((await put({ skill_update: 'auto' })).status, 200);
  assert.equal(app.settings.get().toolPermissions?.skill_update, 'auto');
});

test('appr: the approval card stays within reach (static)', () => {
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.match(css, /#messages > \* \{ flex-shrink: 0; \}/, 'nothing in the chat column shrinks (a run card has overflow hidden)');
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /function revealApproval\(card/);
  assert.match(app, /runApproval\(steps, card\)\) place\(card\);\n\s+revealApproval\(card\);/, 'a new card opens its run and scrolls into view');
  assert.match(app, /const card = approvalCard\(ev\);\n\s+append\(card\);\n\s+revealApproval\(card\);/, 'a reload brings the card back into the chat, in view');
  assert.match(app, /function syncActivityAnswers\(\)/);
  assert.match(app, /for \(const a of approvalAnswers\(\)\) add\(`approval:/, 'Ctrl K lists the waiting card');
  assert.match(app, /yes\.dataset\.answer = 'yes';\n\s+no\.dataset\.answer = 'no';/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(html, /<span id="activity-act" hidden><\/span>/);
  const panel = readFileSync(join(ROOT, 'web', 'her-panel.js'), 'utf8');
  // 3.3.0 (ezplain): her panel points to the card (Show me) instead of a third Allow / Deny.
  assert.doesNotMatch(panel, /hp-appr-btns/, 'her panel has no copy of the answers');
  const skills = readFileSync(join(ROOT, 'web', 'skills.js'), 'utf8');
  assert.match(skills, /mark\(btn\(label, 'ghost', \(\) => decide\(false\)\), 'no'\)/);
  const steps = readFileSync(join(ROOT, 'web', 'steps.js'), 'utf8');
  assert.match(steps, /t\('Open skill'\)/);
  assert.match(steps, /\/restore`, 'POST'/);
});
