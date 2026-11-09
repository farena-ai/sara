// C3 (MCP Apps): the apps MCP tools open in the web chat.
//
// - GET  /api/mcp-apps/<id>/frame  the app's page, served with `Content-Security-Policy: sandbox
//   allow-scripts; default-src 'none' …` (src/tools/mcp.ts mcpAppCsp): an opaque origin, so it can't
//   read Sara's cookies, storage, API or the chat page, even when opened on its own.
// - GET  /api/mcp-apps/<id>        what the web bridge hands the app (the call's input and result).
// - POST /api/mcp-apps/<id>/call   a tool call the app asked for: only its own server's tools that
//   are open to apps; the tool's permission decides (Off: refused; Ask: an approval card in the
//   conversation, Sara's normal path for other apps' changes; Runs on its own: runs).
import type { ServerResponse } from 'node:http';
import { HttpError, readJson, send } from '../http.ts';
import { appLanguage, en, tr } from '../i18n.ts';
import { mcpAppCsp, mcpToolName, type McpCallResult } from '../tools/mcp.ts';
import { clip } from '../tools/types.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const FRAME_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'SAMEORIGIN',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), clipboard-read=(), clipboard-write=()',
};

const CLOSED = en('This app is no longer open. Ask Sara to show it again.');
const NO_CSP = { connect: [], resource: [] };

const textOf = (r: McpCallResult) => clip((r.content ?? []).map((c) => c.text ?? '').filter(Boolean).join(' ') || 'done', 300);

export function createMcpAppRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  return async (req, res, method, parts) => {
    const [a, id, c] = parts;
    if (a !== 'mcp-apps') return NEXT;
    const mgr = app.mcp;
    if (!mgr || !id || parts.length > 3) throw new HttpError(404, 'Not found');
    const rec = mgr.apps.get(id);
    if (c === 'frame' && method === 'GET') {
      const lang = appLanguage(app.settings.get());
      const page = rec?.html ?? `<!DOCTYPE html><html lang="${lang}"><meta charset="utf-8"><body><p>${tr(CLOSED, lang).replace(/[<>&]/g, '')}</p></body></html>`;
      res.writeHead(200, { ...FRAME_HEADERS, 'content-security-policy': mcpAppCsp(rec?.csp ?? NO_CSP) });
      return void res.end(page);
    }
    if (!rec) throw new HttpError(404, CLOSED);
    if (!c && method === 'GET') return send(res, 200, { id: rec.id, server: rec.server, tool: rec.tool, input: rec.input, result: rec.result });
    if (c !== 'call' || method !== 'POST') throw new HttpError(405, 'Method not allowed');

    const body = await readJson(req, 256 * 1024);
    const name = typeof body.name === 'string' ? body.name : '';
    const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? (body.arguments as Record<string, unknown>) : {};
    let permission;
    try {
      permission = mgr.appPermission(rec.id, name, app.settings.get().toolPermissions);
    } catch (err) {
      throw new HttpError(403, (err as Error).message);
    }
    if (permission === 'never') throw new HttpError(403, 'That tool is turned off in Settings.');
    const signal = closeSignal(res);
    if (permission === 'auto') return send(res, 200, { result: await callOrThrow(() => mgr.callFromApp(rec.id, name, args, signal)) });

    // Ask: the owner's OK in the conversation the app is in, like every other app's change.
    const summary = `${rec.server} app: ${clip(name, 60)} ${clip(JSON.stringify(args), 160)}`;
    let raw: McpCallResult | undefined;
    const outcome = await new Promise<{ ok: boolean; status: string; text: string }>((resolve, reject) => {
      try {
        ctx.requestApproval(rec.conversationId, mcpToolName(rec.server, name), summary, args, async () => {
          raw = await mgr.callFromApp(rec.id, name, args, AbortSignal.timeout(10 * 60_000));
          if (raw.isError) throw new Error(textOf(raw));
          return `${summary}: ${textOf(raw)}`;
        }, resolve);
      } catch (err) {
        reject(new HttpError(409, (err as Error).message));
      }
    });
    if (raw && (outcome.ok || raw.isError)) return send(res, 200, { result: raw });
    if (outcome.status === 'stopped') throw new HttpError(403, 'You declined this.');
    throw new HttpError(502, outcome.text);
  };
}

async function callOrThrow(run: () => Promise<McpCallResult>): Promise<McpCallResult> {
  try {
    return await run();
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
}

/** Aborts when the browser goes away before the answer was sent. */
function closeSignal(res: ServerResponse): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}
