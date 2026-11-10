// 3.3.0 (easy reach): where the phone app card, the away-from-home page and the no-reach notes live.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const html = read('web', 'index.html');
const app = read('web', 'app.js');
const reach = read('web', 'reach.js');
const movein = read('web', 'movein.js');
const page = (id: string) => {
  const i = html.indexOf(`data-page="${id}"`);
  return html.slice(i, html.indexOf('</section>', i));
};

test('reach UI: Connect the Sara phone app sits on Phone and notifications (where Today leads) and Devices', () => {
  assert.match(page('co-phone'), /<div id="reach-phone" class="rch-host"/);
  assert.match(read('src', 'checklist.ts'), /label: 'Put her on your phone'[^\n]*open: 'settings:co-phone'/);
  assert.match(app, /if \(pick === 'co-phone' && !inPhoneApp\(navigator\.userAgent\)\) void renderPhoneConnect\(\$\('#reach-phone'\)\)/);
  const dev = page('dh-devices');
  assert.match(dev, /id="pair-noreach"/);
  assert.match(dev, /id="reach-away-h">Use Sara away from home/);
  assert.match(dev, /<div id="reach-away" class="rch-host"/);
  // Where to get the app: Google Play. GitHub releases carry no Android app, so no dead download link.
  for (const s of [dev, reach]) {
    assert.match(s, /https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.backstagecoding\.sara/);
    assert.doesNotMatch(s, /Or download it here/);
  }
});

test('reach UI: the QR is the phone link from the server, never the old /pair one; no address → Set up access', () => {
  const fn = app.slice(app.indexOf("$('#pair-new').addEventListener('click'"), app.indexOf("$('#pair-cancel')"));
  assert.match(fn, /if \(p\.phone\) \$\('#pair-qr'\)\.src = p\.phone\.qr;/);
  assert.doesNotMatch(fn, /\$\('#pair-qr'\)\.src = p\.qr/);
  assert.match(fn, /\$\('#pair-noreach'\)\.hidden = Boolean\(p\.phone\)/);
  assert.match(reach, /if \(p\.phone\) \{[\s\S]*qrImg\(p\.phone\.qr/);
  assert.match(reach, /Your phone can't reach this computer yet[\s\S]*Set up access/);
});

test('reach UI: the move-in step shows no line when the other computer cannot reach Sara', () => {
  const fn = movein.slice(movein.indexOf('async function otherComputer()'));
  const noReach = fn.indexOf('if (r.reachable === false)');
  assert.ok(noReach > 0 && noReach < fn.indexOf('pre.textContent = r.lines[os]'), 'checked before any line is shown');
  assert.match(fn, /I have a move-in file[\s\S]*sara:open-away/);
  assert.doesNotMatch(movein, /Open Sara on the old computer with the address you use from elsewhere/);
});

test('reach UI: Health shows the real answer, not "open the address you use now"', () => {
  assert.doesNotMatch(app, /Open the address you use now on your phone/);
  assert.match(app, /void reachLine\(\$\('#reach-line'\)\)/);
  assert.match(page('dh-health'), /<div id="reach-line"/);
});

test('reach UI: findable by Ctrl K and the settings search; turning access on asks first', () => {
  assert.match(app, /add\('away', 'phone', t\('Use Sara away from home'\), \(\) => openAway\(\)/);
  assert.match(app, /add\('phone-app', 'phone', t\('Connect the Sara phone app'\)/);
  const kw = read('web', 'settings-search.js');
  for (const k of ['add a computer', 'add desktop', 'away from home', 'tailscale', 'use on my phone outside']) assert.ok(kw.includes(`'${k}'`), k);
  assert.match(reach, /if \(!confirm\(t\('Turn on secure access with Tailscale\?/);
  assert.match(reach, /body: \{ action: 'on', confirm: true \}/);
  assert.match(reach, /if \(!confirm\(t\('Turn off secure access\?/);
});

test('reach UI: the new tip is short enough in every language', () => {
  const tip = /id="reach-away-h">Use Sara away from home <button type="button" class="tip" data-tip="([^"]+)"/.exec(html)![1];
  assert.ok(tip.length <= 260);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const m = new RegExp(`^${JSON.stringify(tip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: (".*")`, 'm').exec(read('web', 'i18n', `${l}.json`));
    assert.ok(m, l);
    assert.ok((JSON.parse(m[1]) as string).length <= 260, l);
  }
});
