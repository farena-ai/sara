// Phase 8: morning briefing (time window, weather facts, fallback, delivery).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BriefingWorker, defaultUnits, geocode, plainBriefing } from '../src/briefing.ts';
import { makeApp, tempDir } from './helpers.ts';

const fakeFetch = async (url: string) => {
  if (url.includes('geocoding')) return new Response(JSON.stringify({ results: [{ name: 'Kansas City', latitude: 39.1, longitude: -94.6, admin1: 'Kansas', country_code: 'US' }, { name: 'Kansas City', latitude: 39.09, longitude: -94.58, admin1: 'Missouri', country_code: 'US' }] }));
  if (url.includes('forecast')) {
    assert.match(url, /temperature_unit=fahrenheit/);
    return new Response(JSON.stringify({ current: { temperature_2m: 51.4, weather_code: 2 }, daily: { temperature_2m_max: [68.2], temperature_2m_min: [47.9], precipitation_probability_max: [20], weather_code: [61] } }));
  }
  return new Response('{}', { status: 404 });
};

test('geocode picks the state the owner named; units follow the time zone', async () => {
  const p = await geocode('Kansas City, MO', fakeFetch as never);
  assert.equal(p.name, 'Kansas City, Missouri, US');
  assert.equal(defaultUnits('America/Chicago'), 'F');
  assert.equal(defaultUnits('Europe/Berlin'), 'C');
  assert.equal(defaultUnits('America/Sao_Paulo'), 'C');
});

test('briefing goes out once, at the chosen time, with weather and the list', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-26T12:00:00Z') }; // 07:00 in Chicago
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Alex',
    timeZone: 'America/Chicago',
    briefing: { enabled: true, time: '07:30', place: { name: 'Kansas City, Missouri, US', lat: 39.09, lon: -94.58 } },
  });
  app.planner!.addTask({ title: 'Call the plumber', dueAt: '2026-10-26T20:00:00Z' });
  const conv = app.store.createConversation({ channelKey: 'home' }); // Y5: her own chat, where the briefing goes (src/home-chat.ts)
  app.store.addMessage(conv.id, 'user', 'hi');
  const w = new BriefingWorker(app, fakeFetch as never);
  assert.equal(await w.tick(), undefined, 'not yet 07:30');
  clock.now = new Date('2026-10-26T12:31:00Z');
  app.script.push([{ type: 'text', text: 'Morning, Alex! Light rain later, high 68°. Don\u2019t forget to call the plumber today.' }]);
  const sent = await w.tick();
  assert.match(sent!, /plumber/);
  const req = app.requests.at(-1)!;
  assert.match(JSON.stringify(req.messages), /Kansas City: light rain, now 51°F, high 68°, low 48°, 20% chance of rain/);
  assert.match(JSON.stringify(req.messages), /Call the plumber/);
  const last = app.store.messages(conv.id).at(-1)!;
  assert.deepEqual(last.meta?.briefing, { day: '2026-10-26' });
  assert.equal(await w.tick(), undefined, 'only once a day');

  // Model unavailable → plain facts; a briefing missed by hours is skipped.
  clock.now = new Date('2026-10-27T12:35:00Z');
  app.script.push([{ type: 'text', text: '' }]);
  const plain = await w.tick();
  assert.match(plain!, /^Good morning! It's Tuesday, October 27\./);
  clock.now = new Date('2026-10-28T20:00:00Z');
  assert.equal(await w.tick(), undefined, '7 hours late: skipped');
});

// Bug (2026-10-29, owner's server): he switched the briefing on at 09:07 with the time set to
// 07:00 and pressed "Send one now" the same second. The minute tick (07:00 already passed, under
// 3 hours late) sent the day's briefing too: two "Morning, Frank" messages 91 ms apart.
test('the scheduled briefing and "Send one now" never make two briefings at once', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-29T14:07:56Z') }; // 09:07 in Chicago, briefing time 07:00
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  app.settings.update({
    providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }],
    defaultProviderId: 'p',
    defaultModel: 'm',
    ownerName: 'Frank',
    timeZone: 'America/Chicago',
    briefing: { enabled: true, time: '07:00', place: { name: 'Kansas City, Missouri, US', lat: 39.09, lon: -94.58 } },
  });
  const conv = app.store.createConversation({ channelKey: 'home' }); // Y5: her own chat, where the briefing goes (src/home-chat.ts)
  app.store.addMessage(conv.id, 'user', 'hi');
  const briefings = () => app.store.messages(conv.id).filter((m) => m.role === 'assistant' && m.meta?.briefing);
  app.script.push([{ type: 'text', text: 'Morning, Frank! First one.' }]);
  const w = new BriefingWorker(app, fakeFetch as never);
  // Owner's button and the minute tick at the same moment, in both orders.
  const [now1, tick1] = await Promise.all([w.send(), w.tick()]);
  assert.equal(briefings().length, 1, 'one briefing, not two');
  assert.equal(tick1, undefined, 'the tick left it to the one already being written');
  assert.match(now1, /First one/);
  assert.equal(app.requests.length, 1, 'one model call');

  // Next day: the tick starts first and the owner presses the button while it is writing.
  clock.now = new Date('2026-10-30T12:05:00Z');
  app.script.push([{ type: 'text', text: 'Morning again!' }]);
  const [tick2, now2] = await Promise.all([w.tick(), w.send()]);
  assert.equal(briefings().length, 2);
  assert.match(tick2!, /Morning again/);
  assert.equal(now2, tick2, 'the button gets the briefing that was already on its way');

  // Asked for again later that day: an explicit request still sends one.
  app.script.push([{ type: 'text', text: 'Here it is again.' }]);
  assert.match(await w.send(), /again/);
  assert.equal(briefings().length, 3);
});

test('a restart or a lost "sent today" mark never re-sends the day\'s briefing', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-10-29T12:10:00Z') }; // 07:10 in Chicago
  const app = makeApp(dir, clock);
  t.after(() => {
    app.store.close();
    cleanup();
  });
  const briefing = { enabled: true, time: '07:00' };
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', timeZone: 'America/Chicago', briefing });
  const conv = app.store.createConversation({ channelKey: 'home' }); // Y5: her own chat, where the briefing goes (src/home-chat.ts)
  app.store.addMessage(conv.id, 'user', 'hi');
  app.script.push([{ type: 'text', text: 'Morning!' }]);
  assert.match((await new BriefingWorker(app, fakeFetch as never).tick())!, /Morning/);
  // The settings write that saved "sent today" is lost (a save from the Settings window that read
  // the old settings, a restore, a crash): a new worker after a restart must still not send again.
  app.settings.update({ briefing });
  clock.now = new Date('2026-10-29T12:30:00Z');
  assert.equal(await new BriefingWorker(app, fakeFetch as never).tick(), undefined);
  assert.equal(app.store.messages(conv.id).filter((m) => m.meta?.briefing).length, 1);
  assert.equal(app.requests.length, 1, 'no second model call');
  // The next day goes out as usual.
  clock.now = new Date('2026-10-30T12:01:00Z');
  assert.ok(await new BriefingWorker(app, fakeFetch as never).tick());
});

test('plain briefing reads well', () => {
  const t = plainBriefing({ date: 'Monday, October 26', weather: 'KC: clear', agenda: '- task #3 "Pay rent": due today Mon 5:00 PM\n- 2 other open tasks (use the todo tool to list them)' });
  assert.equal(t, `Good morning! It's Monday, October 26.\nWeather: KC: clear.\nOn your list:\n- "Pay rent": due today Mon 5:00 PM\n- 2 other open tasks`);
});
