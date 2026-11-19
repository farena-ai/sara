// V4.3 (docs/HEALTH.md "Imports"): readers for Apple Health export.xml / export.zip, Google Takeout
// Fit and Garmin CSV/FIT exports → sealed daily measurements (steps, sleep, heart rate, resting heart
// rate, weight) in the person's own health log, deduped (a second import adds nothing), with a trend
// on the Health page. Every export here is synthetic, built at run time.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { childRouteCheck } from '../src/family.ts';
import { readHealthExport, readFit } from '../src/health-import.ts';
import { healthFor, HealthLog } from '../src/health-log.ts';
import { createSaraServer } from '../src/server.ts';
import { createHealthTools } from '../src/tools/health-log.ts';
import { zipStored } from '../src/zip-write.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const TZ = 'America/Chicago';
const clock = { now: new Date('2026-11-18T14:00:00Z') };
const { dir, cleanup } = tempDir();
const app = makeApp(dir, clock);
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
let base = '';
before(async () => {
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: TZ, disclosureAcceptedAt: clock.now.toISOString() } as never);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  HealthLog.closeFor(app.dataDir);
  app.store.close();
  cleanup();
});
const upload = async (name: string, body: Buffer) => {
  const res = await fetch(`${base}/api/health-log/import?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const get = async (path: string, method = 'GET') => {
  const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const deflateZip = (files: [string, string | Buffer][]) => zipStored(files.map(([path, s]) => ({ path, data: typeof s === 'string' ? Buffer.from(s, 'utf8') : s })), { deflate: true });

// ---------------------------------------------------------------- synthetic Apple Health export
const iphone = ['Alex', '’s iPhone'].join('');
const watch = ['Alex', '’s Apple Watch'].join('');
const rec = (type: string, src: string, start: string, end: string, value: string, unit: string, child = '') =>
  child
    ? `  <Record type="${type}" sourceName="${src}" sourceVersion="17.1" unit="${unit}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}">\n   ${child}\n  </Record>`
    : `  <Record type="${type}" sourceName="${src}" sourceVersion="17.1" unit="${unit}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>`;
const sleep = (src: string, start: string, end: string, value: string) => `  <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="${src}" creationDate="${end}" startDate="${start}" endDate="${end}" value="${value}"/>`;
const APPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>\n]>',
  '<HealthData locale="en_US">',
  ' <ExportDate value="2026-11-10 08:00:00 -0600"/>',
  ' <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>',
  // Steps: the phone and the watch both count the same walk; the day is the bigger of the two.
  rec('HKQuantityTypeIdentifierStepCount', iphone, '2026-11-01 09:00:00 -0600', '2026-11-01 09:10:00 -0600', '3000', 'count'),
  rec('HKQuantityTypeIdentifierStepCount', iphone, '2026-11-01 17:00:00 -0600', '2026-11-01 17:30:00 -0600', '2000', 'count'),
  rec('HKQuantityTypeIdentifierStepCount', watch, '2026-11-01 09:00:00 -0600', '2026-11-01 09:10:00 -0600', '4000', 'count'),
  rec('HKQuantityTypeIdentifierStepCount', watch, '2026-11-01 17:00:00 -0600', '2026-11-01 17:30:00 -0600', '2500', 'count'),
  rec('HKQuantityTypeIdentifierStepCount', iphone, '2026-11-02 10:00:00 -0600', '2026-11-02 11:00:00 -0600', '7000', 'count'),
  rec('HKQuantityTypeIdentifierHeartRate', watch, '2026-11-01 08:00:00 -0600', '2026-11-01 08:00:00 -0600', '60', 'count/min', '<MetadataEntry key="HKMetadataKeyHeartRateMotionContext" value="0"/>'),
  rec('HKQuantityTypeIdentifierHeartRate', watch, '2026-11-01 12:00:00 -0600', '2026-11-01 12:00:00 -0600', '80', 'count/min'),
  rec('HKQuantityTypeIdentifierRestingHeartRate', watch, '2026-11-01 00:00:00 -0600', '2026-11-01 23:59:00 -0600', '58', 'count/min'),
  rec('HKQuantityTypeIdentifierBodyMass', iphone, '2026-11-01 07:00:00 -0600', '2026-11-01 07:00:00 -0600', '172.4', 'lb'),
  rec('HKQuantityTypeIdentifierBodyMass', iphone, '2026-11-02 07:05:00 -0600', '2026-11-02 07:05:00 -0600', '172', 'lb'),
  rec('HKQuantityTypeIdentifierDietaryWater', iphone, '2026-11-01 07:00:00 -0600', '2026-11-01 07:00:00 -0600', '250', 'mL'),
  // Sleep: two sources overlap (union = 23:00-06:30, 7.5 h); in-bed time is ignored when asleep time exists.
  sleep(iphone, '2026-10-31 22:30:00 -0600', '2026-11-01 06:45:00 -0600', 'HKCategoryValueSleepAnalysisInBed'),
  sleep(watch, '2026-10-31 23:00:00 -0600', '2026-11-01 03:00:00 -0600', 'HKCategoryValueSleepAnalysisAsleepCore'),
  sleep(watch, '2026-11-01 02:00:00 -0600', '2026-11-01 06:30:00 -0600', 'HKCategoryValueSleepAnalysisAsleepDeep'),
  sleep(watch, '2026-11-01 01:00:00 -0600', '2026-11-01 01:10:00 -0600', 'HKCategoryValueSleepAnalysisAwake'),
  // A night with in-bed time only: that is what counts.
  sleep(iphone, '2026-11-01 23:00:00 -0600', '2026-11-02 06:00:00 -0600', 'HKCategoryValueSleepAnalysisInBed'),
  ' <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="30"/>',
  '</HealthData>',
  '',
].join('\n');

test('Apple Health: steps per day from the bigger source, sleep as merged time asleep, heart rate, weight', async () => {
  const r = await readHealthExport('export.zip', deflateZip([['apple_health_export/export.xml', APPLE], ['apple_health_export/export_cda.xml', '<x/>']]), { tz: TZ });
  assert.equal(r.source, 'apple');
  const by = (m: string) => r.readings.filter((x) => x.metric === m).map((x) => [x.day, x.value, x.unit]);
  assert.deepEqual(by('steps'), [['2026-11-01', 6500, 'steps'], ['2026-11-02', 7000, 'steps']]);
  assert.deepEqual(by('sleep'), [['2026-11-01', 7.5, 'h'], ['2026-11-02', 7, 'h']]);
  assert.deepEqual(by('heart rate'), [['2026-11-01', 70, 'bpm']]);
  assert.deepEqual(by('resting heart rate'), [['2026-11-01', 58, 'bpm']]);
  assert.deepEqual(by('weight'), [['2026-11-01', 172.4, 'lb'], ['2026-11-02', 172, 'lb']]);
  assert.equal(r.readings.find((x) => x.metric === 'weight')?.at, '2026-11-01T13:00:00.000Z', 'a weight keeps its own time');
  // The plain export.xml reads the same.
  const plain = await readHealthExport('export.xml', Buffer.from(APPLE, 'utf8'), { tz: TZ });
  assert.deepEqual(plain.readings, r.readings);
});

// ---------------------------------------------------------------- synthetic Google Takeout (Fit)
const GOOGLE_DAILY = [
  'Date,Move Minutes count,Calories (kcal),Distance (m),Heart Points,Heart Minutes,Average heart rate (bpm),Max heart rate (bpm),Min heart rate (bpm),Average speed (m/s),Max speed (m/s),Min speed (m/s),Step count,Average weight (kg),Max weight (kg),Min weight (kg)',
  '2026-11-03,45,2100.5,5000.2,20,15,72.4,130,55,1.2,2.0,0.5,8123,78.2,78.4,78.0',
  '2026-11-04,30,1900,4000,,,,,,,,,6000,,,',
  '',
].join('\n');
const GOOGLE_DAY_FILE = 'Start time,End time,Step count\n00:00:00.000-06:00,00:15:00.000-06:00,99999\n';
const GOOGLE_SLEEP = JSON.stringify({ fitnessActivity: 'sleep', startTime: '2026-11-04T05:00:00.000Z', endTime: '2026-11-04T12:30:00.000Z', duration: '27000s' });
const GOOGLE_WALK = JSON.stringify({ fitnessActivity: 'walking', startTime: '2026-11-04T15:00:00.000Z', endTime: '2026-11-04T15:30:00.000Z', duration: '1800s' });
const googleZip = () =>
  deflateZip([
    ['Takeout/Fit/Daily activity metrics/Daily activity metrics.csv', GOOGLE_DAILY],
    ['Takeout/Fit/Daily activity metrics/2026-11-03.csv', GOOGLE_DAY_FILE],
    ['Takeout/Fit/All Sessions/2026-11-03T23_00_00Z_SLEEP.json', GOOGLE_SLEEP],
    ['Takeout/Fit/All Sessions/2026-11-04T09_00_00-06_00_WALKING.json', GOOGLE_WALK],
    ['Takeout/archive_browser.html', '<html></html>'],
  ]);

test('Google Takeout Fit: the daily metrics file and sleep sessions (per-day files are not counted twice)', async () => {
  const r = await readHealthExport('takeout-20261110.zip', googleZip(), { tz: TZ });
  assert.equal(r.source, 'google');
  const by = (m: string) => r.readings.filter((x) => x.metric === m).map((x) => [x.day, x.value, x.unit]);
  assert.deepEqual(by('steps'), [['2026-11-03', 8123, 'steps'], ['2026-11-04', 6000, 'steps']]);
  assert.deepEqual(by('heart rate'), [['2026-11-03', 72.4, 'bpm']]);
  assert.deepEqual(by('weight'), [['2026-11-03', 78.2, 'kg']], 'max/min weight columns are not readings');
  assert.deepEqual(by('sleep'), [['2026-11-04', 7.5, 'h']], 'the night belongs to the local day she woke up');
});

// ---------------------------------------------------------------- synthetic Garmin CSV + FIT
const GARMIN_SLEEP = 'Date,Score,Resting Heart Rate,Body Battery,Quality,Duration,Sleep Need,Bedtime,Wake Time\n2026-11-05,82,54,60,Good,7h 32min,8h,10:41 PM,6:13 AM\n2026-11-06,--,--,--,--,--,8h,--,--\n';
const GARMIN_WEIGHT = 'Time,Weight,Change,BMI,Body Fat\n"Nov 5, 2026",175.2 lbs,0.2 lbs,24.1,20 %\n';
const GARMIN_STEPS = 'Date,Steps,Goal\n11/05/2026,"9,876","7,500"\n';

/** A tiny FIT file writer (definition + data per message, little-endian). */
function fit(msgs: { global: number; fields: [num: number, size: number, base: number, value: number][] }[]): Buffer {
  const parts: Buffer[] = [];
  for (const [i, m] of msgs.entries()) {
    const local = i % 4;
    const def = Buffer.alloc(6 + m.fields.length * 3);
    def[0] = 0x40 | local;
    def[2] = 0;
    def.writeUInt16LE(m.global, 3);
    def[5] = m.fields.length;
    m.fields.forEach(([n, s, b], k) => def.set([n, s, b], 6 + k * 3));
    const data = Buffer.alloc(1 + m.fields.reduce((a, f) => a + f[1], 0));
    data[0] = local;
    let o = 1;
    for (const [, s, , v] of m.fields) {
      if (s === 1) data.writeUInt8(v, o);
      else if (s === 2) data.writeUInt16LE(v, o);
      else data.writeUInt32LE(v, o);
      o += s;
    }
    parts.push(def, data);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(14);
  head[0] = 14;
  head[1] = 0x20;
  head.writeUInt16LE(2100, 2);
  head.writeUInt32LE(body.length, 4);
  head.write('.FIT', 8, 'latin1');
  return Buffer.concat([head, body, Buffer.alloc(2)]);
}
const fitTime = (iso: string) => Math.round(Date.parse(iso) / 1000) - 631_065_600;
const GARMIN_FIT = () =>
  fit([
    // monitoring (55): timestamp 253, activity_type 5 (6 walking, 1 running), cycles 3 (steps, cumulative), heart_rate 27
    { global: 55, fields: [[253, 4, 0x86, fitTime('2026-11-05T16:00:00Z')], [5, 1, 0, 6], [3, 4, 0x86, 4000], [27, 1, 2, 64]] },
    { global: 55, fields: [[253, 4, 0x86, fitTime('2026-11-05T20:00:00Z')], [5, 1, 0, 6], [3, 4, 0x86, 5200], [27, 1, 2, 66]] },
    { global: 55, fields: [[253, 4, 0x86, fitTime('2026-11-05T21:00:00Z')], [5, 1, 0, 1], [3, 4, 0x86, 800], [27, 1, 2, 0xff]] },
    // weight_scale (30): weight 0 (kg × 100)
    { global: 30, fields: [[253, 4, 0x86, fitTime('2026-11-06T13:10:00Z')], [0, 2, 0x84, 7900]] },
  ]);

test('Garmin: sleep, weight and steps CSV files and a .fit file', async () => {
  const s = await readHealthExport('Sleep.csv', Buffer.from(GARMIN_SLEEP), { tz: TZ });
  assert.equal(s.source, 'garmin');
  assert.deepEqual(s.readings.map((x) => [x.metric, x.day, x.value]), [['sleep', '2026-11-05', 7.53], ['resting heart rate', '2026-11-05', 54]]);
  const w = await readHealthExport('Weight.csv', Buffer.from(GARMIN_WEIGHT), { tz: TZ });
  assert.deepEqual(w.readings.map((x) => [x.metric, x.day, x.value, x.unit]), [['weight', '2026-11-05', 175.2, 'lb']]);
  const st = await readHealthExport('Steps.csv', Buffer.from(GARMIN_STEPS), { tz: TZ });
  assert.deepEqual(st.readings.map((x) => [x.metric, x.day, x.value]), [['steps', '2026-11-05', 9876]]);
  const f = readFit(GARMIN_FIT(), TZ);
  assert.deepEqual(f.map((x) => [x.metric, x.day, x.value, x.unit]), [['steps', '2026-11-05', 6000, 'steps'], ['heart rate', '2026-11-05', 65, 'bpm'], ['weight', '2026-11-06', 79, 'kg']]);
  // A zip of Garmin files reads them all.
  const z = await readHealthExport('garmin.zip', deflateZip([['Sleep.csv', GARMIN_SLEEP], ['monitor/1234.fit', GARMIN_FIT()]]), { tz: TZ });
  assert.equal(z.source, 'garmin');
  assert.equal(z.readings.length, 5);
});

test('a file that is no health export gets a plain answer', async () => {
  await assert.rejects(readHealthExport('notes.txt', Buffer.from('hello there'), { tz: TZ }), /Apple Health|Google|Garmin/);
  await assert.rejects(readHealthExport('x.csv', Buffer.from('a,b\n1,2\n'), { tz: TZ }), /no steps, sleep, heart rate or weight/i);
  const r = await upload('notes.txt', Buffer.from('hello there'));
  assert.equal(r.status, 400);
});

test('import once through the page; a second import adds nothing; sealed at rest; trend and undo', async () => {
  const first = await upload('export.zip', deflateZip([['apple_health_export/export.xml', APPLE]]));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.added, 8);
  assert.equal(first.body.source, 'apple');
  const again = await upload('export.zip', deflateZip([['apple_health_export/export.xml', APPLE]]));
  assert.equal(again.status, 200);
  assert.equal(again.body.added, 0, 'a second import adds nothing');
  assert.equal(again.body.updated, 0);
  assert.equal(again.body.same, 8);
  const h = healthFor(app);
  assert.equal(h.entries({}).length, 8);
  assert.equal(h.imports().length, 1, 'an import that changed nothing leaves no row');

  // Another source with the same day keeps the first one (no double steps); new days are added.
  const g = await upload('takeout.zip', googleZip());
  assert.equal(g.body.added, 5);
  const g2 = await upload('takeout.zip', googleZip());
  assert.equal(g2.body.added, 0);
  const fitUp = await upload('1234.fit', GARMIN_FIT());
  assert.equal(fitUp.body.added, 3);
  assert.equal((await upload('1234.fit', GARMIN_FIT())).body.added, 0);

  // Weight follows the unit the person already uses (the Apple export said lb): Google's 78.2 kg is shown in lb.
  const kg = h.entries({ name: 'weight' }).find((e) => e.at.startsWith('2026-11-03'));
  assert.equal(kg?.unit, 'lb');
  assert.equal(kg?.value, 172.4);

  // Sealed: no reading value or source name is in the database file in clear.
  const raw = readFileSync(join(h.dir, 'health.db')).toString('latin1') + (() => {
    try {
      return readFileSync(join(h.dir, 'health.db-wal')).toString('latin1');
    } catch {
      return '';
    }
  })();
  for (const word of ['6500', '8123', 'steps', 'apple', 'export.zip', 'resting']) assert.ok(!raw.includes(word), `"${word}" is not stored in clear`);

  // The page: imported rows stay out of the hand-logged list, the trend shows them.
  const page = (await get('/api/health-log')).body;
  assert.equal(page.entries.length, 0, 'hand-logged list is not flooded by imports');
  const steps = page.trends.find((t: { name: string }) => t.name === 'steps');
  assert.ok(steps, JSON.stringify(page.trends));
  assert.equal(steps.last.day, '2026-11-05');
  assert.equal(steps.last.value, 6000);
  assert.equal(steps.points.length, 5);
  assert.equal(steps.avg7, Math.round((6500 + 7000 + 8123 + 6000 + 6000) / 5));
  assert.deepEqual(page.trends.map((t: { name: string }) => t.name), ['steps', 'sleep', 'heart rate', 'resting heart rate', 'weight']);
  assert.equal(page.imports.length, 3);
  assert.deepEqual(page.imports.map((i: { source: string }) => i.source).sort(), ['apple', 'garmin', 'google']);

  // The doctor summary sums device days instead of listing each one.
  const md = h.summaryMarkdown('2026-11-01', '2026-11-06');
  assert.match(md, /From your devices/);
  assert.match(md, /\| steps \| 5 \| 6725 \| 6000 \| 8123 \|/);

  // Chat reading lists hand-logged entries and a device line per measurement.
  const read = createHealthTools(() => app).find((t) => t.spec.name === 'health_read')!;
  const out = String(await read.run({ what: 'readings', days: 30 }, { workspaceDir: '.', signal: new AbortController().signal, sandbox: { kind: 'none' }, modelLocal: true } as never));
  assert.match(out, /steps: 7-day average/);

  // Undo an import: its rows go, a later import of the same file adds them back.
  const garmin = page.imports.find((i: { source: string }) => i.source === 'garmin');
  const del = await get(`/api/health-log/imports/${garmin.id}`, 'DELETE');
  assert.equal(del.body.removed, 3);
  assert.equal((await upload('1234.fit', GARMIN_FIT())).body.added, 3);
});

test('a child cannot import (a parent manages their log); the demo has none', () => {
  assert.equal(childRouteCheck('k1', { band: '9-12' } as never, 'POST', ['health-log', 'import'])?.status, 403);
  assert.equal(childRouteCheck('k1', { band: '9-12' } as never, 'DELETE', ['health-log', 'imports', '1'])?.status, 403);
});
