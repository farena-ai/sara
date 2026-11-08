// EC17 follow-up (docs/ops/EC1617_DESIGN.md, "Edit history while held"): while a legal hold is on,
// rewriting a message or a memory in place keeps the previous version in an append-only edit history
// (database triggers, so every edit path is covered), exported with the person's data and visible
// to the owner. A hold preserves content, not just existence.
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { AuditTrail, auditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { DataRights, setDataRights, type PersonSpace } from '../src/data-rights.ts';
import { HouseholdStore } from '../src/household.ts';
import { editHistory, setDbHold } from '../src/legal-hold.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const clock = { now: new Date('2026-11-07T12:00:00Z') };

function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8); const size = buf.readUInt32LE(i + 18); const nameLen = buf.readUInt16LE(i + 26); const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8'); const start = i + 30 + nameLen + extra;
    const data = buf.subarray(start, start + size);
    out.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    i = start + size;
  }
  return out;
}

function world() {
  const { dir: root, cleanup } = tempDir();
  const household = new HouseholdStore(root);
  const { code } = household.invite({ name: 'Robin', hours: 24, confirm18: true, limits: { models: [{ providerId: 'p', model: 'm' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } });
  const { member, dir } = household.redeem(code, true);
  const owner = makeApp(root, clock); const memberApp = makeApp(dir, clock);
  const spaces = (): PersonSpace[] => [
    { person: 'owner', name: 'Owner', dir: root, apps: () => [owner] },
    { person: member.id, name: member.name, dir, apps: () => [memberApp] },
  ];
  const rights = new DataRights(root, { spaces, deleteMember: async () => {} }, () => clock.now);
  setDataRights(rights);
  setAuditTrail(new AuditTrail(root, { redact: (s) => s, key: () => 'k'.repeat(64), policyRev: () => 0 }));
  return { root, owner, member: memberApp, memberId: member.id, rights, cleanup: () => { setDataRights(undefined); setAuditTrail(undefined); setPolicy(new PolicyStore()); owner.store.close(); memberApp.store.close(); cleanup(); } };
}

test('edit history: nothing is kept without a hold; while held each in-place rewrite keeps the previous text', () => {
  const w = world();
  try {
    const db = w.member.store.db;
    const conv = w.member.store.createConversation({ title: 't' });
    const msg = w.member.store.addMessage(conv.id, 'user', 'first words');
    const mem = w.member.memory!.add({ kind: 'fact', content: 'likes tea', conversationId: null, sourceMessageId: null, happenedOn: '2026-11-01' });
    w.member.store.updateMessageContent(msg.id, 'before the hold');
    assert.equal(editHistory(db).length, 0);
    w.rights.setHolds({ people: [w.memberId] });
    w.member.store.updateMessageContent(msg.id, 'second words');
    w.member.store.updateMessageContent(msg.id, 'third words');
    w.member.store.updateMessageContent(msg.id, 'third words'); // no change, no row
    w.member.memory!.update(mem.id, 'likes coffee');
    w.member.memory!.setPinned(mem.id, true); // a flag change is not a rewrite
    const rows = editHistory(db);
    assert.deepEqual(rows.map((r) => [r.kind, r.rowId, r.previous]), [
      ['message', msg.id, 'before the hold'],
      ['message', msg.id, 'second words'],
      ['memory', mem.id, 'likes tea'],
    ]);
    assert.equal(rows[0].conversationId, conv.id);
    assert.ok(rows.every((r) => !r.withheld && typeof r.editedAt === 'string'));
    // The owner's space is not held: its edits keep nothing.
    const oc = w.owner.store.createConversation({});
    const om = w.owner.store.addMessage(oc.id, 'user', 'owner text');
    w.owner.store.updateMessageContent(om.id, 'owner edit');
    assert.equal(editHistory(w.owner.store.db).length, 0);
  } finally { w.cleanup(); }
});

test('edit history: append-only (no update ever, no delete while held), and gone with its message once released', () => {
  const w = world();
  try {
    const db = w.member.store.db;
    const conv = w.member.store.createConversation({});
    const msg = w.member.store.addMessage(conv.id, 'user', 'v1');
    setDbHold(db, true, clock.now);
    w.member.store.updateMessageContent(msg.id, 'v2');
    assert.throws(() => db.exec("UPDATE sara_edit_history SET previous = 'forged'"), /SARA_EDIT_HISTORY/);
    assert.throws(() => db.exec('DELETE FROM sara_edit_history'), /SARA_LEGAL_HOLD/);
    assert.equal(editHistory(db)[0].previous, 'v1');
    setDbHold(db, false);
    assert.throws(() => db.exec("UPDATE sara_edit_history SET previous = 'forged'"), /SARA_EDIT_HISTORY/);
    // After release the history goes with the chat it belongs to (no orphan copies of deleted text).
    w.member.store.deleteConversation(conv.id);
    assert.equal(editHistory(db).length, 0);
  } finally { w.cleanup(); }
});

test('edit history: a reply the safety layer replaced is recorded as an edit, without the blocked text', () => {
  const w = world();
  try {
    const db = w.member.store.db;
    const conv = w.member.store.createConversation({});
    const msg = w.member.store.addMessage(conv.id, 'assistant', 'unsafe reply text');
    setDbHold(db, true, clock.now);
    w.member.store.updateMessageContent(msg.id, 'I can’t help with that.', { withhold: true });
    const [row] = editHistory(db);
    assert.equal(row.withheld, true);
    assert.equal(row.previous, null);
    assert.ok(!JSON.stringify(editHistory(db)).includes('unsafe'));
    // The marker is cleared: the next ordinary edit keeps its text.
    w.member.store.updateMessageContent(msg.id, 'edited again');
    assert.equal(editHistory(db)[1].previous, 'I can’t help with that.');
  } finally { w.cleanup(); }
});

test('edit history: exported with the person and shown to the owner over HTTP (audited); members are refused', async () => {
  const w = world();
  const auth = new OwnerAuth(w.root); const token = auth.newToken!;
  const server = createSaraServer({ app: w.owner, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/data-rights`;
  const call = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  try {
    const conv = w.member.store.createConversation({});
    const msg = w.member.store.addMessage(conv.id, 'user', 'canary-before');
    w.rights.setHolds({ people: [w.memberId] });
    w.member.store.updateMessageContent(msg.id, 'canary-after');
    const files = unzip(w.rights.exportPerson(w.memberId).zip);
    const hist = JSON.parse(files.get('main/edit-history.json')!.toString('utf8'));
    assert.equal(hist.format, 'sara-edit-history');
    assert.equal(hist.edits[0].previous, 'canary-before');
    assert.ok(JSON.parse(files.get('manifest.json')!.toString('utf8')).files.some((f: { path: string }) => f.path === 'main/edit-history.json'));
    // The owner's export has no history file when nothing was edited under hold.
    assert.equal(unzip(w.rights.exportPerson('owner').zip).has('main/edit-history.json'), false);
    const n = auditTrail()!.list().length;
    const r = await call(`/history?person=${w.memberId}`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.edits.length, 1);
    assert.equal(body.edits[0].previous, 'canary-before');
    const audits = auditTrail()!.list().slice(0, auditTrail()!.list().length - n);
    const row = audits.find((a) => a.action === 'data.edit-history');
    assert.ok(row);
    assert.ok(!JSON.stringify(audits).includes('canary'));
    assert.equal((await call('/history?person=0000000000')).status, 404);
    // The data-rights view shows how many edits each person has kept.
    const view = await (await call('')).json();
    assert.equal(view.people.find((p: { person: string }) => p.person === w.memberId).edits, 1);
    w.owner.member = { record: () => undefined, apps: () => [], deleteSelf: async () => {} } as never;
    assert.equal((await call(`/history?person=${w.memberId}`)).status, 403);
  } finally { server.close(); w.cleanup(); }
});
