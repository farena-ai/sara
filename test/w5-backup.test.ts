// W5.3 (docs/design/W5BACKUP.md): backups you can carry. Recovery key in words + a printed sheet,
// sealed copies to a folder/drive and to a linked Sara, and a guided restore on a new computer into
// a throwaway data dir. Wrong keys, mistyped words and changed files are refused with plain reasons.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBackup } from '../src/backup.ts';
import { CarryError, isCarry, keyFromWords, makeRecoveryKey, openCarryFile, qrTextOf, sealCarryFile, WORDS, wordsOf } from '../src/carry-key.ts';
import { carrySheetPdf } from '../src/carry-sheet.ts';
import { applyStagedRestore, carryDue, carryTick, listDrives, setCarryDeps } from '../src/carry.ts';
import { Vault } from '../src/vault.ts';
import { ROOT, tempDir } from './helpers.ts';
import { clock, linkPair, pairNode, type PairNode } from './helpers-repair-pair.ts';

const words = (k: Buffer) => wordsOf(k).join(' ');

test('W5.3: the recovery key is 18 words, any spelling of them works, a wrong word is caught', () => {
  assert.equal(WORDS.length, 256);
  assert.equal(new Set(WORDS).size, 256);
  for (const w of WORDS) assert.match(w, /^[a-z]{3,7}$/);
  const k = makeRecoveryKey();
  assert.equal(k.length, 16);
  const w = wordsOf(k);
  assert.equal(w.length, 18);
  assert.deepEqual(keyFromWords(w.join(' ')), k);
  assert.deepEqual(keyFromWords(`  ${w.join(', ').toUpperCase()}\n`), k);
  assert.deepEqual(keyFromWords(w.map((x, i) => `${i + 1}. ${x}`).join('\n')), k, 'numbered like the sheet');
  assert.deepEqual(keyFromWords(qrTextOf(k)), k, 'the QR text');
  const bad = [...w];
  bad[4] = WORDS[(WORDS.indexOf(bad[4]!) + 1) % 256]!;
  assert.throws(() => keyFromWords(bad.join(' ')), (e: Error) => e instanceof CarryError && e.code === 'checksum');
  assert.throws(() => keyFromWords(w.slice(0, 17).join(' ')), (e: Error) => e instanceof CarryError && e.code === 'count');
  assert.throws(() => keyFromWords(`${w.slice(0, 17).join(' ')} zzzzz`), (e: Error) => e instanceof CarryError && e.code === 'word' && /zzzzz/.test(e.message));
});

test('W5.3: sealed copies open with the key; a wrong key and a changed byte are told apart', async () => {
  const t = tempDir();
  try {
    const plain = join(t.dir, 'b.tar.gz');
    const data = Buffer.concat([Buffer.from('sara-backup.json '), Buffer.alloc(300_000, 7), Buffer.from(' the end')]);
    writeFileSync(plain, data);
    const k = makeRecoveryKey();
    const sealed = join(t.dir, 'b.sara');
    await sealCarryFile(plain, sealed, k);
    const bytes = readFileSync(sealed);
    assert.ok(isCarry(bytes.subarray(0, 8)));
    assert.ok(!bytes.includes(Buffer.from('sara-backup.json')), 'nothing readable inside');
    const out = join(t.dir, 'out.tar.gz');
    await openCarryFile(sealed, out, k);
    assert.deepEqual(readFileSync(out), data);
    await assert.rejects(openCarryFile(sealed, join(t.dir, 'x1'), makeRecoveryKey()), (e: Error) => e instanceof CarryError && e.code === 'key');
    assert.ok(!existsSync(join(t.dir, 'x1')), 'nothing written for a wrong key');
    for (const at of [bytes.length - 3, 200, 40]) {
      const bad = Buffer.from(bytes);
      bad[at] = bad[at]! ^ 0x55;
      writeFileSync(join(t.dir, 'bad.sara'), bad);
      await assert.rejects(openCarryFile(join(t.dir, 'bad.sara'), join(t.dir, 'x2'), k), (e: Error) => e instanceof CarryError && e.code === 'changed', `byte ${at}`);
      assert.ok(!existsSync(join(t.dir, 'x2')), 'no half-opened file is left');
    }
    writeFileSync(join(t.dir, 'short.sara'), bytes.subarray(0, bytes.length - 100));
    await assert.rejects(openCarryFile(join(t.dir, 'short.sara'), join(t.dir, 'x3'), k), (e: Error) => e instanceof CarryError && e.code === 'changed');
    writeFileSync(join(t.dir, 'plain.sara'), data);
    await assert.rejects(openCarryFile(join(t.dir, 'plain.sara'), join(t.dir, 'x4'), k), (e: Error) => e instanceof CarryError && e.code === 'not');
  } finally {
    t.cleanup();
  }
});

test('W5.3: the recovery sheet is a one-page PDF with every word and the QR', () => {
  const k = makeRecoveryKey();
  const pdf = carrySheetPdf({ words: wordsOf(k), qrText: qrTextOf(k), madeAt: '2026-11-19T12:00:00Z', owner: 'Alex', lang: 'en' }).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.equal((pdf.match(/\/Type \/Page\b/g) ?? []).length, 1);
  for (const w of wordsOf(k)) assert.ok(pdf.includes(`(${w})`), w);
  assert.match(pdf, /Recovery sheet/);
  assert.ok((pdf.match(/ re f/g) ?? []).length > 100, 'the QR is drawn as squares');
  const es = carrySheetPdf({ words: wordsOf(k), qrText: qrTextOf(k), madeAt: '2026-11-19T12:00:00Z', owner: 'Alex', lang: 'es' }).toString('latin1');
  assert.doesNotMatch(es, /\(Recovery sheet/, 'the sheet speaks her language');
});

test('W5.3: drives are listed per platform; the system disk is marked', () => {
  const t = tempDir();
  try {
    setCarryDeps({ platform: 'win32', exists: (p) => ['C:\\', 'E:\\'].includes(p), statfs: () => ({ free: 5e9, total: 32e9 }), systemDrive: 'C:' });
    const d = listDrives();
    assert.deepEqual(d.map((x) => [x.path, x.system]), [['C:\\', true], ['E:\\', false]]);
    mkdirSync(join(t.dir, 'Volumes', 'USB STICK'), { recursive: true });
    setCarryDeps({ platform: 'darwin', volumes: join(t.dir, 'Volumes') });
    assert.deepEqual(listDrives().map((x) => x.name), ['USB STICK']);
  } finally {
    setCarryDeps();
    t.cleanup();
  }
});

/** Seeds an owner server with a chat, a memory and a vault value. */
function seed(n: PairNode): void {
  const c = n.app.store.createConversation({ title: 'Trip to Lisbon' });
  n.app.store.addMessage(c.id, 'user', 'Book the train for the 14th');
  n.app.vault.set('test:carry', 'a vault value that must come back');
}

async function makeSheet(n: PairNode): Promise<string> {
  const s = await n.req('POST', '/api/backups/carry/sheet', {});
  assert.equal(s.words.length, 18);
  assert.match(s.qr, /^data:image\/svg\+xml;base64,/);
  return s.words.join(' ');
}

test('W5.3: the sheet is shown once; copies only start after "I printed it"', async (t) => {
  const a = await pairNode(t, 'Alex');
  const drive = join(a.dir, '..', `usb-${Date.now()}`);
  mkdirSync(drive, { recursive: true });
  t.after(() => setCarryDeps());
  let r = await a.raw('POST', '/api/backups/carry/targets', { kind: 'folder', path: drive, every: 'day', keep: 2 });
  assert.equal(r.status, 409, 'no sheet yet');
  const w = await makeSheet(a);
  assert.deepEqual((await a.req('GET', '/api/backups/carry/sheet')).words.join(' '), w, 'shown again until printed');
  const pdf = await a.raw('GET', '/api/backups/carry/sheet.pdf');
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.headers.get('cache-control'), 'no-store');
  r = await a.raw('POST', '/api/backups/carry/targets', { kind: 'folder', path: drive });
  assert.equal(r.status, 409, 'not confirmed yet');
  const v = await a.req('POST', '/api/backups/carry/sheet/confirm', {});
  assert.ok(v.sheet.confirmedAt);
  assert.equal((await a.raw('GET', '/api/backups/carry/sheet')).status, 410);
  assert.equal((await a.raw('GET', '/api/backups/carry/sheet.pdf')).status, 410);
  const view = await a.req('GET', '/api/backups/carry');
  assert.ok(!JSON.stringify(view).includes(w.split(' ')[0]! + ' ' + w.split(' ')[1]), 'the words never come back');
  assert.equal((await a.raw('POST', '/api/backups/carry/sheet', {})).status, 409, 'a new sheet must be asked for on purpose');
  const again = await a.req('POST', '/api/backups/carry/sheet', { again: true });
  assert.notEqual(again.words.join(' '), w);
});

test('W5.3: copies to a drive folder on a schedule with retention; an unplugged drive waits', async (t) => {
  const a = await pairNode(t, 'Alex');
  seed(a);
  const usb = join(a.dir, '..', `usb-${Date.now()}`);
  mkdirSync(usb, { recursive: true });
  const w = await makeSheet(a);
  await a.req('POST', '/api/backups/carry/sheet/confirm', {});
  const added = await a.req('POST', '/api/backups/carry/targets', { kind: 'folder', path: usb, every: 'day', keep: 2 });
  const id = added.targets[0].id;
  for (let i = 0; i < 3; i++) {
    clock.now = new Date(clock.now.getTime() + 1000);
    await a.req('POST', `/api/backups/carry/targets/${id}/copy`, {});
  }
  const dir = join(usb, 'Sara backups');
  const copies = readdirSync(dir).filter((n) => n.endsWith('.sara'));
  assert.equal(copies.length, 2, 'keeps the newest 2');
  assert.ok(existsSync(join(dir, 'README.txt')));
  const k = keyFromWords(w);
  const out = join(a.dir, 'tmp', 'opened.tar.gz');
  mkdirSync(join(a.dir, 'tmp'), { recursive: true });
  await openCarryFile(join(dir, copies.sort().at(-1)!), out, k);
  assert.ok(readFileSync(out).length > 100);
  const view = await a.req('GET', '/api/backups/carry');
  assert.equal(view.targets[0].last.ok, true);
  // Schedule: due after a day, not before.
  const tg = view.targets[0];
  assert.equal(carryDue(tg, new Date(Date.parse(tg.last.at) + 3600_000)), false);
  assert.equal(carryDue(tg, new Date(Date.parse(tg.last.at) + 24 * 3600_000)), true);
  assert.equal(carryDue({ ...tg, every: 'week' }, new Date(Date.parse(tg.last.at) + 48 * 3600_000)), false);
  // Unplugged: the tick waits and says so, no error, no throw.
  const gone = join(a.dir, '..', `gone-${Date.now()}`);
  const t2 = await a.req('POST', '/api/backups/carry/targets', { kind: 'folder', path: usb, every: 'day', keep: 3 });
  const id2 = t2.targets.find((x: { id: string }) => x.id !== id).id;
  await a.req('PUT', `/api/backups/carry/targets/${id2}`, { path: gone, allowMissing: true });
  clock.now = new Date(clock.now.getTime() + 25 * 3600_000);
  const results = await carryTick(a.app, a.dir);
  const r2 = results.find((x) => x.id === id2)!;
  assert.equal(r2.waiting, true);
  const after = (await a.req('GET', '/api/backups/carry')).targets.find((x: { id: string }) => x.id === id2);
  assert.equal(after.waiting, true);
  assert.equal(after.last?.ok ?? null, null);
  await a.req('DELETE', `/api/backups/carry/targets/${id2}`);
  assert.equal((await a.req('GET', '/api/backups/carry')).targets.length, 1);
});

test('W5.3: a copy sent to a linked Sara is sealed end to end; the holder opts in and cannot read it', async (t) => {
  const a = await pairNode(t, 'Alex');
  const b = await pairNode(t, 'Sam');
  seed(a);
  const { aLink, bLink } = await linkPair(a, b);
  const w = await makeSheet(a);
  await a.req('POST', '/api/backups/carry/sheet/confirm', {});
  const wire: string[] = [];
  const real = a.m.peerFetch.bind(a.m);
  a.m.peerFetch = (url: string, init: RequestInit) => {
    wire.push(`${url}\n${String(init.body ?? '')}`);
    return real(url, init);
  };
  const tg = await a.req('POST', '/api/backups/carry/targets', { kind: 'peer', link: aLink, every: 'week', keep: 2 });
  const id = tg.targets[0].id;
  let r = await a.raw('POST', `/api/backups/carry/targets/${id}/copy`, {});
  assert.equal(r.status, 403, 'Sam has not said yes');
  assert.match(String(((await r.json()) as { error: string }).error), /Sam|hold/i);
  await b.req('PUT', `/api/backups/carry/hold/${bLink}`, { on: true, maxMb: 500 });
  for (let i = 0; i < 3; i++) {
    clock.now = new Date(clock.now.getTime() + 1000);
    await a.req('POST', `/api/backups/carry/targets/${id}/copy`, {});
  }
  const held = (await b.req('GET', '/api/backups/carry')).hold.find((h: { id: string }) => h.id === bLink);
  assert.equal(held.on, true);
  assert.equal(held.copies.length, 2, 'keeps the newest 2');
  const file = join(b.dir, 'carry-held', bLink, held.copies[0].name);
  const bytes = readFileSync(file);
  assert.ok(isCarry(bytes.subarray(0, 8)));
  for (const s of ['Trip to Lisbon', 'sara-backup.json', 'a vault value']) assert.ok(!bytes.includes(Buffer.from(s)), s);
  const all = wire.join('\n');
  for (const word of w.split(' ').slice(0, 6)) assert.ok(!new RegExp(`\\b${word}\\b`).test(all.replace(/"data":"[^"]*"/g, '')), `word ${word} never crosses`);
  assert.ok(!all.includes('Trip to Lisbon'));
  // Sam's own vault has nothing that opens it.
  for (const v of b.app.vault.values?.() ?? []) assert.ok(!String(v).includes(w));
  // Sam downloads it (to hand it back on a stick); the bytes are the sealed copy.
  const dl = await b.raw('GET', `/api/backups/carry/hold/${bLink}/${encodeURIComponent(held.copies[0].name)}`);
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), bytes);
  // And it opens with Alex's sheet.
  const out = join(b.dir, 'tmp-open.tar.gz');
  await openCarryFile(file, out, keyFromWords(w));
  // Turning it off refuses the next copy; removing one frees the space.
  await b.req('DELETE', `/api/backups/carry/hold/${bLink}/${encodeURIComponent(held.copies[0].name)}`);
  assert.equal((await b.req('GET', '/api/backups/carry')).hold.find((h: { id: string }) => h.id === bLink).copies.length, 1);
  await b.req('PUT', `/api/backups/carry/hold/${bLink}`, { on: false });
  r = await a.raw('POST', `/api/backups/carry/targets/${id}/copy`, {});
  assert.equal(r.status, 403);
  // A forged peer call without the link's key is refused.
  const forged = await fetch(`${b.base}/msg/v1/carry/begin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', name: 'sara-x.sara', size: 1 }) });
  assert.equal(forged.status, 401);
});

test('W5.3: restore on a new computer, end to end into a throwaway data dir (wrong key, changed file, then the sheet)', async (t) => {
  const a = await pairNode(t, 'Alex');
  seed(a);
  const usb = join(a.dir, '..', `usb-${Date.now()}`);
  mkdirSync(usb, { recursive: true });
  const w = await makeSheet(a);
  await a.req('POST', '/api/backups/carry/sheet/confirm', {});
  const tg = await a.req('POST', '/api/backups/carry/targets', { kind: 'folder', path: usb, every: 'day', keep: 3 });
  await a.req('POST', `/api/backups/carry/targets/${tg.targets[0].id}/copy`, {});
  const sealed = join(usb, 'Sara backups', readdirSync(join(usb, 'Sara backups')).find((n) => n.endsWith('.sara'))!);
  // The new computer: a fresh, empty Sara.
  const nw = await pairNode(t, 'New PC');
  setCarryDeps({ platform: 'linux', mounts: [usb] });
  t.after(() => setCarryDeps());
  const found = await nw.req('GET', '/api/backups/carry/restore/found');
  assert.ok(found.files.some((f: { path: string }) => f.path === sealed), 'finds the copy on the drive');
  const st = await nw.req('POST', '/api/backups/carry/restore', { path: sealed });
  // A wrong sheet, a mistyped word, then a changed file.
  let r = await nw.raw('POST', `/api/backups/carry/restore/${st.id}/check`, { words: words(makeRecoveryKey()) });
  assert.equal(r.status, 400);
  assert.match(String(((await r.json()) as { error: string }).error), /doesn.t fit|other sheet/i);
  const typo = w.split(' ');
  typo[0] = typo[0] === 'apple' ? 'acorn' : 'apple';
  r = await nw.raw('POST', `/api/backups/carry/restore/${st.id}/check`, { words: typo.join(' ') });
  assert.equal(r.status, 400);
  const bad = Buffer.from(readFileSync(sealed));
  bad[bad.length - 40] = bad[bad.length - 40]! ^ 1;
  const badPath = join(usb, 'Sara backups', 'sara-changed.sara');
  writeFileSync(badPath, bad);
  const st2 = await nw.req('POST', '/api/backups/carry/restore', { path: badPath });
  r = await nw.raw('POST', `/api/backups/carry/restore/${st2.id}/check`, { words: w });
  assert.equal(r.status, 400);
  assert.match(String(((await r.json()) as { error: string }).error), /changed|damaged/i);
  r = await nw.raw('POST', `/api/backups/carry/restore/${st.id}/stage`, {});
  assert.equal(r.status, 409, 'not checked yet');
  // The right sheet: opened, checked by the drill (checks only), then staged.
  const ok = await nw.req('POST', `/api/backups/carry/restore/${st.id}/check`, { words: w });
  assert.equal(ok.record.ok, true, JSON.stringify(ok.record));
  assert.ok(ok.record.counts.conversations >= 1);
  const staged = await nw.req('POST', `/api/backups/carry/restore/${st.id}/stage`, {});
  assert.equal(staged.staged, true);
  assert.ok((await nw.req('GET', '/api/backups/carry')).staged);
  // At the next start the staged restore runs before anything opens the data: use a copy of the
  // new computer's folder as the throwaway data dir (the test server still holds the live one).
  const t3 = tempDir();
  t.after(() => t3.cleanup());
  const dest = join(t3.dir, 'data');
  mkdirSync(join(dest, 'restore-staged'), { recursive: true });
  for (const f of readdirSync(join(nw.dir, 'restore-staged'))) writeFileSync(join(dest, 'restore-staged', f), readFileSync(join(nw.dir, 'restore-staged', f)));
  writeFileSync(join(dest, 'owner.json'), '{}');
  const done = applyStagedRestore(dest);
  assert.ok(done?.movedTo);
  assert.ok(!existsSync(join(dest, 'restore-staged')));
  const db = new DatabaseSync(join(dest, 'sara.db'), { readOnly: true });
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM conversations WHERE title = 'Trip to Lisbon'").get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
  assert.equal(new Vault(dest).get('test:carry'), 'a vault value that must come back');
  assert.equal(applyStagedRestore(dest), undefined, 'runs once');
});

test('W5.3: wiring (one tick, boot hook, CLI key, skip lists, peer mount, scope word)', () => {
  const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
  assert.match(main, /applyStagedRestore\(dataDir\)/);
  assert.ok(main.indexOf('applyStagedRestore(dataDir)') < main.indexOf('new OwnerAuth(dataDir'), 'before anything opens the data');
  assert.match(main, /carryTick\(mainApp, dataDir\)/);
  assert.match(main, /SARA_BACKUP_KEY/);
  assert.match(readFileSync(join(ROOT, 'src', 'backup.ts'), 'utf8'), /'restore-staged'/);
  assert.match(readFileSync(join(ROOT, 'src', 'backup.ts'), 'utf8'), /'carry-held'/);
  assert.match(readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8'), /\/msg\/v1\/carry\//);
  assert.match(readFileSync(join(ROOT, 'src', 'support.ts'), 'utf8'), /'carry'/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['cy-sheet', 'cy-targets', 'cy-hold', 'cy-restore']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(readFileSync(join(ROOT, 'web', 'app.js'), 'utf8'), /carry\.js/);
  assert.ok(createBackup);
});
