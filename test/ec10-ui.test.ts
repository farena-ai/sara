// EC10 (docs/ops/EC10_DESIGN.md): the Secret sources box under Settings → Data & health → Operations
// and the policy pin's checkbox. Names, references and status only; never a value.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');

test('EC10 UI: the box sits on the Operations page, owner only, hidden until loaded, no inline styles', () => {
  const page = /<section class="settings-page" data-page="dh-operations"[^>]*>([\s\S]*?)<\/section>/.exec(html)!;
  assert.match(page[0], /data-owner-only/);
  const box = /<div id="ss-box"[^>]*>([\s\S]*?)<\/details>\s*<\/div>/.exec(page[1])!;
  assert.match(box[0], /^<div id="ss-box"[^>]*\bhidden\b/);
  for (const id of ['ss-summary', 'ss-list', 'ss-check', 'ss-status']) assert.ok(box[0].includes(`id="${id}"`), id);
  for (const ref of ['env:OPENAI_KEY', 'file:/run/secrets/openai', 'vault:secret/sara#openai', 'op://Servers/OpenAI/credential', 'keychain:sara/openai', 'env:KEY_A | env:KEY_B']) assert.ok(box[0].includes(`<code>${ref}</code>`), ref);
  assert.ok(!/style=/.test(box[0]));
  for (const m of box[0].matchAll(/data-tip="([^"]+)"/g)) assert.ok(m[1].length <= 260, m[1]);
  const js = readFileSync(join(ROOT, 'web', 'secret-sources.js'), 'utf8');
  assert.ok(!/\.style\b|innerHTML/.test(js), 'no inline styles or HTML strings');
  assert.ok(/id="po-secrets"/.test(html), 'the policy page has the pin');
  const gov = readFileSync(join(ROOT, 'web', 'governance.js'), 'utf8');
  assert.match(gov, /externalSecrets: true/);
});

test('EC10 UI: status lines are translated from the template the server sends', async () => {
  const stub = String.raw`const t = (s, p = {}) => '«' + s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)) + '»';`;
  const src = readFileSync(join(ROOT, 'web', 'secret-sources.js'), 'utf8').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub);
  const { refLine, summaryLine } = (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as { refLine: (r: unknown) => string; summaryLine: (v: unknown) => string };
  assert.equal(refLine({ ok: null }), '«Not read yet.»');
  assert.equal(refLine({ ok: true }), '«Working.»');
  assert.equal(refLine({ ok: false, error: 'The environment variable A is not set.', errorKey: 'The environment variable {name} is not set.', params: { name: 'A' } }), '«The environment variable A is not set.»');
  assert.equal(refLine({ ok: false, error: 'plain' }), 'plain');
  assert.equal(summaryLine({ configured: { vault: true, onepassword: false }, commands: false, ttlSeconds: 300, pinned: true }), '«Vault: set up» · «1Password Connect: not set up» · «Commands: off» · «read again every 5 min» · «Your policy allows only references for server keys.»');
});
