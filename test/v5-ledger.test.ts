// V5.2 (docs/design/V5LEDGER.md): the privacy ledger. Every request that leaves the server through
// the net guard is counted by destination host and purpose (never bodies, paths or queries); a
// "What left this server" view per day; private local mode shows zero.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { netFetch, noteOutbound, openWebSocket, setNetTransport, setPrivateLocal } from '../src/net-guard.ts';
import { ledgerHints, LEDGER_DAYS, PrivacyLedger, purposeOf, setPrivacyLedger } from '../src/privacy-ledger.ts';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const realFetch = globalThis.fetch.bind(globalThis);
const sent: string[] = [];
const fakeTransport = (async (input: string | URL | Request) => {
  sent.push(String(input instanceof Request ? input.url : input));
  return new Response('{}', { status: 200 });
}) as typeof fetch;

/** A body word that must never reach the ledger file (built at run time). */
const secretWord = ['priv', 'ate', '-', String(Date.now() % 1000)].join('');

test('purposes: the caller label first, then the owner hints, then known services, then the home network', () => {
  const hints = [{ host: 'llm.example.test', purpose: 'model' as const }];
  assert.equal(purposeOf('api.openai.com', undefined, []), 'model');
  assert.equal(purposeOf('api.search.brave.com', undefined, []), 'search');
  assert.equal(purposeOf('gmail.googleapis.com', undefined, []), 'mail');
  assert.equal(purposeOf('fcm.googleapis.com', undefined, []), 'notifications');
  assert.equal(purposeOf('backstagecoding.com', undefined, []), 'makers');
  assert.equal(purposeOf('api.telegram.org', undefined, []), 'chat-apps');
  assert.equal(purposeOf('llm.example.test', undefined, hints), 'model');
  assert.equal(purposeOf('eu.llm.example.test', undefined, hints), 'model', 'a hint covers subdomains');
  assert.equal(purposeOf('imap.example.test', 'your mail server', hints), 'mail');
  assert.equal(purposeOf('192.168.1.20', undefined, []), 'home-network');
  assert.equal(purposeOf('news.example.test', undefined, []), 'other');
});

test('ledger hints come from the owner settings: model providers, the search address, the hub', () => {
  const hints = ledgerHints({ providers: [{ baseUrl: 'https://llm.example.test/v1' }, { baseUrl: 'http://127.0.0.1:11434/v1' }, {}], search: { url: 'https://searx.example.test/' } }, 'https://hub.example.test/sara/hub');
  assert.deepEqual(hints.map((h) => `${h.host}=${h.purpose}`).sort(), ['hub.example.test=makers', 'llm.example.test=model', 'searx.example.test=search']);
});

test('fake requests show under the right destination and purpose; loopback is not counted; bodies never kept', async (t) => {
  const { dir, cleanup } = tempDir();
  const file = join(dir, 'privacy-ledger.json');
  let now = new Date('2026-11-18T15:00:00Z');
  const ledger = new PrivacyLedger({ file, timeZone: () => 'America/Chicago', now: () => now, hints: () => [{ host: 'llm.example.test', purpose: 'model' }] });
  setPrivacyLedger(ledger);
  setNetTransport(fakeTransport);
  t.after(() => {
    setPrivacyLedger(undefined);
    setNetTransport();
    cleanup();
  });
  await netFetch('https://llm.example.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: secretWord }] }) });
  await netFetch('https://llm.example.test/v1/chat/completions?key=' + secretWord, { method: 'POST', body: 'x'.repeat(100) });
  await netFetch('https://api.search.brave.com/res/v1/web/search?q=' + secretWord);
  await netFetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: 'local' });
  await netFetch('http://localhost:8080/x');
  noteOutbound(`tcp://imap.example.test:993`, 'your mail server');
  const day = ledger.day('2026-11-18');
  assert.equal(day.total.count, 4);
  assert.equal(day.total.places, 3);
  const model = day.groups.find((g) => g.purpose === 'model')!;
  assert.equal(model.count, 2);
  assert.equal(model.hosts[0].host, 'llm.example.test');
  assert.ok(model.bytes >= 100 + secretWord.length, 'request sizes are added up');
  assert.equal(day.groups.find((g) => g.purpose === 'search')!.hosts[0].host, 'api.search.brave.com');
  const mail = day.groups.find((g) => g.purpose === 'mail')!;
  assert.equal(mail.hosts[0].host, 'imap.example.test');
  assert.equal(mail.hosts[0].unsized, 1, 'a raw connection has no size to tell');
  assert.ok(!day.groups.some((g) => g.hosts.some((h) => /127\.0\.0\.1|localhost/.test(h.host))), 'this computer is not "leaving"');
  ledger.flush();
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(secretWord), 'no body, query or path is kept');
  assert.ok(!raw.includes('/v1/chat'), 'no paths are kept');
  // A late request in Chicago is still the same local day (UTC already says the 19th).
  now = new Date('2026-11-19T05:30:00Z');
  await netFetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });
  assert.equal(ledger.day('2026-11-18').total.count, 5);
  now = new Date('2026-11-19T07:00:00Z');
  await netFetch('https://api.openai.com/v1/responses', { method: 'POST', body: '{}' });
  assert.equal(ledger.day('2026-11-19').total.count, 1);
  assert.deepEqual(ledger.days().map((d) => d.day), ['2026-11-19', '2026-11-18']);
  // Kept across a restart; days past the window are dropped.
  ledger.flush();
  const again = new PrivacyLedger({ file, timeZone: () => 'America/Chicago', now: () => now });
  assert.equal(again.day('2026-11-18').total.count, 5);
  now = new Date(now.getTime() + (LEDGER_DAYS + 2) * 86_400_000);
  again.note('https://api.openai.com/v1/x');
  assert.deepEqual(again.days().map((d) => d.day).length, 1, 'old days are dropped');
});

test('WebSockets count too; private local mode shows zero left and counts what was stopped', async (t) => {
  const { dir, cleanup } = tempDir();
  const ledger = new PrivacyLedger({ file: join(dir, 'l.json'), timeZone: () => 'UTC', now: () => new Date('2026-11-18T12:00:00Z') });
  setPrivacyLedger(ledger);
  setNetTransport(fakeTransport);
  t.after(() => {
    setPrivateLocal(false);
    setPrivacyLedger(undefined);
    setNetTransport();
    cleanup();
  });
  setPrivateLocal(true);
  await assert.rejects(netFetch('https://api.openai.com/v1/chat/completions', { method: 'POST', body: '{}' }));
  await assert.rejects(netFetch('https://api.search.brave.com/res/v1/web/search'));
  assert.throws(() => openWebSocket('wss://gateway.discord.gg/'));
  await netFetch('http://127.0.0.1:11434/api/chat', { method: 'POST', body: '{}' });
  const day = ledger.day('2026-11-18');
  assert.equal(day.total.count, 0, 'nothing left');
  assert.deepEqual(day.groups, []);
  assert.equal(day.stopped.reduce((n, s) => n + s.count, 0), 3);
  assert.ok(day.stopped.some((s) => s.host === 'api.openai.com'));
});

test('route: GET /api/private-local/ledger shows the day; DELETE forgets it; owner only', async (t) => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-18T12:00:00Z') };
  const app = makeApp(dir, clock);
  app.settings.update({ timeZone: 'UTC', providers: [{ id: 'x', label: 'X', kind: 'openai-compatible', baseUrl: 'https://llm.example.test/v1' }], defaultProviderId: 'x', defaultModel: 'm', disclosureAcceptedAt: clock.now.toISOString() });
  const file = join(dir, 'privacy-ledger.json');
  const ledger = new PrivacyLedger({ file, timeZone: () => app.settings.get().timeZone, now: () => clock.now, hints: () => ledgerHints(app.settings.get(), 'https://hub.example.test/sara/hub') });
  setPrivacyLedger(ledger);
  setNetTransport(fakeTransport);
  const auth = new OwnerAuth(dir, () => clock.now);
  const owner = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    server.close();
    setPrivacyLedger(undefined);
    setNetTransport();
    app.store.close();
    cleanup();
  });
  const call = async (path: string, method = 'GET', token = owner) => {
    const r = await realFetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: base } });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  await netFetch('https://llm.example.test/v1/chat', { method: 'POST', body: '{}' });
  await netFetch('https://hub.example.test/sara/hub/checkin', { method: 'POST', body: '{}' });
  let r = await call('/private-local/ledger');
  assert.equal(r.status, 200);
  assert.equal(r.json.day, '2026-11-18');
  assert.equal(r.json.total.count, 2);
  assert.deepEqual(r.json.groups.map((g: { purpose: string }) => g.purpose).sort(), ['makers', 'model']);
  assert.equal(r.json.privateLocal, false);
  r = await call('/private-local/ledger?day=2026-11-01');
  assert.equal(r.json.total.count, 0);
  r = await call('/private-local/ledger?day=nonsense');
  assert.equal(r.status, 400);
  r = await call('/private-local/ledger', 'GET', 'not-a-token');
  assert.equal(r.status, 401);
  r = await call('/private-local/ledger', 'DELETE');
  assert.equal(r.status, 200);
  r = await call('/private-local/ledger');
  assert.equal(r.json.total.count, 0);
  assert.ok(!existsSync(file) || !readFileSync(file, 'utf8').includes('llm.example.test'));
});

test('web: the Privacy page has the What left this server section with tips, loaded with the page', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const page = html.slice(html.indexOf('data-page="dh-privacy"'), html.indexOf('data-page="dh-reports"'));
  assert.match(page, /<h3[^>]*>What left this server <button type="button" class="tip"/);
  for (const id of ['pv-ledger-day', 'pv-ledger-list', 'pv-ledger-forget']) assert.match(page, new RegExp(`id="${id}"`));
  assert.match(page, /class="tip" data-tip="Pick a day[^"]*">\?<\/button> <select id="pv-ledger-day"/, 'the day picker has its tip before it');
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /pick === 'dh-privacy'[\s\S]{0,300}loadLedger/);
  const js = readFileSync(join(ROOT, 'web', 'privacy-ledger.js'), 'utf8');
  assert.match(js, /api\('\/private-local\/ledger/);
  assert.doesNotMatch(js, /innerHTML\s*=\s*[^'"`]/, 'host names are drawn as text');
});
