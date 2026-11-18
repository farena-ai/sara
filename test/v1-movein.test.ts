// V1.1 (docs/design/ROADMAP_V.md, docs/design/V1MOVEIN.md): move in with one button, nothing left
// behind. A fake Hermes Agent home (packed by the real Node collector) and a fake ChatGPT export (both
// built at test time) go through ONE review: "Bring everything" decides every card that is safe to
// decide, the review counts match the source, nothing is saved before Import, one Import brings both,
// and the "first evening" checklist lists every kind that was skipped with the reason. Also: ChatGPT
// saved memories and custom instructions and Claude project knowledge become notes; Hermes config
// entries that were only listed now point at the Sara place that does the same thing.
// All data is made up (owner "Alex").
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './helpers.ts';
import { chatgptConversations, makeZip } from './history-fixtures.ts';
import { makeHermesHome } from './movein-fixtures.ts';
import { app, cleanupScratch, scratch } from './movein-real-fixtures.ts';
import { OwnerAuth } from '../src/auth.ts';
import { readExport } from '../src/history-import/index.ts';
import { translateConfig } from '../src/movein/config.ts';
import { createSaraServer } from '../src/server.ts';

after(cleanupScratch);

const NODE_COLLECTOR = join(ROOT, 'scripts', 'sara-movein.mjs');
const NOW = new Date('2026-10-31T15:00:00Z');

/** A ChatGPT export with saved memories, custom instructions and a memory written in a chat ("bio"). */
function chatgptExport(): Buffer {
  const convs = chatgptConversations(3);
  // The model's own memory write inside the first chat (recipient "bio"), as ChatGPT stores it.
  const c0 = convs[0] as { mapping: Record<string, { id: string; parent: string | null; children: string[]; message: unknown }>; current_node?: string };
  const leaf = c0.current_node ?? Object.keys(c0.mapping).at(-1)!;
  c0.mapping['bio-1'] = { id: 'bio-1', parent: leaf, children: [], message: { id: 'bio-1', author: { role: 'assistant' }, create_time: 1704450000, content: { content_type: 'text', parts: ['Alex keeps a sourdough starter called Gerald.'] }, recipient: 'bio', metadata: {} } };
  c0.mapping[leaf].children.push('bio-1');
  c0.current_node = 'bio-1';
  return makeZip({
    'conversations.json': JSON.stringify(convs),
    'user.json': JSON.stringify({ id: 'user-x', email: 'someone@example.com', about_user_message: 'I am a nurse in Lyon and I ride my bike to work.', about_model_message: 'Answer in short paragraphs and skip the small talk.' }),
    'memories.json': JSON.stringify([{ content: 'Alex has a sister called Ana.' }, 'Alex prefers tea after 4 pm.', { content: 'Alex keeps a sourdough starter called Gerald.' }]),
    'file-abc-bird.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]),
  });
}

function claudeExport(): Buffer {
  const msg = (uuid: string, sender: string, text: string, at: string) => ({ uuid, sender, text, content: [{ type: 'text', text }], created_at: at, updated_at: at, attachments: [], files: [] });
  const conv = { uuid: 'conv-1', name: 'Marathon plan', created_at: '2026-01-02T10:00:00Z', updated_at: '2026-01-02T10:05:00Z', chat_messages: [msg('m1', 'human', 'Help me plan for the marathon.', '2026-01-02T10:00:00Z'), msg('m2', 'assistant', 'Sure, sixteen weeks.', '2026-01-02T10:01:00Z')] };
  const long = `Week by week:\n${'Run easy, then rest. '.repeat(300)}`;
  return makeZip({
    'conversations.json': JSON.stringify([conv]),
    'users.json': JSON.stringify([{ uuid: 'acct-1', full_name: 'Test Person' }]),
    'projects.json': JSON.stringify([{ uuid: 'proj-1', name: 'Running', description: 'Getting ready for the city marathon', prompt_template: 'Be my running coach. Keep plans gentle on the knees.', docs: [{ uuid: 'd1', filename: 'race-day.md', content: 'Race day: 12 April, start at 8:30, bib 412.' }, { uuid: 'd2', filename: 'plan.md', content: long }] }]),
  });
}

test('ChatGPT export: saved memories, custom instructions and in-chat memory writes become notes (deduped)', () => {
  const p = readExport(chatgptExport(), NOW);
  assert.equal(p.source, 'chatgpt');
  assert.equal(p.conversations.length, 3);
  const notes = p.notes ?? [];
  const mem = notes.filter((n) => n.kind === 'memory').map((n) => n.text);
  assert.deepEqual(mem.sort(), ['Alex has a sister called Ana.', 'Alex keeps a sourdough starter called Gerald.', 'Alex prefers tea after 4 pm.']);
  const ins = notes.filter((n) => n.kind === 'instructions');
  assert.equal(ins.length, 2);
  assert.ok(ins.some((n) => n.about === 'you' && /nurse in Lyon/.test(n.text)));
  assert.ok(ins.some((n) => n.about === 'answers' && /short paragraphs/.test(n.text)));
  // The memory write is not counted as a skipped tool step any more: it is a note.
  assert.equal(p.skipped.tool, readExport(makeZip({ 'conversations.json': JSON.stringify(chatgptConversations(3)) }), NOW).skipped.tool);
});

test('Claude export: project instructions and knowledge files become notes; a long file is clipped and says so', () => {
  const p = readExport(claudeExport(), NOW);
  assert.equal(p.source, 'claude');
  const proj = (p.notes ?? []).filter((n) => n.kind === 'project');
  assert.equal(proj.length, 3, JSON.stringify(proj.map((n) => n.from)));
  assert.ok(proj.some((n) => /running coach/.test(n.text) && /Running/.test(n.text)));
  assert.ok(proj.some((n) => /bib 412/.test(n.text)));
  const clipped = proj.filter((n) => n.clipped);
  assert.equal(clipped.length, 1);
  assert.ok(clipped[0].text.length <= 2000);
  assert.equal(p.skipped.clipped, 1);
});

test('Hermes config: entries that were only listed now say which Sara place does the same thing', () => {
  const tree = { stt: { enabled: true, provider: 'local' }, delegation: { max_iterations: 20 }, compression: { threshold: 0.8 }, memory: { memory_enabled: true }, display: { skin: 'mono' }, smart_model_routing: { enabled: true }, checkpoints: { enabled: true }, toolsets: ['web', 'terminal'], quick_commands: { status: 'git status' }, honcho: { enabled: true }, session_reset: { mode: 'idle' }, security: { redact_secrets: true }, browser: { headless: true }, code_execution: { timeout: 60 } };
  const cards = translateConfig([{ path: 'config/config.yaml.json', format: 'yaml', tree } as never], { kind: 'hermes', agentId: 'default', providers: [] });
  for (const k of Object.keys(tree)) {
    const c = cards.find((x) => x.key === `knob:${k}`);
    assert.ok(c, `a card for ${k}`);
    assert.ok(c.page, `${k} opens a page`);
    assert.notEqual(c.why, 'Sara manages this differently.', `${k} says what Sara does instead`);
  }
  assert.match(cards.find((x) => x.key === 'knob:stt')!.lives, /Voice/);
  assert.match(cards.find((x) => x.key === 'knob:delegation')!.lives, /team/i);
});

/** A test server with the Move in and history routes. */
async function rig(t: { after: (fn: () => void) => void }) {
  const a = app('v1movein');
  a.settings.update({ disclosureAcceptedAt: new Date().toISOString() });
  const auth = new OwnerAuth(a.dataDir);
  const owner = auth.newToken!;
  const server = createSaraServer({ app: a, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    a.moveIn?.close();
    a.historyImport?.stop();
    server.close();
    a.store.close();
  });
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${owner}`, ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(raw ? { body: new Uint8Array(raw) } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* text */
    }
    return { status: res.status, text, json };
  };
  return { a, call };
}

/** What Sara holds (the "nothing saved before review" check). */
function holdings(a: ReturnType<typeof app>) {
  const n = (sql: string) => Number((a.store.db.prepare(sql).get() as { n: number }).n);
  return { conversations: n('SELECT COUNT(*) AS n FROM conversations'), memories: n('SELECT COUNT(*) AS n FROM memories'), skills: a.skills!.list().filter((s) => s.source !== 'builtin').length, tasks: a.planner!.tasks({ status: 'all' }).length, persona: a.persona.name };
}

test('one review: a Hermes home and a ChatGPT export, counts match the source, nothing saved before Import, the first-evening checklist lists every skipped kind', async (t) => {
  const root = scratch('v1one');
  const home = makeHermesHome(root);
  const out = join(root, 'out');
  mkdirSync(out);
  const col = spawnSync(process.execPath, ['--no-warnings', NODE_COLLECTOR, 'collect', '--hermes-home', home, '--yes', '--out', out, '--progress', 'off'], { encoding: 'utf8', env: { ...process.env, HERMES_HOME: '' }, timeout: 120_000 });
  assert.equal(col.status, 0, col.stderr);
  const r = await rig(t);
  const s = await (r.a.moveIn ??= new (await import('../src/movein/index.ts')).MoveIn(() => r.a)).addFile(join(out, readdirSync(out)[0]));
  assert.equal(s.state, 'ready', s.error);
  const before = holdings(r.a);

  // Bring everything: every card that is safe to decide is decided; the summary counts the source.
  const ev = await r.call('POST', `/api/movein/bundles/${s.id}/everything`, {});
  assert.equal(ev.status, 200, ev.text);
  const bring = ev.json.bring;
  assert.equal(bring.persona, 1);
  assert.equal(bring.chats, ev.json.preview.conversations.count);
  assert.equal(bring.notes, ev.json.preview.sections.memories.writes + ev.json.preview.sections.profile.writes);
  assert.ok(bring.skills >= 2, JSON.stringify(bring));
  assert.equal(bring.jobs, 6, 'all six cron jobs are in the review (each becomes a task, a reminder or a line for you)');
  assert.ok(bring.settings >= 1 && bring.hooks >= 1 && bring.plugins >= 1, JSON.stringify(bring));
  assert.equal(ev.json.choices.persona.use, 0, 'her personality is pre-picked (the owner can still change it)');
  const tr = await r.call('GET', `/api/movein/bundles/${s.id}/translations`);
  const proposed = [...tr.json.code].filter((c: { state: string; mode?: string }) => c.state === 'proposed' && c.mode !== 'info');
  for (const c of proposed) assert.ok(c.flags?.length || c.translation?.type === 'flag', `only code with a safety flag (or nothing to translate it to) stays undecided: ${c.key}`);
  for (const c of tr.json.config.filter((x: { mode: string }) => x.mode !== 'info')) assert.equal(c.state, /:\s*off\b/.test(c.old) ? 'proposed' : 'confirmed', `settings card ${c.key} (a chat app that was off stays yours to decide)`);

  // The ChatGPT export joins the same review.
  const hv = await r.call('POST', '/api/history-import/preview', undefined, chatgptExport());
  assert.equal(hv.status, 200, hv.text);
  assert.equal(hv.json.conversations, 3);
  assert.deepEqual({ memories: hv.json.notes.memories, instructions: hv.json.notes.instructions }, { memories: 3, instructions: 2 });
  assert.deepEqual(holdings(r.a), before, 'nothing is saved before review');

  // One Import brings both.
  const imp = await r.call('POST', `/api/movein/bundles/${s.id}/import`, { choices: ev.json.choices, history: hv.json.id });
  assert.equal(imp.status, 202, imp.text);
  await r.a.moveIn!.idle(s.id);
  await r.a.moveIn!.historyIdle();
  const done = r.a.moveIn!.session(s.id)!;
  assert.equal(done.state, 'imported', done.error);
  const now = holdings(r.a);
  const imported = (ch: string) => Number((r.a.store.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE channel = ? AND channel_key NOT LIKE '%notes%' AND channel_key NOT LIKE '%movein-person%'").get(ch) as { n: number }).n);
  assert.equal(imported('import-hermes'), bring.chats);
  assert.equal(imported('import-chatgpt'), 3);
  const fromChatGPT = r.a.store.db.prepare("SELECT content FROM memories WHERE conversation_id IN (SELECT id FROM conversations WHERE channel = 'import-chatgpt')").all() as { content: string }[];
  assert.equal(fromChatGPT.length, 5, JSON.stringify(fromChatGPT));
  assert.ok(now.skills > before.skills);
  assert.notEqual(now.persona, before.persona);

  // The first evening: bridges, voice, model, and every kind that was skipped, with the reason.
  const evening = await r.call('GET', `/api/movein/batches/${done.batchId}/evening`);
  assert.equal(evening.status, 200, evening.text);
  const items = evening.json.items as { key: string; done: boolean; text: string; page?: string }[];
  for (const k of ['model', 'voice', 'bridges']) assert.ok(items.some((x) => x.key === k), `checklist has ${k}`);
  assert.ok(items.find((x) => x.key === 'bridges')!.text.includes('Telegram'), 'the old Telegram bridge is named');
  assert.ok(!items.find((x) => x.key === 'bridges')!.text.includes('Discord'), 'a chat app switched off on the old agent is not one to reconnect');
  const skipped = evening.json.skipped as { kind: string; count: number; why: string }[];
  const kinds = new Set(skipped.map((x) => x.kind));
  const batch = (await r.call('GET', `/api/movein/batches/${done.batchId}`)).json;
  for (const l of batch.report.leftBehind) assert.ok(kinds.has(l.key), `left behind "${l.key}" is on the checklist`);
  for (const [k, n] of Object.entries(hv.json.skipped as Record<string, number>)) if (n) assert.ok(kinds.has(`chatgpt-${k}`), `ChatGPT ${k} is on the checklist`);
  for (const x of skipped) assert.ok(x.why.length > 5, `${x.kind} says why`);
  assert.equal(evening.json.history?.name, 'ChatGPT');
});

test('the export alone: a ChatGPT zip on Move in has the same checklist (no bundle needed)', async (t) => {
  const r = await rig(t);
  const hv = await r.call('POST', '/api/history-import/preview', undefined, claudeExport());
  assert.equal(hv.status, 200, hv.text);
  assert.equal(hv.json.notes.projects, 3);
  const run = await r.call('POST', '/api/history-import/run', { id: hv.json.id, options: { learn: false } });
  assert.equal(run.status, 200, run.text);
  const ev = await r.call('GET', '/api/movein/evening');
  assert.equal(ev.status, 200, ev.text);
  assert.equal(ev.json.history.name, 'Claude');
  assert.ok(ev.json.skipped.some((x: { kind: string }) => x.kind === 'claude-clipped'), JSON.stringify(ev.json.skipped));
  // Remove imported history also removes the notes it brought.
  const del = await r.call('DELETE', '/api/history-import?source=claude');
  assert.equal(del.status, 200);
  assert.equal(Number((r.a.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n), 0);
});
