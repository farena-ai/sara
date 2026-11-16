// S8 (docs/AGENT_TEAMS.md): the team-run routes are the owner's (members, the demo and signed-out
// callers get 403/401), audited and denied to device tokens; propose → edit → approve → final OK over
// HTTP; the Team dialog's Team runs section and the chat's run card follow the web rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import type { ChatRequest, ProviderConfig, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import { TeamRuns } from '../src/team-runs.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

async function rig(t: TestContext, mode: 'owner' | 'member' | 'demo' = 'owner') {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-16T12:00:00Z') });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  const sent: string[] = [];
  app.tools.add({ spec: { name: 'email', description: 'email', parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', summarize: (a) => `Email ${String(a.to)}`, run: async (a) => (sent.push(String(a.to)), 'sent') } as Tool);
  app.providerFactory = (config: ProviderConfig) => ({
    config,
    listModels: async () => ['m'],
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      const all = req.messages.map((m) => String(m.content)).join('\n');
      const i = req.messages.map((m) => m.role).lastIndexOf('user');
      const after = req.messages.slice(i + 1).some((m) => m.role === 'tool');
      if (all.includes('You plan a team run')) yield { type: 'text', text: JSON.stringify({ roles: [{ id: 'd', name: 'Drafter', kind: 'drafter', tools: ['email'] }], steps: [{ id: 's1', role: 'd', title: 'Write and send', instructions: 'Write it and email Sam.' }], deliver: { kind: 'message' } }) };
      else if (!after) yield { type: 'tool_call', call: { id: 'e1', name: 'email', arguments: { to: 'sam@example.test' } } };
      else yield { type: 'text', text: 'The note is written; the email waits for the final approval.' };
    },
  });
  if (mode === 'owner') app.teamRuns = new TeamRuns(app, app.store.db);
  const auth = new OwnerAuth(dir);
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...(mode === 'demo' ? { demo: true } : {}), ...(mode === 'member' ? { spaceId: 'm1', member: { record: () => ({ id: 'm1', name: 'Alex' }), apps: () => [app], deleteSelf: async () => {} } } : {}) } as never);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    app.store.close();
    cleanup();
  });
  async function api(path: string, method = 'GET', body?: unknown, token: string | null = auth.newToken ?? null) {
    const res = await fetch(base + path, { method, headers: { Origin: base, ...(token ? { authorization: ['Bearer', token].join(' ') } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }
  return { app, api, sent };
}

test('team-run routes: propose, edit, approve once, then one final OK for the email', async (t) => {
  const { app, api, sent } = await rig(t);
  const list = await api('/api/team-runs');
  assert.equal(list.status, 200);
  assert.ok(list.body.tools.some((x: { name: string; kind: string }) => x.name === 'email' && x.kind === 'action'));
  assert.ok(!list.body.tools.some((x: { name: string }) => x.name === 'shell'), 'hard-limit tools are never offered');
  const made = await api('/api/team-runs', 'POST', { goal: 'Write a note for Sam and email it' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.run.id;
  assert.equal(made.body.run.status, 'proposed');
  const plan = { ...made.body.run.plan, roles: made.body.run.plan.roles.map((r: object) => ({ ...r, budget: { tokens: 20_000, minutes: 5 } })) };
  const edited = await api(`/api/team-runs/${id}/plan`, 'PUT', { plan });
  assert.equal(edited.body.run.plan.roles[0].budget.tokens, 20_000);
  assert.equal((await api(`/api/team-runs/${id}/approve`, 'POST', {})).status, 200);
  assert.equal((await api(`/api/team-runs/${id}/approve`, 'POST', {})).status, 409, 'approved once');
  await app.teamRuns!.finished(id);
  const got = await api(`/api/team-runs/${id}`);
  assert.equal(got.body.run.status, 'waiting');
  assert.equal(got.body.run.actions.length, 1);
  assert.deepEqual(sent, []);
  const ok = await api(`/api/team-runs/${id}/decide`, 'POST', { approved: true });
  assert.equal(ok.body.run.status, 'done');
  assert.deepEqual(sent, ['sam@example.test']);
  assert.equal((await api(`/api/team-runs/${id}/decide`, 'POST', { approved: true })).status, 409);
  const notice = app.store.messages(made.body.run.conversationId).find((m) => m.role === 'notice' && m.content.startsWith('teamrun:'));
  assert.ok(notice, 'the run card sits in the chat');
});

test('team-run routes: members, the demo and signed-out callers cannot use them; audited, no device tokens', async (t) => {
  for (const mode of ['member', 'demo'] as const) {
    const { api } = await rig(t, mode);
    assert.equal((await api('/api/team-runs')).status, 403, mode);
    assert.equal((await api('/api/team-runs', 'POST', { goal: 'A job of some size' })).status, 403, mode);
  }
  const { api } = await rig(t);
  assert.equal((await api('/api/team-runs', 'GET', undefined, null)).status, 401);
  const src = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(/const AUDITED = new Set\(\[([^\]]+)\]\)/.exec(src)![1], /'team-runs'/);
  assert.match(/const DEVICE_TOKEN_DENIED = new Set\(\[([^\]]+)\]\)/.exec(src)![1], /'team-runs'/);
});

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');

test('team-run ui: the Team dialog has Team runs, the chat shows a live run card, web rules hold', () => {
  const html = web('index.html');
  const js = web('team-runs.js');
  const app = web('app.js');
  assert.match(html, /<h3 id="truns-h">Team runs <button type="button" class="tip" data-tip="[^"]{20,260}">\?<\/button><\/h3>/);
  assert.match(html, /<div id="truns" aria-labelledby="truns-h"><\/div>/);
  assert.doesNotMatch(js, /style=|\.style\./);
  for (const m of js.matchAll(/t\('((?:[^'\\]|\\.)*)'/g)) assert.ok(m[1].length <= 260, m[1]);
  assert.match(js, /\/approve/);
  assert.match(js, /\/decide/);
  assert.match(app, /m\.kind === 'teamrun'\) \{\s*\/\/[^\n]*\n\s*els\.push\(teamRunNotice\(m\)\)/);
  assert.match(app, /void loadTeamRuns\(\)/);
});
