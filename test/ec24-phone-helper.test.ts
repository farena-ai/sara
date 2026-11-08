// EC24 (docs/ops/EC24_DESIGN.md): the phone-helper broker. A request reaches only opted-in devices,
// waits for Allow once / Deny, times out, can be cancelled, checks what comes back (picture size and
// type, coordinates), rounds the location unless precise was asked, honours the policy pin and
// writes exactly one audit row per request. Nothing is kept once the request is settled.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { EventHub, type HubEvent } from '../src/events.ts';
import { IMAGE_MAX_BYTES, PhoneHelper, coarse, parseImage } from '../src/phone-helper.ts';
import { PolicyStore, setPolicy } from '../src/policy-profile.ts';
import { tempDir } from './helpers.ts';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 2)]);
const url = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

function setup(t: { after: (fn: () => void) => void }, o: { timeoutMs?: number; pins?: Record<string, unknown> } = {}) {
  const { dir, cleanup } = tempDir();
  const events = new EventHub();
  const seen: HubEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const alive = new Set(['s-phone', 's-laptop']);
  const trail = new AuditTrail(dir, { key: () => 'k', policyRev: () => 0 });
  setAuditTrail(trail);
  const pol = new PolicyStore(dir);
  if (o.pins) pol.set({ name: 'Family rules', pins: o.pins });
  setPolicy(pol);
  const helper = new PhoneHelper({ dir, events, timeoutMs: o.timeoutMs ?? 2000, alive: (id) => alive.has(id), label: (id) => (id === 's-phone' ? 'Pixel 9' : 'Laptop') });
  t.after(() => {
    helper.cancelAll();
    setPolicy(new PolicyStore());
    setAuditTrail(undefined);
    cleanup();
  });
  return { dir, helper, seen, alive, trail };
}
const asks = (seen: HubEvent[]) => seen.filter((e): e is Extract<HubEvent, { type: 'helper' }> => e.type === 'helper');
const rows = (trail: AuditTrail) => trail.list({ limit: 50 }).filter((r) => r.action.startsWith('phone.'));

test('opt in per device: kept in a file, only live sessions count, off by default', (t) => {
  const { dir, helper, alive } = setup(t);
  assert.equal(helper.available(), false, 'no device: the tools are not offered');
  helper.setDevice('s-phone', true);
  assert.deepEqual(helper.devices().map((d) => d.label), ['Pixel 9']);
  assert.ok(helper.isDevice('s-phone') && !helper.isDevice('s-laptop'));
  assert.ok(existsSync(join(dir, 'phone-helper.json')));
  assert.ok(!readFileSync(join(dir, 'phone-helper.json'), 'utf8').includes('Pixel'), 'only session ids, no labels or data');
  const again = new PhoneHelper({ dir, alive: (id) => alive.has(id), label: () => 'Pixel 9' });
  assert.ok(again.isDevice('s-phone'), 'survives a restart');
  alive.delete('s-phone');
  assert.equal(helper.available(), false, 'a signed-out device no longer counts');
  assert.equal(helper.isDevice('s-phone'), false);
  helper.setDevice('s-phone', false);
  assert.equal(helper.devices().length, 0);
});

test('camera: asked, allowed once, the picture comes back, nothing is left behind, one audit row', async (t) => {
  const { helper, seen, trail } = setup(t);
  helper.setDevice('s-phone', true);
  const p = helper.request('camera', { reason: 'Is the plant wilting?' });
  const ask = asks(seen)[0];
  assert.equal(ask.state, 'asking');
  assert.equal(ask.kind, 'camera');
  assert.equal(ask.reason, 'Is the plant wilting?');
  assert.deepEqual(helper.pending().map((r) => r.id), [ask.id]);
  helper.answer(ask.id, 's-phone', { allow: true, image: url('image/jpeg', JPEG) });
  const r = await p;
  assert.ok(r.ok && (r.kind === 'camera' || r.kind === 'screen'));
  if (r.ok && 'image' in r) {
    assert.equal(r.image.mime, 'image/jpeg');
    assert.ok(r.image.data.equals(JPEG));
  }
  assert.equal(helper.pending().length, 0, 'the request is gone once answered');
  assert.equal(asks(seen).at(-1)!.state, 'done', 'the prompt closes on every helper device');
  const a = rows(trail);
  assert.equal(a.length, 1);
  assert.equal(a[0].action, 'phone.camera');
  assert.equal(a[0].outcome, 'ok');
  assert.equal(a[0].target, 'Pixel 9');
  assert.ok(!JSON.stringify(a).includes(JPEG.toString('base64').slice(0, 20)), 'never the picture');
});

test('deny: refused, the reason is not stored, one row', async (t) => {
  const { helper, seen, trail } = setup(t);
  helper.setDevice('s-phone', true);
  const p = helper.request('screen', { reason: 'Show me the error' });
  helper.answer(asks(seen)[0].id, 's-phone', { allow: false });
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.outcome, 'denied');
  const a = rows(trail);
  assert.deepEqual(a.map((x) => [x.action, x.outcome]), [['phone.screen', 'refused']]);
  assert.ok(!JSON.stringify(a).includes('Show me the error'));
});

test('timeout: no answer, the prompt expires, a late answer is refused (404)', async (t) => {
  const { helper, seen, trail } = setup(t, { timeoutMs: 60 });
  helper.setDevice('s-phone', true);
  const r = await helper.request('location', { reason: 'Where are you?' });
  assert.equal(!r.ok && r.outcome, 'timeout');
  assert.equal(asks(seen).at(-1)!.state, 'expired');
  assert.throws(() => helper.answer(asks(seen)[0].id, 's-phone', { allow: true, lat: 1, lon: 2 }), (e: Error & { status?: number }) => e.status === 404);
  assert.deepEqual(rows(trail).map((x) => x.outcome), ['failed']);
});

test('cancel: a stopped turn closes the prompt', async (t) => {
  const { helper, seen } = setup(t);
  helper.setDevice('s-phone', true);
  const ac = new AbortController();
  const p = helper.request('camera', { reason: 'x', signal: ac.signal });
  ac.abort();
  const r = await p;
  assert.equal(!r.ok && r.outcome, 'cancelled');
  assert.equal(asks(seen).at(-1)!.state, 'cancelled');
  assert.equal(helper.pending().length, 0);
});

test('only an opted-in device may answer; the first answer wins', async (t) => {
  const { helper, seen } = setup(t);
  helper.setDevice('s-phone', true);
  const p = helper.request('camera', { reason: 'x' });
  const id = asks(seen)[0].id;
  assert.throws(() => helper.answer(id, 's-laptop', { allow: true, image: url('image/jpeg', JPEG) }), (e: Error & { status?: number }) => e.status === 403);
  assert.throws(() => helper.answer('nope', 's-phone', { allow: false }), (e: Error & { status?: number }) => e.status === 404);
  helper.answer(id, 's-phone', { allow: false });
  assert.throws(() => helper.answer(id, 's-phone', { allow: true }), (e: Error & { status?: number }) => e.status === 404);
  assert.equal(!(await p).ok, true);
});

test('payload limits: type, magic bytes, size; a bad picture fails the request', async (t) => {
  assert.equal(parseImage(url('image/png', PNG)).mime, 'image/png');
  assert.throws(() => parseImage(url('image/gif', JPEG)), /picture/i);
  assert.throws(() => parseImage(url('image/jpeg', PNG)), /picture/i, 'bytes must match the type');
  assert.throws(() => parseImage('hello'), /picture/i);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(IMAGE_MAX_BYTES)]);
  assert.throws(() => parseImage(url('image/jpeg', big)), (e: Error & { status?: number }) => e.status === 413);
  const { helper, seen, trail } = setup(t);
  helper.setDevice('s-phone', true);
  const p = helper.request('camera', { reason: 'x' });
  assert.throws(() => helper.answer(asks(seen)[0].id, 's-phone', { allow: true, image: 'data:text/plain;base64,aGk=' }), (e: Error & { status?: number }) => e.status === 400);
  const r = await p;
  assert.equal(!r.ok && r.outcome, 'error');
  assert.deepEqual(rows(trail).map((x) => x.outcome), ['failed']);
});

test('location: coarse by default (about 1 km), exact only when asked, coordinates checked', async (t) => {
  assert.deepEqual(coarse(48.858372, 2.294481, 12, false), { lat: 48.86, lon: 2.29, accuracy: 1000 });
  assert.deepEqual(coarse(48.858372, 2.294481, 12, true), { lat: 48.85837, lon: 2.29448, accuracy: 12 });
  const { helper, seen } = setup(t);
  helper.setDevice('s-phone', true);
  const p = helper.request('location', { reason: 'weather' });
  assert.equal(asks(seen)[0].precise, false);
  assert.throws(() => helper.answer(asks(seen)[0].id, 's-phone', { allow: true, lat: 123, lon: 2 }), (e: Error & { status?: number }) => e.status === 400);
  const r = await p;
  assert.equal(!r.ok && r.outcome, 'error');
  const q = helper.request('location', { reason: 'directions', precise: true });
  const ask = asks(seen).filter((e) => e.state === 'asking').at(-1)!;
  assert.equal(ask.precise, true);
  helper.answer(ask.id, 's-phone', { allow: true, lat: 48.858372, lon: 2.294481, accuracy: 8 });
  const ok = await q;
  assert.ok(ok.ok && ok.kind === 'location' && ok.lat === 48.85837 && ok.precise === true);
});

test('a device can say it cannot do it (no screen share on this phone)', async (t) => {
  const { helper, seen } = setup(t);
  helper.setDevice('s-phone', true);
  const p = helper.request('screen', { reason: 'x' });
  helper.answer(asks(seen)[0].id, 's-phone', { allow: true, error: 'unsupported' });
  const r = await p;
  assert.equal(!r.ok && r.outcome, 'unsupported');
});

test('policy pin phoneHelper:false: nothing offered, nothing asked, opting in refused', async (t) => {
  const { helper, seen, trail } = setup(t, { pins: { phoneHelper: false } });
  assert.throws(() => helper.setDevice('s-phone', true), (e: Error & { status?: number }) => e.status === 409);
  const r = await helper.request('camera', { reason: 'x' });
  assert.equal(!r.ok && r.outcome, 'off');
  assert.equal(asks(seen).length, 0, 'the phone is never asked');
  assert.equal(helper.available(), false);
  assert.deepEqual(rows(trail).map((x) => x.outcome), ['refused']);
  assert.throws(() => new PolicyStore().set({ name: 'x', pins: { phoneHelper: true } }), /only be pinned off/);
});

test('no helper device: the request fails at once without asking anyone', async (t) => {
  const { helper, seen } = setup(t);
  const r = await helper.request('camera', { reason: 'x' });
  assert.equal(!r.ok && r.outcome, 'no-device');
  assert.equal(asks(seen).length, 0);
});
