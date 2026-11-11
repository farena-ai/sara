// Interrupt and tell her now: a steer that doesn't wait for the next safe point. The model call she
// is in is stopped at once (what she had written stays, marked interrupted), finished tool results
// stay, a read-only tool in progress is cancelled, a tool that changes things is never killed by the
// interrupt (she stops right after it; "Stop the command" uses the run-cancel path), and an approval
// card keeps waiting. The model is a scripted fake that can hold a stream open; waits poll for state.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseCommand, runCommand, type BridgeAdapter } from '../src/bridges/commands.ts';
import { runTurn, type ChatEvent } from '../src/chat.ts';
import { interruptible, pendingFor, whileBusySettings } from '../src/pending.ts';
import type { ChatRequest, Provider, StreamEvent } from '../src/providers/types.ts';
import { createSaraServer } from '../src/server.ts';
import type { Tool } from '../src/tools/types.ts';
import { call, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

const NOW = new Date('2026-11-11T15:00:00Z');
const PO = { herName: 'Sara', namePrefix: false };

async function until<T>(f: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the state');
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function drain(gen: AsyncGenerator<ChatEvent>, on?: (ev: ChatEvent) => void): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of gen) {
    out.push(ev);
    on?.(ev);
  }
  return out;
}
function latch() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open: () => open() };
}

type Step = StreamEvent[] | ((signal: AbortSignal) => AsyncIterable<StreamEvent>);
/** A stream that writes `parts`, then holds until the gate opens (or the call is aborted), then `rest`. */
const hold = (parts: string[], gate: ReturnType<typeof latch>, rest: StreamEvent[] = []) =>
  async function* (signal: AbortSignal): AsyncIterable<StreamEvent> {
    for (const p of parts) yield { type: 'text', text: p };
    await new Promise<void>((res, rej) => {
      if (signal.aborted) return rej(signal.reason);
      signal.addEventListener('abort', () => rej(signal.reason), { once: true });
      void gate.wait().then(res);
    });
    yield* rest;
  };

interface Setup {
  app: TestApp;
  steps: Step[];
  ran: Record<string, number>;
  /** The signal each tool run got, by tool name (the last run). */
  sig: Record<string, AbortSignal>;
  gate: { tool?: ReturnType<typeof latch> };
}

function setup(t: { after: (fn: () => void) => void }): Setup {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: NOW });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const steps: Step[] = [];
  app.providerFactory = (config) =>
    ({
      config,
      listModels: async () => ['m'],
      async *stream(req: ChatRequest) {
        app.requests.push(structuredClone({ ...req, signal: undefined }));
        const st = steps.shift() ?? text('ok');
        if (typeof st === 'function') yield* st(req.signal!);
        else
          for (const ev of st) {
            if (req.signal?.aborted) throw req.signal.reason;
            yield ev;
          }
      },
    }) as Provider;
  const ran: Record<string, number> = { slow_read: 0, slow_write: 0, quick_write: 0, slow_cmd: 0, ask_tool: 0 };
  const sig: Record<string, AbortSignal> = {};
  const gate: Setup['gate'] = {};
  const waitOn = (name: string): Tool['run'] => async (_a, ctx) => {
    ran[name]++;
    sig[name] = ctx.signal;
    await new Promise<void>((res, rej) => {
      if (ctx.signal.aborted) return rej(new Error('aborted'));
      ctx.signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
      void gate.tool?.wait().then(res);
    });
    return `${name} finished`;
  };
  const tools: Tool[] = [
    { spec: { name: 'slow_read', description: 'reads slowly', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', interruptible: true, summarize: () => 'read the logs', run: waitOn('slow_read') },
    { spec: { name: 'slow_write', description: 'writes slowly', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'write the file', run: waitOn('slow_write') },
    { spec: { name: 'slow_cmd', description: 'a long command', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', runsCommands: true, summarize: () => 'npm run build', run: waitOn('slow_cmd') },
    {
      spec: { name: 'quick_write', description: 'writes', parameters: { type: 'object', properties: {} } },
      defaultPermission: 'auto',
      summarize: () => 'save it',
      async run() {
        ran.quick_write++;
        return 'saved';
      },
    },
    {
      spec: { name: 'ask_tool', description: 'asks first', parameters: { type: 'object', properties: {} } },
      defaultPermission: 'ask',
      summarize: () => 'send the email',
      async run() {
        ran.ask_tool++;
        return 'sent';
      },
    },
  ];
  for (const tl of tools) app.tools.add(tl);
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'https://api.example.com/v1' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'UTC',
    disclosureAcceptedAt: NOW.toISOString(),
    toolPermissions: { slow_read: 'auto', slow_write: 'auto', slow_cmd: 'auto', quick_write: 'auto', ask_tool: 'ask' },
  });
  return { app, steps, ran, sig, gate };
}

const msgs = (s: Setup, convId: string) => s.app.store.messages(convId);

// ------------------------------------------------------------------ settings and the pending store

test('setting: whileBusy keeps steer / queue / interrupt; unset stays steer (next safe point)', (t) => {
  const s = setup(t);
  assert.equal(whileBusySettings(s.app).whileBusy, 'steer', 'new installs: at the next step');
  s.app.settings.update({ chats: { whileBusy: 'interrupt' } } as never);
  assert.equal(whileBusySettings(s.app).whileBusy, 'interrupt');
  s.app.settings.update({ chats: { whileBusy: 'queue' } } as never);
  assert.equal(whileBusySettings(s.app).whileBusy, 'queue');
  s.app.settings.update({ chats: { whileBusy: 'nonsense' } } as never);
  assert.equal(whileBusySettings(s.app).whileBusy, 'steer');
});

test('pending: an interrupt is a steer marked now; it calls the running turn at once; a person never interrupts; Interrupt on a waiting note', (t) => {
  const s = setup(t);
  const pend = pendingFor(s.app);
  const conv = s.app.store.createConversation({ title: 'x' });
  let cuts = 0;
  pend.turnStarted(conv.id);
  const off = pend.attach(conv.id, { interrupt: () => void cuts++, stopTool: () => false });
  const r = pend.add(conv.id, { kind: 'interrupt', content: 'stop, use pnpm', sender: 'owner' });
  assert.ok(r.ok);
  assert.equal(r.item.kind, 'steer');
  assert.equal(r.item.meta.now, true);
  assert.equal(cuts, 1, 'the turn was told at once');
  assert.equal(pend.interrupting(conv.id), true);
  // A partner's message always waits its turn (never cuts in).
  const p = pend.add(conv.id, { kind: 'interrupt', content: 'hello?', sender: 'person' });
  assert.ok(p.ok && p.item.kind === 'queue' && !p.item.meta.now);
  assert.equal(cuts, 1);
  // A plain steer waiting for the next step can be turned into an interrupt from its pill.
  const st = pend.add(conv.id, { kind: 'steer', content: 'also the docs', sender: 'member' });
  assert.ok(st.ok && !st.item.meta.now);
  const it = pend.interrupt(conv.id, st.ok ? st.item.id : '');
  assert.equal(it?.meta.now, true);
  assert.equal(cuts, 2);
  assert.equal(pend.interrupt(conv.id, 'p-nope'), undefined);
  off();
  pend.turnEnded(conv.id);
  // No turn running: an interrupt is simply the next turn (moved), like a steer.
  const idle = pend.add(conv.id, { kind: 'interrupt', content: 'later', sender: 'owner' });
  assert.ok(idle.ok && idle.item.state === 'moved');
  assert.equal(cuts, 2);
});

test('read-only tools are the ones an interrupt may cancel (reads, searches, looks, fetch); changes are not', () => {
  for (const n of ['read_file', 'list_dir', 'search', 'web_search', 'web_fetch', 'recall', 'gmail_search', 'browser_read', 'code_find']) assert.equal(interruptible(n), true, n);
  for (const n of ['write_file', 'edit_file', 'shell', 'email_send', 'browser_click', 'computer', 'gmail_organize', 'make_document', 'git']) assert.equal(interruptible(n), false, n);
  assert.equal(interruptible('anything', { interruptible: true } as Tool), true, 'a tool may say so itself');
});

// ------------------------------------------------------------------ the turn

test('interrupt mid-stream: the model call stops at once, what she wrote is kept (interrupted), the steer goes in, she continues', async (t) => {
  const s = setup(t);
  const g = latch();
  const conv = s.app.store.createConversation({ title: 'x' });
  s.steps.push(hold(['I was going to say ', 'npm install'], g, [{ type: 'text', text: ' and more' }]), text('OK, pnpm it is.'));
  const pend = pendingFor(s.app);
  let id = '';
  const evs = await drain(runTurn(s.app, conv.id, 'how do I install it?'), (ev) => {
    if (ev.type === 'token' && ev.text === 'npm install' && !id) {
      const r = pend.add(conv.id, { kind: 'interrupt', content: 'use pnpm instead', sender: 'owner' });
      id = r.ok ? r.item.id : '';
    }
  });
  assert.ok(!evs.some((e) => e.type === 'error'), JSON.stringify(evs.filter((e) => e.type === 'error')));
  const types = evs.map((e) => e.type);
  assert.ok(types.indexOf('interrupted') > 0 && types.indexOf('steer') > types.indexOf('interrupted') && types.at(-1) === 'done', types.join(','));
  const partial = msgs(s, conv.id).find((m) => m.role === 'assistant' && m.meta?.interrupted === 'steer')!;
  assert.equal(partial.content, 'I was going to say npm install', 'only what she had written');
  assert.equal(partial.meta?.partial, true);
  const ie = evs.find((e) => e.type === 'interrupted') as Extract<ChatEvent, { type: 'interrupted' }>;
  assert.equal(ie.messageId, partial.id);
  // The next call: her cut-off words (she knows what she was saying), then his message, then the note.
  const next = s.app.requests[1].messages;
  const a = next.findIndex((m) => m.role === 'assistant' && m.content.startsWith('I was going to say npm install'));
  const u = next.findIndex((m) => m.role === 'user' && m.content === 'use pnpm instead');
  const n = next.findIndex((m) => m.role === 'system' && /stopped you mid-reply/.test(m.content));
  assert.ok(a > 0 && u > a && n > u, `order ${a} ${u} ${n}`);
  assert.match(next[a].content, /cut off/);
  const steer = msgs(s, conv.id).find((m) => m.role === 'user' && m.content === 'use pnpm instead')!;
  assert.equal((steer.meta?.steer as { now?: boolean }).now, true);
  assert.equal(pend.get(id)?.state, 'taken');
  assert.equal(msgs(s, conv.id).filter((m) => m.role === 'assistant').at(-1)?.content, 'OK, pnpm it is.');
  assert.equal(s.app.requests.length, 2, 'no call in between');
});

test('interrupt during tools: finished results stay, a read-only tool in progress is cancelled, calls not started are skipped', async (t) => {
  const s = setup(t);
  s.gate.tool = latch();
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'x' });
  s.steps.push([call('q1', 'quick_write', {}), call('r1', 'slow_read', {}), call('w1', 'quick_write', {})], text('Changed course.'));
  const pend = pendingFor(s.app);
  const turn = drain(runTurn(s.app, conv.id, 'save it and read the logs'));
  await until(() => s.ran.slow_read === 1);
  pend.add(conv.id, { kind: 'interrupt', content: 'forget the logs', sender: 'owner' });
  const evs = await turn;
  assert.equal(s.sig.slow_read.aborted, true, 'the read was cancelled');
  const tools = msgs(s, conv.id).filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => [m.meta?.toolCallId, m.meta?.status]), [['q1', 'ok'], ['r1', 'error'], ['w1', 'error']]);
  assert.equal(tools[0].content, 'saved', 'the finished result is kept');
  assert.match(tools[1].content, /sent a new message/);
  assert.match(tools[2].content, /Not run/);
  assert.equal(s.ran.quick_write, 1, 'the call after the interrupt never ran');
  assert.ok(evs.some((e) => e.type === 'steer'));
  assert.ok(!evs.some((e) => e.type === 'error'));
  assert.equal(s.app.requests.length, 2);
});

test('interrupt during a tool that changes things: never killed; she stops right after it returns; Stop the command uses the run cancel', async (t) => {
  const s = setup(t);
  s.gate.tool = latch();
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'x' });
  s.steps.push([call('w1', 'slow_write', {}), call('w2', 'quick_write', {})], text('Done, and noted.'));
  const pend = pendingFor(s.app);
  const turn = drain(runTurn(s.app, conv.id, 'write it'));
  await until(() => s.ran.slow_write === 1);
  pend.add(conv.id, { kind: 'interrupt', content: 'also add a test', sender: 'owner' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.sig.slow_write.aborted, false, 'a write is never cut mid-way');
  assert.deepEqual(pend.phase(conv.id), { kind: 'tool', tool: 'slow_write', summary: 'write the file', stoppable: false });
  assert.equal(pend.stopTool(conv.id), false, 'only commands can be stopped');
  s.gate.tool.open();
  await turn;
  const tools = msgs(s, conv.id).filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((m) => [m.meta?.toolCallId, m.meta?.status, m.content.slice(0, 7)]), [['w1', 'ok', 'slow_wr'], ['w2', 'error', 'Not run']]);
  assert.equal(s.ran.quick_write, 0);
  assert.equal(s.app.requests.length, 2, 'no model call between the tool and his message');
  assert.ok(s.app.requests[1].messages.some((m) => m.role === 'user' && m.content === 'also add a test'));
  // A long command: the pill offers Stop the command (the run's own cancel: the process is killed).
  s.gate.tool = latch();
  s.steps.push([call('c1', 'slow_cmd', {})], text('Stopped the build.'));
  const t2 = drain(runTurn(s.app, conv.id, 'build it'));
  await until(() => s.ran.slow_cmd === 1);
  pend.add(conv.id, { kind: 'interrupt', content: 'skip the build', sender: 'owner' });
  assert.equal(pend.phase(conv.id)?.stoppable, true);
  assert.equal(pend.stopTool(conv.id), true);
  await t2;
  assert.equal(s.sig.slow_cmd.aborted, true);
  const c1 = msgs(s, conv.id).find((m) => m.role === 'tool' && m.meta?.toolCallId === 'c1')!;
  assert.match(c1.content, /stopped/i);
  assert.equal(msgs(s, conv.id).at(-1)?.content, 'Stopped the build.');
});

test('interrupt with an approval card waiting: the card stays; the message waits for Allow or Deny and is read right after', async (t) => {
  const s = setup(t);
  const conv = s.app.store.createConversation({ title: 'x' });
  s.steps.push([call('a1', 'ask_tool', {})], text('Sent, and noted.'));
  const pend = pendingFor(s.app);
  let id = '';
  const evs = await drain(runTurn(s.app, conv.id, 'email Sam'), (ev) => {
    if (ev.type !== 'approval') return;
    const r = pend.add(conv.id, { kind: 'interrupt', content: 'say hi from me too', sender: 'owner' });
    id = r.ok ? r.item.id : '';
    setTimeout(() => {
      assert.equal(s.app.approvals.pendingFor(conv.id).length, 1, 'the card still waits');
      assert.equal(pend.get(id)?.state, 'waiting');
      assert.equal(pend.phase(conv.id)?.kind, 'approval');
      s.app.approvals.decide(ev.approvalId, true);
    }, 20);
  });
  assert.equal(s.ran.ask_tool, 1, 'ran because of Allow, not the text');
  assert.deepEqual(evs.map((e) => e.type).filter((x) => ['approval', 'tool_result', 'steer'].includes(x)), ['approval', 'tool_result', 'steer']);
  assert.equal(pend.get(id)?.state, 'taken');
});

// ------------------------------------------------------------------ server, bridges, web

test('server: whileBusy interrupt → 202; Interrupt on a pill; the pill state; Stop the command; the setting saves', async (t) => {
  const s = setup(t);
  const { OwnerAuth } = await import('../src/auth.ts');
  const auth = new OwnerAuth(s.app.dataDir);
  const token = auth.newToken!;
  const server = createSaraServer({ app: s.app, auth, webDir: join(ROOT, 'web'), info: { version: '3.4.2', revision: null, startedAt: NOW.toISOString() } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  t.after(() => server.close());
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* a stream */
    }
    return { status: res.status, json };
  };
  s.gate.tool = latch();
  const conv = s.app.store.createConversation({ mode: 'coding', title: 'x' });
  s.steps.push([call('c1', 'slow_cmd', {})], text('Skipped it.'));
  const first = api('POST', `/conversations/${conv.id}/messages`, { content: 'build it' });
  await until(() => s.ran.slow_cmd === 1);
  const st = await api('POST', `/conversations/${conv.id}/messages`, { content: 'later: docs', whileBusy: 'steer' });
  assert.equal(st.status, 202);
  let list = await api('GET', `/conversations/${conv.id}/pending`);
  assert.equal(list.json.interrupt, null, 'nothing is interrupting yet');
  const pid = (st.json.pending as { id: string }).id;
  const now = await api('POST', `/conversations/${conv.id}/pending/${pid}/interrupt`, {});
  assert.equal(now.status, 200);
  list = await api('GET', `/conversations/${conv.id}/pending`);
  assert.deepEqual(list.json.interrupt, { state: 'tool', tool: 'slow_cmd', summary: 'npm run build', stoppable: true });
  assert.equal((await api('POST', `/conversations/${conv.id}/pending/stop-tool`, {})).status, 200);
  await first;
  assert.equal(s.sig.slow_cmd.aborted, true);
  assert.equal((await api('POST', `/conversations/${conv.id}/pending/stop-tool`, {})).status, 404, 'nothing runs now');
  assert.equal((await api('POST', `/conversations/${conv.id}/pending/${pid}/interrupt`, {})).status, 404);
  // A new message with whileBusy: 'interrupt'.
  const g = latch();
  s.steps.push(hold(['Writing a long '], g), text('Sure.'));
  const second = api('POST', `/conversations/${conv.id}/messages`, { content: 'tell me a story' });
  await until(() => s.app.requests.length === 3);
  const it = await api('POST', `/conversations/${conv.id}/messages`, { content: 'shorter please', whileBusy: 'interrupt' });
  assert.equal(it.status, 202);
  assert.equal((it.json.pending as { kind: string }).kind, 'steer');
  await second;
  assert.ok(msgs(s, conv.id).some((m) => m.meta?.interrupted === 'steer' && m.content === 'Writing a long '));
  const wb = await api('PUT', '/chats/while-busy', { whileBusy: 'interrupt' });
  assert.equal((wb.json.settings as { whileBusy: string }).whileBusy, 'interrupt');
});

test('bridges: /now <text> interrupts; a plain owner message follows the setting; others always wait', async (t) => {
  const s = setup(t);
  const conv = s.app.store.createConversation({ title: 'x', channel: 'telegram', channelKey: '1' });
  const pend = pendingFor(s.app);
  const took: [string, string][] = [];
  const adapter = { currentSession: () => conv, startSession: () => conv, take: (kind: string, text: string) => (took.push([kind, text]), '') } as unknown as BridgeAdapter;
  const cmd = parseCommand('/now stop and use pnpm', PO)!;
  assert.equal(cmd.name, 'now');
  await runCommand({ app: s.app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd, adapter });
  assert.deepEqual(took, [['interrupt', 'stop and use pnpm']]);
  const empty = await runCommand({ app: s.app, bridge: 'telegram', place: 'owner-dm', who: 'owner', lang: 'en', cmd: parseCommand('/now', PO)!, adapter });
  assert.match(empty.text ?? '', /\/now/);
  const other = await runCommand({ app: s.app, bridge: 'telegram', place: 'partner-dm', who: 'person', lang: 'en', cmd, adapter });
  assert.equal(took.length, 1, 'not for someone else');
  assert.ok(other.text);
  // The bridges pass the owner's setting straight through; an interrupt from the setting cuts in.
  s.app.settings.update({ chats: { whileBusy: 'interrupt' } } as never);
  pend.turnStarted(conv.id);
  const r = pend.add(conv.id, { kind: whileBusySettings(s.app).whileBusy, content: 'from the phone', sender: 'owner' });
  assert.ok(r.ok && r.item.meta.now === true);
  pend.turnEnded(conv.id);
  for (const f of ['src/bridges/telegram.ts', 'src/bridges/discord.ts', 'src/plugins/manager.ts']) assert.match(readFileSync(join(ROOT, f), 'utf8'), /'steer' \| 'queue' \| 'interrupt'/, f);
});

test('web: the ▾ menu offers Interrupt now, Ctrl/Cmd+Enter interrupts, /now is typed, the setting has a third choice, the pill explains', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const busy = readFileSync(join(ROOT, 'web', 'busy.js'), 'utf8');
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(html, /data-busy="interrupt"/);
  assert.match(html, /<option value="interrupt">/);
  assert.match(app, /e\.ctrlKey \|\| e\.metaKey/);
  assert.match(app, /state\.nowSend/);
  assert.match(busy, /steer\|queue\|btw\|now/);
  for (const s of ['Interrupting…', 'Interrupt now', 'Stop the command', 'She was saying…']) assert.ok(busy.includes(s) || app.includes(s), s);
});
