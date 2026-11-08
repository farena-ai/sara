import { serveBusinessStatic } from './static.ts';
import { recoveryMode } from './recovery.ts';
import { createBusinessBackup } from './backup.ts';
import { acquireBusinessWriter, bindBusinessWriter } from './lifecycle.ts';
import { BusinessAudit } from './audit.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LoginLimiter } from '../auth.ts';
import { clientIp, proxyTrust } from '../http.ts';
import { BusinessAuth, BusinessIdentityDirectory, BUSINESS_COOKIE, type BusinessSession } from './identity.ts';
import { openBusinessProfile, type BusinessProfile } from './profile.ts';
import { BusinessControlStore } from './store.ts';
import { createBusinessManagementRouter } from './routes.ts';
import { BusinessWorkspaces } from './workspaces.ts';
import { BusinessRetrieval } from './retrieval.ts';
import { BusinessEvents } from './events.ts';
import { createBusinessContentRouter } from './content-routes.ts';
import { BusinessBudget } from './budget.ts';
import { BUSINESS_USAGE_PATHS, handleBusinessUsage } from './usage-report.ts';
import { BusinessModels, configureBusinessModels, primeOperatorSecrets } from './model-config.ts';
import { BusinessDocuments } from './documents.ts';
import { BusinessChat } from './chat.ts';
import { createBusinessWriteRouter } from './write-routes.ts';
import { envMode } from '../private-local.ts';
import { BusinessSso } from './sso.ts';
import { SSO_BINDING_COOKIE, ssoRoutes } from './sso-routes.ts';
import { BusinessScim } from './scim.ts';
import { BusinessAccessError } from './policy.ts';
import type { BusinessMutation } from './types.ts';

const MAX_BODY = 65_536;
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Invalid request.');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value as Record<string, unknown>;
}

export function businessOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('SARA_BUSINESS_ORIGIN must be an explicit HTTPS origin (HTTP is allowed only on loopback).');
  }
  return url.origin;
}

export function createBusinessRuntime(options: { profile: BusinessProfile; origin: string; trustProxy?: boolean | { secret: string }; privateLocal?: boolean; onMutation?: (event: BusinessMutation) => void }) {
  const origin = businessOrigin(options.origin);
  const writer = acquireBusinessWriter(options.profile);
  let cleanup: (() => void) | undefined;
  try {
    const identities = new BusinessIdentityDirectory(options.profile); cleanup = () => identities.close();
    const lifecycle = identities.lifecycle; bindBusinessWriter(writer, lifecycle);
    const auth = new BusinessAuth(options.profile, identities);
    let events: BusinessEvents | undefined;
    let activeChat: BusinessChat | undefined;
    const control = new BusinessControlStore(identities, { principalActive: principal => auth.isPrincipalActive(principal), onMutation: event => {
      events?.revalidateAll();
      activeChat?.revalidateActive();
      if (event.workspaceId) events?.publish(event.workspaceId, { kind: 'audience.changed' });
      options.onMutation?.(event);
    } });
    events = new BusinessEvents(control.policy);
    const workspaceEvents = events;
    const workspaces = new BusinessWorkspaces(options.profile, control);
    const retrieval = new BusinessRetrieval(workspaces);
    const budget = new BusinessBudget(control.database, () => lifecycle.assertAdmission()); budget.interruptPending();
    const models = new BusinessModels(options.profile, options.privateLocal, () => { lifecycle.assertAdmission(); if (recoveryMode(control.database)) throw new Error('Models are disabled during recovery.'); });
    const documents = new BusinessDocuments(control, workspaces);
    const chat = new BusinessChat({ control, workspaces, retrieval, budget, models }); activeChat = chat;
    const sso = new BusinessSso({ profile: options.profile, control, auth, origin, privateLocal: options.privateLocal });
    const scim = new BusinessScim({ profile: options.profile, control, sso, origin });
    const ssoLimiter = new LoginLimiter(30);
    const ssoStarts = new LoginLimiter(100);
    const unsubscribeAuth = auth.onSessionInvalidated(() => { workspaceEvents.revalidateAll(); chat.revalidateActive(); });
    const failedAuth = new LoginLimiter(30);
    const challengeAllocations = new LoginLimiter(100);
    const cookie = (res: ServerResponse, session?: BusinessSession) => {
      res.setHeader('set-cookie', `${BUSINESS_COOKIE}=${session?.value ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${session?.maxAgeSeconds ?? 0}${origin.startsWith('https:') ? '; Secure' : ''}`);
    };
    const management = createBusinessManagementRouter({ store: control, auth, body, json, cookie, clientIp: req => clientIp(req, options.trustProxy) });
    const audit = new BusinessAudit(control, workspaces);
    const content = createBusinessContentRouter({ control, workspaces, retrieval, events: workspaceEvents, audit, json });
    const writes = createBusinessWriteRouter({ control, chat, documents, models, events: workspaceEvents, body, json });
    const server = createServer((req, res) => {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'no-referrer');
      res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      if (origin.startsWith('https:')) res.setHeader('strict-transport-security', 'max-age=31536000');
      void lifecycle.run(async () => {
        const path = new URL(req.url ?? '/', origin).pathname;
        if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Origin denied.' });
        if (await serveBusinessStatic(req, res, path)) return;
        // EC2: the IdP sends the browser back cross-site; state + the binding cookie authenticate it.
        if (path === '/api/business/sso/callback' && req.method === 'GET') {
          const ip = clientIp(req, options.trustProxy);
          const back = (location: string, cookies: string[] = []) => { res.writeHead(303, { location, 'cache-control': 'no-store', 'set-cookie': [`${SSO_BINDING_COOKIE}=; Path=/api/business/sso; HttpOnly; SameSite=Lax; Max-Age=0${origin.startsWith('https:') ? '; Secure' : ''}`, ...cookies] }); res.end(); };
          if (recoveryMode(control.database)) return back('/?sso=unavailable');
          if (ssoLimiter.blocked(ip)) return back('/?sso=state');
          const binding = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith(`${SSO_BINDING_COOKIE}=`))?.slice(SSO_BINDING_COOKIE.length + 1);
          const result = await sso.callback(new URL(req.url ?? '/', origin).searchParams, binding);
          if ('reason' in result) { ssoLimiter.fail(ip); return back(`/?sso=${result.reason}`); }
          return back('/', [`${BUSINESS_COOKIE}=${result.session.value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${result.session.maxAgeSeconds}${origin.startsWith('https:') ? '; Secure' : ''}`]);
        }
        // EC16: SCIM is server to server (no Origin, no cookie); the bearer token authenticates it.
        if (path === '/scim/v2' || path.startsWith('/scim/v2/')) {
          if (recoveryMode(control.database)) return json(res, 503, { error: 'Business recovery requires reconciliation.' });
          return scim.handle(req, res, path, clientIp(req, options.trustProxy));
        }
        if ( (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Origin denied.' });
        if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, profile: 'business' });
        if (recoveryMode(control.database) && !['/api/business/reenroll', '/api/business/me', '/api/business/logout', '/api/business/passkeys/register/options', '/api/business/passkeys/register/finish', '/api/business/passkeys/login/options', '/api/business/passkeys/login/finish'].includes(path)) return json(res, 503, { error: 'Business recovery requires reconciliation.' });
        if (path === '/api/business/claim' && req.method === 'GET') return json(res, 200, auth.claimStatus());
        const allowed = new Set(['/api/business/reenroll', '/api/business/claim', '/api/business/me', '/api/business/logout', '/api/business/passkeys/register/options', '/api/business/passkeys/register/finish', '/api/business/passkeys/login/options', '/api/business/passkeys/login/finish']);
        if (path === '/api/business/org/audit' || BUSINESS_USAGE_PATHS.includes(path)) allowed.add(path);
        if (path === '/api/business/scim/config' || path === '/api/business/scim/token') allowed.add(path);
        if (['/api/business/sso/status', '/api/business/sso/start', '/api/business/sso/config', '/api/business/sso/test'].includes(path)) allowed.add(path);
        if (!allowed.has(path) && !management.matches(path) && !content.matches(path) && !writes.matches(path)) return json(res, 404, { error: 'Not found.' });
        if (req.method !== 'GET' && (req.method !== 'POST' || req.headers.origin !== origin)) return json(res, 403, { error: 'Origin denied.' });
        const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${BUSINESS_COOKIE}=`));
        const principal = cookies.length === 1 ? auth.principal(cookies[0].slice(BUSINESS_COOKIE.length + 1)) : undefined;
        // A UI tab may hold an old actor's draft after another tab changes the shared cookie.
        // This expectation only narrows the verified cookie principal; it never grants authority.
        if (req.headers['x-sara-business-session'] !== undefined && req.headers['x-sara-business-session'] !== principal?.sessionId) return json(res, 409, { error: 'Business session changed.' });
        if (writes.matches(path) && (req.method === 'POST' || path.endsWith('/model-policy'))) return writes.handle(req, res, path, principal);
        if (content.matches(path)) return content.handle(req, res, path, principal);
        if (management.matches(path)) return management.handle(req, res, path, principal);
        if (path === '/api/business/org/audit' && req.method === 'GET') {
          try { if (!principal) return json(res, 401, { error: 'Sign-in required.' }); return json(res, 200, audit.organization(principal)); }
          catch { return json(res, 403, { error: 'Request denied.' }); }
        }
        if (BUSINESS_USAGE_PATHS.includes(path)) return handleBusinessUsage({ control, req, res, path, principal: principal && auth.isPrincipalActive(principal) ? principal : undefined, json });
        if (path.startsWith('/api/business/scim/')) {
          try {
            if (!principal || !auth.isPrincipalActive(principal)) return json(res, 401, { error: 'Sign-in required.' });
            if (path === '/api/business/scim/config' && req.method === 'GET') return json(res, 200, scim.view(principal));
            if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
            const data = await body(req);
            return json(res, 200, path.endsWith('/token') ? scim.rotateToken(principal, data) : scim.save(principal, data));
          } catch (error) { return json(res, error instanceof BusinessAccessError ? error.status : 400, { error: error instanceof BusinessAccessError ? error.message : 'Request denied.' }); }
        }
        if (path.startsWith('/api/business/sso/')) return ssoRoutes({ req, res, path, principal, sso, auth, body, json, origin, limiter: ssoStarts, ip: clientIp(req, options.trustProxy) });
        if (path === '/api/business/me' && req.method === 'GET') {
          if (!principal) return json(res, 401, { error: 'Sign-in required.' });
          const identity = identities.get(principal.identityId)!;
          let organization: { name: string | null; role: string } | null = null;
          try { organization = { name: control.organizationName(), role: control.policy.requireOrganization(principal).role }; } catch { /* Enrollment/recovery remains available without grants. */ }
          const enrolled = !!control.database.prepare('SELECT credential_id FROM business_credential_refs WHERE identity_id=? AND auth_epoch=? LIMIT 1').get(principal.identityId, principal.authEpoch);
          return json(res, 200, { principal, identity: { id: identity.id, name: identity.name }, organization, passkeyEnrolled: enrolled, signIn: sso.isSsoSession(principal) ? 'sso' : 'passkey', recovering: recoveryMode(control.database), spendingPaused: !!control.database.prepare("SELECT value FROM business_model_state WHERE key='paused'").get() });
        }
        const anonymous = path === '/api/business/reenroll' || path === '/api/business/claim' || path.startsWith('/api/business/passkeys/login/');
        if (!anonymous && !principal) return json(res, 401, { error: 'Sign-in required.' });
        if (req.method !== 'POST') return json(res, 404, { error: 'Not found.' });
        const ip = clientIp(req, options.trustProxy);
        const authenticating = path === '/api/business/reenroll' || path === '/api/business/claim' || path.endsWith('/finish');
        if (authenticating && failedAuth.blocked(ip)) return json(res, 429, { error: 'Too many requests.' });
        if (path.endsWith('/options')) {
          if (challengeAllocations.blocked(ip)) return json(res, 429, { error: 'Too many requests.' });
          // Allocation is bounded independently of authentication failures and successes.
          challengeAllocations.fail(ip);
        }
        const data = await body(req);
        if (!anonymous && (!principal || !auth.isPrincipalActive(principal))) return json(res, 401, { error: 'Sign-in required.' });
        if (path === '/api/business/reenroll') {
          try { const session = auth.reenroll(data.code, data.confirm18 === true); cookie(res, session); failedAuth.reset(ip); return json(res, 200, { principal: session.principal }); }
          catch { failedAuth.fail(ip); return json(res, 400, { error: 'Re-enrollment denied.' }); }
        }
        if (path === '/api/business/claim') {
          if (typeof data.name !== 'string' || data.confirm18 !== true) return json(res, 400, { error: 'Adult confirmation (18+) is required.' });
          const session = auth.claim(ip, data.code, data.name, true);
          if (!session) { failedAuth.fail(ip); return json(res, 401, { error: 'Claim denied.' }); }
          control.bootstrapAdministrator();
          failedAuth.reset(ip);
          cookie(res, session); return json(res, 201, { principal: session.principal });
        }
        if (path === '/api/business/logout') {
          const endSession = await sso.logout(principal!).catch(() => undefined);
          auth.logout(principal!); cookie(res); return json(res, 200, { ok: true, ...(endSession ? { endSession } : {}) });
        }
        const kind = path.includes('/register/') ? 'register' : 'login';
        if (path.endsWith('/options')) {
          const identityId = kind === 'register' ? principal!.identityId : data.identityId;
          if (identityId !== undefined && typeof identityId !== 'string') return json(res, 400, { error: 'Invalid request.' });
          return json(res, 200, auth.options(kind, identityId, origin, principal));
        }
        if (typeof data.challenge !== 'string' || !data.response || typeof data.response !== 'object') return json(res, 400, { error: 'Invalid request.' });
        let session: BusinessSession | undefined;
        try {
          session = auth.finish(kind, data.challenge, data.response, origin, principal);
        } catch {
          failedAuth.fail(ip);
          return json(res, 400, { error: 'Request denied.' });
        }
        failedAuth.reset(ip);
        if (session) cookie(res, session);
        return json(res, 200, session ? { principal: session.principal } : { ok: true });
      }).catch(() => { if (!res.headersSent) json(res, 400, { error: 'Request denied.' }); else res.end(); });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 100;
    const closeServer = server.close.bind(server);
    server.close = callback => {
      // Node waits for active SSE responses; end them before asking its server to drain.
      lifecycle.closeAdmission(); chat.close(); workspaceEvents.close(); sso.close(); return closeServer(callback);
    };
    sso.startTimer();
    let closing: Promise<void> | undefined;
    return { sso, scim, configureModels: (input: unknown, keys: Record<string, string> = {}) => configureBusinessModels(options.profile, input, keys, writer), backup: (file: string, passphrase: string) => createBusinessBackup(options.profile, control, file, passphrase), lifecycle, audit, server, auth, identities, control, policy: control.policy, workspaces, retrieval, events: workspaceEvents, budget, models, documents, chat, origin, close(): Promise<void> {
      if (closing) return closing;
      lifecycle.closeAdmission(); unsubscribeAuth(); chat.close(); workspaceEvents.close(); sso.close();
      closing = (async () => {
        await sso.closing();
        if (server.listening) {
          const stopped = new Promise<void>((resolveClose, reject) => { server.close(err => err ? reject(err) : resolveClose()); server.closeIdleConnections(); });
          await lifecycle.drain();
          // Browsers can preconnect without sending HTTP headers. Idle-HTTP cleanup does not
          // cover those sockets; close them only after every admitted operation has settled.
          server.closeAllConnections(); await stopped;
        }
        await lifecycle.drain(); await lifecycle.waitSnapshot();
        workspaces.close(); identities.close(); writer.release();
      })(); return closing;
    } };
  } catch (error) { try { cleanup?.(); } finally { writer.release(); } throw error; }
}

export async function startBusinessFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.SARA_DATA || !env.SARA_BUSINESS_ORIGIN) throw new Error('Business startup requires separate SARA_DATA and SARA_BUSINESS_ORIGIN.');
  businessOrigin(env.SARA_BUSINESS_ORIGIN);
  const port = Number(env.SARA_PORT ?? 7860);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid SARA_PORT.');
  const profile = openBusinessProfile(env.SARA_DATA);
  await primeOperatorSecrets(profile);
  const runtime = createBusinessRuntime({ profile, origin: env.SARA_BUSINESS_ORIGIN, trustProxy: proxyTrust(env, profile.businessDir), privateLocal: envMode(env.SARA_PRIVATE_LOCAL) !== undefined });
  try { await new Promise<void>((ready, reject) => { runtime.server.once('error', reject); runtime.server.listen(port, env.SARA_HOST ?? '127.0.0.1', ready); }); }
  catch (error) { await runtime.close(); throw error; }
  if (runtime.auth.claimCode) process.stdout.write(`Business setup code: ${runtime.auth.claimCode}\n`);
  const address = runtime.server.address();
  process.stdout.write(`Business listening on ${typeof address === 'object' && address ? address.port : port}\n`);
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void runtime.close().finally(() => process.exit(0)); } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return runtime;
}
