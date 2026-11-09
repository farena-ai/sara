// C14: Spotify through the official Web API, signed in with the owner's own Spotify developer app
// (made once at developer.spotify.com; Settings → Connections → Spotify walks through it). The
// sign-in is Authorization Code + PKCE: only a Client ID, no secret. Tokens live in the encrypted
// vault and are renewed automatically. Read scopes by default; changing playlists and controlling
// playback are separate ticks that add their scopes at the next sign-in.
// Spotify (Feb 2026): a Development Mode app works only while its owner has Spotify Premium.
import { netFetch } from './net-guard.ts';
import { createHash, randomBytes } from 'node:crypto';
import type { Vault } from './vault.ts';

export const SPOTIFY_CLIENT_VAULT = 'spotify:client';
export const SPOTIFY_TOKEN_VAULT = 'spotify:token';
export const SPOTIFY_READ_SCOPES = ['user-read-currently-playing', 'user-read-playback-state', 'user-read-recently-played', 'user-top-read', 'playlist-read-private', 'playlist-read-collaborative'] as const;
export const SPOTIFY_PLAYLIST_SCOPES = ['playlist-modify-private', 'playlist-modify-public'] as const;
export const SPOTIFY_PLAYBACK_SCOPES = ['user-modify-playback-state'] as const;

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API = 'https://api.spotify.com/v1';

/**
 * Test-only: send Web API calls to a local fake Spotify (SARA_SPOTIFY_API_BASE, e.g.
 * http://127.0.0.1:7900). Only loopback addresses are accepted.
 */
export function spotifyApiBase(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.SARA_SPOTIFY_API_BASE?.trim().replace(/\/+$/, '');
  return v && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(v) ? v : undefined;
}

/** A Spotify answer that wasn't OK. `reason` is Spotify's own code (PREMIUM_REQUIRED, NO_ACTIVE_DEVICE…). */
export class SpotifyApiError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(message: string, status: number, reason = '') {
    super(message);
    this.name = 'SpotifyApiError';
    this.status = status;
    this.reason = reason;
  }
}

export interface SpotifyOptions {
  /** "Let her change my playlists" (adds playlist-modify-*). */
  playlists: boolean;
  /** "Let her control playback" (adds user-modify-playback-state). */
  playback: boolean;
}
interface Client extends SpotifyOptions {
  clientId: string;
}
interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  scopes: string;
  name?: string;
}

export interface SpotifyStatus {
  configured: boolean;
  clientId?: string;
  connected: boolean;
  name?: string;
  options: SpotifyOptions;
  /** What the last sign-in actually allowed. */
  canPlaylists: boolean;
  canPlayback: boolean;
  /** A tick was added after the sign-in: sign in again to allow it. */
  needsReconnect: boolean;
}

type Fetch = typeof fetch;

export function spotifyScopes(o: Partial<SpotifyOptions>): string[] {
  return [...SPOTIFY_READ_SCOPES, ...(o.playlists ? SPOTIFY_PLAYLIST_SCOPES : []), ...(o.playback ? SPOTIFY_PLAYBACK_SCOPES : [])];
}

export class SpotifyAccount {
  readonly #vault: Vault;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  readonly #base: string | undefined;
  readonly #pending = new Map<string, { verifier: string; redirect: string; at: number }>();

  constructor(vault: Vault, opts: { fetch?: Fetch; now?: () => number; apiBase?: string } = {}) {
    this.#vault = vault;
    this.#fetch = opts.fetch ?? netFetch;
    this.#now = opts.now ?? Date.now;
    this.#base = opts.apiBase;
  }

  #client(): Client | undefined {
    const raw = this.#vault.get(SPOTIFY_CLIENT_VAULT);
    return raw ? (JSON.parse(raw) as Client) : undefined;
  }
  #tokens(): Tokens | undefined {
    const raw = this.#vault.get(SPOTIFY_TOKEN_VAULT);
    return raw ? (JSON.parse(raw) as Tokens) : undefined;
  }

  status(): SpotifyStatus {
    const c = this.#client();
    const t = this.#tokens();
    const granted = new Set((t?.scopes ?? '').split(/\s+/).filter(Boolean));
    const options = { playlists: c?.playlists === true, playback: c?.playback === true };
    const canPlaylists = Boolean(t) && SPOTIFY_PLAYLIST_SCOPES.every((s) => granted.has(s));
    const canPlayback = Boolean(t) && SPOTIFY_PLAYBACK_SCOPES.every((s) => granted.has(s));
    return {
      configured: Boolean(c),
      ...(c ? { clientId: c.clientId } : {}),
      connected: Boolean(t),
      ...(t?.name ? { name: t.name } : {}),
      options,
      // A tick taken away hides the tools at once; a tick added needs the owner to allow it.
      canPlaylists: canPlaylists && options.playlists,
      canPlayback: canPlayback && options.playback,
      needsReconnect: Boolean(t) && ((options.playlists && !canPlaylists) || (options.playback && !canPlayback)),
    };
  }

  setClient(clientId: string, opts: Partial<SpotifyOptions>): void {
    clientId = clientId.trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) throw new Error('The Client ID is 32 letters and digits. Copy it from your app at developer.spotify.com → Dashboard → your app → Settings.');
    const before = this.#client();
    this.#vault.set(SPOTIFY_CLIENT_VAULT, JSON.stringify({ clientId, playlists: opts.playlists === true, playback: opts.playback === true }));
    if (before && before.clientId !== clientId) this.#vault.delete(SPOTIFY_TOKEN_VAULT);
  }

  setOptions(opts: Partial<SpotifyOptions>): void {
    const c = this.#client();
    if (!c) throw new Error('Add your Spotify app (Client ID) first.');
    this.#vault.set(SPOTIFY_CLIENT_VAULT, JSON.stringify({ ...c, playlists: opts.playlists ?? c.playlists, playback: opts.playback ?? c.playback }));
  }

  /** The Spotify page to send the owner to. `redirect` must be registered in the Spotify app. */
  authUrl(redirect: string): string {
    const c = this.#client();
    if (!c) throw new Error('Add your Spotify app (Client ID) first.');
    for (const [k, v] of this.#pending) if (this.#now() - v.at > 10 * 60_000) this.#pending.delete(k);
    const state = randomBytes(16).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    this.#pending.set(state, { verifier, redirect, at: this.#now() });
    const q = new URLSearchParams({
      client_id: c.clientId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: spotifyScopes(c).join(' '),
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Spotify sent the owner back with a code: trade it (and the PKCE verifier) for tokens. */
  async finish(code: string, state: string): Promise<SpotifyStatus> {
    const p = this.#pending.get(state);
    this.#pending.delete(state);
    if (!p || this.#now() - p.at > 10 * 60_000) throw new Error('That sign-in link expired. Start again from Settings.');
    const c = this.#client();
    if (!c) throw new Error('The Spotify app was removed.');
    const j = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: p.redirect, client_id: c.clientId, code_verifier: p.verifier });
    if (!j.refresh_token) throw new Error('Spotify did not give a long-lived sign-in. Try again.');
    const tokens: Tokens = { access: j.access_token, refresh: j.refresh_token, expiresAt: this.#now() + (j.expires_in - 60) * 1000, scopes: j.scope ?? '' };
    this.#vault.set(SPOTIFY_TOKEN_VAULT, JSON.stringify(tokens));
    try {
      const me = (await this.api('/me')) as { display_name?: string; id?: string };
      const name = me.display_name || me.id;
      if (name) this.#vault.set(SPOTIFY_TOKEN_VAULT, JSON.stringify({ ...tokens, name: String(name).slice(0, 80) }));
    } catch {
      /* the name just isn't shown */
    }
    return this.status();
  }

  async #token(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
    const r = await this.#fetch(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(20_000) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string; refresh_token?: string; expires_in?: number; scope?: string };
    if (!r.ok || !j.access_token) {
      if (j.error === 'invalid_grant' && body.grant_type === 'refresh_token') {
        this.#vault.delete(SPOTIFY_TOKEN_VAULT);
        throw new Error('Spotify signed Sara out (the sign-in expired or was removed). Connect again in Settings → Connections → Spotify.');
      }
      throw new Error(`Spotify sign-in failed: ${j.error_description ?? j.error ?? r.status}`);
    }
    return { access_token: j.access_token, expires_in: j.expires_in ?? 3600, ...(j.refresh_token ? { refresh_token: j.refresh_token } : {}), ...(j.scope !== undefined ? { scope: j.scope } : {}) };
  }

  async #access(): Promise<string> {
    const t = this.#tokens();
    if (!t) throw new Error('Spotify is not connected (Settings → Connections → Spotify).');
    if (t.expiresAt > this.#now()) return t.access;
    const c = this.#client();
    if (!c) throw new Error('The Spotify app was removed.');
    const j = await this.#token({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: c.clientId });
    // PKCE refresh tokens rotate: keep the new one when Spotify sends it.
    const next: Tokens = { ...t, access: j.access_token, expiresAt: this.#now() + (j.expires_in - 60) * 1000, ...(j.refresh_token ? { refresh: j.refresh_token } : {}), ...(j.scope ? { scopes: j.scope } : {}) };
    this.#vault.set(SPOTIFY_TOKEN_VAULT, JSON.stringify(next));
    return next.access;
  }

  /** One Web API call. `path` starts with "/" (e.g. "/me/player"). 204 answers come back as null. */
  async api(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
    if (!path.startsWith('/')) throw new Error('bad Spotify path');
    const access = await this.#access();
    const r = await this.#fetch(`${this.#base ?? SPOTIFY_API}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: `Bearer ${access}`, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal ?? AbortSignal.timeout(20_000),
    });
    const text = await r.text().catch(() => '');
    let j: { error?: { message?: string; reason?: string } | string } = {};
    try {
      j = text ? (JSON.parse(text) as typeof j) : {};
    } catch {
      /* not JSON (some player answers are empty or plain text) */
    }
    if (!r.ok) {
      const e = typeof j.error === 'object' ? j.error : { message: typeof j.error === 'string' ? j.error : undefined };
      const reason = e?.reason ?? '';
      if (reason === 'PREMIUM_REQUIRED' || (r.status === 403 && /premium/i.test(e?.message ?? ''))) throw new SpotifyApiError('That needs Spotify Premium: Spotify only lets Premium accounts control playback from other apps.', 403, 'PREMIUM_REQUIRED');
      if (reason === 'NO_ACTIVE_DEVICE' || (r.status === 404 && path.startsWith('/me/player'))) throw new SpotifyApiError('No Spotify device is active. Open Spotify on a phone, computer or speaker (or name a device), then try again.', r.status, 'NO_ACTIVE_DEVICE');
      if (r.status === 403 && /scope/i.test(e?.message ?? '')) throw new SpotifyApiError('The Spotify sign-in did not allow this. Tick it in Settings → Connections → Spotify and connect again.', 403, 'SCOPE');
      if (r.status === 429) throw new SpotifyApiError('Spotify asked Sara to slow down. Try again in a minute.', 429, 'RATE');
      throw new SpotifyApiError(`Spotify: ${e?.message ?? r.status}`, r.status, reason);
    }
    return text && j ? j : null;
  }

  /** Forget the sign-in. Spotify has no revoke call: the owner removes access at spotify.com/account/apps. */
  disconnect(): void {
    this.#vault.delete(SPOTIFY_TOKEN_VAULT);
  }

  forgetClient(): void {
    this.#vault.delete(SPOTIFY_CLIENT_VAULT);
    this.#vault.delete(SPOTIFY_TOKEN_VAULT);
  }
}
