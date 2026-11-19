// V4.2 (docs/design/INTERPRETER.md): /api/talk/interpret… (inside the `talk` route family, so
// household members use it with their own data; a member whose voice is off gets 403).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { en, trOwner } from '../i18n.ts';
import { INTERP_LANGS, interpLang, interpPrefs, interpreterLog, saveInterpPrefs, translateTurn, type InterpLang } from '../interpreter.ts';
import type { RouteCtx } from './context.ts';

export async function interpreterRoute(ctx: RouteCtx, req: IncomingMessage, res: ServerResponse, method: string, parts: string[]): Promise<void> {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const [, , c, d] = parts;
  if (ctx.opts.member && ctx.opts.member.record()?.limits?.voice === false) {
    if (method !== 'GET') await readJson(req).catch(() => undefined);
    throw new HttpError(403, T(en('Voice is off for you on this Sara.')));
  }
  const log = interpreterLog(app);
  if (!c && method === 'GET') return send(res, 200, { prefs: interpPrefs(app), langs: INTERP_LANGS, sessions: log.list() });
  if (!c && method === 'PUT') return send(res, 200, { prefs: saveInterpPrefs(app, await readJson(req)) });
  if (c === 'start' && method === 'POST') {
    const body = await readJson(req);
    const p = interpPrefs(app);
    const a = body.a === undefined ? p.a : interpLang(body.a);
    const b = body.b === undefined ? p.b : interpLang(body.b);
    if (!a || !b || a === b) throw new HttpError(400, T(en('Pick two different languages.')));
    if (a !== p.a || b !== p.b) saveInterpPrefs(app, { a, b });
    return send(res, 200, { session: log.start(a, b) });
  }
  if (c === 'turn' && method === 'POST') {
    const body = await readJson(req);
    const s = log.get(String(body.id ?? ''));
    if (!s) throw new HttpError(404, T(en('This interpreter session has ended.')));
    const said = String(body.text ?? '').trim();
    if (!said) throw new HttpError(400, T(en('Nothing was heard.')));
    const hint = interpLang(body.hint) as InterpLang | undefined;
    const last = s.lines.at(-1)?.from;
    const r = await translateTurn(app, said, { ...interpPrefs(app), a: s.a, b: s.b }, { ...(hint ? { hint } : {}), ...(last ? { last } : {}) });
    const line = log.add(s.id, { from: r.from, to: r.to, said, text: r.ok ? r.text : '' });
    return send(res, 200, { line, ...(r.ok ? {} : { why: T(r.why) }) });
  }
  if (c === 'end' && method === 'POST') {
    const body = await readJson(req);
    const s = log.end(String(body.id ?? ''));
    if (!s) throw new HttpError(404, T(en('This interpreter session has ended.')));
    return send(res, 200, { ok: true, count: s.lines.length });
  }
  if (c && !d && method === 'GET') {
    const s = log.get(c);
    if (!s) throw new HttpError(404, T(en('Transcript not found.')));
    return send(res, 200, { session: s });
  }
  if (c && d === 'text' && method === 'GET') {
    const txt = log.text(c);
    if (txt === undefined) throw new HttpError(404, T(en('Transcript not found.')));
    const data = Buffer.from(txt, 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': data.length, 'content-disposition': `attachment; filename="interpreter-${c}.txt"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
    return void res.end(data);
  }
  if (c && !d && method === 'DELETE') {
    if (!log.remove(c)) throw new HttpError(404, T(en('Transcript not found.')));
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Not found');
}
