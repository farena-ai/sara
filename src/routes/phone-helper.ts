// EC24 (docs/ops/EC24_DESIGN.md): Settings → Devices and sign-in → Phone as a helper, and the
// device's answer to a prompt. Owner only (members and the demo never reach here; apps signed in
// with a device code are refused in server.ts). A device is a browser sign-in (cookie session):
// it switches itself on or off, and only it answers.
//   GET  /api/phone-helper                 this device's switch, the helper devices, waiting requests
//   PUT  /api/phone-helper {helper}        this device on or off (one audit row; 409 under the pin)
//   POST /api/phone-helper/requests/:id    {allow, image | lat, lon, accuracy | error}
import { SESSION_COOKIE } from '../auth.ts';
import { audit } from '../audit-trail.ts';
import { cookies, HttpError, readJson, send } from '../http.ts';
import { ANSWER_MAX_BODY } from '../phone-helper.ts';
import { policy } from '../policy-profile.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createPhoneHelperRoutes(ctx: RouteCtx): RouteHandler {
  const { app, auth, opts } = ctx;
  return async (req, res, method, parts) => {
    const [a, b, c, d] = parts;
    if (a !== 'phone-helper') return NEXT;
    const helper = app.phoneHelper;
    if (opts.member || app.member || opts.demo || app.demo || !helper) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    const session = auth.sessionId(cookies(req)[SESSION_COOKIE]);
    const view = () => ({
      thisDevice: helper.isDevice(session),
      canOptIn: Boolean(session),
      pinned: !policy().phoneHelperOn,
      devices: helper.devices().map(({ id, label, since }) => ({ id, label, since, current: id === session })),
      pending: helper.isDevice(session) && policy().phoneHelperOn ? helper.pending() : [],
    });
    if (!b && method === 'GET') return send(res, 200, view());
    if (!b && method === 'PUT') {
      const body = await readJson(req);
      if (typeof body.helper !== 'boolean') throw new HttpError(400, 'Send helper: true or false.');
      if (!session) throw new HttpError(400, 'Open Sara on the phone you want to use and switch it on there.');
      try {
        helper.setDevice(session, body.helper);
      } catch (err) {
        audit({ action: 'phone.helper', who: 'owner', role: 'owner', channel: 'web', outcome: 'refused', keys: ['helper'] });
        throw err;
      }
      audit({ action: 'phone.helper', who: 'owner', role: 'owner', channel: 'web', outcome: 'ok', keys: ['helper'], target: helper.devices().find((x) => x.id === session)?.label ?? 'this device' });
      return send(res, 200, view());
    }
    if (b === 'requests' && c && !d && method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req, ANSWER_MAX_BODY);
      } catch (err) {
        // A body over the cap still ends the request, so she isn't left waiting on a broken phone.
        if (err instanceof HttpError && err.status === 413 && helper.isDevice(session) && helper.pending().some((p) => p.id === c)) helper.answer(c, session, { allow: true, error: 'too-large' });
        throw err;
      }
      helper.answer(c, session, body);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found');
  };
}
