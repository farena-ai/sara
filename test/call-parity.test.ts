// R2a: one turn scope for text turns and live calls (docs/ops/R2_DESIGN.md). Fake engines and
// synthetic data only; no voice service is contacted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTurn, turnScope, type ChatEvent } from '../src/chat.ts';
import { LiveCall } from '../src/live.ts';
import { ADULT_OFF_NOTE } from '../src/safety.ts';
import { SESSION_CONTINUITY_MARK } from '../src/session-continuity.ts';
import type { WsConnection } from '../src/ws.ts';
import { makeApp, tempDir, text } from './helpers.ts';

const NOW = '2026-11-05T15:00:00.000Z';
function fixture() {
  const temp = tempDir();
  const clock = { now: new Date(NOW) };
  const app = makeApp(temp.dir, clock);
  app.settings.update({ providers: [{ id: 'p', label: 'Fixture', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', local: true }], defaultProviderId: 'p', defaultModel: 'fixture', ownerName: 'Alex', disclosureAcceptedAt: NOW } as never);
  app.tools.add({ spec: { name: 'read_notes', description: 'fixture read', parameters: {} }, defaultPermission: 'auto', summarize: () => 'Read notes', async run() { return 'Notes.'; } });
  app.tools.add({ spec: { name: 'send_note', description: 'fixture send', parameters: {} }, defaultPermission: 'ask', summarize: () => 'Send a note', async run() { return 'Sent.'; } });
  return { app, clock, close() { app.store.close(); temp.cleanup(); } };
}
const fakeClient = (): WsConnection => ({ send() {}, close() {}, open: true });
const liveFor = (app: ReturnType<typeof fixture>['app'], id: string) => new LiveCall(app, id, fakeClient(), 'test-key', { engine: 'grok' });
async function collect(it: AsyncIterable<ChatEvent>) { const out: ChatEvent[] = []; for await (const e of it) out.push(e); return out; }

test('turnScope matches runTurn tools and sections', async () => {
  const f = fixture();
  try {
    const other = f.app.store.createConversation();
    f.app.store.addMessage(other.id, 'user', 'Planning the ORCHARD_TRIP for Saturday.');
    f.app.store.addMessage(other.id, 'assistant', 'Saturday works for the orchard.');
    f.app.memory!.add({ kind: 'fact', content: 'Alex keeps bees on the roof', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
    const conv = f.app.store.createConversation();
    const scope = turnScope(f.app, f.app.store.getConversation(conv.id)!, { text: 'Tell me about the bees on the roof' });
    f.app.script.push(text('Okay.'));
    await collect(runTurn(f.app, conv.id, 'Tell me about the bees on the roof'));
    const req = f.app.requests[0];
    assert.deepEqual(scope.tools.map((t) => t.spec.name).sort(), (req.tools ?? []).map((t) => t.name).filter((n) => n !== 'find_tools').sort());
    const system = req.messages[0].content as string;
    for (const n of scope.sections.safetyNotes) assert.ok(system.includes(n), `safety note in text turn: ${n.slice(0, 40)}`);
    assert.equal(scope.adultOn, false);
    assert.ok(scope.sections.safetyNotes.includes(ADULT_OFF_NOTE));
    assert.match(scope.sections.memories ?? '', /bees on the roof/);
    assert.ok(system.includes('bees on the roof'));
    const session = req.messages.find((m) => m.role === 'system' && String(m.content).startsWith(SESSION_CONTINUITY_MARK));
    assert.ok(session && scope.sections.session, 'both carry the R1 session note');
    assert.match(scope.sections.session!, /ORCHARD_TRIP/);
    assert.match(String(session.content), /ORCHARD_TRIP/);
  } finally {
    f.close();
  }
});

test('member live call gets member tools not owner', () => {
  const owner = fixture();
  const member = fixture();
  try {
    member.app.member = { id: 'm1' } as never;
    member.app.settings.update({ toolPermissions: { send_note: 'never' } } as never);
    const oc = owner.app.store.createConversation();
    const mc = member.app.store.createConversation();
    const ownerNames = turnScope(owner.app, owner.app.store.getConversation(oc.id)!, {}).tools.map((t) => t.spec.name);
    const memberScope = turnScope(member.app, member.app.store.getConversation(mc.id)!, { call: 'live' });
    assert.ok(ownerNames.includes('send_note'));
    assert.ok(!memberScope.tools.some((t) => t.spec.name === 'send_note'), 'the member\'s own never rule applies');
    assert.equal(memberScope.sections.session, undefined, 'no owner session notes for a member');
    const live = liveFor(member.app, mc.id);
    assert.ok(!live.instructions().includes(SESSION_CONTINUITY_MARK));
  } finally {
    owner.close();
    member.close();
  }
});

test('live adult follows text rule on/off/voiceRoom', () => {
  const f = fixture();
  try {
    const web = f.app.store.createConversation();
    const room = f.app.store.createConversation({ channel: 'home-assistant' });
    assert.ok(liveFor(f.app, web.id).instructions().includes(ADULT_OFF_NOTE), 'off by default');
    f.app.settings.update({ adultMode: { on: true, confirmedAt: NOW } } as never);
    assert.ok(!liveFor(f.app, web.id).instructions().includes(ADULT_OFF_NOTE), 'on in his own chat, like text');
    assert.equal(turnScope(f.app, f.app.store.getConversation(web.id)!, { call: 'live' }).adultOn, true);
    const roomScope = turnScope(f.app, f.app.store.getConversation(room.id)!, { call: 'live' });
    assert.equal(roomScope.voiceRoom, true);
    assert.equal(roomScope.adultOn, false);
    assert.ok(liveFor(f.app, room.id).instructions().includes(ADULT_OFF_NOTE), 'a voice room never gets adult mode');
  } finally {
    f.close();
  }
});

test('forgotten message absent from live instructions', () => {
  const f = fixture();
  try {
    const conv = f.app.store.createConversation();
    const gone = f.app.store.addMessage(conv.id, 'user', 'my locker code is FORGET_ME_731');
    f.app.store.addMessage(conv.id, 'assistant', 'Noted.');
    f.app.store.updateMessageMeta(gone.id, { forgotten: true });
    const other = f.app.store.createConversation();
    const gone2 = f.app.store.addMessage(other.id, 'user', 'the vault is ALSO_GONE_552');
    f.app.store.addMessage(other.id, 'assistant', 'Okay.');
    f.app.store.updateMessageMeta(gone2.id, { forgotten: true });
    const ins = liveFor(f.app, conv.id).instructions();
    assert.ok(!ins.includes('FORGET_ME_731'));
    assert.ok(!ins.includes('ALSO_GONE_552'));
  } finally {
    f.close();
  }
});

test('revoked session note absent after edit', () => {
  const f = fixture();
  try {
    const other = f.app.store.createConversation();
    f.app.store.addMessage(other.id, 'user', 'The boat is called ALPHA_SLOOP_42.');
    const later = f.app.store.addMessage(other.id, 'assistant', 'Lovely name for a boat.');
    const conv = f.app.store.createConversation();
    const live = liveFor(f.app, conv.id);
    const first = live.instructions();
    assert.ok(first.includes(SESSION_CONTINUITY_MARK), 'the R1 session note is on the call');
    assert.match(first, /ALPHA_SLOOP_42/);
    // Forgetting any line of that conversation withdraws it as a session source (R1 rule).
    f.app.store.updateMessageMeta(later.id, { forgotten: true });
    assert.ok(!live.instructions().includes('ALPHA_SLOOP_42'));
  } finally {
    f.close();
  }
});
