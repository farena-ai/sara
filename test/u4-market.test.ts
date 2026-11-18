// U4.27 community marketplace (docs/MARKETPLACE.md): listings between linked servers, checked by the
// receiver before anything is installed. Three in-process servers: Alex hosts a community, Bo is a member
// and Cy is Bo's linked friend.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Automations } from '../src/automations.ts';
import { checkListing, hashListing, HARD_TOOL, marketOf, PROTECTED_SETTING, type Listing } from '../src/market.ts';
import { setPrivateLocal } from '../src/net-guard.ts';
import { SkillStore } from '../src/skill-store.ts';
import { TeamRuns } from '../src/team-runs.ts';
import type { Tool } from '../src/tools/types.ts';
import { clock, pairNode, linkPair, type PairNode } from './helpers-repair-pair.ts';
import { ROOT } from './helpers.ts';

const tool = (name: string): Tool => ({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', run: async () => 'ok' }) as unknown as Tool;

async function node(t: TestContext, name: string): Promise<PairNode> {
  const n = await pairNode(t, name);
  n.app.skills = new SkillStore(n.app.store.db, { companionDir: join(n.dir, 'skills'), now: () => clock.now });
  n.app.automations = new Automations(n.app, n.app.store.db);
  n.app.teamRuns = new TeamRuns(n.app, n.app.store.db);
  for (const x of ['web_search', 'web_fetch', 'run_command']) n.app.tools.add(tool(x));
  const mk = marketOf(n.app); // made now, so the cleanup hooks never open a new one on a deleted folder
  t.after(async () => mk?.idle());
  return n;
}

async function community(a: PairNode, members: PairNode[]): Promise<{ cid: string; chats: string[] }> {
  const made = await a.req('POST', '/api/messages/communities', { name: 'Helpers club' });
  const cid = made.chat.id as string;
  const { code } = await a.req('POST', `/api/messages/communities/${cid}/code`, { url: a.base });
  const chats: string[] = [];
  for (const b of members) chats.push((await b.req('POST', '/api/messages/join', { code, url: b.base })).chat.id);
  await a.m.flush();
  return { cid, chats };
}

const fakeKey = () => ['sk', 'proj', 'A'.repeat(12) + 'b'.repeat(12) + 'C'.repeat(12)].join('-');

function listing(over: Partial<Listing> = {}): Listing {
  const base = { id: 'l1', kind: 'skill', title: 'Trip packing', description: 'Packs for a trip.', version: '1.0.0', author: 'Bo', permissions: { tools: ['web_search'], settings: [] }, payload: { name: 'trip-packing', description: 'Use when packing for a trip.', body: 'Make a list by weather.' }, at: clock.now.toISOString() } as Omit<Listing, 'hash'>;
  const l = { ...base, ...over } as Listing;
  return { ...l, hash: over.hash ?? hashListing(l) };
}

test('U4.27: static checks refuse secrets, hard-limit tools, protected settings, unknown tools, big items, code and a wrong hash', () => {
  const env = { tools: new Set(['web_search', 'web_fetch', 'run_command']), storeIds: new Set<string>() };
  assert.equal(checkListing(listing(), env).ok, true);
  assert.match(checkListing(listing(), env).does.join('\n'), /trial/);
  const bad = (l: Listing) => checkListing(l, env).problems.join(' | ');
  assert.match(bad(listing({ payload: { name: 'x-y', description: 'd', body: `key: ${fakeKey()}` } })), /secret/i);
  assert.match(bad(listing({ permissions: { tools: ['run_command'], settings: [] } })), /never/i);
  assert.ok(HARD_TOOL('pc_click') && HARD_TOOL('run_command') && !HARD_TOOL('web_search'));
  assert.match(bad(listing({ permissions: { tools: [], settings: ['providers.apiKey'] } })), /protected/i);
  assert.ok(PROTECTED_SETTING('adult.on') && PROTECTED_SETTING('privateLocal') && !PROTECTED_SETTING('timeZone'));
  assert.match(bad(listing({ permissions: { tools: ['teleport'], settings: [] } })), /teleport/);
  assert.match(bad(listing({ payload: { name: 'x-y', description: 'd', body: 'x'.repeat(40_000) } })), /too big/i);
  assert.match(bad(listing({ payload: { name: 'x-y', description: 'd', body: 'b', files: [{ path: 'scripts/a.sh', content: 'rm -rf /' }] } as never })), /files|code/i);
  assert.match(bad({ ...listing(), title: 'Changed after hashing' }), /hash/i);
  // Automations: only safe triggers and actions; an email draft never sends by itself.
  const auto = (payload: unknown) => listing({ kind: 'automation', permissions: { tools: [], settings: [] }, payload: payload as never });
  assert.equal(checkListing(auto({ name: 'Morning', trigger: { kind: 'schedule', every: 'day', time: '08:00' }, actions: [{ kind: 'notify', text: 'hi' }] }), env).ok, true);
  assert.match(bad(auto({ name: 'Hook', trigger: { kind: 'webhook' }, actions: [{ kind: 'notify', text: 'hi' }] })), /trigger/i);
  assert.match(bad(auto({ name: 'Mail', trigger: { kind: 'schedule', every: 'day', time: '08:00' }, actions: [{ kind: 'draft_email', to: 'a@b.test', sendWithoutAsking: true }] })), /send/i);
  // Add-on links: only a link to an item in this server's own Store list.
  assert.match(bad(listing({ kind: 'addon', permissions: { tools: [], settings: [] }, payload: { storeId: 'weather' } as never })), /Store/);
  assert.equal(checkListing(listing({ kind: 'addon', permissions: { tools: [], settings: [] }, payload: { storeId: 'weather' } as never }), { ...env, storeIds: new Set(['weather']) }).ok, true);
});

test('U4.27: a community shelf: publish, review, install (skill on trial, automation paused), update notice, ratings, report and removal', async (t) => {
  const alex = await node(t, 'Alex');
  const bo = await node(t, 'Bo');
  const { cid, chats } = await community(alex, [bo]);
  const boPlace = `c:${chats[0]}`;
  const alexPlace = `c:${cid}`;
  const places = (await bo.req('GET', '/api/market')).places;
  assert.ok(places.some((p: any) => p.id === boPlace && p.kind === 'community'));

  // Bo shares a skill and an automation into the community (stored by the host, Alex).
  bo.app.skills!.save('companion', { name: 'trip-packing', description: 'Use when packing for a trip.', body: 'Check the weather with web_search, then list clothes.' }, { create: true });
  const s1 = await bo.req('POST', '/api/market/publish', { place: boPlace, kind: 'skill', ref: 'trip-packing', version: '1.0.0', description: 'Packs for a trip by the weather.', tools: ['web_search'] });
  assert.equal(s1.listing.author, 'Bo');
  const a1 = bo.app.automations!.create({ name: 'Morning nudge', trigger: { kind: 'schedule', every: 'day', time: '08:00' }, actions: [{ kind: 'notify', text: 'Stretch!' }] });
  await bo.req('POST', '/api/market/publish', { place: boPlace, kind: 'automation', ref: String(a1.id), version: '1.0.0', description: 'A morning reminder.' });
  // A secret never leaves: the sender's own check refuses before anything is sent.
  bo.app.skills!.save('companion', { name: 'leaky', description: 'Use when testing.', body: `token = ${fakeKey()}` }, { create: true });
  const leak = await bo.raw('POST', '/api/market/publish', { place: boPlace, kind: 'skill', ref: 'leaky', version: '1.0.0', description: 'x' });
  assert.equal(leak.status, 400);

  const shelf = (await alex.req('GET', `/api/market/places/${encodeURIComponent(alexPlace)}`)).listings;
  assert.deepEqual(shelf.map((l: any) => l.title).sort(), ['Morning nudge', 'trip-packing']);
  const sk = shelf.find((l: any) => l.kind === 'skill');
  // Review shows exactly what installing does, and the receiver's checks.
  const rv = await alex.req('POST', '/api/market/review', { place: alexPlace, listing: sk.id });
  assert.equal(rv.check.ok, true);
  assert.match(rv.check.does.join('\n'), /trial/);
  assert.match(rv.check.does.join('\n'), /web_search/);
  // Nothing installs without the reviewed hash (the person's OK on exactly that content).
  assert.equal((await alex.raw('POST', '/api/market/install', { place: alexPlace, listing: sk.id, hash: 'nope' })).status, 409);
  await alex.req('POST', '/api/market/install', { place: alexPlace, listing: sk.id, hash: rv.listing.hash });
  assert.equal(alex.app.skills!.get('companion', 'trip-packing')?.status, 'trial');
  const au = shelf.find((l: any) => l.kind === 'automation');
  const rva = await alex.req('POST', '/api/market/review', { place: alexPlace, listing: au.id });
  assert.match(rva.check.does.join('\n'), /paused/);
  await alex.req('POST', '/api/market/install', { place: alexPlace, listing: au.id, hash: rva.listing.hash });
  const got = alex.app.automations!.list().find((x) => x.name === 'Morning nudge');
  assert.equal(got?.enabled, false, 'automations start paused');

  // Bo (a member) installs too: through the host, over the signed link.
  bo.app.skills!.delete('companion', 'trip-packing');
  const brv = await bo.req('POST', '/api/market/review', { place: boPlace, listing: sk.id });
  await bo.req('POST', '/api/market/install', { place: boPlace, listing: sk.id, hash: brv.listing.hash });
  assert.equal(bo.app.skills!.get('companion', 'trip-packing')?.status, 'trial');

  // An update notifies subscribers and never applies itself.
  bo.app.skills!.save('companion', { name: 'trip-packing', description: 'Use when packing for a trip.', body: 'Version two: check the weather, then list clothes and a charger.' }, {});
  await bo.req('POST', '/api/market/publish', { place: boPlace, kind: 'skill', ref: 'trip-packing', version: '1.1.0', description: 'Now with a charger.', tools: ['web_search'], listing: sk.id });
  await marketOf(alex.app)!.idle();
  await marketOf(bo.app)!.idle();
  const inst = (await alex.req('GET', '/api/market')).installs.find((i: any) => i.listing === sk.id);
  assert.equal(inst.update, '1.1.0');
  assert.doesNotMatch(alex.app.skills!.detail('companion', 'trip-packing')!.body, /Version two/);
  const boInst = (await bo.req('GET', '/api/market')).installs.find((i: any) => i.listing === sk.id);
  assert.equal(boInst.update, '1.1.0', 'a member subscriber is told too');
  const rv2 = await alex.req('POST', '/api/market/review', { place: alexPlace, listing: sk.id });
  await alex.req('POST', '/api/market/install', { place: alexPlace, listing: sk.id, hash: rv2.listing.hash });
  assert.match(alex.app.skills!.detail('companion', 'trip-packing')!.body, /Version two/);
  assert.equal(alex.app.skills!.get('companion', 'trip-packing')?.status, 'trial', 'an update starts on trial again');

  // Ratings and comments (one per server), a report, and the community owner's removal.
  await bo.req('POST', '/api/market/rate', { place: boPlace, listing: au.id, stars: 4, comment: 'Handy.' });
  await alex.req('POST', '/api/market/rate', { place: alexPlace, listing: au.id, stars: 2 });
  await bo.req('POST', '/api/market/rate', { place: boPlace, listing: au.id, stars: 5, comment: 'Very handy.' });
  const rated = (await bo.req('GET', `/api/market/places/${encodeURIComponent(boPlace)}`)).listings.find((l: any) => l.id === au.id);
  assert.deepEqual([rated.rating.n, rated.rating.avg], [2, 3.5]);
  assert.deepEqual(rated.comments.map((c: any) => c.text), ['Very handy.']);
  await bo.req('POST', '/api/market/report', { place: boPlace, listing: au.id, why: 'Spammy' });
  const reps = (await alex.req('GET', '/api/market')).reports;
  assert.equal(reps[0].why, 'Spammy');
  assert.equal((await bo.raw('POST', '/api/market/remove', { place: boPlace, listing: sk.id })).status, 200, 'the author may withdraw his own');
  await alex.req('POST', '/api/market/remove', { place: alexPlace, listing: au.id });
  assert.equal((await bo.req('GET', `/api/market/places/${encodeURIComponent(boPlace)}`)).listings.length, 0);
});

test('U4.27: a linked friend shares a team recipe and a Store link; the receiver re-checks a forged listing', async (t) => {
  const bo = await node(t, 'Bo');
  const cy = await node(t, 'Cy');
  const { aLink: boLink, bLink: cyLink } = await linkPair(bo, cy);
  const plan = {
    roles: [
      { id: 'r', name: 'Scout', kind: 'researcher', tools: ['web_fetch'], instructions: 'Look only at shops that ship.' },
      { id: 'd', name: 'Drafter', kind: 'drafter', tools: [] },
    ],
    steps: [
      { id: 's1', role: 'r', title: 'Prices', instructions: 'Find prices for: {job}' },
      { id: 's2', role: 'd', title: 'Write it', instructions: 'Write the comparison.', after: ['s1'] },
    ],
    deliver: { kind: 'document', format: 'docx', title: '{job}' },
  };
  const rec = bo.app.teamRuns!.recipes.importJson({ kind: 'sara-team-recipe', version: 1, name: 'Product comparison', description: 'Compares products', plan });
  await bo.req('POST', '/api/market/publish', { place: `f:${boLink}`, kind: 'team', ref: String(rec.id), version: '1.0.0', description: 'Two helpers compare products.' });
  await bo.req('POST', '/api/market/publish', { place: `f:${boLink}`, kind: 'addon', ref: 'weather', version: '1.0.0', description: 'The weather add-on from the Store.' });
  const list = (await cy.req('GET', `/api/market/places/${encodeURIComponent(`f:${cyLink}`)}`)).listings;
  assert.equal(list.length, 2);
  const team = list.find((l: any) => l.kind === 'team');
  const rv = await cy.req('POST', '/api/market/review', { place: `f:${cyLink}`, listing: team.id });
  await cy.req('POST', '/api/market/install', { place: `f:${cyLink}`, listing: team.id, hash: rv.listing.hash });
  assert.ok(cy.app.teamRuns!.recipes.list().some((r) => r.name === 'Product comparison'));
  // Store add-on links are links only: never installed from a friend, and only when the item is in this server's Store list.
  const addon = list.find((l: any) => l.kind === 'addon');
  const arv = await cy.req('POST', '/api/market/review', { place: `f:${cyLink}`, listing: addon.id });
  assert.equal(arv.check.ok, false);
  assert.match(arv.check.problems.join(' '), /Store/);
  // A listing changed on the way (or by a bad server) fails the receiver's own hash check.
  const db = new DatabaseSync(join(bo.dir, 'market.db'));
  const row = db.prepare('SELECT listing FROM mk_listings WHERE id = ?').get(team.id) as { listing: string };
  db.prepare('UPDATE mk_listings SET listing = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(row.listing), title: 'Something else' }), team.id);
  db.close();
  const bad = await cy.req('POST', '/api/market/review', { place: `f:${cyLink}`, listing: team.id });
  assert.equal(bad.check.ok, false);
  assert.match(bad.check.problems.join(' '), /hash/i);
  assert.equal((await cy.raw('POST', '/api/market/install', { place: `f:${cyLink}`, listing: team.id, hash: bad.listing.hash })).status, 400);
});

test('U4.27: private local mode keeps the shelf at home; household members and the demo get no marketplace', async (t) => {
  const bo = await node(t, 'Bo');
  const cy = await node(t, 'Cy');
  const { aLink } = await linkPair(bo, cy);
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  const r = await bo.raw('GET', `/api/market/places/${encodeURIComponent(`f:${aLink}`)}`);
  assert.equal(r.status, 409);
  setPrivateLocal(false);
  const member = { ...bo.app, member: { id: 'm1' } } as never;
  assert.equal(marketOf(member), undefined);
  assert.equal(marketOf({ ...bo.app, messages: undefined } as never), undefined);
  const iso = readFileSync(join(ROOT, 'test', 'household-isolation.test.ts'), 'utf8');
  assert.match(iso, /'market'/);
});

test('U4.27: wiring: peer endpoint, routes, the Get more section and its strings', () => {
  const server = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8');
  assert.match(server, /\/msg\/v1\/market\//);
  assert.match(readFileSync(join(ROOT, 'src', 'market.ts'), 'utf8'), /import type \{ Messenger \} from '\.\/messages\.ts'/);
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  // The U4-A merge dropped the Money dialog's closing tags, which nested every later dialog (Settings too) inside it.
  for (const tag of ['dialog', 'form']) assert.equal(html.match(new RegExp(`<${tag}\\b`, 'g'))!.length, html.match(new RegExp(`</${tag}>`, 'g'))!.length, `balanced <${tag}>`);
  const store = html.slice(html.indexOf('data-page="ab-store"'), html.indexOf('data-page="ab-tools"'));
  for (const id of ['mk-place', 'mk-kind', 'mk-item', 'mk-version', 'mk-desc', 'mk-share']) assert.match(store, new RegExp(`id="${id}"`));
  assert.match(readFileSync(join(ROOT, 'web', 'app.js'), 'utf8'), /pick === 'ab-store' && typeof loadMarket === 'function'/);
});
