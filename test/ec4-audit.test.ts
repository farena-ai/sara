// EC4: one append-only, hash-chained audit trail with export (docs/ops/EC45_DESIGN.md).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { AuditTrail, toCsv } from '../src/audit-trail.ts';
import { Redactor } from '../src/redact.ts';
import { tempDir } from './helpers.ts';

/** Reads a stored (or deflated) zip into name → text. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const data = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    i += 30 + nameLen + extra + size;
  }
  return out;
}

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET';
function trail(clock = { now: new Date('2026-11-07T12:00:00Z') }) {
  const { dir, cleanup } = tempDir();
  const red = new Redactor(() => [SECRET]);
  const t = new AuditTrail(dir, { redact: (s) => red.redact(s), key: () => 'k1', policyRev: () => 2, now: () => clock.now });
  return { t, dir, cleanup, clock };
}

test('EC4 trail: rows chain, verify passes, and any edit, removal or truncation is caught', () => {
  const { t, dir, cleanup } = trail();
  try {
    t.record({ action: 'settings.change', keys: ['ownerName'] });
    t.record({ action: 'tools.change', target: 'shell', outcome: 'refused' });
    t.record({ action: 'signin.passkey', role: 'member', who: 'm-1', channel: 'web' });
    assert.deepEqual(t.verify(), { ok: true, rows: 3 });
    const file = join(dir, 'audit', 'trail.jsonl');
    const good = readFileSync(file, 'utf8');
    const lines = good.trim().split('\n');
    // Edited row (an outcome changed from refused to ok).
    writeFileSync(file, good.replace('"outcome":"refused"', '"outcome":"ok"'));
    assert.deepEqual(t.verify(), { ok: false, rows: 3, brokenAt: 2, reason: 'changed' });
    // A row removed from the middle.
    writeFileSync(file, [lines[0], lines[2]].join('\n') + '\n');
    assert.equal(t.verify().reason, 'missing');
    // The newest row cut off.
    writeFileSync(file, lines.slice(0, 2).join('\n') + '\n');
    assert.equal(t.verify().reason, 'truncated');
    writeFileSync(file, good);
    assert.equal(t.verify().ok, true);
    const row = JSON.parse(lines[0]);
    assert.equal(row.policyRev, 2);
    assert.equal(row.prev, '0'.repeat(64));
  } finally {
    cleanup();
  }
});

test('EC4 trail: filters by who, action prefix, channel, outcome and dates; newest first', () => {
  const { t, cleanup, clock } = trail();
  try {
    t.record({ action: 'settings.change' });
    clock.now = new Date('2026-11-08T09:00:00Z');
    t.record({ action: 'approval.decided', target: 'shell', channel: 'telegram', outcome: 'refused' });
    t.record({ action: 'signin.passkey', role: 'member', who: 'm-1' });
    assert.deepEqual(t.list().map((r) => r.seq), [3, 2, 1]);
    assert.deepEqual(t.list({ who: 'member' }).map((r) => r.seq), [3]);
    assert.deepEqual(t.list({ who: 'm-1' }).map((r) => r.seq), [3]);
    assert.deepEqual(t.list({ action: 'approval' }).map((r) => r.seq), [2]);
    assert.deepEqual(t.list({ action: 'signin.passkey' }).map((r) => r.seq), [3]);
    assert.deepEqual(t.list({ action: 'sign' }).map((r) => r.seq), []);
    assert.deepEqual(t.list({ channel: 'telegram' }).map((r) => r.seq), [2]);
    assert.deepEqual(t.list({ outcome: 'refused' }).map((r) => r.seq), [2]);
    assert.deepEqual(t.list({ to: '2026-11-07' }).map((r) => r.seq), [1]);
    assert.deepEqual(t.list({ from: '2026-11-08' }).map((r) => r.seq), [3, 2]);
    assert.deepEqual(t.list({ limit: 1 }).map((r) => r.seq), [3]);
  } finally {
    cleanup();
  }
});

test('EC4 trail: retention drops old rows, never a pending one or anything after it, and the chain still verifies', () => {
  const { t, cleanup, clock } = trail();
  try {
    clock.now = new Date('2026-01-01T00:00:00Z');
    t.record({ action: 'settings.change' });
    t.record({ action: 'delivery.sent', outcome: 'pending' });
    t.record({ action: 'settings.change' });
    clock.now = new Date('2026-11-07T00:00:00Z');
    t.record({ action: 'settings.change' });
    assert.equal(t.retentionDays, 365);
    assert.equal(t.prune(365), 0, 'nothing past a year');
    t.setRetention(30);
    assert.equal(t.prune(), 1, 'only the row before the pending one');
    assert.deepEqual(t.list().map((r) => r.action), ['audit.prune', 'settings.change', 'settings.change', 'delivery.sent']);
    assert.deepEqual(t.verify(), { ok: true, rows: 4 });
    assert.equal(t.prune(0), 0, 'keep everything');
    assert.throws(() => t.setRetention(7));
  } finally {
    cleanup();
  }
});

test('EC4 export: JSONL and CSV round-trip with a hashed, signed manifest; no secrets, no content unless asked', () => {
  const { t, cleanup } = trail();
  try {
    t.record({ action: 'approval.decided', target: 'shell', content: `run deploy with ${SECRET}` });
    t.record({ action: 'settings.change', keys: ['ownerName', 'bad key with spaces'], target: '=HYPERLINK("x")' });
    const { zip, manifest } = t.exportZip('jsonl');
    const files = unzip(zip);
    assert.deepEqual(Object.keys(files).sort(), ['audit.jsonl', 'manifest.json']);
    const rows = files['audit.jsonl'].trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
    assert.equal(rows[0].content, undefined, 'content left out by default');
    assert.deepEqual(rows[1].keys, ['ownerName']);
    const m = JSON.parse(files['manifest.json']);
    assert.equal(m.rows, 2);
    assert.equal(m.verified, true);
    assert.equal(m.sha256, createHash('sha256').update(Buffer.from(files['audit.jsonl'], 'utf8')).digest('hex'));
    assert.equal(m.hmacSha256, t.sign(m));
    assert.deepEqual(m, manifest);
    // A manifest changed after export no longer matches its signature.
    assert.notEqual(t.sign({ ...m, rows: 3 }), m.hmacSha256);
    // With content: the summary is there, the secret redacted.
    const withContent = unzip(t.exportZip('jsonl', {}, { content: true }).zip)['audit.jsonl'];
    assert.match(withContent, /run deploy with/);
    assert.doesNotMatch(withContent, /SECRETSECRET/);
    // CSV: header, formula cells defused, content column only when asked.
    const csv = unzip(t.exportZip('csv').zip)['audit.csv'];
    assert.match(csv, /^seq,at,who,role,action,target,channel,outcome,keys,policyRev,prev,hash\r\n/);
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
    assert.doesNotMatch(csv, /run deploy/);
    assert.match(toCsv(t.list({}, { content: true }), true), /,content\r\n/);
    // Filters carry into the export and its manifest.
    const only = t.exportZip('jsonl', { action: 'settings' });
    assert.equal(only.manifest.rows, 1);
    assert.deepEqual(only.manifest.filters, { action: 'settings' });
  } finally {
    cleanup();
  }
});
