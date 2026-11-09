// C5: Open Responses (`POST /v1/responses`, https://www.openresponses.org) next to
// /v1/chat/completions, on the same keys, rate limits, safety layer and approval rules. The checks
// follow the spec's examples and the HTTP cases of its compliance suite (bin/compliance-test.ts).
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { call as toolCall, makeApp, ROOT, tempDir, text } from './helpers.ts';

const { dir, cleanup } = tempDir();
const clock = { now: new Date('2026-11-08T15:00:00Z') };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
const auth = new OwnerAuth(dir, () => clock.now);
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
let key = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  key = auth.createApiKey('Responses test').token;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});

const req = (method: string, path: string, body?: unknown, k = key) =>
  fetch(`${base}/v1${path}`, { method, headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type Item = { id: string; type: string; status: string; role?: string; content?: { type: string; text: string; annotations: unknown[] }[]; name?: string; [k: string]: unknown };
type Resp = { id: string; object: string; status: string; output: Item[]; previous_response_id: string | null; error: { code: string; message: string } | null; usage: unknown; store: boolean; [k: string]: unknown };
const create = async (body: Record<string, unknown>, k = key) => {
  const r = await req('POST', '/responses', { model: 'sara', ...body }, k);
  return { status: r.status, json: (await r.json()) as Resp & { error?: { message: string; type: string; code: string } } };
};
const outText = (r: Resp) => r.output.filter((i) => i.type === 'message').flatMap((i) => i.content!.map((c) => c.text)).join('');
const userLines = () => app.requests.at(-1)!.messages.filter((m) => m.role === 'user').map((m) => m.content);
const historyLines = () => app.requests.at(-1)!.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => `${m.role}:${m.content}`);

async function sse(body: Record<string, unknown>, onEvent?: (e: Record<string, unknown>) => void) {
  const r = await req('POST', '/responses', { model: 'sara', stream: true, ...body });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/event-stream/);
  const events: { event: string; data: Record<string, unknown> }[] = [];
  let buf = '';
  let done = false;
  const dec = new TextDecoder();
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const name = /^event: (.*)$/m.exec(block)?.[1] ?? '';
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      const ev = JSON.parse(data) as Record<string, unknown>;
      events.push({ event: name, data: ev });
      onEvent?.(ev);
    }
  }
  return { events, done };
}

test('responses: a full Response object (spec fields), status completed, one assistant message with output_text', async () => {
  app.script.push(text('Hello ', 'there, Alex.'));
  const r = await create({ input: [{ type: 'message', role: 'user', content: 'Say hello in exactly 3 words.' }], temperature: 0.4, metadata: { app: 'x' } });
  assert.equal(r.status, 200);
  const b = r.json;
  assert.match(b.id, /^resp_/);
  assert.equal(b.object, 'response');
  assert.equal(b.status, 'completed');
  for (const k of ['created_at', 'completed_at', 'model', 'tools', 'tool_choice', 'truncation', 'parallel_tool_calls', 'text', 'top_p', 'presence_penalty', 'frequency_penalty', 'top_logprobs', 'temperature', 'store', 'background', 'service_tier', 'metadata']) assert.ok(k in b, k);
  for (const k of ['incomplete_details', 'previous_response_id', 'instructions', 'error', 'reasoning', 'usage', 'max_output_tokens', 'max_tool_calls', 'safety_identifier', 'prompt_cache_key']) assert.ok(k in b, `${k} (nullable)`);
  assert.equal(b.error, null);
  assert.equal(b.temperature, 0.4);
  assert.deepEqual(b.metadata, { app: 'x' });
  const msg = b.output.find((i) => i.type === 'message')!;
  assert.match(msg.id, /^msg_/);
  assert.equal(msg.role, 'assistant');
  assert.equal(msg.status, 'completed');
  assert.equal(msg.content![0].type, 'output_text');
  assert.deepEqual(msg.content![0].annotations, []);
  // The AI notice comes first in a new session (the disclosure rule holds here too).
  assert.match(outText(b), /AI/);
  assert.match(outText(b), /Hello there, Alex\.$/);
  // A plain string input works the same.
  app.script.push(text('Fine.'));
  const s = await create({ input: 'How are you?' });
  assert.equal(s.status, 200);
  assert.match(outText(s.json), /Fine\.$/);
  assert.deepEqual(userLines().filter((c) => !c.startsWith('[Note')).at(-1), 'How are you?');
});

test('responses: earlier input items are the history; system/developer items and instructions become a low-priority note', async () => {
  app.script.push(text('Your name is Alice.'));
  const r = await create({
    instructions: 'Answer briefly.',
    input: [
      { type: 'message', role: 'system', content: 'You are a pirate.' },
      { type: 'message', role: 'user', content: 'My name is Alice.' },
      { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Hello Alice!' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is my name?' }] },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.instructions, 'Answer briefly.');
  const h = historyLines();
  assert.ok(h.includes('user:My name is Alice.') && h.includes('assistant:Hello Alice!'), h.join(' | '));
  assert.equal(h.filter((l) => l.startsWith('user:') && !l.includes('[Note')).at(-1), 'user:What is my name?');
  const sys = app.requests.at(-1)!.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.ok(!sys.startsWith('You are a pirate'), 'the app\'s instructions never replace hers');
  assert.match(JSON.stringify(app.requests.at(-1)!.messages), /Answer briefly\.[\s\S]*You are a pirate\.|You are a pirate\.[\s\S]*Answer briefly\./);
});

test('responses: an input_image (data: URL) reaches the model with the message; remote image URLs are refused', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  app.script.push(text('A tiny dot.'));
  const r = await create({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What do you see?' }, { type: 'input_image', image_url: png }] }] });
  assert.equal(r.status, 200);
  const last = app.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1) as { images?: unknown[] };
  assert.equal(last.images?.length, 1);
  const bad = await create({ input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'http://169.254.169.254/x.png' }] }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error!.type, 'invalid_request_error');
});

test('previous_response_id: the earlier input and output come first; unknown, deleted, store:false or another key\'s id → 404', async () => {
  app.script.push(text('Noted: blue.'));
  const first = await create({ input: 'My favourite colour is blue.' });
  app.script.push(text('Blue.'));
  const second = await create({ previous_response_id: first.json.id, input: [{ role: 'user', content: 'What is my favourite colour?' }] });
  assert.equal(second.status, 200);
  assert.equal(second.json.previous_response_id, first.json.id);
  const h = historyLines();
  const iIn = h.indexOf('user:My favourite colour is blue.');
  const iOut = h.findIndex((l) => l.startsWith('assistant:') && l.includes('Noted: blue.'));
  assert.ok(iIn >= 0 && iOut > iIn, h.join(' | '));
  assert.equal(h.filter((l) => l.startsWith('user:') && !l.includes('[Note')).at(-1), 'user:What is my favourite colour?');
  // A chain of three keeps all of it in order.
  app.script.push(text('Yes.'));
  await create({ previous_response_id: second.json.id, input: 'Sure?' });
  const h3 = historyLines();
  assert.ok(h3.indexOf('user:My favourite colour is blue.') < h3.indexOf('user:What is my favourite colour?'));
  // GET returns the stored response; another key can't see it; DELETE removes it.
  const got = await req('GET', `/responses/${first.json.id}`);
  assert.equal(got.status, 200);
  assert.equal(((await got.json()) as Resp).id, first.json.id);
  const other = auth.createApiKey('Other').token;
  assert.equal((await req('GET', `/responses/${first.json.id}`, undefined, other)).status, 404);
  assert.equal((await create({ previous_response_id: first.json.id, input: 'x' }, other)).status, 404);
  const del = await req('DELETE', `/responses/${first.json.id}`);
  assert.deepEqual(await del.json(), { id: first.json.id, object: 'response.deleted', deleted: true });
  assert.equal((await req('GET', `/responses/${first.json.id}`)).status, 404);
  const gone = await create({ previous_response_id: first.json.id, input: 'x' });
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error!.code, 'previous_response_not_found');
  app.script.push(text('ok'));
  const nostore = await create({ store: false, input: 'not kept' });
  assert.equal(nostore.json.store, false);
  assert.equal((await req('GET', `/responses/${nostore.json.id}`)).status, 404);
});

test('streaming: the spec\'s semantic events in order, event name = type, rising sequence numbers, a terminal response.completed', async () => {
  app.script.push(text('One, ', 'two, ', 'three.'));
  const { events, done } = await sse({ input: [{ type: 'message', role: 'user', content: 'Count from 1 to 3.' }] });
  assert.ok(done, '[DONE] after the terminal event');
  for (const e of events) assert.equal(e.event, e.data.type);
  const seq = events.map((e) => e.data.sequence_number as number);
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
  assert.equal(new Set(seq).size, seq.length);
  const types = events.map((e) => e.data.type as string);
  assert.equal(types[0], 'response.created');
  assert.equal(types[1], 'response.in_progress');
  assert.equal(types.at(-1), 'response.completed');
  const order = ['response.output_item.added', 'response.content_part.added', 'response.output_text.delta', 'response.output_text.done', 'response.content_part.done', 'response.output_item.done'];
  let at = -1;
  for (const t of order) {
    const i = types.indexOf(t, at + 1);
    assert.ok(i > at, `${t} after the one before`);
    at = i;
  }
  const deltas = events.filter((e) => e.data.type === 'response.output_text.delta').map((e) => e.data.delta as string).join('');
  const finalResp = events.at(-1)!.data.response as Resp;
  assert.equal(finalResp.status, 'completed');
  assert.equal(outText(finalResp), deltas);
  assert.match(deltas, /One, two, three\.$/);
  const created = events[0].data.response as Resp;
  assert.equal(created.status, 'in_progress');
  assert.deepEqual(created.output, []);
  // The streamed response is stored like any other.
  assert.equal((await req('GET', `/responses/${finalResp.id}`)).status, 200);
});

test('her own tools: shown as sara:tool_call items; an approval card streams as sara:approval and is answered in Sara', async () => {
  app.settings.update({ otherApps: { tools: true }, toolPermissions: { todo: 'ask' } });
  try {
    app.script.push([toolCall('c1', 'todo', { action: 'add', title: 'Buy milk' })], text('Added it.'));
    let approvalId = '';
    const { events } = await sse({ input: 'add milk to my list' }, (e) => {
      if (e.type === 'sara:approval') {
        approvalId = String(e.approval_id);
        app.approvals.decide(approvalId, true);
      }
    });
    assert.ok(approvalId, 'an approval event');
    const ap = events.find((e) => e.data.type === 'sara:approval')!.data;
    assert.equal(typeof ap.sequence_number, 'number');
    assert.match(String(ap.summary), /Buy milk/);
    const finalResp = events.at(-1)!.data.response as Resp;
    assert.equal(finalResp.status, 'completed');
    const tool = finalResp.output.find((i) => i.type === 'sara:tool_call')!;
    assert.ok(tool, JSON.stringify(finalResp.output));
    assert.match(tool.id, /^stc_/);
    assert.equal(tool.name, 'todo');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.result, 'ok');
    assert.match(outText(finalResp), /Added it\.$/);
    assert.equal(app.planner!.tasks().at(-1)?.title, 'Buy milk');
    // Item lifecycle holds: every added item is done before the next is added.
    const life = events.filter((e) => /^response\.output_item\.(added|done)$/.test(e.data.type as string)).map((e) => (e.data.type as string).endsWith('added') ? 'a' : 'd').join('');
    assert.match(life, /^(ad)+$/);
  } finally {
    app.settings.update({ otherApps: { tools: false }, toolPermissions: {} });
  }
});

test('responses errors: OpenAI shape for no key, unknown model, no input, bad JSON, wrong method; app function tools are not run', async () => {
  const nokey = await req('POST', '/responses', { model: 'sara', input: 'hi' }, '');
  assert.equal(nokey.status, 401);
  assert.equal(((await nokey.json()) as { error: { code: string } }).error.code, 'invalid_api_key');
  const unknown = await create({ model: 'gpt-nope', input: 'hi' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error!.code, 'model_not_found');
  const empty = await create({ input: [] });
  assert.equal(empty.status, 400);
  assert.equal((await create({ input: [{ role: 'assistant', content: 'only me' }] })).status, 400);
  const badJson = await fetch(`${base}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{' });
  assert.equal(badJson.status, 400);
  assert.equal((await req('PUT', '/responses')).status, 405);
  // The app's own function tools are ignored (as on chat/completions); the echoed tools list is empty.
  app.script.push(text('It is sunny.'));
  const t = await create({ input: 'Weather in Paris?', tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }] });
  assert.equal(t.status, 200);
  assert.deepEqual(t.json.tools, []);
  assert.equal(app.requests.at(-1)!.tools?.length ?? 0, 0);
});
