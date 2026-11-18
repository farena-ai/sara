// V0.8 (docs/SIGN_IN_SSO.md): OpenID Connect sign-in routes for personal and household servers.
//   Before sign-in (owner's front space only; never the demo):
//     GET  /api/sso/callback   the provider sends the browser back; 303 to /?sso=done (one-use ticket cookie) or /?sso=<reason>
//     POST /api/sso/start      {confirm18?} → {url} (+ a SameSite=Lax binding cookie for the return)
//     POST /api/sso/finish     the ticket → the owner's or a member's session cookie (new-device approval applies to the owner)
//   The owner, signed in (Settings → Connections → Devices and sign-in → Sign in with your provider):
//     GET/PUT /api/sso         settings (the client secret is write-only, kept in the vault)
//     POST /api/sso/check      discovery + keys;  POST /api/sso/test → {url} for the Test sign-in popup
//     GET  /api/sso/test-result;  POST /api/sso/preview {email, groups};  POST /api/sso/unlink {person}
//   The owner token, passkeys and pairing codes always keep working: nothing here can turn them off.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deviceLabel, type LoginLimiter, type OwnerAuth } from '../auth.ts';
import type { DeviceGate } from '../device-gate.ts';
import { cleanLimits, cookieValue } from '../household.ts';
import { HttpError, readJson, send } from '../http.ts';
import { en } from '../i18n.ts';
import { HomeSso, SSO_BINDING_COOKIE, SSO_TICKET_COOKIE, SsoInputError, type SsoPerson } from '../home-sso.ts';
import type { HouseholdHooks } from '../server.ts';

const SAY: Record<string, string> = {
  issuer: en('The issuer URL must start with https:// (http:// only on this computer), without ?, # or a user name.'),
  clientId: en('The client ID is not valid.'),
  clientSecret: en('The client secret is not valid (no spaces).'),
  origin: en('This server’s address must start with http:// or https://.'),
  groupClaim: en('The group claim may use letters, digits and _ : . / - only.'),
  skewSeconds: en('The allowed clock difference is 0 to 300 seconds.'),
  email: en('One of the emails is not an email address.'),
  group: en('A group name is empty or too long.'),
  duplicate: en('An email can belong to only one person.'),
  adults: en('Confirm that everyone on the list is 18 or older.'),
  incomplete: en('Fill in the issuer URL, client ID, client secret and this server’s address first.'),
  off: en('Sign-in with your provider is off on this server.'),
  busy: en('Too many sign-in requests. Try again in a few minutes.'),
  expired: en('This sign-in expired or was already used. Start again.'),
  unavailable: en('This account can’t be signed in here right now. Use your token or passkey.'),
};
const BAD = en('That setting is not valid.');

export interface SsoRouteDeps {
  sso: HomeSso;
  auth: OwnerAuth;
  gate: DeviceGate;
  limiter: LoginLimiter;
  household?: HouseholdHooks;
  cookie: (req: IncomingMessage) => (value: string, maxAge: number) => string;
  isHttps: (req: IncomingMessage) => boolean;
  secureCookies: boolean;
  ip: (req: IncomingMessage) => string;
  sameSiteOnly: () => void;
}

/** The owner and every household member, for the sign-in rules and the Settings preview. */
export function ssoPeople(ownerName: string, household?: HouseholdHooks['store']): SsoPerson[] {
  return [
    { id: 'owner', name: ownerName || 'Owner', role: 'owner', active: true },
    ...(household?.members() ?? []).map((m) => ({ id: m.id, name: m.name, role: m.child ? ('kid' as const) : ('member' as const), active: m.status === 'active' })),
  ];
}

const pageOrigin = (req: IncomingMessage, https: boolean) => {
  const o = String(req.headers.origin ?? '');
  if (/^https?:\/\/[^/]+$/.test(o)) return o;
  return req.headers.host ? `${https ? 'https' : 'http'}://${req.headers.host}` : '';
};

function inputError(err: unknown): never {
  if (err instanceof SsoInputError) throw new HttpError(400, SAY[err.message] ?? BAD);
  throw err;
}

/** Sign-in routes (no session yet). Returns true when it answered. */
export async function ssoPublicRoute(d: SsoRouteDeps, req: IncomingMessage, res: ServerResponse, method: string, b: string | undefined): Promise<boolean> {
  const secure = d.secureCookies || d.isHttps(req) ? '; Secure' : '';
  const lax = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/api/sso; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  if (b === 'callback' && method === 'GET') {
    const ip = d.ip(req);
    const back = (location: string, cookies: string[] = []) => {
      res.writeHead(303, { location, 'cache-control': 'no-store', 'set-cookie': [lax(SSO_BINDING_COOKIE, '', 0), ...cookies] });
      res.end();
    };
    if (d.limiter.blocked(ip)) return back('/?sso=state'), true;
    const r = await d.sso.callback(new URL(req.url ?? '/', 'http://x').searchParams, cookieValue(req, SSO_BINDING_COOKIE));
    if ('test' in r) return back('/?sso-test=done'), true;
    if ('reason' in r) {
      if (r.reason === 'state') d.limiter.fail(ip, Date.now(), 0.5);
      return back(`/?sso=${r.reason}`), true;
    }
    return back('/?sso=done', [lax(SSO_TICKET_COOKIE, r.ticket, 120)]), true;
  }
  if (b === 'start' && method === 'POST') {
    d.sameSiteOnly();
    const ip = d.ip(req);
    if (d.limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    d.limiter.fail(ip, Date.now(), 0.1);
    const body = await readJson(req);
    const r = await d.sso.start({ confirm18: body.confirm18 === true }).catch(inputError);
    res.setHeader('set-cookie', lax(SSO_BINDING_COOKIE, r.binding, 600));
    send(res, 200, { url: r.url });
    return true;
  }
  if (b === 'finish' && method === 'POST') {
    d.sameSiteOnly();
    const ip = d.ip(req);
    if (d.limiter.blocked(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const f = d.sso.finish(cookieValue(req, SSO_TICKET_COOKIE));
    const clear = lax(SSO_TICKET_COOKIE, '', 0);
    if (!f) {
      d.limiter.fail(ip);
      res.setHeader('set-cookie', clear);
      throw new HttpError(401, SAY.expired);
    }
    d.limiter.reset(ip);
    const label = deviceLabel(req.headers['user-agent']);
    const cookie = d.cookie(req);
    const withClear = (c: string) => res.setHeader('set-cookie', [clear, c]);
    if ('person' in f.target && f.target.person.id === 'owner') {
      // The owner: exactly like a passkey sign-in (new-device approval and the device limit apply).
      let value = '';
      d.gate.signIn(req, res, (v, m) => {
        value = v;
        return cookie(v, m);
      });
      const sid = value ? d.auth.cookieId(value) : undefined;
      if (sid) f.complete('owner', 'owner', sid);
      return true;
    }
    const hooks = d.household;
    if (!hooks) throw new HttpError(409, SAY.unavailable);
    if ('person' in f.target) {
      const s = hooks.sessionFor?.(f.target.person.id, label);
      if (!s) throw new HttpError(409, SAY.unavailable);
      withClear(cookie(s.value, s.maxAgeSeconds));
      f.complete(f.target.person.id, f.target.person.id, s.id);
      send(res, 200, { ok: true });
      return true;
    }
    // Just-in-time: a new adult member, the same way an invite makes one (the owner confirmed 18+ for the list).
    const before = new Set(hooks.store.members().map((m) => m.id));
    const { code } = hooks.store.invite({ name: f.target.create.name, hours: 1, confirm18: true, limits: cleanLimits({ models: hooks.models().slice(0, 1).map(({ providerId, model }) => ({ providerId, model })) }, hooks.models()) });
    const joined = await hooks.join(code, f.confirm18, label);
    const added = hooks.store.members().find((m) => !before.has(m.id));
    withClear(cookie(joined.session.value, joined.session.maxAgeSeconds));
    if (added) f.complete(added.id, added.id, (joined.session as { id?: string }).id ?? '');
    console.log('Household: someone joined with OpenID Connect sign-in.');
    send(res, 200, { ok: true, joined: true });
    return true;
  }
  return false;
}

/** The owner's settings routes. Returns true when it answered. */
export async function ssoOwnerRoute(d: SsoRouteDeps & { askFirst: () => void; unlinkMember?: (id: string) => void }, req: IncomingMessage, res: ServerResponse, method: string, b: string | undefined): Promise<boolean> {
  const https = d.secureCookies || d.isHttps(req);
  if (!b && method === 'GET') return send(res, 200, d.sso.view(pageOrigin(req, https))), true;
  if (!b && method === 'PUT') {
    d.sameSiteOnly();
    // A remote device needs the owner's OK first: a provider that maps to the owner is a way in.
    d.askFirst();
    const body = await readJson(req);
    let v;
    try { v = d.sso.save(body); } catch (err) { inputError(err); }
    return send(res, 200, v), true;
  }
  if (b === 'check' && method === 'POST') return d.sameSiteOnly(), send(res, 200, await d.sso.check()), true;
  if (b === 'test' && method === 'POST') {
    d.sameSiteOnly();
    const r = await d.sso.start({ test: true }).catch(inputError);
    const secure = https ? '; Secure' : '';
    res.setHeader('set-cookie', `${SSO_BINDING_COOKIE}=${r.binding}; Path=/api/sso; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    return send(res, 200, { url: r.url }), true;
  }
  if (b === 'test-result' && method === 'GET') return send(res, 200, { result: d.sso.testResult() }), true;
  if (b === 'preview' && method === 'POST') {
    d.sameSiteOnly();
    return send(res, 200, d.sso.preview(await readJson(req))), true;
  }
  if (b === 'unlink' && method === 'POST') {
    d.sameSiteOnly();
    const body = await readJson(req);
    const person = String(body.person ?? '');
    if (!/^(owner|[a-z0-9]{1,40})$/.test(person)) throw new HttpError(400, BAD);
    return send(res, 200, { removed: d.sso.unlink(person) }), true;
  }
  return false;
}
