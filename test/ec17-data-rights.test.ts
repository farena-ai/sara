// EC17 (docs/ops/EC1617_DESIGN.md, docs/DATA_RIGHTS.md): retention per data kind, legal hold that
// blocks every delete path (DELETE_PATHS, driven one by one), per-person export and delete.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { OwnerAuth } from '../src/auth.ts';
import { DataRights, DELETE_PATHS, setDataRights, type PersonSpace } from '../src/data-rights.ts';
import { HouseholdStore } from '../src/household.ts';
import { dbHeld, isLegalHold } from '../src/legal-hold.ts';
import { LibraryStore } from '../src/library/store.ts';
import { MemoryTidy } from '../src/memory-tidy.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, PNG, ROOT, tempDir, type TestApp } from './helpers.ts';

const clock = { now: new Date('2026-11-07T12:00:00Z') };
const DAY = 86_400_000;

/** Reads a stored (uncompressed) zip from src/zip-write.ts into path → bytes. */
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

interface World { root: string; owner: TestApp; member: TestApp; memberId: string; household: HouseholdStore; rights: DataRights; deleted: string[]; cleanup: () => void }
function world(): World {
  const { dir: root, cleanup } = tempDir();
  const household = new HouseholdStore(root);
  const { code } = household.invite({ name: 'Robin', hours: 24, confirm18: true, limits: { models: [{ providerId: 'p', model: 'm' }], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false } });
  const { member, dir } = household.redeem(code, true);
  const mk = (d: string) => { const app = makeApp(d, clock); app.library = new LibraryStore(app.store.db, d, () => clock.now); return app; };
  const owner = mk(root); const memberApp = mk(dir);
  const deleted: string[] = [];
  const spaces = (): PersonSpace[] => [
    { person: 'owner', name: 'Owner', dir: root, apps: () => [owner] },
    ...household.members().map((m) => ({ person: m.id, name: m.name, dir: household.dirOf(m.id), apps: () => [memberApp] })),
  ];
  const rights = new DataRights(root, { spaces, deleteMember: async (id) => { memberApp.store.close(); household.deleteMember(id); deleted.push(id); } }, () => clock.now);
  setDataRights(rights);
  setAuditTrail(new AuditTrail(root, { redact: (s) => s, key: () => 'k'.repeat(64), policyRev: () => 0 }));
  return { root, owner, member: memberApp, memberId: member.id, household, rights, deleted, cleanup: () => { setDataRights(undefined); setAuditTrail(undefined); setPolicy(new PolicyStore()); try { owner.store.close(); } catch { /* closed */ } try { memberApp.store.close(); } catch { /* closed */ } cleanup(); } };
}
/** Fills one space with a chat, a memory, a library file and a photo carrying `canary`. */
function seed(app: TestApp, canary: string) {
  const conv = app.store.createConversation({ title: `chat ${canary}` });
  const msg = app.store.addMessage(conv.id, 'user', `hello ${canary}`);
  app.store.addMessage(conv.id, 'assistant', `reply ${canary}`);
  const mem = app.memory!.add({ kind: 'fact', content: `fact ${canary}`, conversationId: conv.id, sourceMessageId: msg.id, happenedOn: '2026-11-01' });
  const doc = app.library!.add({ name: `${canary}.txt`, bytes: Buffer.from(`file ${canary}`), keep: true });
  const photo = app.uploads!.save(`data:image/png;base64,${PNG}`);
  return { conv, msg, mem, doc, photo };
}
const rows = (app: TestApp) => ({
  conversations: Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n),
  messages: Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n),
  memories: Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n),
  docs: Number((app.store.db.prepare('SELECT COUNT(*) AS n FROM library_docs').get() as { n: number }).n),
});

test('data rights: defaults keep today’s behaviour (keep everything, no hold) and the file is exact', () => {
  const w = world();
  try {
    assert.deepEqual(w.rights.retention, { chats: 0, memories: 0, files: 0 });
    assert.deepEqual(w.rights.holds, { instance: false, people: [] });
    seed(w.owner, 'a');
    assert.deepEqual(w.rights.runRetention(), { chats: 0, memories: 0, files: 0, heldSpaces: 0 });
    assert.throws(() => w.rights.setRetention({ chats: 7 }), /Pick 30/);
    assert.throws(() => w.rights.setRetention({ audit: 30 }), /Unknown field/);
    assert.throws(() => w.rights.setHolds({ people: ['abcdef1234'] }), /No such person/);
    assert.equal(w.rights.personOf(join(w.root, 'members', w.memberId, 'companions', 'x')), w.memberId);
    assert.equal(w.rights.personOf(join(w.root, 'companions', 'x')), 'owner');
  } finally { w.cleanup(); }
});

/**
 * One exercise per DELETE_PATHS id: it runs that path against a held space and returns whether the
 * data is still there. A new path in src/data-rights.ts without an exercise here fails the test.
 */
const EXERCISES: Record<(typeof DELETE_PATHS)[number]['id'], (w: World, s: ReturnType<typeof seed>) => Promise<unknown> | unknown> = {
  'chat.delete': (w, s) => w.member.store.deleteConversation(s.conv.id),
  'chat.trim': (w, s) => w.member.store.deleteMessagesFrom(s.conv.id, s.msg.id),
  'chat.sql': (w, s) => w.member.store.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(s.conv.id),
  'memory.forget': (w, s) => w.member.memory!.delete(s.mem.id),
  'memory.conversation': (w, s) => w.member.memory!.deleteForConversation(s.conv.id),
  'memory.sql': (w) => w.member.store.db.exec('DELETE FROM memories'),
  'memory.tidy': (w) => new MemoryTidy(w.member, w.member.store.db).run('now', clock.now),
  'file.library': (w, s) => w.member.library!.delete(s.doc.id),
  'file.photo': (w, s) => w.member.uploads!.remove(s.photo.id),
  'file.photo-prune': (w) => { if (w.member.uploads!.prune(new Set()) !== 0) throw new Error('pruned while held'); throw new Error('SARA_LEGAL_HOLD (prune skipped)'); },
  'retention.run': (w) => { w.rights.setRetention({ chats: 30, memories: 30, files: 30 }); clock.now = new Date(clock.now.getTime() + 400 * DAY); try { const before = rows(w.member); const r = w.rights.runRetention(); if (JSON.stringify(rows(w.member)) !== JSON.stringify(before) || !r.heldSpaces) throw new Error('retention deleted held data'); throw new Error('SARA_LEGAL_HOLD (space skipped)'); } finally { clock.now = new Date('2026-11-07T12:00:00Z'); w.rights.setRetention({ chats: 0, memories: 0, files: 0 }); } },
  'person.delete': (w) => w.rights.deletePerson(w.memberId, true),
  'household.delete': (w) => w.household.deleteMember(w.memberId),
  'audit.prune': (w) => { const t = new AuditTrail(w.root, { redact: (s) => s, key: () => 'k'.repeat(64), policyRev: () => 0, now: () => new Date(clock.now.getTime() + 800 * DAY) } as ConstructorParameters<typeof AuditTrail>[1]); if (t.prune(30) !== 0) throw new Error('pruned while held'); throw new Error('SARA_LEGAL_HOLD (prune skipped)'); },
};

for (const scope of ['person', 'instance'] as const) {
  test(`legal hold (${scope}): every delete path in DELETE_PATHS is refused and the data stays`, async () => {
    assert.deepEqual(Object.keys(EXERCISES).sort(), DELETE_PATHS.map((p) => p.id).sort(), 'every delete path has an exercise');
    const w = world();
    try {
      const s = seed(w.member, 'm1');
      seed(w.owner, 'o1');
      w.rights.setHolds(scope === 'person' ? { people: [w.memberId] } : { instance: true });
      assert.equal(dbHeld(w.member.store.db), true);
      assert.equal(dbHeld(w.owner.store.db), scope === 'instance');
      const before = rows(w.member);
      for (const path of DELETE_PATHS) {
        let refused = false;
        try { await EXERCISES[path.id](w, s); } catch (err) { refused = isLegalHold(err) || /legal hold/i.test((err as Error).message); if (!refused) throw err; }
        assert.ok(refused, `${path.id} was not refused`);
        assert.deepEqual(rows(w.member), before, `${path.id} removed data`);
        assert.ok(w.member.uploads!.get(s.photo.id), `${path.id} removed the photo`);
        assert.ok(existsSync(w.household.dirOf(w.memberId)), `${path.id} removed the space`);
      }
      // The owner is not held by a person hold: their deletes still work.
      if (scope === 'person') assert.equal(w.owner.store.deleteConversation(w.owner.store.createConversation({}).id), true);
      // Released: the same paths work again.
      w.rights.setHolds(scope === 'person' ? { people: [] } : { instance: false });
      assert.equal(w.member.memory!.delete(s.mem.id), true);
      assert.equal(w.member.store.deleteConversation(s.conv.id), true);
      const log = readFileSync(join(w.root, 'audit', 'trail.jsonl'), 'utf8');
      assert.match(log, /"action":"data.hold"/);
      assert.match(log, /"action":"data.person-delete","[^\n]*"outcome":"refused"/);
    } finally { w.cleanup(); }
  });
}

test('legal hold: the policy pin keeps the whole-server hold on; personDelete:false refuses deletes', async () => {
  const w = world();
  const { dir: pdir, cleanup } = tempDir();
  try {
    const p = new PolicyStore(pdir); setPolicy(p);
    p.set({ name: 'Counsel', pins: { legalHold: true, personDelete: false } });
    assert.equal(w.rights.holds.instance, true);
    assert.equal(w.rights.held(w.root), true);
    assert.throws(() => w.rights.setHolds({ instance: false }), /Set by your admin/);
    p.set({ name: 'Counsel', pins: { personDelete: false } });
    await assert.rejects(w.rights.deletePerson(w.memberId, true), /Set by your admin/);
    assert.throws(() => p.set({ pins: { legalHold: false } }), /only be pinned on/);
  } finally { w.cleanup(); cleanup(); }
});

test('retention: runs per kind on the household tick, keeps pinned memories and held spaces, writes one audit row', () => {
  const w = world();
  try {
    const old = seed(w.member, 'OLDCANARY');
    w.member.memory!.setPinned?.(old.mem.id, true);
    const keepOwner = seed(w.owner, 'OWNERCANARY');
    w.rights.setHolds({ people: ['owner'] });
    clock.now = new Date(clock.now.getTime() + 40 * DAY);
    const photoFile = w.member.uploads!.get(old.photo.id)!.path;
    utimesSync(photoFile, new Date(clock.now.getTime() - 35 * DAY), new Date(clock.now.getTime() - 35 * DAY));
    const fresh = seed(w.member, 'FRESHCANARY');
    w.rights.setRetention({ chats: 30, memories: 30, files: 30 });
    const r = w.rights.runRetention();
    assert.equal(r.chats, 1); assert.equal(r.files, 2); assert.equal(r.heldSpaces, 1);
    assert.equal(r.memories, 0, 'the pinned old memory and the fresh one stay'); assert.ok(w.member.memory!.get?.(old.mem.id) ?? w.member.memory!.listAll().some((m) => m.id === old.mem.id));
    assert.equal(w.member.store.getConversation(old.conv.id), undefined);
    assert.ok(w.member.store.getConversation(fresh.conv.id));
    assert.ok(w.member.library!.get(fresh.doc.id));
    assert.equal(w.member.library!.get(old.doc.id), undefined);
    assert.equal(w.member.uploads!.get(old.photo.id), undefined);
    // The held owner keeps everything.
    assert.ok(w.owner.store.getConversation(keepOwner.conv.id));
    const log = readFileSync(join(w.root, 'audit', 'trail.jsonl'), 'utf8');
    assert.equal((log.match(/"action":"retention.run"/g) ?? []).length, 1);
    assert.doesNotMatch(log, /CANARY/, 'no content in audit rows');
  } finally { clock.now = new Date('2026-11-07T12:00:00Z'); w.cleanup(); }
});

test('export: a zip of one person’s data only, with a manifest of sha256 sums', () => {
  const w = world();
  try {
    seed(w.member, 'MEMBER-CANARY');
    seed(w.owner, 'OWNER-CANARY');
    const { zip, name } = w.rights.exportPerson(w.memberId);
    assert.match(name, /^sara-member-2026-11-07\.zip$/);
    const files = unzip(zip);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'));
    assert.equal(manifest.person, w.memberId);
    assert.ok(files.has('main/export.json'));
    assert.ok([...files.keys()].some((k) => k.startsWith('main/photos/')));
    assert.ok([...files.keys()].some((k) => k.startsWith('main/library/') && k.endsWith('MEMBER-CANARY.txt')));
    const all = [...files.values()].map((b) => b.toString('latin1')).join('\n');
    assert.match(all, /MEMBER-CANARY/);
    assert.doesNotMatch(all, /OWNER-CANARY/, 'another person’s data is never in the export');
    for (const f of manifest.files) assert.equal(files.get(f.path)!.length, f.bytes);
    assert.throws(() => w.rights.exportPerson('../../etc'), /Pick a person/);
  } finally { w.cleanup(); }
});

test('delete: a member’s space is gone completely, with a receipt; the owner cannot be deleted this way', async () => {
  const w = world();
  try {
    seed(w.member, 'gone');
    const dir = w.household.dirOf(w.memberId);
    await assert.rejects(w.rights.deletePerson(w.memberId, false), /Confirm/);
    await assert.rejects(w.rights.deletePerson('owner', true), /whole server/);
    const receipt = await w.rights.deletePerson(w.memberId, true);
    assert.deepEqual(receipt.before, { conversations: 1, messages: 2, memories: 1, files: 2 });
    assert.equal(receipt.folderGone, true); assert.equal(receipt.recordGone, true);
    assert.equal(existsSync(dir), false); assert.equal(w.household.get(w.memberId), undefined);
    const log = readFileSync(join(w.root, 'audit', 'trail.jsonl'), 'utf8');
    assert.match(log, /"action":"data.person-delete","[^\n]*"outcome":"ok"/);
  } finally { w.cleanup(); }
});

test('routes: owner only (members and device apps refused), export download, holds and delete over HTTP', async () => {
  const w = world();
  const auth = new OwnerAuth(w.root); const token = auth.newToken!;
  const server = createSaraServer({ app: w.owner, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/data-rights`;
  const call = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base.slice(0, base.indexOf('/api')) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    seed(w.member, 'http');
    const view = await (await call('')).json();
    assert.equal(view.people.length, 2); assert.deepEqual(view.choices, [0, 30, 90, 365, 730]); assert.equal(view.deletePaths, DELETE_PATHS.length);
    assert.equal((await call('/retention', 'PUT', { chats: 90 })).status, 200);
    assert.equal((await call('/holds', 'PUT', { people: [w.memberId] })).status, 200);
    const zip = await call(`/export?person=${w.memberId}`);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.ok(unzip(Buffer.from(await zip.arrayBuffer())).has('manifest.json'));
    const refused = await call('/delete', 'POST', { person: w.memberId, confirm: true });
    assert.equal(refused.status, 409); assert.equal((await refused.json()).legalHold, true);
    // A delete through another route hits the database trigger: also a 409, not a 500.
    assert.equal((await call('/holds', 'PUT', { people: [w.memberId], instance: true })).status, 200);
    const conv = w.owner.store.createConversation({});
    const viaChat = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations/${conv.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}`, origin: base.slice(0, base.indexOf('/api')) } });
    assert.equal(viaChat.status, 409);
    assert.equal((await call('/holds', 'PUT', { people: [], instance: false })).status, 200);
    const ok = await call('/delete', 'POST', { person: w.memberId, confirm: true });
    assert.equal(ok.status, 200, await ok.clone().text()); assert.equal((await ok.json()).receipt.folderGone, true);
    w.owner.member = { record: () => undefined, apps: () => [], deleteSelf: async () => {} } as unknown as TestApp['member'];
    assert.equal((await call('')).status, 403);
  } finally { server.close(); w.cleanup(); }
});

test('data rights: a damaged settings file holds everything instead of releasing', () => {
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'data-rights.json'), '{not json');
    const d = new DataRights(dir);
    assert.equal(d.holds.instance, true); assert.equal(d.held(dir), true);
  } finally { cleanup(); }
});
