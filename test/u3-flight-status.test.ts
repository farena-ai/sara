// U3.14 (docs/TRAVEL.md "Flight status sources"): OpenSky Network as a free flight status source
// next to AirLabs. Anonymous (no sign-up, no key), personal non-commercial use, live positions only:
// in the air or on the ground, never gates, delays or cancellations. Off until the person picks it.
// Recorded fixture responses only: no test reaches the network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { callsignOf, openskySource, OPENSKY_LIMITS, Travel, type FetchLike } from '../src/travel.ts';
import { makeApp, tempDir } from './helpers.ts';

// A recorded /api/states/all answer (shape from the OpenSky REST docs; made-up aircraft and values).
// Fields: icao24, callsign, origin_country, time_position, last_contact, lon, lat, baro_altitude,
// on_ground, velocity, true_track, vertical_rate, sensors, geo_altitude, squawk, spi, position_source.
const hex = (n: number) => (0xa00000 + n).toString(16);
const state = (n: number, callsign: string, lon: number, lat: number, alt: number | null, ground: boolean) => [hex(n), callsign.padEnd(8, ' '), 'Testland', 1795000000, 1795000000, lon, lat, alt, ground, ground ? 0 : 245.1, 280.5, 0, null, alt, null, false, 0];
const STATES = (rows: unknown[][]) => ({ time: 1795000000, states: rows });

function recorder(answer: unknown, status = 200) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  };
  return { urls, fetchImpl };
}

const DEP = '2026-11-20T15:55:00Z'; // FRA 10:55 local
const ARR = '2026-11-20T18:50:00Z'; // JFK 13:50 local
const ctx = { from: 'FRA', to: 'JFK', departsAt: DEP, arrivesAt: ARR };

test('U3.14 callsigns: airline IATA code → ICAO callsign; unknown airlines are refused', () => {
  assert.equal(callsignOf('LH400'), 'DLH400');
  assert.equal(callsignOf('LH 0400'), 'DLH400');
  assert.equal(callsignOf('UA1'), 'UAL1');
  assert.equal(callsignOf('IB3456'), 'IBE3456');
  assert.equal(callsignOf('ZZ123'), undefined);
  assert.equal(callsignOf('not a flight'), undefined);
});

test('U3.14 OpenSky: in the air, with position and honest limits (one small anonymous query)', async () => {
  const { urls, fetchImpl } = recorder(STATES([state(1, 'BAW117', -30, 52, 10970, false), state(2, 'DLH400', -35.2, 51.5, 11280, false)]));
  const src = openskySource(fetchImpl, () => new Date('2026-11-20T17:00:00Z'));
  assert.equal(src.id, 'opensky');
  const st = await src.status('LH400', '2026-11-20', undefined, ctx);
  assert.equal(urls.length, 1);
  const u = new URL(urls[0]!);
  assert.equal(`${u.origin}${u.pathname}`, 'https://opensky-network.org/api/states/all');
  // A bounding box around both airports (fewer credits than the whole world), no key or account.
  for (const k of ['lamin', 'lomin', 'lamax', 'lomax']) assert.ok(u.searchParams.has(k), k);
  assert.ok(!/key|token|user|pass/i.test(urls[0]!));
  assert.equal(st?.state, 'active');
  assert.deepEqual(st?.position, { lat: 51.5, lon: -35.2, altM: 11280, onGround: false });
  assert.equal(st?.source, 'OpenSky Network');
  assert.equal(st?.limits, OPENSKY_LIMITS);
  assert.equal(st?.depDelayMin, undefined);
  assert.equal(st?.depGate, undefined);
});

test('U3.14 OpenSky: on the ground at the destination after departure → landed; at the origin → still on the ground', async () => {
  const landed = recorder(STATES([state(2, 'DLH400', -73.78, 40.64, null, true)]));
  const st = await openskySource(landed.fetchImpl, () => new Date('2026-11-20T19:10:00Z')).status('LH400', '2026-11-20', undefined, ctx);
  assert.equal(st?.state, 'landed');
  const waiting = recorder(STATES([state(2, 'DLH400', 8.56, 50.03, null, true)]));
  const st2 = await openskySource(waiting.fetchImpl, () => new Date('2026-11-20T15:40:00Z')).status('LH400', '2026-11-20', undefined, ctx);
  assert.equal(st2?.state, 'scheduled');
  assert.equal(st2?.position?.onGround, true);
});

test('U3.14 OpenSky: no call outside the flight window, for unknown airlines, or without a time; not seen → nothing', async () => {
  const r = recorder(STATES([]));
  const far = openskySource(r.fetchImpl, () => new Date('2026-11-19T12:00:00Z'));
  assert.equal(await far.status('LH400', '2026-11-20', undefined, ctx), undefined);
  const now = openskySource(r.fetchImpl, () => new Date('2026-11-20T17:00:00Z'));
  assert.equal(await now.status('ZZ123', '2026-11-20', undefined, ctx), undefined);
  assert.equal(await now.status('LH400', '2026-11-20'), undefined);
  assert.equal(r.urls.length, 0);
  assert.equal(await now.status('LH400', '2026-11-20', undefined, ctx), undefined);
  assert.equal(r.urls.length, 1);
  // Over the date line the box would be wrong: the whole world is asked instead.
  const pac = recorder(STATES([]));
  await openskySource(pac.fetchImpl, () => new Date('2026-11-20T17:00:00Z')).status('NH105', '2026-11-20', undefined, { from: 'HND', to: 'LAX', departsAt: DEP, arrivesAt: ARR });
  assert.ok(!new URL(pac.urls[0]!).searchParams.has('lamin'));
});

test('U3.14 OpenSky: out of credits or an error is reported as an error (no made-up status)', async () => {
  const r = recorder({}, 429);
  await assert.rejects(openskySource(r.fetchImpl, () => new Date('2026-11-20T17:00:00Z')).status('LH400', '2026-11-20', undefined, ctx), /OpenSky HTTP 429/);
});

test('U3.14 Travel settings: OpenSky is off by default, needs no key, and says what it cannot do', async (t) => {
  const { dir, cleanup } = tempDir();
  const app = makeApp(dir, { now: new Date('2026-11-20T17:00:00Z') });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const r = recorder(STATES([state(2, 'DLH400', -35.2, 51.5, 11280, false)]));
  const travel = new Travel(app, app.store.db, { fetch: r.fetchImpl });
  assert.equal(travel.settings().provider, 'off');
  assert.match(travel.statusText({ id: 1, title: 'x', dates: '', bookings: [] } as never), /Flight status is off/);
  const s = travel.setSettings({ provider: 'opensky' });
  assert.equal(s.provider, 'opensky');
  assert.equal(s.hasKey, false);
  assert.equal(travel.setSettings({ provider: 'bogus' }).provider, 'opensky');
  assert.equal(travel.setSettings({ provider: 'off' }).provider, 'off');
});
