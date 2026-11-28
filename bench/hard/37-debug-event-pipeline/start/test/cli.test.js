import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, tempDir } from './helpers.js';

const line = (id, account, amount) => JSON.stringify({ id, key: account, data: { account, amount } });

test('relay run prints the counters and the ledger totals', () => {
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, 'in.ndjson'), [line('1', 'acct-1', '10.00'), '# a comment', '', line('2', 'acct-2', '-2.50'), line('3', 'acct-1', '0.05')].join('\n'));
    const r = cli(t.dir, 'run', 'in.ndjson');
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, 'submitted 3, duplicates 0, delivered 3, retried 0, dead 0, pending 0\n  acct-1              10.05\n  acct-2              -2.50\n');
  } finally {
    t.cleanup();
  }
});

test('relay journal ls and relay totals read the journal', () => {
  const t = tempDir();
  try {
    writeFileSync(join(t.dir, 'in.ndjson'), [line('1', 'acct-1', '10.00'), line('2', 'acct-2', '1.25')].join('\n'));
    assert.equal(cli(t.dir, 'run', 'in.ndjson', '--journal', 'j', '--segment-size=3').code, 0);
    assert.equal(cli(t.dir, 'journal', 'ls', '--journal', 'j').out, 'segment-1.log          3 records\nsegment-2.log          1 records\n');
    assert.deepEqual(JSON.parse(cli(t.dir, 'totals', '--journal', 'j', '--json').out), { 'acct-1': '10.00', 'acct-2': '1.25' });
  } finally {
    t.cleanup();
  }
});

test('usage errors exit with 2', () => {
  const t = tempDir();
  try {
    const r = cli(t.dir, 'run', 'in.ndjson', '--batch', 'x');
    assert.equal(r.code, 2);
    assert.match(r.err, /--batch must be a whole number/);
    assert.equal(cli(t.dir, 'nope').code, 2);
  } finally {
    t.cleanup();
  }
});
