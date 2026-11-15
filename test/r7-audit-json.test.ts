// R7: the audit export also comes as one JSON array; content stays out unless asked for.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { AuditTrail } from '../src/audit-trail.ts';
import { tempDir } from './helpers.ts';

/** The files of a stored (or deflated) ZIP. */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const body = buf.subarray(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    out[name] = (method === 8 ? inflateRawSync(body) : body).toString('utf8');
    i += 30 + nameLen + extra + size;
  }
  return out;
}

test('audit export: json is one array with the chain fields; message content left out by default', () => {
  const { dir, cleanup } = tempDir();
  try {
    const trail = new AuditTrail(dir, { key: () => 'k', now: () => new Date('2026-11-15T10:00:00Z') });
    trail.record({ action: 'login.do', who: 'owner' });
    trail.record({ action: 'approval.decided', target: 'mail_send', content: 'Send the invoice to Robin' });
    const plain = unzip(trail.exportZip('json', { from: '2026-11-15', to: '2026-11-15' }).zip);
    const rows = JSON.parse(plain['audit.json']!);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r: { hash: string; prev: string }) => /^[0-9a-f]{64}$/.test(r.hash) && r.prev));
    assert.equal(plain['audit.json']!.includes('invoice'), false);
    const manifest = JSON.parse(plain['manifest.json']!);
    assert.equal(manifest.format, 'json');
    assert.equal(manifest.verified, true);
    assert.equal(manifest.hmacSha256, trail.sign(manifest));
    const withContent = unzip(trail.exportZip('json', {}, { content: true }).zip);
    assert.ok(withContent['audit.json']!.includes('invoice'));
    assert.equal(JSON.parse(unzip(trail.exportZip('json', { from: '2026-11-16' }).zip)['audit.json']!).length, 0);
  } finally {
    cleanup();
  }
});
