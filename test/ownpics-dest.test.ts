// Pictures from her: an explicit destination. A chat just for her pictures by default (never whichever
// chat came first), one of his own chats, a project's chat, and/or his Telegram/Discord chat with her
// (only when that app is connected). The old "also to my chat apps" switch carries over. "Send one now"
// runs in the background, one at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maybeOwnPhoto, ownDest, ownTargets, startOwnPhotoJob, type OwnStep } from '../src/own-photos.ts';
import type { Conversation } from '../src/store.ts';
import type { Tool } from '../src/tools/types.ts';
import { makeApp, tempDir, text, type TestApp } from './helpers.ts';

const PNG = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const NOON = new Date('2026-11-07T18:00:00Z');

function setup(t: { after: (fn: () => void) => void }, own: Record<string, unknown> = {}) {
  const { dir, cleanup } = tempDir();
  const app: TestApp = makeApp(dir, { now: NOON });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x', defaultModel: 'm' }], defaultProviderId: 'p', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: NOON.toISOString(), photos: { mode: 'new', own: { on: true, ...own } } });
  let gate: Promise<void> | undefined;
  const take: Tool = {
    defaultPermission: 'auto',
    source: 'built-in',
    spec: { name: 'take_photo', description: '', parameters: { type: 'object' } },
    summarize: () => '',
    run: async (_a, ctx) => {
      await gate;
      ctx.attachImage?.(app.uploads!.save(PNG).id);
      return 'ok';
    },
  };
  app.tools.add(take);
  const first = app.store.createConversation({ channel: 'web', title: 'Trip planning' });
  app.store.addMessage(first.id, 'user', 'hey, how is your day?');
  app.store.addMessage(first.id, 'assistant', 'Lovely!');
  const say = () => app.script.push(text('SCENE: a cozy reading nook with a cup of tea, soft window light\nCAPTION: Quiet afternoon.'));
  // Fake bridges: connected or not, recording what they were asked to send.
  const sent: { kind: string; caption: string; files: number }[] = [];
  const bridge = (kind: 'telegram' | 'discord', running: boolean) => {
    const conv = app.store.createConversation({ channel: kind, channelKey: kind === 'telegram' ? '1001' : 'dm-1', title: kind === 'telegram' ? 'Telegram' : 'Discord' });
    return {
      status: () => ({ running, linked: true }),
      sendOwnPicture: async (files: unknown[], caption: string): Promise<Conversation> => {
        sent.push({ kind, caption, files: files.length });
        return conv;
      },
      conv,
    };
  };
  return { app, first, say, sent, bridge, hold: (p: Promise<void>) => (gate = p) };
}
const now = (app: TestApp, onStep?: (s: OwnStep) => void) => maybeOwnPhoto(app, { force: true, onStep });

test('ownpics dest: default is a chat just for her pictures, made once and reused; nothing in his other chats or apps', async (t) => {
  const s = setup(t);
  const tg = s.bridge('telegram', true);
  s.app.bridges = { telegram: tg } as never;
  assert.deepEqual(ownTargets(s.app).to, [{ kind: 'chat', name: `Pictures from ${s.app.persona.name}` }]);
  s.say();
  const steps: OwnStep[] = [];
  const r = await now(s.app, (x) => steps.push(x));
  assert.deepEqual(steps, ['scene', 'picture', 'sending']);
  const id = r.sent!.conversationId!;
  assert.equal(s.app.store.getConversation(id)!.title, `Pictures from ${s.app.persona.name}`);
  assert.equal(s.app.store.messages(s.first.id).length, 2, 'not in the chat that came first');
  assert.equal(s.sent.length, 0, 'apps only when chosen');
  s.app.settings.update({ photos: { ...s.app.settings.get().photos!, own: { ...s.app.settings.get().photos!.own!, sent: [] } } });
  s.say();
  assert.equal((await now(s.app)).sent!.conversationId, id, 'the same chat next time');
  assert.equal(s.app.store.listConversations().filter((c) => c.title.startsWith('Pictures from')).length, 1);
});

test('ownpics dest: one of his own chats, or a project (its own "Pictures from" chat inside it)', async (t) => {
  const s = setup(t);
  const mine = s.app.store.createConversation({ channel: 'web', title: 'Evenings' });
  s.app.settings.update({ photos: { mode: 'new', own: { on: true, dest: { here: 'chat', chatId: mine.id } } } });
  assert.deepEqual(ownTargets(s.app).to, [{ kind: 'chat', name: 'Evenings' }]);
  s.say();
  assert.equal((await now(s.app)).sent!.conversationId, mine.id);
  const project = { id: s.app.planner!.projectId('Garden')! };
  s.app.settings.update({ photos: { mode: 'new', own: { on: true, dest: { here: 'project', projectId: project.id } } } });
  assert.deepEqual(ownTargets(s.app).to, [{ kind: 'project', name: 'Garden' }]);
  s.say();
  const r = await now(s.app);
  const conv = s.app.store.getConversation(r.sent!.conversationId!)!;
  assert.equal(conv.projectId, project.id);
  assert.equal(conv.channel, 'web');
  assert.deepEqual(r.sent!.to, [{ kind: 'project', name: 'Garden' }]);
  s.app.settings.update({ photos: { mode: 'new', own: { on: true, dest: { here: 'project', projectId: 999 } } } });
  assert.equal((await now(s.app)).skipped, 'no project');
});

test('ownpics dest: Telegram only goes straight to his Telegram chat and is kept in that conversation; not connected = a plain reason', async (t) => {
  const s = setup(t, { dest: { here: 'none', telegram: true } });
  assert.equal((await now(s.app)).skipped, 'apps not connected');
  const tg = s.bridge('telegram', true);
  const dc = s.bridge('discord', false);
  s.app.bridges = { telegram: tg, discord: dc } as never;
  assert.deepEqual(ownTargets(s.app).to, [{ kind: 'telegram' }]);
  s.say();
  const r = await now(s.app);
  assert.deepEqual(s.sent, [{ kind: 'telegram', caption: 'Quiet afternoon.', files: 1 }]);
  assert.equal(r.sent!.conversationId, tg.conv.id, 'kept in her Telegram chat with him (so it is in her Photos)');
  assert.deepEqual(r.sent!.to, [{ kind: 'telegram' }]);
  assert.equal(s.app.store.listConversations().filter((c) => c.title.startsWith('Pictures from')).length, 0, 'no chat made here');
  // A chat here + Discord while Discord is down: the chat gets it, Discord is reported as missed.
  s.app.settings.update({ photos: { mode: 'new', own: { on: true, dest: { here: 'own', discord: true } } } });
  assert.deepEqual(ownTargets(s.app).missing, ['discord']);
  s.say();
  const r2 = await now(s.app);
  assert.equal(r2.sent!.to[0].kind, 'chat');
  assert.deepEqual(r2.missed, [{ kind: 'discord', why: 'not connected' }]);
});

test('ownpics dest: the old "also to my chat apps" switch means a chat here + Telegram + Discord', () => {
  assert.deepEqual(ownDest({ on: true, often: 'rarely', monthlyCap: 8, toApps: true }), { here: 'own', telegram: true, discord: true });
  assert.deepEqual(ownDest({ on: true, often: 'rarely', monthlyCap: 8 }), { here: 'own', telegram: false, discord: false });
  assert.deepEqual(ownDest({ on: true, often: 'rarely', monthlyCap: 8, toApps: true, dest: { here: 'none', telegram: true } }), { here: 'none', telegram: true, discord: false });
});

test('ownpics job: Send one now runs once at a time in the background', async (t) => {
  const s = setup(t);
  let release!: () => void;
  s.hold(new Promise<void>((r) => (release = r)));
  s.say();
  const a = startOwnPhotoJob(s.app);
  assert.equal(a.started, true);
  assert.equal(a.job.running, true);
  const b = startOwnPhotoJob(s.app);
  assert.equal(b.started, false, 'one at a time');
  for (let i = 0; i < 100 && a.job.step !== 'picture'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(a.job.step, 'picture');
  release();
  for (let i = 0; i < 100 && a.job.running; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(a.job.step, 'done');
  assert.equal(a.job.result?.sent?.caption, 'Quiet afternoon.');
  assert.equal(startOwnPhotoJob(s.app).started, true, 'a new one can start after');
});
