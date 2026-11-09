// EC11: share a conversation as a read-only, expiring, revocable snapshot (docs/ops/EC1115_DESIGN.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Redactor } from '../src/redact.ts';
import { buildSnapshot, scrubForShare, SHARE_EXPIRY, shareRefusal, ShareStore } from '../src/share.ts';
import type { Conversation, StoredMessage } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const SECRET = 'vault-secret-value-1234';
const red = new Redactor(() => [SECRET]);
const conv = (o: Partial<Conversation> = {}): Conversation => ({ id: 'c1', title: 'Trip plans', providerId: null, model: null, workspace: 'main', mode: 'chat', private: false, channel: 'web', channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '2026-11-07T10:00:00Z', updatedAt: '2026-11-07T10:00:00Z', ...o });
let mid = 0;
const msg = (role: StoredMessage['role'], content: string, meta?: Record<string, unknown>): StoredMessage => ({ id: ++mid, conversationId: 'c1', role, content, createdAt: '2026-11-07T10:00:00Z', ...(meta ? { meta } : {}) });

test('EC11 scrub: keys, vault secrets, e-mail and phone numbers are hidden; dates and prices are not', () => {
  const r = scrubForShare(`key sk-ant-${'a'.repeat(30)} and ${SECRET}, mail alex@example.com, call +1 (555) 123-4567 on 2026-11-07 for $1,200.50`, red);
  assert.ok(!r.text.includes('sk-ant-'));
  assert.ok(!r.text.includes(SECRET));
  assert.ok(!r.text.includes('alex@example.com') && r.text.includes('[email]'));
  assert.ok(!r.text.includes('555') && r.text.includes('[phone]'));
  assert.ok(r.text.includes('2026-11-07') && r.text.includes('$1,200.50'));
  assert.equal(r.n, 4);
});

test('EC11 refusals: off the record, partner, adult, group, imported always; private and private local unless allowed', () => {
  assert.equal(shareRefusal(conv(), {}), undefined);
  assert.match(shareRefusal(conv(), { offRecord: true })!, /off.the.record/i);
  assert.match(shareRefusal(conv({ partner: 'Sam' }), {})!, /someone else/i);
  assert.match(shareRefusal(conv({ channel: 'telegram-nsfw' }), {})!, /adult/i);
  assert.match(shareRefusal(conv({ channel: 'group:1' }), {})!, /group/i);
  assert.match(shareRefusal(conv({ channel: 'import-chatgpt' }), {})!, /imported/i);
  assert.match(shareRefusal(conv({ private: true }), {})!, /private/i);
  assert.equal(shareRefusal(conv({ private: true }), { allowPrivate: true }), undefined);
  assert.match(shareRefusal(conv(), { privateLocal: true })!, /private local/i);
  assert.equal(shareRefusal(conv(), { privateLocal: true, allowPrivate: true }), undefined);
  // Allowing private chats never opens off-the-record or partner chats.
  assert.ok(shareRefusal(conv(), { offRecord: true, allowPrivate: true }));
  assert.ok(shareRefusal(conv({ partner: 'Sam' }), { allowPrivate: true }));
});

test('EC11 snapshot: tool output and pictures are left out unless chosen; notices and call arguments never', () => {
  const messages = [
    msg('user', 'Find flights, my mail is alex@example.com', { images: ['img1'] }),
    msg('assistant', '', { toolCalls: [{ id: 't', name: 'web_search', arguments: { q: SECRET } }] }),
    msg('tool', `result with token=${'x'.repeat(12)} ${'y'.repeat(3000)}`, { name: 'web_search', toolCallId: 't' }),
    msg('notice', 'Sara is an AI (disclosure)'),
    msg('assistant', 'Here are three flights.'),
  ];
  const picture = (id: string) => (id === 'img1' ? { mime: 'image/png', data: Buffer.from('png').toString('base64') } : undefined);
  const plain = buildSnapshot(conv(), messages, { tools: false, pictures: false }, { redact: red, picture, companion: 'Sara' });
  assert.deepEqual(plain.snapshot.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(plain.snapshot.hidden.tools, 1);
  assert.equal(plain.snapshot.hidden.pictures, 1);
  assert.equal(plain.pictures.length, 0);
  assert.ok(plain.snapshot.messages[0].text.includes('[email]'));
  assert.ok(!JSON.stringify(plain.snapshot).includes(SECRET), 'tool-call arguments are never shared');
  const full = buildSnapshot(conv(), messages, { tools: true, pictures: true }, { redact: red, picture, companion: 'Sara' });
  assert.deepEqual(full.snapshot.messages.map((m) => m.role), ['user', 'tool', 'assistant']);
  const tool = full.snapshot.messages[1];
  assert.equal(tool.name, 'web_search');
  assert.ok(tool.text.length <= 2001 + 20 && !tool.text.includes('x'.repeat(12)));
  assert.deepEqual(full.snapshot.messages[0].pics, [0]);
  assert.equal(full.pictures.length, 1);
});

test('EC11 store: 256-bit token shown once, only its hash kept; expiry, revoke and views', () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-07T12:00:00Z') };
  const s = new ShareStore(dir, () => clock.now);
  try {
    const snap = buildSnapshot(conv(), [msg('user', 'hello'), msg('assistant', 'hi')], { tools: false, pictures: false }, { redact: red, companion: 'Sara' });
    const a = s.create({ space: 'owner', companion: 'main', conversationId: 'c1', expires: '1d', options: { tools: false, pictures: false }, ...snap });
    assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
    const raw = Buffer.concat(['shares.db', 'shares.db-wal'].map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f)) : Buffer.alloc(0))));
    assert.ok(!raw.includes(Buffer.from(a.token)), 'the token itself is never stored');
    assert.ok(raw.includes(Buffer.from(createHash('sha256').update(a.token).digest('hex'))));
    const v1 = s.open(a.token);
    assert.equal(v1?.first, true);
    assert.equal(v1?.share.snapshot.messages[1].text, 'hi');
    assert.equal(s.open(a.token)?.first, false);
    assert.equal(s.list()[0].views, 2);
    assert.equal(s.open(a.token.slice(0, -1) + (a.token.endsWith('A') ? 'B' : 'A')), undefined);
    clock.now = new Date(clock.now.getTime() + SHARE_EXPIRY['1d'] + 1000);
    assert.equal(s.open(a.token), undefined, 'expired');
    const b = s.create({ space: 'owner', companion: 'main', conversationId: 'c1', expires: '7d', options: { tools: false, pictures: false }, ...snap });
    assert.ok(s.open(b.token));
    assert.equal(s.revoke(b.id)?.views, 1);
    assert.equal(s.open(b.token), undefined, 'revoke ends access at once');
    const c = s.create({ space: 'owner', companion: 'main', conversationId: 'c1', expires: '30d', options: { tools: false, pictures: true }, snapshot: snap.snapshot, pictures: [{ mime: 'image/png', data: Buffer.from('png') }] });
    assert.equal(s.picture(c.token, 0)?.data.toString(), 'png');
    assert.equal(s.revokeConversation('owner', 'main', 'c1'), 1);
    assert.equal(s.picture(c.token, 0), undefined);
    assert.throws(() => s.create({ space: 'owner', companion: 'main', conversationId: 'c1', expires: 'never' as '1d', options: { tools: false, pictures: false }, ...snap }), /expiry/i);
    assert.equal(s.settings().allowPrivate, false);
    s.setSettings({ allowPrivate: true });
    assert.equal(s.settings().allowPrivate, true);
  } finally {
    s.close();
    cleanup();
  }
});
