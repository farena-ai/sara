// V2.10 (docs/design/V2SCHEDULE.md): friend-to-friend scheduling over an S9a link. Two in-process
// servers: Alex asks, Sam shares his free/busy, Alex's server proposes 3 times, both pick the same one.
// Only {start, end} busy blocks cross; titles, places and attendees never leave either server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { busyBlocks, friendTimeOf, pickTimes, signFt } from '../src/friend-time.ts';
import { ROOT } from './helpers.ts';
import { clock, linkPair, pairNode, type PairNode } from './helpers-repair-pair.ts';

const H = 3600_000;
const at = (h: number, m = 0) => new Date(clock.now.getTime() + h * H + m * 60_000).toISOString();

/** Captures every body this node sends to its friend. */
function wire(n: PairNode): string[] {
  const out: string[] = [];
  const real = n.m.peerFetch.bind(n.m);
  n.m.peerFetch = (url: string, init: RequestInit) => {
    out.push(`${url}\n${String(init.body ?? '')}`);
    return real(url, init);
  };
  return out;
}

async function pair(t: import('node:test').TestContext, zones: [string, string] = ['America/Chicago', 'America/New_York']) {
  const a = await pairNode(t, 'Alex');
  const b = await pairNode(t, 'Sam');
  a.app.settings.update({ timeZone: zones[0] });
  b.app.settings.update({ timeZone: zones[1] });
  const { aLink, bLink } = await linkPair(a, b);
  return { a, b, aLink, bLink };
}

test('V2.10: blocks drop every word, widen to 15 minutes and merge', () => {
  const from = new Date(clock.now);
  const to = new Date(clock.now.getTime() + 48 * H);
  const blocks = busyBlocks(
    [
      { start: at(2, 7), end: at(2, 50), title: 'Dentist on Elm Street', location: 'Elm' },
      { start: at(2, 40), end: at(3, 20), title: 'Lunch with Kim' },
      { start: at(5), end: at(6), title: 'Holiday', allDay: true },
      { start: at(-5), end: at(1), title: 'Before the range' },
    ],
    from,
    to,
  );
  assert.deepEqual(blocks, [
    { start: at(0), end: at(1) },
    { start: at(2), end: at(3, 30) },
  ]);
  for (const b of blocks) assert.deepEqual(Object.keys(b).sort(), ['end', 'start']);
});

test('V2.10: three times on different days, never in busy time', () => {
  const now = new Date(clock.now);
  const busy = [{ start: at(-100), end: at(26) }];
  const times = pickTimes(busy, 60, now, new Date(now.getTime() + 7 * 24 * H));
  assert.equal(times.length, 3);
  const days = new Set(times.map((x) => x.slice(0, 10)));
  assert.equal(days.size, 3);
  for (const x of times) assert.ok(Date.parse(x) >= Date.parse(at(26)));
  assert.deepEqual(pickTimes([{ start: at(-1), end: at(200) }], 30, now, new Date(now.getTime() + 7 * 24 * H)), []);
});

test('V2.10: two linked servers agree a slot; only busy blocks cross', async (t) => {
  const { a, b, aLink, bLink } = await pair(t);
  const SECRET_A = ['Therapy', 'session', 'Oak'].join(' ');
  const SECRET_B = ['Job', 'interview', 'Acme'].join(' ');
  let aRead = 0;
  let bRead = 0;
  // Alex: busy every morning 15:00-19:00 UTC (9-13 in Chicago); Sam: the whole first day.
  friendTimeOf(a.app)!.events = async (from, to) => {
    aRead++;
    const out = [];
    for (let d = 0; d < 9; d++) out.push({ start: at(d * 24 + 3), end: at(d * 24 + 7), title: SECRET_A, location: 'Oak Street', attendees: ['kim@example.test'] });
    return out.filter((e) => Date.parse(e.end) > from.getTime() && Date.parse(e.start) < to.getTime());
  };
  friendTimeOf(b.app)!.events = async () => {
    bRead++;
    return [{ start: at(0), end: at(24), title: SECRET_B, location: 'Acme HQ' }];
  };
  const aOut = wire(a);
  const bOut = wire(b);

  const started = await a.req('POST', '/api/friend-time', { link: aLink, title: 'Coffee', minutes: 60, part: 'day', days: 7 });
  assert.equal(started.request.status, 'asked');
  assert.equal(started.request.friend, 'Sam');
  assert.equal(bRead, 0, 'nothing is read on Sam’s side before he says yes');
  const id = started.request.id;

  const seen = await b.req('GET', '/api/friend-time');
  const mine = seen.requests.find((r: any) => r.id === id);
  assert.equal(mine.side, 'friend');
  assert.equal(mine.status, 'asked');
  assert.equal(mine.friend, 'Alex');
  assert.equal(mine.title, 'Coffee');
  assert.equal(aRead, 0, 'the asker reads its calendar only once the friend shares');

  const shared = await b.req('POST', `/api/friend-time/${id}/share`, {});
  assert.equal(shared.request.status, 'proposed');
  assert.equal(shared.request.times.length, 3);
  const aView = (await a.req('GET', '/api/friend-time')).requests.find((r: any) => r.id === id);
  assert.equal(aView.status, 'proposed');
  assert.deepEqual(aView.times, shared.request.times);
  // Every time is free on both calendars, inside 9-17 for both people.
  for (const x of aView.times) {
    const s = Date.parse(x);
    assert.ok(s >= Date.parse(at(24)), 'Sam is busy the whole first day');
    for (const zone of ['America/Chicago', 'America/New_York']) {
      for (const edge of [s, s + 60 * 60_000 - 1]) {
        const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(edge)));
        assert.ok(h >= 9 && h < 17, `${x} inside daytime in ${zone}`);
      }
    }
  }

  // Different picks: not agreed yet.
  await b.req('POST', `/api/friend-time/${id}/pick`, { time: aView.times[2] });
  let r = (await a.req('POST', `/api/friend-time/${id}/pick`, { time: aView.times[0] })).request;
  assert.equal(r.status, 'proposed');
  assert.equal(r.theirPick, aView.times[2]);
  // Same pick: agreed on both servers, in both planners.
  r = (await a.req('POST', `/api/friend-time/${id}/pick`, { time: aView.times[2] })).request;
  assert.equal(r.status, 'agreed');
  assert.equal(r.agreed, aView.times[2]);
  const bDone = (await b.req('GET', '/api/friend-time')).requests.find((x: any) => x.id === id);
  assert.equal(bDone.status, 'agreed');
  assert.equal(bDone.agreed, aView.times[2]);
  const aTask = a.app.planner!.tasks({ status: 'open' }).find((x) => x.title === 'Coffee with Sam');
  const bTask = b.app.planner!.tasks({ status: 'open' }).find((x) => x.title === 'Coffee with Alex');
  assert.equal(aTask?.dueAt && new Date(aTask.dueAt).toISOString(), aView.times[2]);
  assert.equal(bTask?.dueAt && new Date(bTask.dueAt).toISOString(), aView.times[2]);

  // What crossed: the ask, Sam's busy blocks, the picks. No event words either way; Alex's blocks never left.
  const all = [...aOut, ...bOut].join('\n');
  for (const w of [SECRET_A, SECRET_B, 'Oak Street', 'Acme HQ', 'kim@example.test', 'Therapy', 'interview']) assert.ok(!all.includes(w), `${w} never crosses`);
  const busyCall = bOut.find((x) => x.includes('/msg/v1/ftime/busy'))!;
  const body = JSON.parse(busyCall.split('\n').slice(1).join('\n'));
  assert.deepEqual(Object.keys(body).sort(), ['busy', 'id', 'req', 'v']);
  for (const blk of body.busy) assert.deepEqual(Object.keys(blk).sort(), ['end', 'start']);
  assert.ok(!aOut.some((x) => x.includes('/busy')), 'the asker never sends its busy blocks');
  assert.ok(aOut.every((x) => !x.includes(at(3))), 'none of Alex’s busy times leave his server');
});

test('V2.10: each side keeps its own hours; no common time says so', async (t) => {
  const { a, b, aLink } = await pair(t, ['America/Chicago', 'Asia/Tokyo']);
  friendTimeOf(a.app)!.events = async () => [];
  friendTimeOf(b.app)!.events = async () => [];
  // Evening in Chicago (23:00-03:00 UTC) is the next morning in Tokyo: no evening fits both.
  const { request } = await a.req('POST', '/api/friend-time', { link: aLink, title: 'Call', minutes: 30, part: 'evening', days: 5 });
  const shared = await b.req('POST', `/api/friend-time/${request.id}/share`, {});
  assert.equal(shared.request.status, 'none');
  assert.deepEqual(shared.request.times, []);
  assert.equal((await a.req('GET', '/api/friend-time')).requests[0].status, 'none');
});

test('V2.10: decline, cancel and refused peer calls', async (t) => {
  const { a, b, aLink, bLink } = await pair(t);
  friendTimeOf(a.app)!.events = async () => [];
  friendTimeOf(b.app)!.events = async () => [];
  const one = (await a.req('POST', '/api/friend-time', { link: aLink, title: 'Walk', minutes: 30, part: 'any', days: 3 })).request;
  await b.req('POST', `/api/friend-time/${one.id}/decline`, {});
  assert.equal((await a.req('GET', '/api/friend-time')).requests.find((r: any) => r.id === one.id).status, 'declined');
  // A declined request can't be shared any more.
  assert.equal((await b.raw('POST', `/api/friend-time/${one.id}/share`, {})).status, 400);

  const two = (await a.req('POST', '/api/friend-time', { link: aLink, title: 'Lunch', minutes: 45, part: 'day', days: 5 })).request;
  const prop = (await b.req('POST', `/api/friend-time/${two.id}/share`, {})).request;
  // A time that was never proposed is refused.
  assert.equal((await a.raw('POST', `/api/friend-time/${two.id}/pick`, { time: at(1000) })).status, 400);
  // Busy blocks are taken once, and only by the asker's side.
  await assert.rejects(friendTimeOf(b.app)!.callForTest(bLink, 'busy', { req: two.id, busy: [] }), /already closed/);
  await assert.rejects(friendTimeOf(a.app)!.callForTest(aLink, 'busy', { req: two.id, busy: [] }), /not allowed/);
  // A forged signature (wrong scope word) is refused.
  const key = b.m.privateKeyFor(bLink)!;
  const raw = JSON.stringify({ v: 1, id: 'x1', req: two.id, time: prop.times[0] });
  const sig = signFt(bLink, 'pick', raw, key, clock.now, 'sproj');
  const res = await fetch(`${a.base}/msg/v1/ftime/pick`, { method: 'POST', headers: { 'content-type': 'application/json', ...sig }, body: raw });
  assert.equal(res.status, 401);
  await a.req('POST', `/api/friend-time/${two.id}/cancel`, {});
  assert.equal((await b.req('GET', '/api/friend-time')).requests.find((r: any) => r.id === two.id).status, 'cancelled');
  await a.req('DELETE', `/api/friend-time/${two.id}`);
  assert.ok(!(await a.req('GET', '/api/friend-time')).requests.some((r: any) => r.id === two.id));
});

test('V2.10: chat tool, lean words and the off-server lists', () => {
  const chat = readFileSync(join(ROOT, 'src/chat.ts'), 'utf8');
  const lean = readFileSync(join(ROOT, 'src/lean.ts'), 'utf8');
  assert.match(chat, /PEOPLE_TOOLS = new Set\([^)]*'friend_time'/);
  assert.match(chat, /OFFSERVER_TOOL = [\s\S]{0,1500}?name === 'friend_time';/);
  assert.match(lean, /friend_time/);
  assert.match(lean, /friendtime: \[[^\]]*'find a time'/);
  const web = readFileSync(join(ROOT, 'web/friend-time.js'), 'utf8');
  assert.doesNotMatch(web, /#[0-9a-f]{3,6}\b/i, 'theme variables only');
});
