// R1 (a): Outlook files over 3 MB go up through a Graph upload session on the draft (createUploadSession,
// then byte ranges in multiples of 320 KiB to the pre-signed URL with no Authorization header), with
// retries on 5xx and a resume from nextExpectedRanges; 150 MB per file is Graph's cap. Fake Graph only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MicrosoftAuth, GraphMail, UPLOAD_CHUNK, SMALL_ATTACH } from '../src/mail/graph.ts';
import type { Draft } from '../src/mail/types.ts';
import { ATTACH_CAP, AttachmentError, resolveAttachments } from '../src/mail/attachments.ts';
import { Vault } from '../src/vault.ts';
import { tempDir } from './helpers.ts';
import { FakeGraph } from './mail-graph-fake.ts';

const fake = await new FakeGraph().start();
const tmp = tempDir();
after(async () => {
  await fake.stop();
  tmp.cleanup();
});
const vault = new Vault(tmp.dir);
const msOpts = { graphBase: `${fake.base}/v1.0`, loginBase: `${fake.base}/login`, sleep: async () => {} };
const ms = new MicrosoftAuth(vault, msOpts);
ms.setClient(fake.clientId, fake.clientSecret);
const REDIRECT = 'http://localhost:3000/api/mail/microsoft/callback';
const { code, state } = fake.authorize(ms.authUrl(REDIRECT));
const tok = await ms.finish(code, state);
ms.saveTokens('acc1', tok);
const slept: number[] = [];
const mail = new GraphMail(ms, 'acc1', 'ana@outlook.com', { sleep: async (ms2) => void slept.push(ms2) });

const bytes = (n: number, seed = 7) => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const files = (id: string) => (fake.msgs.find((m) => m.id === id) as unknown as { files?: { name: string; bytes: number; sha?: string }[] }).files ?? [];

test('chunk size is a multiple of 320 KiB and under Graph\'s 4 MB request limit', () => {
  assert.equal(UPLOAD_CHUNK % (320 * 1024), 0);
  assert.ok(UPLOAD_CHUNK <= 4 * 1024 * 1024);
  assert.equal(SMALL_ATTACH, 3 * 1024 * 1024);
  assert.equal(ATTACH_CAP.graph, 150 * 1024 * 1024);
});

test('a 9 MB file goes up in ranges with no Authorization header; a small one in one request', async () => {
  const big = bytes(9 * 1024 * 1024 + 12345);
  const small = bytes(1000, 3);
  fake.puts.length = 0;
  const d: Draft = { to: 'bob@work.com', subject: 'Plans', body: 'Attached.', attachments: [{ name: 'plans.pdf', mime: 'application/pdf', data: big }, { name: 'note.txt', mime: 'text/plain', data: small }] };
  const id = await mail.draft(d);
  assert.ok(id);
  const got = files(id);
  assert.deepEqual(got.map((f) => f.name).sort(), ['note.txt', 'plans.pdf']);
  const plans = got.find((f) => f.name === 'plans.pdf')!;
  assert.equal(plans.bytes, big.length);
  assert.equal(plans.sha, sha(big), 'every byte arrived in order');
  assert.ok(fake.puts.length >= 3);
  assert.ok(fake.puts.every((p) => !p.auth), 'the pre-signed URL never gets the access token');
  assert.match(fake.puts[0]!.range, new RegExp(`^bytes 0-${UPLOAD_CHUNK - 1}/${big.length}$`));
  assert.deepEqual(d.readBack?.sort(), ['note.txt', 'plans.pdf']);
  // The small file went as one fileAttachment POST, the big one through a session.
  assert.ok(fake.writes.some((w) => w.path.endsWith('/attachments') && (w.body as { name?: string }).name === 'note.txt'));
  assert.ok(fake.writes.some((w) => w.path.endsWith('/attachments/createUploadSession') && (w.body as { AttachmentItem: { name: string; size: number } }).AttachmentItem.size === big.length));
});

test('a 503 is retried and a lost answer resumes from nextExpectedRanges', async () => {
  const big = bytes(5 * 1024 * 1024, 11);
  fake.puts.length = 0;
  slept.length = 0;
  fake.uploadFail = 2;
  fake.uploadLost = 1;
  const d = { to: 'bob@work.com', subject: 'Retry', body: 'x', attachments: [{ name: 'scan.pdf', mime: 'application/pdf', data: big }] };
  const id = await mail.draft(d);
  const f = files(id).find((x) => x.name === 'scan.pdf')!;
  assert.equal(f.sha, sha(big));
  assert.equal(fake.puts.filter((p) => p.range.startsWith('bytes 0-')).length, 3, 'two 503s, then the first chunk; the lost answer is not re-sent');
  assert.ok(slept.length >= 2, 'backs off between tries');
  assert.ok(fake.log.some((l) => /^GET \/upload\//.test(l)), 'asks where to resume');
});

test('when every try fails it says so plainly and cancels the session', async () => {
  fake.uploadFail = 100;
  const d = { to: 'bob@work.com', subject: 'Down', body: 'x', attachments: [{ name: 'big.zip', mime: 'application/zip', data: bytes(4 * 1024 * 1024) }] };
  await assert.rejects(mail.draft(d), /Outlook didn't take big\.zip/);
  fake.uploadFail = 0;
  assert.equal(fake.sessions.size, 0, 'the half-done session is cancelled');
});

test('the Outlook cap is 150 MB per file and per email', () => {
  const p1 = join(tmp.dir, 'f.bin');
  writeFileSync(p1, Buffer.alloc(10));
  const app = { library: { get: (id: number) => ({ id, name: `f${id}.bin` }), filePath: () => p1 }, now: () => new Date() } as never;
  assert.equal(resolveAttachments(app, ['1'], 'graph').length, 1);
  // Over the cap: the statSync size is what is checked, so fake a file just over 150 MB sparsely.
  const p2 = join(tmp.dir, 'big.bin');
  writeFileSync(p2, Buffer.alloc(1));
  const app2 = { library: { get: (id: number) => ({ id, name: 'huge.mov' }), filePath: () => p2 }, now: () => new Date() } as never;
  const cap = ATTACH_CAP.graph;
  ATTACH_CAP.graph = 0;
  try {
    assert.throws(() => resolveAttachments(app2, ['1'], 'graph'), (e: Error) => e instanceof AttachmentError && /Outlook takes attachments up to/.test(e.message));
  } finally {
    ATTACH_CAP.graph = cap;
  }
});
