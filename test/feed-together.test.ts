// E6a (docs/ops/E6_DESIGN.md): opening one public feed for Read together. Every request here goes
// through an injected transport (setNetTransport) and a stubbed DNS lookup: no network in tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FeedError, FEED, openFeed } from '../src/feed-together.ts';
import { isPrivateLocalError, setPrivateLocal } from '../src/net-guard.ts';
import { RT, textHash } from '../src/read-together.ts';
import { ATOM, PUBLIC, RDF, RSS, stubNet, xml } from './feed-together-fixture.ts';


const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });
const refused = async (p: Promise<unknown>, reason: string) => assert.rejects(p, (err: unknown) => err instanceof FeedError && err.reason === reason && err.message.length > 0);

test('feeds: RSS 2.0 items become plain text with keys and hashes; scripts, images and HTML are stripped', async (t) => {
  const calls = stubNet(t, () => xml(RSS));
  const s = await openFeed('https://feeds.example.com/rss.xml', { lookup: PUBLIC });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  const h = new Headers(calls[0].init?.headers);
  assert.equal(h.get('user-agent'), 'Sara-Feeds/1');
  assert.equal(h.get('cookie'), null);
  assert.equal(h.get('authorization'), null);
  assert.equal(s.title, 'Heater Notes');
  assert.equal(s.host, 'feeds.example.com');
  assert.match(s.rev, /^[0-9a-f]{64}$/);
  assert.equal(s.rev, textHash(RSS), 'a SHA-256 of the bytes (ASCII fixture)');
  assert.equal(s.items.length, 2);
  const [a, b] = s.items;
  assert.equal(a.title, 'Cleaning the filter & more');
  assert.equal(a.link, 'https://feeds.example.com/filter');
  assert.match(a.key, /^[0-9a-f]{16}$/);
  assert.equal(a.text, 'Rinse the filter every month in warm water.\n\nLet it dry.', 'content:encoded wins over the summary');
  assert.doesNotMatch(a.text, /steal|alert|<|gif/);
  assert.equal(a.textSha, textHash(`${a.title}\n\n${a.text}`));
  assert.equal(a.published, '2026-11-05T10:00:00.000Z');
  assert.equal(b.link, null, 'only http(s) links are kept');
  assert.notEqual(a.key, b.key);
});

test('feeds: Atom and RSS 1.0 (RDF) feeds are read too', async (t) => {
  stubNet(t, (url) => xml(url.includes('atom') ? ATOM : RDF));
  const atom = await openFeed('https://garden.example.org/atom', { lookup: PUBLIC });
  assert.equal(atom.title, 'Garden Log');
  assert.deepEqual(atom.items.map((i) => [i.title, i.link, i.text, i.published]), [['Tomatoes', 'https://garden.example.org/tomatoes', 'Water them early.', '2026-11-04T08:00:00.000Z']]);
  const rdf = await openFeed('https://old.example.net/rdf', { lookup: PUBLIC });
  assert.equal(rdf.title, 'Old News');
  assert.deepEqual(rdf.items.map((i) => [i.title, i.text]), [['First', 'Plain words.']]);
});

test('feeds: http, user names and private or loopback targets are refused before any request', async (t) => {
  const calls = stubNet(t, () => xml(RSS));
  await refused(openFeed('http://feeds.example.com/rss', { lookup: PUBLIC }), 'address');
  await refused(openFeed('https://alex:pw@feeds.example.com/rss', { lookup: PUBLIC }), 'address');
  for (const u of ['https://localhost/rss', 'https://127.0.0.1/rss', 'https://10.1.2.3/rss', 'https://169.254.169.254/latest/meta-data', 'https://[::ffff:127.0.0.1]/rss', 'https://[::1]/rss', 'https://printer.local/rss']) {
    await refused(openFeed(u, { lookup: PUBLIC }), 'address');
  }
  await refused(openFeed('https://sneaky.example.com/rss', { lookup: async () => ['192.168.1.20'] }), 'address');
  await refused(openFeed('https://half.example.com/rss', { lookup: async () => ['93.184.216.34', '127.0.0.1'] }), 'address');
  await refused(openFeed('not a url', { lookup: PUBLIC }), 'address');
  assert.equal(calls.length, 0, 'no request was made');
});

test('feeds: every redirect is checked again; a redirect to a private address and the 4th redirect are refused', async (t) => {
  const calls = stubNet(t, (url) => {
    const n = Number(/\/r(\d+)$/.exec(url)?.[1] ?? NaN);
    if (url.endsWith('/to-private')) return redirect('https://169.254.169.254/latest');
    if (url.endsWith('/to-name')) return redirect('https://internal.example.com/feed');
    if (url.endsWith('/to-http')) return redirect('http://feeds.example.com/feed');
    if (Number.isInteger(n) && n < 9) return redirect(`/r${n + 1}`);
    return xml(RSS);
  });
  const lookup = async (h: string) => (h === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
  await refused(openFeed('https://feeds.example.com/to-private', { lookup }), 'address');
  await refused(openFeed('https://feeds.example.com/to-name', { lookup }), 'address');
  await refused(openFeed('https://feeds.example.com/to-http', { lookup }), 'address');
  assert.ok(calls.every((c) => !c.url.includes('169.254') && !c.url.includes('internal.') && !c.url.startsWith('http:')), 'never followed');
  // Three redirects are fine (r6 → r7 → r8 → r9 answers).
  assert.equal((await openFeed('https://feeds.example.com/r6', { lookup })).items.length, 2);
  calls.length = 0;
  await refused(openFeed('https://feeds.example.com/r1', { lookup }), 'redirects');
  assert.equal(calls.length, FEED.maxRedirects + 1, 'the 4th redirect is not followed');
});

test('feeds: over 2 MB is aborted (header or stream); a slow feed times out with a plain message', async (t) => {
  const big = 'x'.repeat(FEED.maxBytes + 1);
  stubNet(t, (url, init) => {
    if (url.endsWith('/declared')) return xml('<rss/>', { 'content-length': String(FEED.maxBytes + 1) });
    if (url.endsWith('/stream')) {
      let sent = 0;
      return new Response(new ReadableStream({
        pull(c) {
          if (sent >= big.length) return c.close();
          c.enqueue(new TextEncoder().encode(big.slice(sent, sent + 65536)));
          sent += 65536;
        },
      }), { status: 200 });
    }
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
  });
  await refused(openFeed('https://feeds.example.com/declared', { lookup: PUBLIC }), 'too-large');
  await refused(openFeed('https://feeds.example.com/stream', { lookup: PUBLIC }), 'too-large');
  const err = await openFeed('https://feeds.example.com/slow', { lookup: PUBLIC, timeoutMs: 40 }).catch((e: unknown) => e);
  assert.ok(err instanceof FeedError && err.reason === 'timeout', String(err));
  assert.match(err.message, /too long/);
  assert.equal(FEED.timeoutMs, 10_000);
  assert.equal(FEED.maxBytes, 2 * 1024 * 1024);
});

test('feeds: HTML pages and other XML are not feeds; errors from the site are plain', async (t) => {
  stubNet(t, (url) => {
    if (url.endsWith('/html')) return new Response('<!doctype html><html><body><p>Hi</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/svg')) return xml('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    if (url.endsWith('/empty')) return xml('');
    return new Response('nope', { status: 404 });
  });
  for (const u of ['html', 'svg', 'empty']) await refused(openFeed(`https://feeds.example.com/${u}`, { lookup: PUBLIC }), 'not-feed');
  await refused(openFeed('https://feeds.example.com/missing', { lookup: PUBLIC }), 'status');
});

test('feeds: at most 50 items; an item over 4,000 characters is cut with a visible (cut)', async (t) => {
  const items = Array.from({ length: 51 }, (_, i) => `<item><title>Item ${i + 1}</title><guid>g${i + 1}</guid><description>${i === 0 ? 'Long words here. '.repeat(400) : `Body ${i + 1}.`}</description></item>`).join('');
  stubNet(t, () => xml(`<rss><channel><title>Many</title>${items}</channel></rss>`));
  const s = await openFeed('https://feeds.example.com/many', { lookup: PUBLIC });
  assert.equal(s.items.length, FEED.maxItems);
  assert.equal(FEED.maxItems, 50);
  assert.equal(s.items.at(-1)!.title, 'Item 50', 'the 51st is dropped');
  const long = s.items[0].text;
  assert.ok(long.length <= RT.maxChars, String(long.length));
  assert.ok(long.endsWith('(cut)'));
  assert.equal(s.items[1].text, 'Body 2.');
});

test('feeds: private local mode refuses the feed with PrivateLocalError and makes no request', async (t) => {
  const calls = stubNet(t, () => xml(RSS));
  let looked = 0;
  setPrivateLocal(true);
  t.after(() => setPrivateLocal(false));
  await assert.rejects(openFeed('https://feeds.example.com/rss', { lookup: async () => (looked++, ['93.184.216.34']) }), (err: unknown) => isPrivateLocalError(err));
  assert.equal(calls.length, 0);
  assert.equal(looked, 0, 'not even a name lookup');
});
