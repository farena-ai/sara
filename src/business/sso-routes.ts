// EC2: HTTP surface of business single sign-on (status, start, admin settings, connection test).
// The cross-site callback is handled by the runtime before its Origin checks (see runtime.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoginLimiter } from '../auth.ts';
import type { BusinessAuth } from './identity.ts';
import { BusinessAccessError } from './policy.ts';
import type { BusinessSso } from './sso.ts';
import type { BusinessPrincipal } from './types.ts';

export const SSO_BINDING_COOKIE = 'sara_business_sso';

interface SsoRouteContext {
  req: IncomingMessage; res: ServerResponse; path: string; principal?: BusinessPrincipal;
  sso: BusinessSso; auth: BusinessAuth; origin: string; ip: string; limiter: LoginLimiter;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  json: (response: ServerResponse, status: number, value: unknown) => void;
}

export async function ssoRoutes(c: SsoRouteContext): Promise<void> {
  const send = (status: number, value: unknown) => c.json(c.res, status, value);
  try {
    if (c.path === '/api/business/sso/status' && c.req.method === 'GET') return send(200, c.sso.status());
    const admin = c.path === '/api/business/sso/config' || c.path === '/api/business/sso/test';
    if (admin && !c.principal) throw new BusinessAccessError(401);
    if (c.path === '/api/business/sso/config' && c.req.method === 'GET') return send(200, c.sso.view(c.principal!));
    if (c.req.method !== 'POST') throw new BusinessAccessError(404);
    if (c.path === '/api/business/sso/start') {
      if (c.limiter.blocked(c.ip)) return send(429, { error: 'Too many requests.' });
      // Each start allocates a pending sign-in; bound them per address.
      c.limiter.fail(c.ip);
      const data = await c.body(c.req);
      const principal = c.principal && c.auth.isPrincipalActive(c.principal) ? c.principal : undefined;
      const { url, binding } = await c.sso.start(data, principal);
      c.res.setHeader('set-cookie', `${SSO_BINDING_COOKIE}=${binding}; Path=/api/business/sso; HttpOnly; SameSite=Lax; Max-Age=600${c.origin.startsWith('https:') ? '; Secure' : ''}`);
      return send(200, { url });
    }
    const data = await c.body(c.req);
    if (!c.principal || !c.auth.isPrincipalActive(c.principal)) throw new BusinessAccessError(401);
    if (c.path === '/api/business/sso/config') return send(200, c.sso.save(c.principal, data));
    if (c.path === '/api/business/sso/test') { if (Object.keys(data).length) throw new BusinessAccessError(400); return send(200, await c.sso.test(c.principal)); }
    throw new BusinessAccessError(404);
  } catch (error) {
    if (error instanceof BusinessAccessError) return send(error.status, { error: error.message });
    return send(400, { error: 'Request denied.' });
  }
}
