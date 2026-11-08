// EC24 (docs/ops/EC24_DESIGN.md): the device prompt and the Settings switch. The prompt is a modal
// that must be answered (never silent): Allow once / Deny, her reason, what she gets, the seconds
// left; Escape is Deny. No inline styles or HTML strings, short tips, the policy checkbox, and the
// words for every kind of request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const js = readFileSync(join(ROOT, 'web', 'phone-helper.js'), 'utf8');

async function load() {
  const stub = String.raw`const t = (s, p = {}) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m)); const setIcon = () => {};`;
  const src = js.replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub).replace(/^import \{[^}]*\} from '\.\/icons\.js';$/m, '');
  return (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as {
    whatLine: (r: unknown) => string;
    leftLine: (at: string, now?: number) => string;
  };
}

test('EC24 the prompt: a required modal with Allow once and Deny, her reason and the time left', () => {
  const d = /<dialog id="helper-ask"[^>]*>([\s\S]*?)<\/dialog>/.exec(html)!;
  assert.ok(d, 'the dialog exists');
  assert.match(d[0], /data-required="1"/, 'cannot be dismissed by tapping outside');
  for (const id of ['helper-title', 'helper-reason', 'helper-what', 'helper-allow', 'helper-deny', 'helper-left', 'helper-video', 'helper-shoot']) assert.ok(d[1].includes(`id="${id}"`), id);
  assert.match(d[1], />Allow once</);
  assert.match(d[1], />Deny</);
  assert.ok(!/style=/.test(d[0]));
  assert.match(js, /addEventListener\('cancel'[\s\S]{0,120}allow: false/, 'Escape answers Deny');
  assert.ok(!/\.style\b|innerHTML/.test(js), 'no inline styles or HTML strings');
  assert.match(js, /getTracks\(\)[\s\S]{0,40}stop\(\)/, 'the capture is stopped');
});

test('EC24 Settings: the switch on Devices and sign-in, hidden until loaded, short tips; the policy checkbox', () => {
  const page = /<section class="settings-page" data-page="dh-devices"[^>]*>([\s\S]*?)<\/section>/.exec(html)!;
  const box = /<div id="hd-box"[^>]*>([\s\S]*?)<\/div>/.exec(page[1])!;
  assert.match(box[0], /\bhidden\b/);
  assert.ok(box[1].includes('id="hd-on"'));
  assert.ok(!/style=/.test(box[0]));
  for (const m of box[1].matchAll(/data-tip="([^"]+)"/g)) assert.ok(m[1].length <= 260, m[1]);
  const po = /<label class="row"><input id="po-phone"[\s\S]*?<\/label>/.exec(html)!;
  assert.ok(po, 'the policy page can pin it off');
  for (const m of po[0].matchAll(/data-tip="([^"]+)"/g)) assert.ok(m[1].length <= 260);
  const gov = readFileSync(join(ROOT, 'web', 'governance.js'), 'utf8');
  assert.match(gov, /phoneHelper: false/);
  assert.match(gov, /phoneHelper: \['#hd-on'\]/, 'the switch shows the lock');
});

test('EC24 the words: what she gets for each kind, and the seconds left', async () => {
  const { whatLine, leftLine } = await load();
  assert.match(whatLine({ kind: 'location', precise: false }), /approximate/);
  assert.match(whatLine({ kind: 'location', precise: true }), /exact/);
  assert.match(whatLine({ kind: 'camera' }), /before it is sent/);
  assert.match(whatLine({ kind: 'camera', facing: 'front' }), /front/);
  assert.match(whatLine({ kind: 'screen' }), /screen or window/);
  assert.equal(leftLine(new Date(10_000 + 45_000).toISOString(), 10_000), 'Closes in 45 s if you do nothing.');
  assert.equal(leftLine(new Date(0).toISOString(), 10_000), 'Closes in 0 s if you do nothing.');
});
