// fixreceipts (2026-11-19, from the owner's 'Packing for Lisbon trip' chat): the claim checker
// knows a tool changes something from the tools' own metadata (src/tools/effects.ts), not from a
// hand list; canvas results back "the checklist is updated"; real misses keep the same chip; and
// "get a second opinion" in chat offers the existing D8 panel for her previous reply (no model call).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runTurn } from '../src/chat.ts';
import { checkClaims, judgedClaim, type Receipt } from '../src/receipts.ts';
import { asksSecondOpinion, secondOpinionOfferText } from '../src/second-opinion.ts';
import { createCanvasTools } from '../src/tools/canvas.ts';
import { toolChanges, toolEffect } from '../src/tools/effects.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const ok = (name: string, output = 'ok', args: Record<string, unknown> = {}): Receipt => ({ name, status: 'ok', args, output });
const writes = (reply: string, receipts: Receipt[], prior: Receipt[] = []) => checkClaims(reply, receipts, prior).filter((c) => c.kind === 'write' || c.kind === 'planner' || c.kind === 'action');

// The owner's turn 2: web research, then canvas_update on the checklist posted in turn 1.
const TURN1 = [ok('canvas_post', 'Posted the live checklist "Packing for Lisbon" in this chat (live view #1). It updates by itself from its own data. Change it with canvas_update (canvas 1).', { kind: 'checklist', title: 'Packing for Lisbon' })];
const TURN2 = [
  ok('web_search', '1. Lisbon packing guide ...'),
  ok('web_search', '1. What to wear in Lisbon in November ...'),
  ok('web_fetch', 'Packing list for Lisbon: layers, rain jacket, comfortable shoes ...'),
  ok('web_fetch', 'Lisbon in November: bring an umbrella ...'),
  ok('canvas_update', 'Changed the live checklist "Packing for Lisbon" (#1); it shows the change in the chat within a few seconds.', { canvas: '1', add: ['Rain jacket', 'Umbrella'] }),
];

test('fixreceipts: canvas_update backs "the checklist is updated" (the Lisbon turn is not flagged)', () => {
  // Registered like the real server: the registry notes each tool's effect.
  const { dir, cleanup } = tempDir();
  try {
    const app = makeApp(dir, { now: new Date('2026-11-19T12:00:00Z') });
    new ToolRegistry(createCanvasTools(() => app));
    const reply = 'I went and read two proper guides on packing for Lisbon in November, and the checklist is updated with them. Rain jacket and an umbrella are on it now.';
    assert.deepEqual(writes(reply, TURN2), []);
    // On the owner's server the sentence went to the claim judge, which called it a FILE claim:
    for (const kind of ['write', 'planner', 'action'] as const) assert.equal(judgedClaim('I went and read two proper guides, and the checklist is updated with them.', kind, TURN2), undefined, kind);
    assert.deepEqual(writes('I posted a live checklist for your trip.', TURN1), []);
    app.store.close();
  } finally {
    cleanup();
  }
});

test('fixreceipts: the next turn recapping the checklist change is backed by the earlier canvas receipts', () => {
  assert.deepEqual(writes('And the checklist: I changed it twice.', [], [...TURN1, ...TURN2]), []);
  assert.equal(judgedClaim('And the checklist: I changed it twice.', 'write', [], [...TURN1, ...TURN2]), undefined);
  assert.equal(judgedClaim('I updated the Packing for Lisbon list twice.', 'planner', [], [...TURN1, ...TURN2]), undefined);
  assert.deepEqual(writes('I updated the Packing for Lisbon list earlier with the rain gear.', [], [...TURN1, ...TURN2]), []);
});

test('fixreceipts: real misses are still caught (reading is not changing)', () => {
  const research = TURN2.slice(0, 4);
  // The judge's FILE verdict on the same sentence with only research behind it: still a miss.
  assert.deepEqual(judgedClaim('I went and read two guides, and the checklist is updated with them.', 'write', research), { kind: 'write', sentence: 'I went and read two guides, and the checklist is updated with them.', problem: 'missing' });
  assert.equal(writes('I updated the checklist with them.', research)[0]?.problem, 'missing');
  // A list tool or a read never backs a change.
  assert.equal(writes('I have updated the file plan.md.', [ok('canvas_list'), ok('read_file'), ok('purchases_list'), ok('upkeep_list')]).length, 1);
  // A recap with no earlier change of that thing is still a miss.
  assert.ok(judgedClaim('And the checklist: I changed it twice.', 'write', [], research));
  // An earlier change of the checklist backs a recap, not a new change it never made.
  assert.equal(judgedClaim('I updated the checklist with the umbrella.', 'write', [], [...TURN1, ...TURN2]), undefined);
  assert.ok(judgedClaim('I updated the checklist with sunscreen and a hat.', 'write', [], [...TURN1, ...TURN2]));
  assert.equal(writes('I updated the checklist with them.', [], TURN1.concat(TURN2).map((r) => ({ ...r, name: 'canvas_list' }))).length, 1);
  assert.ok(judgedClaim('And the checklist: I changed it twice.', 'write', [], [ok('note', 'Saved note #4 "Packing for Lisbon"')].slice(1)));
});

test('fixreceipts: the "did it happen?" chip wording and its nudge are unchanged', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.ok(app.includes("t('You said \"{sentence}\", but I don\\'t see that it happened. Please really do it now, or tell me why you can\\'t.', { sentence: claims[0].sentence })"));
  assert.ok(app.includes("t('Ask her to really do it')"));
});

test('fixreceipts: effects come from the tools\' own metadata (ask = changes, interruptible = reads, explicit wins)', () => {
  const t = (name: string, extra: Partial<Tool> = {}): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => name, run: async () => '', ...extra });
  assert.equal(toolEffect(t('zz_frob', { defaultPermission: 'ask' })), 'changes');
  assert.equal(toolEffect(t('zz_frob', { interruptible: true })), 'reads');
  assert.equal(toolEffect(t('zz_frob', { changes: true })), 'changes');
  assert.equal(toolEffect(t('zz_post', { changes: false })), 'reads');
  assert.equal(toolEffect(t('zz_frob')), undefined, 'an auto tool with an unknown verb is undecided (the all-tools test fails on it)');
  assert.equal(toolEffect(t('purchase_add')), 'changes');
  assert.equal(toolEffect(t('purchases_list')), 'reads');
  assert.equal(toolChanges('mcp_github_create_issue'), true);
  assert.equal(toolChanges('web_search'), false);
});

/** Boots the real server (src/main.ts) on a scratch data folder and reads GET /api/tools. */
async function allTools(): Promise<{ name: string; defaultPermission: string; changes: boolean | null }[]> {
  const data = mkdtempSync(join(tmpdir(), 'sara-fixreceipts-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env: NodeJS.ProcessEnv = { ...process.env, SARA_DATA: data, SARA_PORT: String(port), SARA_HOST: '127.0.0.1', SARA_SANDBOX: 'none', SARA_REPORT_TO: 'off', SARA_SETUP: 'off', SARA_TESTING: '1', SARA_VOICE_DIR: join(data, 'novoice') };
  for (const k of ['SARA_DEMO', 'SARA_PRIVATE_LOCAL', 'SARA_MASTER_KEY', 'SARA_INSTANCE', 'SARA_LOG_FILE', 'NODE_TEST_CONTEXT']) delete env[k];
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src', 'main.ts')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  try {
    const t0 = Date.now();
    for (;;) {
      if (Date.now() - t0 > 90_000) throw new Error(`server did not start: ${err.slice(-1500)}`);
      if (existsSync(join(data, 'first-token.txt'))) {
        const up = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
        if (up) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const token = readFileSync(join(data, 'first-token.txt'), 'utf8').trim();
    const r = await fetch(`http://127.0.0.1:${port}/api/tools`, { headers: { authorization: ['Bearer', token].join(' ') } });
    return (await r.json()).tools;
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
    rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test('fixreceipts: EVERY registered tool is decided, and every changing one backs an "I did it" claim', { timeout: 150_000 }, async () => {
  const tools = await allTools();
  assert.ok(tools.length > 250, `only ${tools.length} tools`);
  const undecided = tools.filter((t) => typeof t.changes !== 'boolean').map((t) => t.name);
  assert.deepEqual(undecided, [], 'say `changes: true|false` on these tools (src/tools/types.ts)');
  // Same effect in this process (the receipts checker reads it by name, as the server does).
  new ToolRegistry(tools.map((x) => ({ spec: { name: x.name, description: x.name, parameters: { type: 'object', properties: {} } }, defaultPermission: x.defaultPermission as Tool['defaultPermission'], changes: x.changes!, summarize: () => x.name, run: async () => '' })));
  const claim = 'I have updated the file plan.md.';
  const notBacking = tools.filter((t) => t.changes && writes(claim, [ok(t.name)]).length).map((t) => t.name);
  assert.deepEqual(notBacking, [], 'changing tools that do not back a write claim');
  const readsBacking = tools.filter((t) => !t.changes && !t.name.startsWith('mcp_') && t.name !== 'shell' && !writes(claim, [ok(t.name)]).length).map((t) => t.name);
  assert.deepEqual(readsBacking, [], 'read-only tools that back a write claim');
  const by = new Map(tools.map((t) => [t.name, t.changes]));
  // The owner's evidence and the newer tools that change things.
  for (const n of ['canvas_post', 'canvas_update', 'purchase_add', 'purchase_return', 'upkeep_log', 'app_keep', 'app_edit', 'friend_time', 'chore_done', 'meal_plan_set', 'health_log', 'bill_paid', 'home_control', 'agenda_add', 'expense_add', 'study_make'].filter((x) => by.has(x))) assert.equal(by.get(n), true, n);
  for (const n of ['web_search', 'web_fetch', 'read_file', 'canvas_list', 'purchases_list', 'upkeep_list', 'app_list', 'app_read', 'bill_list', 'calendar_events', 'mail_search'].filter((x) => by.has(x))) assert.equal(by.get(n), false, n);
});

// ---------- second opinion from chat ----------

test('fixreceipts: "get a second opinion" is understood in six languages, and not for doctors or a no', () => {
  for (const s of [
    'get a second opinion on the checklist',
    'Can you get a second opinion?',
    'what would another model say?',
    'ask another model about this',
    'pide una segunda opinión',
    '¿qué diría otro modelo?',
    'demande un deuxième avis',
    "qu'en dirait un autre modèle ?",
    'hol eine zweite Meinung ein',
    'Was würde ein anderes Modell sagen?',
    'quero uma segunda opinião',
    'o que outro modelo diria?',
    'chiedi un secondo parere',
    'cosa direbbe un altro modello?',
  ]) assert.ok(asksSecondOpinion(s), s);
  for (const s of [
    'Should I get a second opinion from another doctor about my knee?',
    "I don't need a second opinion, thanks",
    'no second opinion please',
    'What is a second opinion worth in a court case? Explain the law around expert witnesses in detail, with examples from three countries and the history behind it all.',
    'update the checklist',
    'my second option is the train',
  ]) assert.ok(!asksSecondOpinion(s), s);
  assert.match(secondOpinionOfferText('es'), /modelos/);
  assert.notEqual(secondOpinionOfferText('pt-BR'), secondOpinionOfferText('en'));
});

function sopWorld() {
  const { dir, cleanup } = tempDir();
  const now = new Date('2026-11-19T12:00:00Z');
  const app = makeApp(dir, { now });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', defaultModel: 'm' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: now.toISOString() });
  return { app, cleanup };
}
async function turn(app: ReturnType<typeof makeApp>, conv: string, text: string) {
  const evs = [];
  for await (const ev of runTurn(app, conv, text)) evs.push(ev);
  return evs;
}

test('fixreceipts: asked in chat, she offers the D8 panel for her previous reply and calls no model, runs no tool', async (t) => {
  const { app, cleanup } = sopWorld();
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation();
  app.store.addMessage(conv.id, 'user', 'Make me a packing checklist for Lisbon');
  const mine = app.store.addMessage(conv.id, 'assistant', 'Here is your checklist: passport, rain jacket, comfy shoes.', { model: 'm', provider: 'P' });
  const before = app.providerCalls;
  const evs = await turn(app, conv.id, 'get a second opinion on the checklist');
  assert.equal(app.providerCalls, before, 'no model was asked');
  assert.ok(!evs.some((e) => e.type === 'tool_call' || e.type === 'approval'), 'no research, no tools');
  const last = app.store.messages(conv.id).at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.deepEqual(last.meta?.secondOpinionOffer, { message: mine.id });
  assert.match(last.content, /two other models/i);
  assert.ok(evs.some((e) => e.type === 'done'));
  // Private chat: the same offer (the panel then lists only models on this computer).
  const priv = app.store.createConversation({ private: true });
  app.store.addMessage(priv.id, 'user', 'q');
  const r2 = app.store.addMessage(priv.id, 'assistant', 'a', { model: 'm' });
  await turn(app, priv.id, 'what would another model say?');
  assert.deepEqual(app.store.messages(priv.id).at(-1)!.meta?.secondOpinionOffer, { message: r2.id, private: true });
  assert.equal(app.providerCalls, before);
});

test('fixreceipts: with no earlier reply of hers, the ask is an ordinary turn (the model answers)', async (t) => {
  const { app, cleanup } = sopWorld();
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation();
  app.script.push([{ type: 'text', text: 'A second opinion on what? Tell me more.' }]);
  await turn(app, conv.id, 'get a second opinion');
  assert.equal(app.providerCalls, 1);
  assert.equal(app.store.messages(conv.id).at(-1)!.meta?.secondOpinionOffer, undefined);
});

test('fixreceipts: the web shows the offer as the D8 plan card (reusing web/second-opinion.js)', () => {
  const js = readFileSync(join(ROOT, 'web', 'second-opinion.js'), 'utf8');
  assert.match(js, /export function secondOpinionOffer\(/);
  assert.match(js, /secondOpinionOffer\?\.message/);
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /secondOpinionOffer\(div, m, state\.currentId\)/);
});
