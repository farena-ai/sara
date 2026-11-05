import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { allKeys } from '../scripts/i18n-extract.ts';
import { tipCoverage } from '../scripts/tip-coverage.ts';
test('business markup participates in translations and tips without control exemptions', () => {
  assert.ok(allKeys().has('Your individual sign-in'));
  const snippet = '<body data-business><label>Name<input id="business-name"></label><label>File<input id="business-file" type="file"></label></body>';
  assert.equal(tipCoverage(snippet).uncovered.length, 2);
  assert.equal(tipCoverage(snippet.replace('id="business-name"', 'id="business-name" data-tip="Name shown to colleagues."').replace('id="business-file"', 'id="business-file" data-tip="Only text files."')).uncovered.length, 0);
  const html = readFileSync(new URL('../web/business.html', import.meta.url), 'utf8');
  assert.equal(tipCoverage(html).uncovered.length, 0); assert.ok(tipCoverage(html).total >= 10);
});
