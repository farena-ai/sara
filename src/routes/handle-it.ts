// W4.1 (docs/HANDLE_IT.md): Handle it, inside the errands route family (members get their own).
//   POST /api/errands/handle                          {kind, ref} → {handle} (the plan; nothing runs)
//   GET  /api/errands/:id/handle                      {handle} (the progress card)
//   POST /api/errands/:id/handle/start · ok · skip · pause · resume · stop   (ok: {amount?, note?, to?, choice?})
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleBegin, handleOk, handlePause, handleResume, handleSkip, handleStart, handleStop, handleView, type HandleKind } from '../handle-it.ts';
import { HttpError, readJson, send } from '../http.ts';

export async function handleRoute(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], wrap: <R>(f: () => Promise<R> | R) => Promise<R>, app: Parameters<typeof handleView>[0]): Promise<void> {
  const [, b, c, d] = parts;
  if (b === 'handle' && !c && method === 'POST') {
    const body = await readJson(req);
    const begun = await wrap(() => handleBegin(app, String(body.kind ?? '') as HandleKind, String(body.ref ?? '')));
    return send(res, 200, { handle: handleView(app, begun.errand.id) });
  }
  const id = Number(b);
  if (!Number.isInteger(id) || id <= 0 || c !== 'handle') throw new HttpError(404, 'Not found');
  if (!d && method === 'GET') return send(res, 200, { handle: await wrap(() => handleView(app, id)) });
  if (d && method === 'POST') {
    const x = (await readJson(req).catch(() => ({}))) as Record<string, unknown>;
    if (d === 'start') return send(res, 200, { handle: await wrap(() => handleStart(app, id)) });
    if (d === 'ok') return send(res, 200, { handle: await wrap(() => handleOk(app, id, { ...(typeof x.amount === 'number' ? { amount: x.amount } : {}), ...(typeof x.note === 'string' ? { note: x.note } : {}), ...(typeof x.to === 'string' ? { to: x.to } : {}), ...(typeof x.choice === 'string' ? { choice: x.choice } : {}) })) });
    if (d === 'skip') return send(res, 200, { handle: await wrap(() => handleSkip(app, id)) });
    if (d === 'pause') return send(res, 200, { handle: await wrap(() => handlePause(app, id)) });
    if (d === 'resume') return send(res, 200, { handle: await wrap(() => handleResume(app, id)) });
    if (d === 'stop') return send(res, 200, { handle: await wrap(() => handleStop(app, id)) });
  }
  throw new HttpError(404, 'Not found');
}
