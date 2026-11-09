// C14: Spotify on the owner's own Spotify developer app (Authorization Code + PKCE), against a fake
// Spotify Web API (no real network).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { createSaraServer } from '../src/server.ts';
import { SPOTIFY_PLAYBACK_SCOPES, SPOTIFY_PLAYLIST_SCOPES, SPOTIFY_READ_SCOPES, SpotifyAccount, spotifyApiBase, SPOTIFY_TOKEN_VAULT } from '../src/spotify.ts';
import { createSpotifyTools } from '../src/tools/spotify.ts';
import { Vault } from '../src/vault.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

type Call = { url: string; method: string; body: string; auth: string };
const CLIENT = '0123456789abcdef0123456789abcdef';

function fakeSpotify(opts: { premium?: boolean; scope?: string } = {}) {
  const calls: Call[] = [];
  let tokenN = 0;
  let refreshFails = false;
  let playing = true;
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? '');
    calls.push({ url, method, body, auth: String((init.headers as Record<string, string>)?.authorization ?? '') });
    const json = (status: number, j: unknown) => new Response(JSON.stringify(j), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://accounts.spotify.com/api/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'refresh_token' && refreshFails) return json(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' });
      tokenN++;
      return json(200, { access_token: `at${tokenN}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt${tokenN}`, scope: opts.scope ?? SPOTIFY_READ_SCOPES.join(' ') });
    }
    const u = new URL(url);
    if (u.pathname === '/v1/me') return json(200, { id: 'alex', display_name: 'Alex' });
    if (u.pathname === '/v1/search') {
      const type = u.searchParams.get('type');
      if (type === 'track') return json(200, { tracks: { items: [{ name: 'Clair de Lune', uri: 'spotify:track:t1', artists: [{ name: 'Debussy' }], album: { name: 'Suite' } }] } });
      if (type === 'artist') return json(200, { artists: { items: [{ name: 'Debussy', uri: 'spotify:artist:a1', genres: ['classical'] }] } });
      if (type === 'album') return json(200, { albums: { items: [{ name: 'Suite', uri: 'spotify:album:b1', artists: [{ name: 'Debussy' }], release_date: '1905' }] } });
      return json(200, { playlists: { items: [null, { name: 'Calm', uri: 'spotify:playlist:p9', owner: { display_name: 'Spotify' }, tracks: { total: 50 } }] } });
    }
    if (u.pathname === '/v1/me/player/currently-playing') {
      if (!playing) return new Response(null, { status: 204 });
      return json(200, { is_playing: true, progress_ms: 61000, item: { name: 'Clair de Lune', uri: 'spotify:track:t1', duration_ms: 300000, artists: [{ name: 'Debussy' }], album: { name: 'Suite' } } });
    }
    if (u.pathname === '/v1/me/playlists' && method === 'GET') return json(200, { items: [{ id: 'p1', name: 'Road trip', uri: 'spotify:playlist:p1', items: { total: 12 }, owner: { id: 'alex' } }] });
    if (u.pathname === '/v1/me/playlists' && method === 'POST') return json(201, { id: 'p2', name: JSON.parse(body).name, uri: 'spotify:playlist:p2', external_urls: { spotify: 'https://open.spotify.com/playlist/p2' } });
    if (u.pathname === '/v1/playlists/p1/items' && method === 'POST') return json(201, { snapshot_id: 's1' });
    if (u.pathname.startsWith('/v1/me/top/')) return json(200, { items: [{ name: 'Debussy', uri: 'spotify:artist:a1' }] });
    if (u.pathname === '/v1/me/player/devices') return json(200, { devices: [{ id: 'dev1', name: 'Kitchen speaker', type: 'Speaker', is_active: true, volume_percent: 40 }] });
    if (u.pathname.startsWith('/v1/me/player')) {
      if (!opts.premium) return json(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } });
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { status: 404, message: 'not found' } });
  }) as typeof fetch;
  return { f, calls, failRefresh: () => (refreshFails = true), stop: () => (playing = false) };
}

async function connected(opts: { premium?: boolean; playback?: boolean; playlists?: boolean } = {}) {
  const vault = new Vault(tempDir().dir);
  const scope = [...SPOTIFY_READ_SCOPES, ...(opts.playlists ? SPOTIFY_PLAYLIST_SCOPES : []), ...(opts.playback ? SPOTIFY_PLAYBACK_SCOPES : [])].join(' ');
  const fake = fakeSpotify({ premium: opts.premium ?? false, scope });
  let now = 1_000_000;
  const sp = new SpotifyAccount(vault, { fetch: fake.f, now: () => now });
  sp.setClient(CLIENT, { playback: opts.playback ?? false, playlists: opts.playlists ?? false });
  const url = new URL(sp.authUrl('https://sara.example/api/spotify/callback'));
  await sp.finish('code1', url.searchParams.get('state') ?? '');
  const tools = Object.fromEntries(createSpotifyTools(sp).map((t) => [t.spec.name, t]));
  const ctx = { signal: new AbortController().signal } as never;
  return { vault, sp, fake, tools, ctx, advance: (ms: number) => (now += ms) };
}

test('C14: PKCE sign-in URL asks only for read scopes by default; the verifier matches the challenge', async () => {
  const vault = new Vault(tempDir().dir);
  const fake = fakeSpotify();
  const sp = new SpotifyAccount(vault, { fetch: fake.f });
  assert.throws(() => sp.authUrl('https://sara.example/api/spotify/callback'), /Client ID/);
  assert.throws(() => sp.setClient('not-an-id', {}), /32/);
  sp.setClient(CLIENT, {});
  const url = new URL(sp.authUrl('https://sara.example/api/spotify/callback'));
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  const scopes = (url.searchParams.get('scope') ?? '').split(' ');
  assert.deepEqual(scopes.sort(), [...SPOTIFY_READ_SCOPES].sort());
  assert.ok(!scopes.some((s) => s.includes('modify')), 'no write scope unless the owner ticks it');
  await sp.finish('code1', url.searchParams.get('state') ?? '');
  const tokenCall = fake.calls.find((c) => c.url.endsWith('/api/token'))!;
  const p = new URLSearchParams(tokenCall.body);
  assert.equal(p.get('grant_type'), 'authorization_code');
  assert.equal(p.get('client_id'), CLIENT);
  assert.equal(p.get('client_secret'), null, 'PKCE: no client secret anywhere');
  assert.equal(createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url'), url.searchParams.get('code_challenge'));
  const st = sp.status();
  assert.equal(st.connected, true);
  assert.equal(st.name, 'Alex');
  assert.equal(st.canPlayback, false);
  // The state is one-time.
  await assert.rejects(sp.finish('code1', url.searchParams.get('state') ?? ''), /expired/);
  // Tokens live in the vault.
  assert.ok(vault.get(SPOTIFY_TOKEN_VAULT)?.includes('rt1'));
});

test('C14: ticking playback and playlists adds exactly those scopes', () => {
  const sp = new SpotifyAccount(new Vault(tempDir().dir), { fetch: fakeSpotify().f });
  sp.setClient(CLIENT, { playback: true, playlists: true });
  const scopes = new URL(sp.authUrl('https://x.example/cb')).searchParams.get('scope')!.split(' ');
  for (const s of [...SPOTIFY_PLAYBACK_SCOPES, ...SPOTIFY_PLAYLIST_SCOPES, ...SPOTIFY_READ_SCOPES]) assert.ok(scopes.includes(s), s);
  assert.deepEqual(sp.status().options, { playback: true, playlists: true });
  // Changing only the options keeps the app and asks for a new sign-in only when scopes grow.
  sp.setOptions({ playback: false, playlists: true });
  assert.deepEqual(sp.status().options, { playback: false, playlists: true });
});

test('C14: an expired access token is refreshed (rotated refresh token kept); a revoked one signs out', async () => {
  const { sp, fake, tools, ctx, advance, vault } = await connected();
  advance(2 * 3600_000);
  const out = await tools.spotify_now_playing!.run({}, ctx);
  assert.match(out, /Clair de Lune/);
  const refresh = fake.calls.filter((c) => c.url.endsWith('/api/token')).at(-1)!;
  const p = new URLSearchParams(refresh.body);
  assert.equal(p.get('grant_type'), 'refresh_token');
  assert.equal(p.get('refresh_token'), 'rt1');
  assert.equal(p.get('client_id'), CLIENT);
  assert.ok(fake.calls.at(-1)!.auth.endsWith('at2'));
  assert.ok(vault.get(SPOTIFY_TOKEN_VAULT)?.includes('rt2'), 'the new refresh token replaces the old one');
  advance(2 * 3600_000);
  fake.failRefresh();
  await assert.rejects(tools.spotify_now_playing!.run({}, ctx), /signed Sara out/);
  assert.equal(sp.status().connected, false);
});

test('C14: search, now playing, playlists and top items read the right endpoints', async () => {
  const { tools, ctx, fake } = await connected();
  assert.match(await tools.spotify_search!.run({ query: 'debussy', type: 'track' }, ctx), /Clair de Lune · Debussy .*spotify:track:t1/);
  assert.match(await tools.spotify_search!.run({ query: 'debussy', type: 'artist' }, ctx), /Debussy .*classical/);
  assert.match(await tools.spotify_search!.run({ query: 'debussy', type: 'album' }, ctx), /Suite · Debussy · 1905/);
  assert.match(await tools.spotify_search!.run({ query: 'calm', type: 'playlist' }, ctx), /Calm/);
  await assert.rejects(tools.spotify_search!.run({ query: 'x', type: 'podcast' }, ctx), /track, album, artist or playlist/);
  assert.match(await tools.spotify_now_playing!.run({}, ctx), /Playing: Clair de Lune · Debussy \(1:01 of 5:00\)/);
  fake.stop();
  assert.match(await tools.spotify_now_playing!.run({}, ctx), /Nothing is playing/);
  assert.match(await tools.spotify_my_playlists!.run({}, ctx), /Road trip .*12 songs.*p1/);
  assert.match(await tools.spotify_top!.run({ type: 'artists', time_range: 'short_term' }, ctx), /Debussy/);
  assert.ok(fake.calls.filter((c) => c.url.includes('/v1/search?')).every((c) => Number(new URL(c.url).searchParams.get('limit')) <= 10), 'Spotify caps search at 10');
  assert.ok(fake.calls.some((c) => c.url.includes('/v1/me/top/artists?') && c.url.includes('time_range=short_term')));
  assert.match(await tools.spotify_devices!.run({}, ctx), /Kitchen speaker \(Speaker, active, volume 40%\) id dev1/);
  // Read tools run on their own; playlist writes ask; playback is a low-risk write that runs on its own.
  for (const n of ['spotify_search', 'spotify_now_playing', 'spotify_my_playlists', 'spotify_top', 'spotify_devices']) assert.equal(tools[n]!.defaultPermission, 'auto', n);
  assert.equal(tools.spotify_playlist_add!.defaultPermission, 'ask');
  assert.equal(tools.spotify_playlist_create!.defaultPermission, 'ask');
  assert.equal(tools.spotify_playback!.defaultPermission, 'auto');
  // Built-in tools (no MCP source label), so Settings → Tools lists them under Music.
  for (const t of Object.values(tools)) assert.equal(t.source, undefined, t.spec.name);
});

test('C14: playlist tools only show with the playlist permission and send the right bodies', async () => {
  const off = await connected();
  assert.equal(off.tools.spotify_playlist_add!.isAvailable!(), false);
  assert.equal(off.tools.spotify_playback!.isAvailable!(), false);
  assert.equal(off.tools.spotify_search!.isAvailable!(), true);
  const { tools, ctx, fake } = await connected({ playlists: true });
  assert.equal(tools.spotify_playlist_add!.isAvailable!(), true);
  const made = await tools.spotify_playlist_create!.run({ name: 'Rainy day', description: 'for you' }, ctx);
  assert.match(made, /Made the playlist "Rainy day".*spotify:playlist:p2/);
  const post = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/me/playlists'))!;
  assert.deepEqual(JSON.parse(post.body), { name: 'Rainy day', description: 'for you', public: false });
  assert.match(await tools.spotify_playlist_add!.run({ playlist: 'spotify:playlist:p1', uris: ['spotify:track:t1'] }, ctx), /Added 1 song/);
  const add = fake.calls.find((c) => c.method === 'POST' && c.url.endsWith('/v1/playlists/p1/items'))!;
  assert.deepEqual(JSON.parse(add.body), { uris: ['spotify:track:t1'] });
  await assert.rejects(tools.spotify_playlist_add!.run({ playlist: 'p1', uris: ['https://evil.example/x'] }, ctx), /spotify:track/);
  assert.match(tools.spotify_playlist_add!.summarize({ playlist: 'p1', uris: ['spotify:track:t1'] }), /Spotify: add 1 song/);
});

test('C14: playback controls send the right player calls on a chosen device; free accounts get a plain Premium answer', async () => {
  const prem = await connected({ premium: true, playback: true });
  const { tools, ctx, fake } = prem;
  assert.equal(tools.spotify_playback!.isAvailable!(), true);
  assert.match(await tools.spotify_playback!.run({ action: 'play', uri: 'spotify:track:t1', device_id: 'dev1' }, ctx), /Playing/);
  const play = fake.calls.find((c) => c.url.includes('/v1/me/player/play'))!;
  assert.equal(play.method, 'PUT');
  assert.ok(play.url.includes('device_id=dev1'));
  assert.deepEqual(JSON.parse(play.body), { uris: ['spotify:track:t1'] });
  await tools.spotify_playback!.run({ action: 'play', uri: 'spotify:playlist:p1' }, ctx);
  assert.deepEqual(JSON.parse(fake.calls.filter((c) => c.url.includes('/v1/me/player/play')).at(-1)!.body), { context_uri: 'spotify:playlist:p1' });
  await tools.spotify_playback!.run({ action: 'pause' }, ctx);
  assert.ok(fake.calls.some((c) => c.method === 'PUT' && c.url.includes('/v1/me/player/pause')));
  await tools.spotify_playback!.run({ action: 'next' }, ctx);
  await tools.spotify_playback!.run({ action: 'previous' }, ctx);
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.url.includes('/v1/me/player/next')));
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.url.includes('/v1/me/player/previous')));
  await tools.spotify_playback!.run({ action: 'volume', volume: 150 }, ctx);
  assert.ok(fake.calls.some((c) => c.url.includes('/v1/me/player/volume?volume_percent=100')));
  await tools.spotify_playback!.run({ action: 'shuffle', on: true }, ctx);
  assert.ok(fake.calls.some((c) => c.url.includes('/v1/me/player/shuffle?state=true')));
  assert.match(await tools.spotify_playback!.run({ action: 'queue', uri: 'spotify:track:t1' }, ctx), /Queued/);
  assert.ok(fake.calls.some((c) => c.method === 'POST' && c.url.includes('/v1/me/player/queue?uri=spotify%3Atrack%3At1')));
  await assert.rejects(tools.spotify_playback!.run({ action: 'queue' }, ctx), /song/);
  await assert.rejects(tools.spotify_playback!.run({ action: 'dance' }, ctx), /play, pause/);

  const free = await connected({ premium: false, playback: true });
  const out = await free.tools.spotify_playback!.run({ action: 'pause' }, free.ctx);
  assert.match(out, /needs Spotify Premium/);
});

test('C14: disconnect forgets the tokens; removing the app forgets everything', async () => {
  const { sp, vault, tools } = await connected();
  sp.disconnect();
  assert.equal(vault.get(SPOTIFY_TOKEN_VAULT), undefined);
  assert.equal(sp.status().connected, false);
  assert.equal(sp.status().configured, true);
  assert.equal(tools.spotify_search!.isAvailable!(), false);
  sp.forgetClient();
  assert.equal(sp.status().configured, false);
});

test('C14: the test seam only accepts loopback', () => {
  assert.equal(spotifyApiBase({ SARA_SPOTIFY_API_BASE: 'http://127.0.0.1:7900' }), 'http://127.0.0.1:7900');
  assert.equal(spotifyApiBase({ SARA_SPOTIFY_API_BASE: 'https://evil.example' }), undefined);
});

test('C14: Settings routes: save the Client ID and ticks, show the redirect, connect through the callback, disconnect', async () => {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-08T12:00:00Z') };
  const app = makeApp(dir, clock);
  const fake = fakeSpotify({ scope: SPOTIFY_READ_SCOPES.join(' ') });
  app.spotify = new SpotifyAccount(app.vault, { fetch: fake.f });
  const auth = new OwnerAuth(dir, () => clock.now);
  const token = auth.newToken!;
  const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, { method, redirect: 'manual', headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  try {
    let v = (await (await call('/api/spotify')).json()) as Record<string, unknown>;
    assert.equal(v.configured, false);
    assert.equal(v.redirect, `${base}/api/spotify/callback`);
    assert.equal(v.redirectOk, true, 'a loopback IP over http is allowed by Spotify');
    assert.equal((await call('/api/spotify/client', 'PUT', { clientId: 'nope' })).status, 400);
    v = (await (await call('/api/spotify/client', 'PUT', { clientId: CLIENT, playback: false })).json()) as Record<string, unknown>;
    assert.equal(v.configured, true);
    assert.equal(v.clientId, CLIENT);
    const { url } = (await (await call('/api/spotify/connect', 'POST', {})).json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    assert.equal(new URL(url).searchParams.get('redirect_uri'), `${base}/api/spotify/callback`);
    // The callback carries no session cookie: the one-time state is the proof.
    const back = await fetch(`${base}/api/spotify/callback?code=abc&state=${encodeURIComponent(state)}`);
    assert.match(await back.text(), /#spotify=connected/);
    v = (await (await call('/api/spotify')).json()) as Record<string, unknown>;
    assert.equal(v.connected, true);
    assert.equal(v.name, 'Alex');
    // Ticking playback after the sign-in asks for a new sign-in; playback stays off until then.
    v = (await (await call('/api/spotify/options', 'PUT', { playback: true })).json()) as Record<string, unknown>;
    assert.equal(v.needsReconnect, true);
    assert.equal(v.canPlayback, false);
    const bad = await fetch(`${base}/api/spotify/callback?code=abc&state=forged`);
    assert.match(await bad.text(), /#spotify=failed/);
    assert.match(await (await fetch(`${base}/api/spotify/callback?error=access_denied`)).text(), /#spotify=refused/);
    v = (await (await call('/api/spotify', 'DELETE')).json()) as Record<string, unknown>;
    assert.equal(v.connected, false);
    assert.equal(v.configured, true);
    v = (await (await call('/api/spotify/client', 'DELETE')).json()) as Record<string, unknown>;
    assert.equal(v.configured, false);
  } finally {
    server.close();
    app.store.close();
    cleanup();
  }
});
