// EC2: the company sign-in screens are served, translated, tipped and free of inline styles.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LANGS, fromJs, loadLang } from '../scripts/i18n-extract.ts';
import { tipCoverage } from '../scripts/tip-coverage.ts';
import { contentFixture } from './helpers/business-content.ts';

const web = (name: string) => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');

test('sso ui: sign-in buttons start hidden and the settings module is served by the business shell only', async () => {
  const html = web('business.html');
  for (const id of ['sso-signin', 'sso-join', 'sso-link', 'sso-hint']) assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), id);
  assert.equal(tipCoverage(html).uncovered.length, 0);
  const f = await contentFixture();
  try {
    const script = await fetch(f.runtime.origin + '/business-sso.js');
    assert.equal(script.status, 200); assert.match(script.headers.get('content-type')!, /javascript/);
    assert.match(await script.text(), /renderSsoSettings/);
  } finally { await f.close(); }
});

test('sso ui: every string is translated, tips stay within 260 characters, no inline styles', () => {
  const source = web('business-sso.js');
  assert.doesNotMatch(source, /\.style\b|style=|cssText/);
  assert.doesNotMatch(web('business-app.js'), /\.style\.|style=/);
  const keys = fromJs(source);
  assert.ok(keys.length > 40, `found ${keys.length} strings`);
  const tips = [...source.matchAll(/(?:field|check)\(t\('(?:[^'\\]|\\.)*'\),\s*t\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1].replace(/\\'/g, "'"));
  assert.ok(tips.length >= 14, `found ${tips.length} tips`);
  for (const tip of tips) assert.ok(tip.length <= 260, tip);
  for (const lang of LANGS) {
    const d = loadLang(lang);
    for (const k of keys) assert.ok(d[k]?.trim(), `${lang}: ${k}`);
    for (const tip of tips) assert.ok(d[tip].length <= 260, `${lang} tip too long (${d[tip].length}): ${d[tip].slice(0, 60)}`);
  }
});

test('sso ui: every refusal reason the server sends has a message in the sign-in page', () => {
  const app = web('business-app.js');
  const server = readFileSync(new URL('../src/business/sso.ts', import.meta.url), 'utf8');
  const reasons = /export type SsoReason = ([^;]+);/.exec(server)![1].match(/'([a-z_]+)'/g)!.map(x => x.slice(1, -1));
  assert.ok(reasons.length >= 10);
  for (const reason of reasons) assert.match(app, new RegExp(`\\b${reason}: \\(\\) => t\\(`), reason);
});
