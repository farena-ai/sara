import { deliveryFor } from '../src/delivery.ts';
// Phase 115 (BR1, 2.48.0): chat apps catch up (docs/design/BRIDGES2.md §4.14). Photos and files both
// ways in Telegram and Discord (stand-in servers) and through the plugin bridge contract v1.1, other
// people's pictures (off by default, described first), send_file, and the one live progress message
// (throttled, Stop, a final line). The model is the fake one from helpers.ts (it records every
// request); time is a manual clock wherever the progress message's timing is checked.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { DISCORD_VAULT, DiscordBridge, type GatewaySocket } from '../src/bridges/discord.ts';
import { conversationFiles, forgetConversationFiles, mediaDb, openProgress, recordShared, sweepShared, takeLeftoverProgress } from '../src/bridges/media.ts';
import { ProgressMessage } from '../src/bridges/progress.ts';
import { PRIO_EDIT, PRIO_REPLY, RateLimited, SendQueue, type Clock } from '../src/bridges/sendq.ts';
import { TELEGRAM_VAULT, TelegramBridge } from '../src/bridges/telegram.ts';
import { chatOrigin } from '../src/library/intake.ts';
import { PRIVATE_PHOTO_NOTE, runTurn, type ChatEvent } from '../src/chat.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { CRISIS_RESOURCES, MINOR_BLOCK_REPLY } from '../src/safety.ts';
import { createSendFileTool } from '../src/tools/send-file.ts';
import { workspaceDir } from '../src/tools/workspace.ts';
import { makeTestPicture } from '../src/bridges/test-picture.ts';
import type { ChatRequest } from '../src/providers/types.ts';
import { fromFolder } from '../src/packages.ts';
import { PLUGIN_LIMITS, PluginManager } from '../src/plugins/manager.ts';
import { pendingFor } from '../src/pending.ts';
import { call, listen, makeApp, ROOT, tempDir, text, type TestApp } from './helpers.ts';

// ------------------------------------------------------------------ helpers

/** A real PNG of `size` px (and, padded, of at least `bytes` bytes: PNG readers ignore what follows IEND). */
const png = (bytes = 0): Buffer => {
  const p = makeTestPicture(8);
  return bytes > p.length ? Buffer.concat([p, Buffer.alloc(bytes - p.length)]) : p;
};

/** A manual clock: timers run only when the test moves time on. */
class ManualClock implements Clock {
  t = 0;
  #timers: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#id;
    this.#timers.push({ at: this.t + Math.max(0, ms), fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.#timers = this.#timers.filter((x) => x.id !== h);
  }
  /** Moves time on in small steps, letting promises and real I/O settle between them. */
  async advance(ms: number, step = 100): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      for (;;) {
        const due = this.#timers.filter((x) => x.at <= this.t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        this.#timers = this.#timers.filter((x) => x !== due);
        due.fn();
        await settle();
      }
      await settle();
    }
  }
}
const settle = () => new Promise((r) => setTimeout(r, 2));

async function bodyOf(req: IncomingMessage): Promise<{ json: Record<string, unknown>; form?: FormData }> {
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('multipart/')) return { json: {}, form: await new Response(buf, { headers: { 'content-type': type } }).formData() };
  return { json: JSON.parse(buf.toString('utf8') || '{}') as Record<string, unknown> };
}

const TG_TOKEN = '123456789:AAF-test-token-for-phase-115';
interface TgSent {
  method: string;
  body: Record<string, unknown>;
  form?: FormData;
  at: number;
}
async function fakeTelegram(clock?: ManualClock) {
  const sent: TgSent[] = [];
  const files = new Map<string, Buffer>();
  let nextId = 500;
  let dropPhotos = false;
  /** Called before answering: return a 429 (retry_after seconds) for this call, or undefined. */
  let limit: (method: string) => number | undefined = () => undefined;
  const { server, url } = await listen(async (req, res) => {
    const path = req.url ?? '';
    const filePath = path.match(/^\/file\/bot[^/]+\/(.+)$/);
    if (filePath) {
      const b = files.get(filePath[1]);
      return void (b ? res.writeHead(200).end(b) : res.writeHead(404).end());
    }
    const method = path.split('/').pop()!;
    const { json, form } = await bodyOf(req);
    const ra = limit(method);
    if (ra !== undefined) return void res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: ra } }));
    sent.push({ method, body: json, ...(form ? { form } : {}), at: clock?.now() ?? Date.now() });
    if (dropPhotos && method === 'sendPhoto') return void req.socket.destroy();
    let result: unknown = true;
    if (method === 'getMe') result = { id: 999, is_bot: true, username: 'sara_test_bot' };
    else if (method === 'getUpdates') result = await new Promise((r) => setTimeout(() => r([]), 50));
    else if (method === 'getFile') result = { file_path: `photos/${String(json.file_id)}` };
    else if (method === 'sendMessage') result = { message_id: nextId++ };
    else if (method === 'sendPhoto') result = { message_id: nextId++, photo: [{ file_id: 'small' }, { file_id: `tg-photo-${nextId}` }] };
    else if (method === 'sendMediaGroup') result = [{ message_id: nextId++, photo: [{ file_id: 'a' }] }, { message_id: nextId++, photo: [{ file_id: 'b' }] }];
    else if (method === 'sendDocument') result = { message_id: nextId++, document: { file_id: `tg-doc-${nextId}` } };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  });
  return {
    sent,
    files,
    url,
    dropPhotos: () => { dropPhotos = true; },
    setLimit: (f: typeof limit) => (limit = f),
    close: () => server.close(),
    texts: (chat: number) => sent.filter((s) => s.method === 'sendMessage' && s.body.chat_id === chat).map((s) => String(s.body.text)),
    calls: (m: string) => sent.filter((s) => s.method === m),
  };
}

const OWNER = 1001;
const FRIEND = 2002;
let uid = 1;
type Up = Record<string, unknown>;
const update = (message: Up) => ({ update_id: uid++, message: { message_id: uid, date: 1_790_000_000, ...message } }) as never;
const dmFrom = (chatId: number, extra: Up, name = 'Alex') => update({ chat: { id: chatId, type: 'private' }, from: { id: chatId, first_name: name }, ...extra });
const sizes = (base: string, bytes: number[]) => bytes.map((b, n) => ({ file_id: `${base}-${n}`, file_size: b, width: 100 * (n + 1), height: 100 * (n + 1) }));

async function tgSetup(t: { after: (fn: () => void) => void }, o: { clock?: ManualClock; settings?: Record<string, unknown>; albumMs?: number } = {}) {
  const { dir, cleanup } = tempDir();
  const time = { now: new Date('2026-11-01T12:00:00Z') };
  const app: TestApp = makeApp(dir, time);
  const tg = await fakeTelegram(o.clock);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', telegram: { enabled: true, allowOthers: true, mirror: false, ownerChatId: OWNER }, ...(o.settings ?? {}) });
  app.vault.set(TELEGRAM_VAULT, TG_TOKEN);
  const bridge = new TelegramBridge(app, { apiBase: tg.url, albumMs: o.albumMs ?? 60, ...(o.clock ? { clock: o.clock } : {}) });
  await bridge.restart();
  await bridge.menus;
  await bridge.leftovers;
  t.after(() => {
    bridge.stop();
    tg.close();
    app.store.close();
    cleanup();
  });
  return { app, bridge, tg, time, dir };
}

/** The user message the fake model saw last. */
const lastUser = (req: ChatRequest | undefined) => [...(req?.messages ?? [])].reverse().find((m) => m.role === 'user') as { content: string; images?: unknown[] } | undefined;

// ------------------------------------------------------------------ Telegram photos in

test('telegram photo in: the largest size ≤ 8 MB is fetched, saved, stored on meta.images and reaches the model', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  const photo = sizes('ph', [400, 900, 9 * 1024 * 1024]);
  tg.files.set('photos/ph-1', png(900));
  tg.files.set('photos/ph-0', png(400));
  app.script.push(text('A small purple circle.'));
  await bridge.handle(dmFrom(OWNER, { photo, caption: 'what is this?' }));
  assert.deepEqual(tg.calls('getFile').map((c) => c.body.file_id), ['ph-1'], 'the largest that fits');
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  const user = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.equal(user.content, 'what is this?');
  assert.equal((user.meta?.images as string[]).length, 1);
  assert.equal(user.meta?.via, 'telegram');
  assert.ok(app.uploads!.get((user.meta!.images as string[])[0]), 'kept in the upload store (magic-checked)');
  assert.equal(lastUser(app.requests.at(-1))?.images?.length, 1, 'the model got the picture');
  assert.ok(tg.texts(OWNER).includes('A small purple circle.'));
  // No caption: "(photo)".
  tg.files.set('photos/pz-0', png(300));
  await bridge.handle(dmFrom(OWNER, { photo: sizes('pz', [300]) }));
  assert.equal(app.store.messages(conv.id).filter((m) => m.role === 'user').at(-1)!.content, '(photo)');
  // Only a 9 MB size: the size line, no turn.
  const calls = app.requests.length;
  await bridge.handle(dmFrom(OWNER, { photo: sizes('big', [9 * 1024 * 1024]) }));
  assert.equal(app.requests.length, calls, 'no turn');
  assert.match(tg.texts(OWNER).at(-1)!, /too big for me \(up to 8 MB\)/);
});

test('telegram album: three updates with one media_group_id are one turn with 3 images; five give 4 and the line', async (t) => {
  // PL2d (C5): the album window is 1 s here (60 ms before), so a loaded machine's gap between two
  // updates of one album can't split it, and the test waits for the turns themselves (polled), not a
  // fixed 150 ms.
  const { app, bridge, tg } = await tgSetup(t, { albumMs: 1000 });
  const until = async (ok: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  };
  for (let i = 0; i < 5; i++) tg.files.set(`photos/al${i}-0`, png(200 + i));
  for (let i = 0; i < 3; i++) await bridge.handle(dmFrom(OWNER, { photo: sizes(`al${i}`, [200 + i]), media_group_id: 'g1', ...(i === 0 ? { caption: 'our trip' } : {}) }), { queued: true });
  await until(() => bridge.albumTurns.length >= 1);
  await Promise.all(bridge.albumTurns);
  const userRows = () => {
    const c = app.store.findChannelConversation('telegram', String(OWNER));
    return c ? app.store.messages(c.id).filter((m) => m.role === 'user') : [];
  };
  await until(() => userRows().length >= 1);
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  let users = app.store.messages(conv.id).filter((m) => m.role === 'user');
  assert.equal(users.length, 1, 'one message');
  assert.equal(users[0].content, 'our trip');
  assert.equal((users[0].meta?.images as string[]).length, 3);
  // Five pictures (different bytes each): the first 4 and one line.
  for (let i = 0; i < 5; i++) await bridge.handle(dmFrom(OWNER, { photo: sizes(`al${i}`, [200 + i]), media_group_id: 'g2' }), { queued: true });
  await until(() => bridge.albumTurns.length >= 2);
  await Promise.all(bridge.albumTurns);
  await until(() => userRows().length >= 2 && tg.texts(OWNER).includes('I looked at the first 4.'));
  users = app.store.messages(conv.id).filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.equal((users[1].meta?.images as string[]).length, 4);
  assert.ok(tg.texts(OWNER).includes('I looked at the first 4.'));
  // The two turns run queued: wait for both replies to be stored, so nothing writes after the test ends.
  await until(() => app.store.messages(conv.id).filter((m) => m.role === 'assistant').length >= 2 && !pendingFor(app).busy(conv.id));
  assert.ok(app.store.messages(conv.id).filter((m) => m.role === 'assistant').length >= 2, 'both album turns answered');
});

test('telegram: a picture sent "as a file" is a photo; a captioned photo is never dropped any more', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  tg.files.set('photos/doc-1', png(500));
  await bridge.handle(dmFrom(OWNER, { document: { file_id: 'doc-1', file_name: 'shot.png', mime_type: 'image/png', file_size: 500 }, caption: 'look' }));
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  const user = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.equal((user.meta?.images as string[]).length, 1);
  assert.equal(app.library, undefined, 'not taken as a document');
});

// ------------------------------------------------------------------ Discord photos in

async function fakeDiscord() {
  const sent: { method: string; path: string; body: Record<string, unknown>; form?: FormData }[] = [];
  const cdn = new Map<string, Buffer>();
  let n = 7000;
  let dropPhotos = false;
  const { server, url } = await listen(async (req, res) => {
    const path = req.url ?? '';
    if (path.startsWith('/cdn/')) {
      const b = cdn.get(path);
      return void (b ? res.writeHead(200).end(b) : res.writeHead(404).end());
    }
    const { json, form } = await bodyOf(req);
    sent.push({ method: req.method ?? '', path, body: json, ...(form ? { form } : {}) });
    if (dropPhotos && form && path.endsWith('/messages')) return void req.socket.destroy();
    let result: unknown = {};
    if (path === '/users/@me') result = { id: '900', username: 'Sara', bot: true };
    else if (/^\/channels\/[\w-]+$/.test(path) && req.method === 'GET') result = { id: path.split('/')[2], nsfw: false };
    else if (path === '/users/@me/channels') result = { id: 'dm-owner' };
    else if (path.endsWith('/typing')) return void res.writeHead(204).end();
    else if (/\/messages$/.test(path) && req.method === 'POST') result = { id: String(n++), attachments: form ? [{ id: 'att-1' }] : [] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  return { sent, cdn, url, dropPhotos: () => { dropPhotos = true; }, close: () => server.close(), posts: (ch: string) => sent.filter((s) => s.method === 'POST' && s.path === `/channels/${ch}/messages`) };
}
const DC_TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.');
const DC_OWNER = { id: '100', username: 'alex', global_name: 'Alex' };

async function dcSetup(t: { after: (fn: () => void) => void }) {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-01T12:00:00Z') });
  const rest = await fakeDiscord();
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', discord: { enabled: true, allowServers: true, mirror: false, ownerUserId: '100' } });
  app.vault.set(DISCORD_VAULT, DC_TOKEN);
  let sock: GatewaySocket | undefined;
  const bridge = new DiscordBridge(app, { api: rest.url, connect: () => (sock = { send: () => undefined, close: () => undefined, onmessage: null, onclose: null }) });
  await bridge.restart();
  void sock;
  t.after(() => {
    bridge.stop();
    rest.close();
    app.store.close();
    cleanup();
  });
  return { app, bridge, rest };
}

test('discord photo in: an image attachment is one turn with the image; a picture-only message is answered; 25 MB is refused', async (t) => {
  const { app, bridge, rest } = await dcSetup(t);
  rest.cdn.set('/cdn/a.png', png(600));
  app.script.push(text('Nice picture.'));
  await bridge.handleMessage({ id: '1', channel_id: 'dm1', author: DC_OWNER, content: '', attachments: [{ id: 'a1', url: `${rest.url}/cdn/a.png`, filename: 'a.png', content_type: 'image/png', size: 600, description: 'a purple dot' }] } as never);
  const conv = app.store.findChannelConversation('discord', 'dm1')!;
  const user = app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.match(user.content, /^\(photo\) \[image description: a purple dot\]$/);
  assert.equal((user.meta?.images as string[]).length, 1);
  assert.equal(lastUser(app.requests.at(-1))?.images?.length, 1);
  assert.ok(rest.posts('dm1').some((p) => p.body.content === 'Nice picture.'), 'answered (no longer ignored)');
  const calls = app.requests.length;
  await bridge.handleMessage({ id: '2', channel_id: 'dm1', author: DC_OWNER, content: '', attachments: [{ url: `${rest.url}/cdn/big.png`, content_type: 'image/png', size: 25 * 1024 * 1024 }] } as never);
  assert.equal(app.requests.length, calls, 'no turn');
  assert.ok(rest.posts('dm1').some((p) => /too big for me/.test(String(p.body.content))));
});

// ------------------------------------------------------------------ vision routing

test('vision routing: a vision route runs the vision job; a private conversation with a cloud vision route stays local with the note', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const app = makeApp(dir, { now: new Date('2026-11-01T12:00:00Z') });
  t.after(() => app.store.close());
  app.settings.update({ providers: [{ id: 'loc', label: 'Here', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }, { id: 'cloud', label: 'Cloud', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'loc', defaultModel: 'small', routes: { vision: { providerId: 'cloud', model: 'eyes' } }, disclosureAcceptedAt: new Date().toISOString() } as never);
  const id = app.uploads!.saveBytes(png(300)).id;
  const conv = app.store.createConversation({ title: 'web' });
  for await (const ev of runTurn(app, conv.id, 'look', undefined, { images: [id] })) void ev;
  assert.equal(app.requests.at(-1)!.model, 'eyes', 'the vision job');
  const priv = app.store.createConversation({ title: 'private', private: true });
  const evs: ChatEvent[] = [];
  for await (const ev of runTurn(app, priv.id, 'look', undefined, { images: [id] })) evs.push(ev);
  assert.ok(!evs.some((e) => e.type === 'error'), 'no throw');
  assert.equal(app.requests.at(-1)!.model, 'small', 'the local chain');
  const u = lastUser(app.requests.at(-1))!;
  assert.ok(u.content.includes(PRIVATE_PHOTO_NOTE));
  assert.ok(!u.images?.length, 'no picture to a model off this computer');
});

// ------------------------------------------------------------------ pictures from other people

test('others: off by default (nothing downloaded); describe-first gives only the fenced description; minor and explicit are refused and deleted', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  tg.files.set('photos/fr-0', png(321));
  await bridge.handle(dmFrom(FRIEND, { photo: sizes('fr', [321]), caption: 'see?' }, 'Ann'));
  assert.equal(tg.calls('getFile').length, 0, 'nothing downloaded');
  assert.ok(tg.texts(FRIEND).includes("I can't look at pictures here."));
  // Switched on: described first.
  app.settings.update({ chats: { media: { photosFromOthers: 'describe' } } } as never);
  app.script.push(text('LABEL: ok\nDESCRIPTION: A purple circle on white.'), text('Pretty!'));
  await bridge.handle(dmFrom(FRIEND, { photo: sizes('fr', [321]), caption: 'see?' }, 'Ann'));
  const describe = app.requests.at(-2)!;
  assert.equal(lastUser(describe)?.images?.length, 1, 'the picture model saw it');
  const talk = app.requests.at(-1)!;
  assert.ok(talk.messages.every((m) => !(m as { images?: unknown[] }).images?.length), 'the talking model never gets their picture');
  const said = lastUser(talk)!.content;
  assert.match(said, /PHOTO \(between the two DATA-\w+ lines/);
  assert.match(said, /\| Photo from Ann, described by the picture model: A purple circle on white\./);
  const conv = app.store.findChannelConversation('telegram', String(FRIEND))!;
  assert.equal(app.store.messages(conv.id).find((m) => m.role === 'user')!.meta?.images, undefined);
  // minor: the reply is the block line, the upload is gone, the count kept.
  tg.files.set('photos/fm-0', png(333));
  app.script.push(text('LABEL: minor\nDESCRIPTION: -'));
  const before = app.requests.length;
  await bridge.handle(dmFrom(FRIEND, { photo: sizes('fm', [333]) }, 'Ann'));
  assert.equal(app.requests.length, before + 1, 'only the describe call');
  assert.equal(tg.texts(FRIEND).at(-1), MINOR_BLOCK_REPLY);
  const minorRow = conversationFiles(app, conv.id).find((r) => r.reason === 'minor')!;
  assert.equal(minorRow.uploadId, null);
  assert.equal(minorRow.status, 'refused');
  // explicit in a group that isn't adult: refused and deleted.
  tg.files.set('photos/fx-0', png(344));
  app.script.push(text('LABEL: explicit\nDESCRIPTION: -'));
  await bridge.handle(update({ chat: { id: -500, type: 'group', title: 'Club' }, from: { id: FRIEND, first_name: 'Ann' }, photo: sizes('fx', [344]), caption: '@sara_test_bot look' }));
  assert.match(tg.texts(-500).at(-1)!, /won't look at that kind of picture here/);
});

test('quotas: the 21st partner picture of the day gets the quota line and nothing is downloaded', async (t) => {
  const { app, bridge, tg } = await tgSetup(t, { settings: { chats: { media: { photosFromOthers: 'describe' } } } });
  const conv = app.store.createConversation({ title: 'x', channel: 'telegram', channelKey: String(FRIEND), partner: 'Ann' });
  for (let i = 0; i < 20; i++) recordShared(app, { conversationId: conv.id, direction: 'in', bridge: 'telegram', chatKey: String(FRIEND), sender: 'person', kind: 'photo', status: 'ok', bytes: 10 });
  await bridge.handle(dmFrom(FRIEND, { photo: sizes('q', [100]) }, 'Ann'));
  assert.equal(tg.calls('getFile').length, 0);
  assert.equal(tg.texts(FRIEND).at(-1), "That's my picture limit for today here.");
});

// ------------------------------------------------------------------ pictures and files out

/** A fake take_photo: makes a picture and attaches it to her reply (like photos.ts does). */
function addPhotoTool(app: TestApp): void {
  app.tools.add({ spec: { name: 'take_photo', description: 'a selfie', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => 'Take a photo', run: async (_a, ctx) => {
    const id = app.uploads!.saveBytes(png(777)).id;
    ctx.attachImage?.(id);
    return 'Made a photo.';
  } });
}

test('pictures out: a selfie asked for in Telegram arrives as sendPhoto with the reply as its caption; a long reply comes after the photo; Discord sends one files[0] message', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  addPhotoTool(app);
  app.script.push([call('c1', 'take_photo', {})], text('Here I am!'));
  await bridge.handle(dmFrom(OWNER, { text: 'send me a selfie' }));
  const photos = tg.calls('sendPhoto');
  assert.equal(photos.length, 1, 'the selfie arrives (2.47 dropped the image event)');
  assert.ok(deliveryFor(app).list().some(row => row.operation === 'sendPhoto' && row.state === 'acknowledged'));
  assert.equal(photos[0].form!.get('caption'), 'Here I am!');
  assert.ok(photos[0].form!.get('photo') instanceof Blob);
  assert.ok(!tg.texts(OWNER).includes('Here I am!'), 'nothing else: the reply was the caption');
  // A 2,000-character reply: the photo without a caption, then the text.
  const long = 'word '.repeat(400).trim();
  app.script.push([call('c2', 'take_photo', {})], text(long));
  await bridge.handle(dmFrom(OWNER, { text: 'another' }));
  const last = tg.calls('sendPhoto').at(-1)!;
  assert.equal(last.form!.get('caption'), null);
  const order = tg.sent.filter((s) => s.method === 'sendPhoto' || (s.method === 'sendMessage' && s.body.chat_id === OWNER)).map((s) => s.method).slice(-2);
  assert.deepEqual(order, ['sendPhoto', 'sendMessage'], 'pictures first, then text');
  assert.equal(tg.texts(OWNER).at(-1), long);
  // Discord: one multipart message with the picture and the reply as content.
  const dc = await dcSetup(t);
  addPhotoTool(dc.app);
  dc.app.script.push([call('d1', 'take_photo', {})], text('Hi from Discord.'));
  await dc.bridge.handleMessage({ id: '9', channel_id: 'dm1', author: DC_OWNER, content: 'selfie please' } as never);
  const multi = dc.rest.posts('dm1').filter((p) => p.form);
  assert.equal(multi.length, 1);
  assert.ok(deliveryFor(dc.app).list().some(row => row.operation === 'message' && row.state === 'acknowledged'));
  const payload = JSON.parse(String(multi[0].form!.get('payload_json'))) as { content?: string; attachments: { description?: string }[] };
  assert.equal(payload.content, 'Hi from Discord.');
  assert.ok(multi[0].form!.get('files[0]') instanceof Blob);
  assert.ok(payload.attachments[0].description, 'alt text for screen readers');
  assert.ok(!dc.rest.posts('dm1').some((p) => !p.form && p.body.content === 'Hi from Discord.'));
});

test('pictures out: an app error line is never a photo\'s caption (found in the live run)', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  addPhotoTool(app);
  app.script.push([call('c1', 'take_photo', {})], [], [], []);
  await bridge.handle(dmFrom(OWNER, { text: 'send me a selfie' }));
  const photo = tg.calls('sendPhoto').at(-1)!;
  assert.ok(photo, 'the selfie still arrives');
  assert.equal(photo.form!.get('caption'), null, 'no "(Something went wrong …)" caption');
  assert.ok(tg.texts(OWNER).some((x) => x.startsWith('(Something went wrong')), 'the error is its own message');
});

test('send_file: a workspace PDF goes out with sendDocument, a shared_files row and a file event; paths, .env, secrets, key-shaped text and rooms are checked', async (t) => {
  const { app, bridge, tg } = await tgSetup(t);
  app.tools.add(createSendFileTool(() => app));
  app.vault.set('provider:x', 'sk-vault-secret-value-123456');
  const conv0 = app.store.createConversation({ title: 'Telegram', channel: 'telegram', channelKey: String(OWNER) });
  const ws = workspaceDir(app.dataDir, conv0.workspace);
  writeFileSync(join(ws, 'report.pdf'), Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 1)]));
  writeFileSync(join(ws, '.env'), 'A=1');
  writeFileSync(join(ws, 'notes.txt'), 'the key is sk-vault-secret-value-123456 ok');
  writeFileSync(join(ws, 'keyish.txt'), 'line one\nghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n');
  app.script.push([call('f1', 'send_file', { path: 'report.pdf', caption: 'your report' })], text('Sent it.'));
  await bridge.handle(dmFrom(OWNER, { text: 'send me the report' }));
  const docs = tg.calls('sendDocument');
  assert.equal(docs.length, 1);
  assert.equal((docs[0].form!.get('document') as File).name, 'report.pdf');
  assert.equal(docs[0].form!.get('caption'), 'your report');
  const row = conversationFiles(app, conv0.id).find((r) => r.kind === 'file')!;
  assert.equal(row.direction, 'out');
  assert.ok(row.path && existsSync(row.path), 'a copy under data/shared');
  assert.equal(row.platformRef?.startsWith('tg-doc-'), true);
  const reply = app.store.messages(conv0.id).filter((m) => m.role === 'assistant').at(-1)!;
  assert.equal((reply.meta?.files as { name: string }[])[0].name, 'report.pdf', 'the web chip');
  // The checks, straight through a turn (events show what happened).
  const turn = async (args: Record<string, unknown>, convId = conv0.id) => {
    const evs: ChatEvent[] = [];
    app.script.push([call(`x${uid++}`, 'send_file', args)], text('ok'));
    for await (const ev of runTurn(app, convId, 'share it')) {
      evs.push(ev);
      if (ev.type === 'approval') app.approvals.decide(ev.approvalId, false);
    }
    return evs;
  };
  const out = (evs: ChatEvent[]) => (evs.find((e) => e.type === 'tool_result') as { output: string; status: string } | undefined);
  assert.match(out(await turn({ path: '../outside.txt' }))!.output, /outside the workspace/);
  assert.match(out(await turn({ path: '.env' }))!.output, /keys or secrets/);
  const vaulted = await turn({ path: 'notes.txt' });
  assert.match(out(vaulted)!.output, /contains one of your saved secrets/);
  assert.ok(!vaulted.some((e) => e.type === 'approval'), 'a hard refusal, no card');
  const keyish = await turn({ path: 'keyish.txt' });
  const card = keyish.find((e) => e.type === 'approval') as { summary: string } | undefined;
  assert.ok(card, 'a key-shaped string asks first');
  assert.match(card!.summary, /line 2 looks like a key/);
  assert.ok(!card!.summary.includes('ghp_abcdefghijklmnop'), 'redacted');
  const room = app.store.createConversation({ title: 'work', channel: 'telegram-work', channelKey: '-77' });
  writeFileSync(join(workspaceDir(app.dataDir, room.workspace), 'report.pdf'), Buffer.from('%PDF-1.4\nx'));
  assert.ok((await turn({ path: 'report.pdf' }, room.id)).some((e) => e.type === 'approval'), 'a work room asks first');
  // Not offered: partner chats (no tools), private conversations, private local mode.
  const offered = () => (app.requests.at(-1)!.tools ?? []).map((x) => x.name);
  const partner = app.store.createConversation({ title: 'p', channel: 'telegram', channelKey: '3', partner: 'Ann' });
  for await (const ev of runTurn(app, partner.id, 'hi')) void ev;
  assert.ok(!offered().includes('send_file'));
  const priv = app.store.createConversation({ title: 'p', private: true });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:9', local: true }] } as never);
  for await (const ev of runTurn(app, priv.id, 'hi')) void ev;
  assert.ok(!offered().includes('send_file'));
  setPrivateLocal(true);
  try {
    for await (const ev of runTurn(app, conv0.id, 'hi')) void ev;
    assert.ok(!offered().includes('send_file'));
  } finally {
    setPrivateLocal(false);
  }
  for await (const ev of runTurn(app, conv0.id, 'hi')) void ev;
  assert.ok(offered().includes('send_file'), 'offered in his own chat');
});

// ------------------------------------------------------------------ the progress message

/** A tool that takes `ms` of the manual clock (and records the arguments it got). */
function addSlowTool(app: TestApp, clock: ManualClock, name = 'slow', ms = 3000, output = 'done'): void {
  app.tools.add({ spec: { name, description: 'slow', parameters: { type: 'object', properties: {} } }, defaultPermission: 'auto', summarize: () => `Run ${name}`, run: async () => {
    await new Promise<void>((r) => void clock.setTimeout(r, ms));
    return output;
  } });
}
/** Drives the manual clock until `p` settles. */
async function drive<T>(clock: ManualClock, p: Promise<T>, maxMs = 60_000): Promise<T> {
  let done = false;
  const out = p.finally(() => (done = true));
  for (let i = 0; i < maxMs / 100 && !done; i++) await clock.advance(100);
  return out;
}

test('progress: one sendMessage at 10 s, edits ≥ 3 s apart and never unchanged, a final "Done" line without Stop, then the answer as a new message; a 6 s turn shows nothing', async (t) => {
  const clock = new ManualClock();
  const { app, bridge, tg } = await tgSetup(t, { clock });
  addSlowTool(app, clock);
  app.script.push([call('s1', 'slow', {})], [call('s2', 'slow', {})], [call('s3', 'slow', {})], [call('s4', 'slow', {})], text('All finished.'));
  await drive(clock, bridge.handle(dmFrom(OWNER, { text: 'do the long job' })));
  const prog = tg.sent.filter((s) => (s.method === 'sendMessage' && /^⏳|^✍️|^⏸/.test(String(s.body.text))) || s.method === 'editMessageText');
  const first = prog[0];
  assert.equal(first.method, 'sendMessage');
  assert.ok(first.at >= 10_000 && first.at < 10_500, `posted at 10 s (was ${first.at})`);
  assert.equal(prog.filter((s) => s.method === 'sendMessage').length, 1, 'exactly one progress message');
  const edits = prog.filter((s) => s.method === 'editMessageText');
  for (let i = 1; i < edits.length; i++) assert.ok(edits[i].at - edits[i - 1].at >= 3000, 'edits at least 3 s apart');
  assert.ok(edits.length && edits[0].at - first.at >= 3000);
  const texts = [first, ...edits].map((s) => String(s.body.text));
  for (let i = 1; i < texts.length; i++) assert.notEqual(texts[i], texts[i - 1], 'unchanged text is never sent');
  const fin = edits.at(-1)!;
  assert.equal(fin.body.text, '✅ Done · 4 steps · 0:12');
  assert.deepEqual(fin.body.reply_markup, { inline_keyboard: [] }, 'the Stop button is gone');
  assert.ok(JSON.stringify(first.body.reply_markup).includes('"callback_data":"st:'), 'a Stop button while she works');
  assert.equal(tg.texts(OWNER).at(-1), 'All finished.', 'the answer is a new message');
  // A 6 s turn: no progress message.
  const before = tg.sent.length;
  app.script.push([call('s5', 'slow', {})], [call('s6', 'slow', {})], text('Quick one.'));
  await drive(clock, bridge.handle(dmFrom(OWNER, { text: 'shorter job' })));
  assert.ok(!tg.sent.slice(before).some((s) => s.method === 'editMessageText' || /^⏳/.test(String(s.body.text ?? ''))));
  // Partner chats never; /progress off in his chat turns it off there.
  await bridge.handle(dmFrom(OWNER, { text: '/progress off' }));
  assert.match(tg.texts(OWNER).at(-1)!, /off in this chat/);
  const b2 = tg.sent.length;
  app.script.push([call('s7', 'slow', {})], [call('s8', 'slow', {})], [call('s9', 'slow', {})], [call('s10', 'slow', {})], text('Done quietly.'));
  await drive(clock, bridge.handle(dmFrom(OWNER, { text: 'long again' })));
  assert.ok(!tg.sent.slice(b2).some((s) => s.method === 'editMessageText'), '/progress off');
  assert.equal(tg.texts(OWNER).at(-1), 'Done quietly.');
});

test('progress: a 429 (retry_after 2) pauses edits and the final edit is still made; partners never get one', async (t) => {
  const clock = new ManualClock();
  const { app, bridge, tg } = await tgSetup(t, { clock });
  addSlowTool(app, clock);
  let limited = false;
  let limitedAt = 0;
  tg.setLimit((m) => {
    if (m === 'editMessageText' && !limited) {
      limited = true;
      limitedAt = clock.now();
      return 2;
    }
    return undefined;
  });
  app.script.push([call('a1', 'slow', {})], [call('a2', 'slow', {})], [call('a3', 'slow', {})], [call('a4', 'slow', {})], [call('a5', 'slow', {})], text('Finished.'));
  await drive(clock, bridge.handle(dmFrom(OWNER, { text: 'go' })));
  const edits = tg.calls('editMessageText');
  assert.ok(limited, 'a 429 came');
  assert.ok(edits[0].at - limitedAt >= 2000, 'the next edit waited retry_after');
  assert.match(String(edits.at(-1)!.body.text), /^✅ Done · 5 steps · /);
  // A partner's turn (no tools, so nothing to show): no progress message.
  const b = tg.sent.length;
  app.script.push(text('Hello Ann.'));
  await drive(clock, bridge.handle(dmFrom(FRIEND, { text: 'hi' }, 'Ann')));
  assert.ok(!tg.sent.slice(b).some((s) => s.method === 'editMessageText' || /^⏳/.test(String(s.body.text ?? ''))));
});

test('progress: no leaks (a vault secret and a URL in a tool\'s arguments and output never appear), only the verb', async (t) => {
  const clock = new ManualClock();
  const { app, bridge, tg } = await tgSetup(t, { clock });
  app.vault.set('provider:z', 'zz-very-secret-token-9988');
  addSlowTool(app, clock, 'leaky', 6000, 'fetched https://internal.example/x with zz-very-secret-token-9988');
  app.script.push([call('l1', 'leaky', { url: 'https://internal.example/x', token: 'zz-very-secret-token-9988' })], [call('l2', 'leaky', { url: 'https://internal.example/y' })], text('ok'));
  await drive(clock, bridge.handle(dmFrom(OWNER, { text: 'leak test' })));
  const shown = tg.sent.filter((s) => s.method === 'editMessageText' || (s.method === 'sendMessage' && /^⏳/.test(String(s.body.text)))).map((s) => String(s.body.text));
  assert.ok(shown.length >= 2);
  for (const x of shown) {
    assert.ok(!x.includes('zz-very-secret') && !x.includes('internal.example'), x);
  }
  assert.ok(shown.some((x) => x.includes('Using leaky')), 'the step verb');
});

test('progress: Stop from the progress message stops the turn for the owner; a partner\'s press is refused and changes nothing', async (t) => {
  const clock = new ManualClock();
  const { app, bridge, tg } = await tgSetup(t, { clock });
  addSlowTool(app, clock, 'slow', 8000);
  app.script.push([call('t1', 'slow', {})], [call('t2', 'slow', {})], [call('t3', 'slow', {})], text('never'));
  const turn = bridge.handle(dmFrom(OWNER, { text: 'long' }));
  await clock.advance(11_000);
  const conv = app.store.findChannelConversation('telegram', String(OWNER))!;
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q1', from: { id: FRIEND, first_name: 'Ann' }, data: `st:${conv.id}` } } as never);
  assert.match(String(tg.calls('answerCallbackQuery').at(-1)!.body.text), /Only the person who runs me can stop this/);
  await clock.advance(2000);
  await bridge.handle({ update_id: uid++, callback_query: { id: 'q2', from: { id: OWNER, first_name: 'Alex' }, data: `st:${conv.id}` } } as never);
  await drive(clock, turn);
  const fin = tg.calls('editMessageText').at(-1)!;
  assert.match(String(fin.body.text), /^⏹ Stopped after 2 steps$/);
  assert.ok(!tg.texts(OWNER).includes('never'));
});

test('pacing: while progress edits wait, her reply goes first; edits for one message are coalesced', async () => {
  const clock = new ManualClock();
  const q = new SendQueue({ clock });
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = q.send('k', PRIO_EDIT, async () => {
    await gate;
    order.push('edit-0');
  }, 'p');
  await settle();
  const e1 = q.send('k', PRIO_EDIT, async () => void order.push('edit-1'), 'p');
  const e2 = q.send('k', PRIO_EDIT, async () => void order.push('edit-2'), 'p');
  const r = q.send('k', PRIO_REPLY, async () => void order.push('reply'));
  release();
  await Promise.all([first, e1, e2, r]);
  assert.deepEqual(order, ['edit-0', 'reply', 'edit-2'], 'reply first; edit-1 replaced by edit-2');
  // A 429 pauses the lane and retries.
  let tries = 0;
  const p = q.send('k', PRIO_REPLY, async () => {
    if (tries++ === 0) throw new RateLimited(1500);
    return 'sent';
  });
  await clock.advance(1600);
  assert.equal(await p, 'sent');
});

test('restart: a leftover bridge_progress row gets the "Interrupted" edit at start-up and is removed', async (t) => {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: new Date('2026-11-01T12:00:00Z') });
  const tg = await fakeTelegram();
  t.after(() => {
    tg.close();
    app.store.close();
    cleanup();
  });
  app.settings.update({ telegram: { enabled: true, allowOthers: false, mirror: false, ownerChatId: OWNER } });
  app.vault.set(TELEGRAM_VAULT, TG_TOKEN);
  openProgress(app, 'conv-1', 'telegram', String(OWNER), '321');
  const bridge = new TelegramBridge(app, { apiBase: tg.url });
  await bridge.restart();
  await bridge.leftovers;
  await bridge.menus;
  bridge.stop();
  const e = tg.calls('editMessageText')[0];
  assert.equal(e.body.message_id, 321);
  assert.equal(e.body.text, '⏹ Interrupted (Sara restarted)');
  assert.deepEqual(takeLeftoverProgress(app, 'telegram'), [], 'removed');
});

test('progress message unit: folding, at most 6 lines, final states', async () => {
  const clock = new ManualClock();
  const sent: string[] = [];
  const pm = new ProgressMessage({ port: { create: async (x) => (sent.push(x), 'r1'), edit: async (_r, x) => void sent.push(x) }, queue: new SendQueue({ clock }), key: 'k', clock, afterMs: 1000, intervalMs: 500, final: 'summary', lang: 'en', owner: true, scrub: (x) => x }).start();
  for (let i = 0; i < 9; i++) {
    pm.event({ type: 'tool_call', id: `c${i}`, name: i < 3 ? 'read_file' : `tool${i}`, summary: '', args: {} });
    pm.event({ type: 'tool_result', id: `c${i}`, name: 'x', status: i === 4 ? 'error' : 'ok', output: 'SECRET OUTPUT', ms: 1 });
  }
  await clock.advance(1200);
  const body = pm.render().split('\n');
  assert.ok(body.length <= 7, 'header + at most 6 lines');
  assert.match(body[1], /^… and \d+ earlier steps$/);
  assert.ok(!pm.render().includes('SECRET OUTPUT'));
  pm.event({ type: 'error', message: 'Stopped.' });
  await drive(clock, pm.finish());
  assert.equal(sent.at(-1), '⏹ Stopped after 9 steps');
  // Spanish owner: the same verbs as the web step line, translated.
  const es = new ProgressMessage({ port: { create: async () => 'r', edit: async () => undefined }, queue: new SendQueue({ clock }), key: 'k2', clock, afterMs: 0, intervalMs: 0, final: 'summary', lang: 'es', owner: true, scrub: (x) => x });
  es.event({ type: 'tool_call', id: 'a', name: 'shell', summary: '', args: { command: 'npm test' } });
  assert.match(es.render(), /▸ Ejecutando las pruebas…|▸ \S/);
});

// ------------------------------------------------------------------ storage, cleanup, safety, small fixes

test('cleanup: other people\'s picture bytes go after 7 days (the message is marked), copies expire, deleting a conversation removes its files', async (t) => {
  const { dir, cleanup } = tempDir();
  const time = { now: new Date('2026-11-01T12:00:00Z') };
  const app = makeApp(dir, time);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const conv = app.store.createConversation({ title: 'Ann', channel: 'telegram', channelKey: '5', partner: 'Ann' });
  const id = app.uploads!.saveBytes(png(999)).id;
  const msg = app.store.addMessage(conv.id, 'user', '(photo) [described]', { othersPhotos: [id] });
  recordShared(app, { conversationId: conv.id, messageId: msg.id, direction: 'in', bridge: 'telegram', chatKey: '5', sender: 'person', kind: 'photo', uploadId: id, status: 'ok', bytes: 999 });
  const own = app.store.createConversation({ title: 'me' });
  mkdirSync(join(dir, 'shared'), { recursive: true });
  const copy = join(dir, 'shared', 'abc');
  writeFileSync(copy, 'x');
  const fileRow = recordShared(app, { conversationId: own.id, direction: 'out', bridge: 'web', chatKey: own.id, sender: 'her', kind: 'file', name: 'a.txt', path: copy, status: 'ok', bytes: 1, expiresAt: new Date(time.now.getTime() + 30 * 86_400_000).toISOString() });
  assert.deepEqual(sweepShared(app), { photos: 0, files: 0, rows: 0 }, 'nothing yet');
  time.now = new Date(time.now.getTime() + 8 * 86_400_000);
  const r = sweepShared(app);
  assert.equal(r.photos, 1);
  assert.equal(app.uploads!.get(id), undefined, 'bytes gone');
  const marked = app.store.messageById(msg.id)!;
  assert.deepEqual(marked.meta?.othersPhotos, []);
  assert.equal(marked.meta?.photoMarks, 1);
  assert.equal(marked.content, '(photo) [described]', 'the description stays');
  time.now = new Date(time.now.getTime() + 30 * 86_400_000);
  assert.equal(sweepShared(app).files, 1);
  assert.equal(existsSync(copy), false);
  assert.equal(conversationFiles(app, own.id)[0].status, 'expired', 'the row stays');
  void fileRow;
  forgetConversationFiles(app, own.id);
  assert.equal(conversationFiles(app, own.id).length, 0);
  assert.ok(mediaDb(app));
});

test('safety: a crisis caption gets the crisis resources; a new partner chat that starts with a photo still gets the AI notice first', async (t) => {
  const { app, bridge, tg } = await tgSetup(t, { settings: { chats: { media: { photosFromOthers: 'describe' } } } });
  tg.files.set('photos/cr-0', png(222));
  app.script.push(text('I am here with you.'));
  await bridge.handle(dmFrom(OWNER, { photo: sizes('cr', [222]), caption: 'I want to kill myself' }));
  assert.ok(tg.texts(OWNER).some((x) => x.includes(CRISIS_RESOURCES.slice(0, 30))), 'crisis resources');
  tg.files.set('photos/np-0', png(223));
  app.script.push(text('LABEL: ok\nDESCRIPTION: A dog.'), text('Cute dog!'));
  await bridge.handle(dmFrom(3003, { photo: sizes('np', [223]) }, 'Bo'));
  const bo = tg.texts(3003);
  assert.match(bo[0], /AI/, 'the disclosure first');
  assert.equal(bo.at(-1), 'Cute dog!');
});

test('small fixes: a plugin bridge\'s document is no longer labelled Telegram', () => {
  assert.equal(chatOrigin('plugin-line'), 'plugin');
  assert.equal(chatOrigin('telegram-work'), 'telegram');
  assert.equal(chatOrigin('discord-nsfw'), 'discord');
});

// ------------------------------------------------------------------ the plugin bridge contract v1.1

async function pluginRig(t: { after: (fn: () => Promise<void> | void) => void }, perms: Record<string, unknown>, def: string, clock: ManualClock) {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date() });
  app.companionId = 'main';
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: new Date().toISOString() });
  const pm = new PluginManager({ db: app.store.db, dataDir: dir, vault: app.vault, sandbox: app.sandbox, events: app.events, scrub: (x) => app.redactor.redact(x), fence: 'node-only', saraVersion: '2.31.0', clock });
  app.pluginManager = pm;
  pm.attach('main', app);
  t.after(async () => {
    await pm.stopAll();
    app.store.close();
    cleanup();
  });
  const src = join(ROOT, 'examples', 'plugins', 'hello-hooks');
  cpSync(src, join(dir, 'br'), { recursive: true });
  cpSync(join(ROOT, 'examples', 'plugins', 'sara-plugin.mjs'), join(dir, 'br', 'sara-plugin.mjs'));
  const man = JSON.parse(readFileSync(join(dir, 'br', 'sara-plugin.json'), 'utf8'));
  writeFileSync(join(dir, 'br', 'sara-plugin.json'), JSON.stringify({ ...man, id: 'line-bridge', name: 'LINE bridge', permissions: { bridges: ['line'], settings: true, ...perms }, settings: [] }));
  writeFileSync(join(dir, 'br', 'main.mjs'), `import { plugin } from './sara-plugin.mjs';\nplugin(${def});\n`);
  const review = pm.stage(fromFolder(join(dir, 'br'), PLUGIN_LIMITS), { kind: 'folder', where: join(dir, 'br') });
  await pm.approve(review.id, { trust: true });
  await pm.setEnabled('line-bridge', 'main', true);
  await pm.putSettings('line-bridge', 'main', {}, { ownerChats: ['U-owner'], others: false });
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 25));
  };
  await until(() => pm.processOf('line-bridge', 'main')?.state === 'ready');
  app.runTracked = async (id, content, onEvent, opts) => {
    for await (const ev of runTurn(app, id, content, undefined, opts)) onEvent(ev);
  };
  const proc = pm.processOf('line-bridge', 'main')!;
  const out: Record<string, unknown>[] = [];
  const orig = proc.send.bind(proc);
  (proc as { send: (m: Record<string, unknown>) => void }).send = (m) => {
    out.push(m);
    orig(m as never);
  };
  const op = (name: string, m: Record<string, unknown>) => (proc as unknown as { events: { onCall: (op: string, msg: Record<string, unknown>) => Promise<Record<string, unknown>> } }).events.onCall(name, { type: 'call', ...m } as never).catch((err: Error): Record<string, unknown> => ({ denied: err.message }));
  return { app, pm, out, op };
}

test('plugin bridge v1.1: an opted-in plugin gets a progress ref and edits and a chunked picture reaches the turn; a v1 plugin stays text only; bridge.file without bridgeFiles is denied and logged', async (t) => {
  const clock = new ManualClock();
  const r = await pluginRig(t, { bridgeFiles: true }, "{ bridge: { files: true, edit: true }, bridges: { line: { send: async () => {}, edit: async () => {} } }, tools: [], init: async () => {} }", clock);
  addSlowTool(r.app, clock, 'slow', 6000);
  // A chunked picture (two chunks).
  const pic = png(600 * 1024);
  const half = 512 * 1024;
  assert.deepEqual(await r.op('bridge.file', { bridge: 'line', chatId: 'U-owner', fileId: 'f1', name: 'p.png', mime: 'image/png', size: pic.length, seq: 0, last: false, data: pic.subarray(0, half).toString('base64') }), { ok: true, received: half });
  await r.op('bridge.file', { bridge: 'line', chatId: 'U-owner', fileId: 'f1', seq: 1, last: true, data: pic.subarray(half).toString('base64') });
  r.app.script.push([call('p1', 'slow', {})], [call('p2', 'slow', {})], text('Lovely.'));
  const res = await drive(clock, r.op('bridge.inbound', { bridge: 'line', chatId: 'U-owner', from: 'Me', text: 'look', files: [{ fileId: 'f1' }] }));
  assert.equal(res.ok, true);
  const conv = r.app.store.getConversation(String(res.conversation))!;
  const user = r.app.store.messages(conv.id).find((m) => m.role === 'user')!;
  assert.equal((user.meta?.images as string[]).length, 1, 'the picture reached the turn');
  const refd = r.out.filter((m) => m.type === 'bridge.send' && m.ref);
  assert.equal(refd.length, 1, 'one progress message with a ref');
  const edits = r.out.filter((m) => m.type === 'bridge.edit' && m.ref === refd[0].ref);
  assert.ok(edits.length >= 1);
  assert.match(String(edits.at(-1)!.text), /^✅ Done · 2 steps · /);
  assert.ok(r.out.some((m) => m.type === 'bridge.send' && m.text === 'Lovely.'));
  // Its Stop is checked to be an owner chat.
  assert.deepEqual(await r.op('bridge.inbound', { bridge: 'line', chatId: 'U-owner', action: 'stop', ref: String(refd[0].ref) }), { ok: true, stopped: false });
});

test('plugin bridge v1: no ready.bridge → exactly today\'s text messages; bridge.file without the permission is denied and logged', async (t) => {
  const clock = new ManualClock();
  const r = await pluginRig(t, {}, "{ bridges: { line: { send: async () => {} } }, tools: [], init: async () => {} }", clock);
  addSlowTool(r.app, clock, 'slow', 6000);
  r.app.script.push([call('v1', 'slow', {})], [call('v2', 'slow', {})], text('Plain text.'));
  const res = await drive(clock, r.op('bridge.inbound', { bridge: 'line', chatId: 'U-owner', from: 'Me', text: 'hi' }));
  assert.equal(res.ok, true);
  assert.ok(r.out.length >= 1);
  assert.ok(r.out.every((m) => Object.keys(m).sort().join(',') === 'bridge,chatId,text,type,v'), 'only plain bridge.send text messages (no ref, no edit, no files)');
  assert.equal(r.out.at(-1)!.text, 'Plain text.');
  const denied = await r.op('bridge.file', { bridge: 'line', chatId: 'U-owner', fileId: 'f9', size: 10, seq: 0, last: true, data: 'aGVsbG8=' });
  assert.match(String((denied as { denied?: string }).denied), /bridgeFiles/);
  assert.ok(r.pm.store.logs('line-bridge').some((l) => l.kind === 'denied' && /bridgeFiles/.test(l.detail)));
});

for (const fault of ['response-lost', 'ack-write'] as const) {
  test(`Q3 caption uncertainty never repeats caption or falsely reports failure (${fault})`, async (t) => {
    const tg = await tgSetup(t);
    const dc = await dcSetup(t);
    for (const app of [tg.app, dc.app]) {
      deliveryFor(app);
      if (fault === 'ack-write') app.store.db.exec("CREATE TRIGGER deny_q3_ack BEFORE UPDATE ON deliveries WHEN NEW.state='acknowledged' BEGIN SELECT RAISE(ABORT,'synthetic ack failure'); END");
      addPhotoTool(app);
      app.script.push([call('q3-photo', 'take_photo', {})], text('Unique caption fixture.'));
    }
    if (fault === 'response-lost') { tg.tg.dropPhotos(); dc.rest.dropPhotos(); }
    await tg.bridge.handle(dmFrom(OWNER, {text:'selfie please'}));
    await dc.bridge.handleMessage({id:'q3',channel_id:'dm1',author:DC_OWNER,content:'selfie please'} as never);
    assert.equal(tg.tg.calls('sendPhoto').length,1);
    assert.equal(dc.rest.posts('dm1').filter(p=>p.form).length,1);
    assert.equal(tg.tg.texts(OWNER).some(text=>text==='Unique caption fixture.' || text.includes("couldn't send the picture")),false);
    assert.equal(dc.rest.posts('dm1').some(p=>!p.form && (p.body.content==='Unique caption fixture.' || String(p.body.content).includes("couldn't send the picture"))),false);
    assert.equal(deliveryFor(tg.app).list().filter(r=>r.state==='outcome_unknown' && r.operation==='sendPhoto').length,1);
    assert.equal(deliveryFor(dc.app).list().filter(r=>r.state==='outcome_unknown' && deliveryFor(dc.app).review(r.id).attachments?.length).length,1);
  });
}
