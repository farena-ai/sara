import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, parseCreditLines, UsageError } from '../src/cli/args.js';
import { main } from '../src/cli/main.js';
import { calculateInvoice, renderText } from '../src/index.js';
import { invoice, line } from './helpers.js';

test('parseArgs', () => {
  assert.deepEqual(parseArgs(['calc', 'a.json', '--json']), { command: 'calc', file: 'a.json', json: true, lang: 'en', lines: null, number: null, date: null });
  assert.deepEqual(parseArgs(['credit', 'a.json', '--lines=A:2,B', '--date', '2026-01-01']).lines, [{ id: 'A', quantity: '2' }, { id: 'B' }]);
  assert.throws(() => parseArgs(['calc']), UsageError);
  assert.throws(() => parseArgs(['print', 'a.json']), UsageError);
  assert.throws(() => parseArgs(['calc', 'a.json', '--lang']), UsageError);
  assert.throws(() => parseCreditLines(':2'), UsageError);
});

test('renderText', () => {
  const text = renderText(calculateInvoice(invoice({ lines: [line('A', '2', '10.00', 'standard', { description: 'Widget' })] })));
  assert.match(text, /^Invoice T-1 {2}2026-01-15 {2}EUR\n/);
  assert.ok(text.includes('\nA   Widget         2       10.00   20.00      0.00  standard\n'), text);
  assert.match(text, /\nPayable {2}24\.00\n$/);
  assert.ok(!/ \n/.test(text), 'no trailing spaces');
});

test('main prints a result and reports errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tally-'));
  try {
    const file = join(dir, 'inv.json');
    writeFileSync(file, JSON.stringify(invoice({ lines: [line('A', '1', '5.00')] })));
    let out = '';
    let err = '';
    const io = { out: (s) => (out += s), err: (s) => (err += s) };
    assert.equal(main(['calc', file, '--json'], io), 0);
    assert.equal(JSON.parse(out).totals.gross, '6.00');
    writeFileSync(file, JSON.stringify(invoice({ currency: 'XXX' })));
    assert.equal(main(['calc', file], io), 1);
    assert.match(err, /UNKNOWN_CURRENCY/);
    assert.equal(main(['calc', join(dir, 'missing.json')], io), 1);
    assert.equal(main(['oops'], io), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
