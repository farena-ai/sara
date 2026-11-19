// W4.6 (docs/design/W4RECORDS.md): public-records report, personal use only. Fake search results
// and fake pages only (no live scraping): paid brokers skipped, sign-in-only sites never opened,
// robots.txt and bot checks honoured, confidence per match, "not found" sections, children refused,
// every search in the audit log, a growing places list, Find more sources, and a PDF whose every
// page carries the exact notice.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { AuditTrail, setAuditTrail } from '../src/audit-trail.ts';
import { cleanQuery, childSignal, isPaidBroker, isSignInOnly, PAID_BROKERS, RECORDS_HEADER, Records, recordsDeps, STARTER_PLACES, type RecordsReport } from '../src/records.ts';
import type { FetchedPage } from '../src/research.ts';
import type { SearchResult } from '../src/tools/search.ts';
import { makeApp, tempDir } from './helpers.ts';

const NAME = ['Jordan', 'Testperson'].join(' ');
const page = (url: string, title: string, body: string): FetchedPage => ({ ok: true, url, title, text: body + ' Filler text about the town council and weather. '.repeat(6), links: [] });

interface World {
  results: Record<string, SearchResult[]>;
  pages: Record<string, FetchedPage>;
  robots: Record<string, string>;
}
function world(): World {
  const r = (url: string, title: string, snippet = '') => ({ url, title, snippet });
  return {
    results: {
      default: [
        r('https://www.spokeo.com/Jordan-Testperson', 'Jordan Testperson - Spokeo', `${NAME} age 41 Springfield. Unlock full report`),
        r('https://www.linkedin.com/in/jtestperson', 'Jordan Testperson - Springfield, IL | LinkedIn', `${NAME}. Springfield, Illinois. Engineer at Acme Widgets.`),
        r('https://news.springfield-gazette.example/2025/garden', 'Garden show winners', `${NAME} of Springfield won first prize`),
        r('https://www.courtlistener.com/docket/123/smith-v-testperson/', 'Smith v. Testperson', 'Small claims docket'),
        r('https://other-town.example/people', 'Other Town residents', `${NAME} of Portland, Oregon`),
        r('https://walled.example/p', 'Walled', 'bot check'),
        r('https://norobots.example/private/p', 'No robots', `${NAME}`),
        r('https://paywalled-records.example/p/1', 'Records', `${NAME}`),
      ],
    },
    pages: {
      'https://news.springfield-gazette.example/2025/garden': page('https://news.springfield-gazette.example/2025/garden', 'Garden show winners', `The annual garden show in Springfield, IL named its winners. ${NAME} of Springfield took first prize for tomatoes.`),
      'https://www.courtlistener.com/docket/123/smith-v-testperson/': page('https://www.courtlistener.com/docket/123/smith-v-testperson/', 'Smith v. Testperson', `Small claims case filed in Sangamon County, Springfield, Illinois. Defendant: ${NAME}, phone (217) 555-0142.`),
      'https://other-town.example/people': page('https://other-town.example/people', 'Other Town residents', `A list of residents. ${NAME} lives in Portland, Oregon and coaches soccer.`),
      'https://walled.example/p': { ok: false, reason: 'bot-wall', detail: 'HTTP 403', status: 403 },
      'https://norobots.example/private/p': page('https://norobots.example/private/p', 'Private', `${NAME} of Springfield`),
      'https://paywalled-records.example/p/1': page('https://paywalled-records.example/p/1', 'Records', `${NAME} Springfield. Subscribe to view the full report for $1.99.`),
    },
    robots: { 'https://norobots.example': 'User-agent: *\nDisallow: /private/\n' },
  };
}

async function rig(t: TestContext, w = world()) {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-19T15:00:00Z') };
  const app = makeApp(dir, clock);
  const trail = new AuditTrail(dir, { now: () => clock.now });
  setAuditTrail(trail);
  const searched: string[] = [];
  const fetched: string[] = [];
  recordsDeps.search = async (q) => {
    searched.push(q);
    return w.results[q] ?? (searched.length === 1 ? w.results.default : []);
  };
  recordsDeps.fetch = async (url) => {
    fetched.push(url);
    return w.pages[url] ?? { ok: false, reason: 'not-found', detail: 'HTTP 404', status: 404 };
  };
  recordsDeps.robots = async (origin) => w.robots[origin] ?? '';
  const records = new Records(app, dir, { now: () => clock.now });
  t.after(() => {
    delete recordsDeps.search;
    delete recordsDeps.fetch;
    delete recordsDeps.robots;
    setAuditTrail(undefined);
    app.store.close();
    cleanup();
  });
  return { app, records, trail, searched, fetched, clock, dir, w };
}

test('W4.6: the paid-broker blocklist catches brokers and their subdomains, never free records sites', () => {
  for (const u of ['https://www.spokeo.com/x', 'https://beenverified.com/p', 'https://people.intelius.com/a', 'https://www.truthfinder.com', 'https://www.mylife.com/x', 'https://www.instantcheckmate.com/', 'https://www.whitepages.com/name/x']) assert.equal(isPaidBroker(u), true, u);
  for (const u of ['https://www.courtlistener.com/x', 'https://opencorporates.com/x', 'https://github.com/x', 'https://notspokeo.com/x', 'not a url']) assert.equal(isPaidBroker(u), false, u);
  assert.ok(PAID_BROKERS.length >= 25);
  assert.equal(new Set(PAID_BROKERS).size, PAID_BROKERS.length, 'no duplicates');
  for (const p of STARTER_PLACES) assert.equal(isPaidBroker(`https://${p.domain}/`), false, `starter place ${p.domain} is not a broker`);
  assert.equal(isSignInOnly('https://www.linkedin.com/in/x'), true);
  assert.equal(isSignInOnly('https://github.com/x'), false);
});

test('W4.6: a query needs an identifier; children are refused before any search', () => {
  assert.throws(() => cleanQuery({}), /name, address, phone, email or username/);
  assert.throws(() => cleanQuery({ city: 'Springfield' }), /name, address, phone, email or username/);
  assert.throws(() => cleanQuery({ name: NAME, age: 15 }), /under 18/);
  assert.throws(() => cleanQuery({ name: 'my 14 year old son' }), /under 18/);
  assert.equal(childSignal('my daughter in middle school'), true);
  assert.equal(childSignal('a teenager'), true);
  assert.equal(childSignal('Jordan, 34, engineer'), false);
  const q = cleanQuery({ name: `  ${NAME} `, phone: '(217) 555-0142', email: 'JT@Example.com', city: 'Springfield', state: 'il', age: '41' });
  assert.equal(q.name, NAME);
  assert.equal(q.phone, '2175550142');
  assert.equal(q.email, 'jt@example.com');
  assert.equal(q.state, 'IL');
  assert.equal(q.age, 41);
});

test('W4.6: a report cites every fact, skips brokers and sign-in sites, honours robots and bot checks, and says not found', async (t) => {
  const { records, trail, searched, fetched } = await rig(t);
  const r0 = records.start({ name: NAME, city: 'Springfield', state: 'IL', phone: '217-555-0142' });
  assert.equal(r0.status, 'running');
  await records.idle();
  const r = records.get(r0.id)!;
  assert.equal(r.status, 'done', r.refusal);
  // Never opened: the broker, the sign-in-only site, the robots-disallowed page.
  assert.ok(!fetched.some((u) => /spokeo|linkedin|norobots/.test(u)), fetched.join(' '));
  const src = (re: RegExp) => r.sources.find((s) => re.test(s.url))!;
  assert.equal(src(/spokeo/).status, 'broker');
  assert.equal(src(/linkedin/).status, 'preview');
  assert.equal(src(/norobots/).status, 'robots');
  assert.equal(src(/walled/).status, 'bot-wall');
  assert.equal(src(/paywalled/).status, 'paid');
  // Facts: link, date seen, quote, confidence.
  assert.ok(r.facts.length >= 3);
  for (const f of r.facts) {
    assert.match(f.url, /^https:\/\//);
    assert.equal(f.seen, '2026-11-19');
    assert.ok(f.quote.includes('Testperson'), f.quote);
    assert.ok(['high', 'medium', 'low'].includes(f.confidence));
  }
  const fact = (re: RegExp) => r.facts.find((f) => re.test(f.url))!;
  assert.equal(fact(/courtlistener/).confidence, 'high');
  assert.deepEqual(fact(/courtlistener/).why.sort(), ['city', 'name', 'phone', 'state'].sort());
  assert.equal(fact(/courtlistener/).section, 'court');
  assert.equal(fact(/gazette/).section, 'news');
  assert.equal(fact(/linkedin/).via, 'preview');
  assert.equal(fact(/linkedin/).section, 'social');
  assert.equal(fact(/other-town/).confidence, 'low', 'same name, another state');
  assert.ok(!r.facts.some((f) => /spokeo|paywalled/.test(f.url)));
  const sections = records.sections(r);
  assert.equal(sections.find((s) => s.type === 'property')!.facts.length, 0);
  assert.ok(sections.find((s) => s.type === 'property')!.notFound);
  // Every search is one audit row (with the query kept as hidden, redacted content).
  const rows = trail.list({ action: 'records.search' }, { content: true });
  assert.equal(rows.length, searched.length);
  assert.ok(rows.every((x) => x.role === 'owner' && x.target === r.id && x.content));
  assert.ok(trail.list({ action: 'records.search' }).every((x) => x.content === undefined), 'content hidden by default');
});

test('W4.6: the places list grows from what worked, marks paid and failing sites, and the next report starts from it', async (t) => {
  const { records, searched } = await rig(t);
  const r = records.start({ name: NAME, city: 'Springfield', state: 'IL' });
  await records.idle();
  assert.equal(records.get(r.id)!.status, 'done');
  const places = records.places();
  const gaz = places.find((p) => p.domain === 'news.springfield-gazette.example')!;
  assert.ok(gaz, 'the news site that matched was learned');
  assert.equal(gaz.origin, 'learned');
  assert.equal(gaz.status, 'works');
  assert.deepEqual(gaz.types, ['news']);
  assert.equal(gaz.region, 'US-IL');
  assert.match(gaz.how, /site:news\.springfield-gazette\.example/);
  assert.ok(gaz.holds.length > 5);
  assert.equal(places.find((p) => p.domain === 'paywalled-records.example')?.status, 'paid');
  assert.equal(places.find((p) => p.domain === 'courtlistener.com')!.hits, 1);
  // The next report searches the learned place first (before the starter places).
  searched.length = 0;
  records.start({ name: 'Casey Exampleton', city: 'Springfield', state: 'IL' });
  await records.idle();
  const firstSite = searched.findIndex((q) => q.includes('site:'));
  assert.match(searched[firstSite], /site:news\.springfield-gazette\.example/);
  assert.ok(!searched.some((q) => q.includes('paywalled-records.example')), 'paid places are never searched');
  // The owner edits the list: switch one off, add one, remove one.
  records.savePlace({ ...gaz, status: 'off', holds: 'Local news and garden shows' });
  assert.equal(records.places().find((p) => p.id === gaz.id)!.status, 'off');
  const added = records.savePlace({ domain: 'records.county.example', types: ['property'], region: 'US-IL', holds: 'County property lookups', how: 'site:records.county.example "{name}"' });
  assert.equal(added.origin, 'owner');
  assert.throws(() => records.savePlace({ domain: 'www.spokeo.com', types: ['web'], holds: 'x', how: 'site:spokeo.com "{name}"' }), /paid/);
  records.removePlace(added.id);
  assert.ok(!records.places().some((p) => p.id === added.id));
});

test('W4.6: a page saying the person is under 18 ends the report with nothing kept', async (t) => {
  const w = world();
  w.pages['https://news.springfield-gazette.example/2025/garden'] = page('https://news.springfield-gazette.example/2025/garden', 'Garden show', `${NAME}, 16, of Springfield won first prize at the youth garden show.`);
  const { records, trail } = await rig(t, w);
  const r = records.start({ name: NAME, city: 'Springfield', state: 'IL' });
  await records.idle();
  const got = records.get(r.id)!;
  assert.equal(got.status, 'refused');
  assert.match(got.refusal!, /under 18/);
  assert.equal(got.facts.length, 0);
  assert.equal(got.sources.length, 0);
  assert.ok(trail.list({ action: 'records.refused' }).length >= 1);
  assert.throws(() => records.more(r.id), /under 18|refused/);
});

test('W4.6: Find more sources runs a new round with new searches and keeps the earlier facts', async (t) => {
  const { records, searched } = await rig(t);
  const r = records.start({ name: NAME, city: 'Springfield', state: 'IL', username: 'jtestperson' });
  await records.idle();
  const before = records.get(r.id)!;
  const firstRound = [...searched];
  records.more(r.id);
  await records.idle();
  const after = records.get(r.id)!;
  assert.equal(after.rounds, 2);
  assert.equal(after.status, 'done');
  const second = searched.slice(firstRound.length);
  assert.ok(second.length > 0, 'round two searched');
  assert.ok(second.every((q) => !firstRound.includes(q)), 'no search repeated');
  assert.ok(after.facts.length >= before.facts.length);
});

test('W4.6: the PDF has a cover, sections and a sources appendix, with the exact notice on every page', async (t) => {
  const { records } = await rig(t);
  const r = records.start({ name: NAME, city: 'Springfield', state: 'IL', phone: '2175550142' });
  await records.idle();
  const pdf = records.pdf(r.id);
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-'));
  const streams = [...s.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => {
    try {
      return inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      return '';
    }
  }).filter((x) => x.includes(' Tj'));
  const pages = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
  assert.ok(pages >= 3, `pages: ${pages}`);
  assert.equal(streams.length, pages);
  const head = `(${RECORDS_HEADER})`;
  assert.equal(RECORDS_HEADER, 'NOT FCRA COMPLIANT - This information can not be used in housing, loan, employment, or other life altering decisions');
  for (const [i, st] of streams.entries()) assert.ok(st.includes('NOT FCRA COMPLIANT') && st.replace(/\\\(|\\\)/g, '').includes(head.slice(1, -1).slice(0, 40)), `page ${i + 1} carries the notice`);
  const all = streams.join('\n');
  assert.match(all, /SOURCES/i);
  assert.match(all, /Not found/);
  assert.match(all, /courtlistener/);
  const md = records.markdown(r.id);
  assert.match(md, /\[page break\]/);
  assert.ok(md.includes(RECORDS_HEADER));
});

test('W4.6: members, kids and the demo get no records engine; the tool hides in private local mode', async (t) => {
  const { app } = await rig(t);
  const { recordsOf, createRecordsTools } = await import('../src/records.ts');
  assert.ok(recordsOf(app));
  const member = Object.assign(Object.create(app), { member: { child: () => false } });
  assert.equal(recordsOf(member), undefined);
  const tool = createRecordsTools(() => app)[0];
  assert.equal(tool.spec.name, 'records_report');
  assert.equal(tool.defaultPermission, 'ask');
  assert.equal(tool.isAvailable!(), true);
  assert.equal(createRecordsTools(() => member)[0].isAvailable!(), false);
});

export type { RecordsReport };

test('W4.6: routes are the owner\'s only; start, read, more, PDF and place edits work over HTTP', async (t) => {
  const { app, dir } = await rig(t);
  const { OwnerAuth } = await import('../src/auth.ts');
  const { createSaraServer } = await import('../src/server.ts');
  const { recordsOf } = await import('../src/records.ts');
  const { join } = await import('node:path');
  const { ROOT } = await import('./helpers.ts');
  const auth = new OwnerAuth(dir, () => new Date('2026-11-19T15:00:00Z'));
  const token = auth.newToken!;
  const boot = async (o: Record<string, unknown>) => {
    const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web'), ...o } as never);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    return (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: base.slice(0, -4), ...(init.headers ?? {}) } });
  };
  const owner = await boot({});
  const started = (await (await owner('/records', { method: 'POST', body: JSON.stringify({ name: NAME, city: 'Springfield', state: 'IL' }) })).json()) as { report: RecordsReport };
  assert.equal(started.report.status, 'running');
  await recordsOf(app)!.idle();
  const got = (await (await owner(`/records/${started.report.id}`)).json()) as { report: RecordsReport; sections: { type: string; notFound: boolean }[] };
  assert.equal(got.report.status, 'done');
  assert.equal(got.sections.length, 6);
  const pdf = await owner(`/records/${started.report.id}/pdf`);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.ok((await pdf.arrayBuffer()).byteLength > 1000);
  assert.equal((await owner(`/records/${started.report.id}/more`, { method: 'POST', body: '{}' })).status, 200);
  await recordsOf(app)!.idle();
  const kid = await owner('/records', { method: 'POST', body: JSON.stringify({ name: NAME, age: 12 }) });
  assert.equal(kid.status, 400);
  const place = (await (await owner('/records/places', { method: 'POST', body: JSON.stringify({ domain: 'https://records.county.example/search', types: ['property'], region: 'US-IL', holds: 'County deeds', how: 'site:records.county.example "{name}"' }) })).json()) as { place: { id: string; domain: string } };
  assert.equal(place.place.domain, 'records.county.example');
  assert.equal((await owner(`/records/places/${place.place.id}`, { method: 'PUT', body: JSON.stringify({ domain: 'records.county.example', status: 'off', how: 'site:records.county.example "{name}"' }) })).status, 200);
  assert.equal((await owner(`/records/places/${place.place.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await owner('/records/places', { method: 'POST', body: JSON.stringify({ domain: 'beenverified.com', how: 'site:beenverified.com "{name}"' }) })).status, 400);
  const member = await boot({ member: { record: () => ({ id: 'm1', name: 'Bo', status: 'active', limits: { voice: false, pictures: false } }) } });
  assert.equal((await member('/records')).status, 403);
  assert.equal((await member('/records', { method: 'POST', body: JSON.stringify({ name: NAME }) })).status, 403);
});
