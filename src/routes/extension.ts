// U4.25 (docs/EXTENSION.md): the browser extension's routes.
//   Its own token (device code, scope 'extension', listed under Settings → Devices and sign-in):
//     GET  /api/ext/state          who she is and the owner's switches (the popup shows them)
//     POST /api/ext/ask            {mode: ask|summarize, question, url, title, selection, text} → {reply, url, conversationId}
//     POST /api/ext/save           {url, title, text, selection} → the Library document {id, name, url}
//     POST /api/ext/fill           {url, title, fields:[{ref, label, name, id, placeholder, autocomplete, type, never}]}
//                                  → {fills, skipped, unmatched} for the popup's approval card (nothing is filled here)
//     POST /api/ext/teach          D1 {name, why, title, url, steps} → {id, name, url}: the steps you showed it,
//                                  checked again (src/teach.ts), for review in Settings → Skills
//     GET  /api/device/whoami, POST /api/device/logout
//   Nothing else: no chats, memories, settings or devices. Private local mode refuses it, kid spaces
//   never reach it (src/family.ts), and the owner can switch it or its form filling off:
//     GET/PUT /api/extension       {on, forms, teach} (+ paired count), in the person's own space.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { audit } from '../audit-trail.ts';
import { disclosureText } from '../safety.ts';
import { askMessage, cleanPage, EXT_CHANNEL, ExtSettingsFile, fillPlanFor, pageFileName, pageMarkdown, type ExtField } from '../extension.ts';
import { HttpError, readJson, send } from '../http.ts';
import { appLanguage, en } from '../i18n.ts';
import { myDetailsFor } from '../my-details.ts';
import { privateLocalOn } from '../net-guard.ts';
import { externalTurn } from '../other-apps.ts';
import { ShortcutLimiter } from '../shortcuts.ts';
import { cleanTeaching, TaughtStore, titleOf } from '../teach.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

const LINES = {
  off: en('The browser extension is turned off in Settings → Connections → Devices and sign-in.'),
  forms: en('Filling forms from the browser extension is off in Settings → Connections → Devices and sign-in.'),
  teach: en('Recording steps from the browser extension is off in Settings → Connections → Devices and sign-in.'),
  noSteps: en('There are no steps to keep: do the task once while Sara watches, then press Stop.'),
  privateLocal: en('Private local mode is on: the browser extension waits until it is off.'),
  only: en('The browser extension can only ask about pages, save them, fill forms and record steps you show it.'),
  notExt: en('Only the browser extension uses these.'),
  empty: en('There is nothing on this page to ask about.'),
  slow: en('Too many requests from the browser extension. Wait a minute and try again.'),
  noLibrary: en('The Library is not available on this server.'),
  failed: en('Sara could not answer just now. Try again, or continue in Sara.'),
  busy: en('Sara is still working on this conversation. Wait for her or press Stop.'),
} as const;

/** Per token: asks, saves and form plans a minute and an hour. */
const LIMITS = { ask: { perMinute: 6, perHour: 120 }, share: { perMinute: 10, perHour: 200 }, widget: { perMinute: 10, perHour: 200 } };

export function createExtensionRoutes(ctx: RouteCtx): { api: (req: IncomingMessage, res: ServerResponse, method: string, parts: string[], deviceId: string) => Promise<void>; routes: RouteHandler } {
  const { app, auth, requireDisclosure } = ctx;
  const settings = new ExtSettingsFile(app.dataDir);
  const limiter = new ShortcutLimiter(LIMITS);
  const role = () => (ctx.opts.member ? 'member' : 'owner') as 'member' | 'owner';
  const who = () => (ctx.opts.member ? `member:${ctx.spaceId}` : 'owner');
  const origin = (req: IncomingMessage): string => {
    const host = String(req.headers.host ?? '');
    const fwd = ctx.opts.trustProxy ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() : '';
    const https = fwd ? fwd === 'https' : Boolean((req.socket as { encrypted?: boolean }).encrypted);
    return /^[\w.:[\]-]+$/.test(host) ? `${https ? 'https' : 'http'}://${host}` : '';
  };
  const ready = (deviceId: string, kind: 'ask' | 'share' | 'widget') => {
    if (privateLocalOn()) throw new HttpError(403, LINES.privateLocal);
    if (!settings.get().on) throw new HttpError(403, LINES.off);
    if (!limiter.take(deviceId, kind)) throw new HttpError(429, LINES.slow);
  };

  async function api(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], deviceId: string): Promise<void> {
    const [a, b] = parts;
    if (a === 'device' && b === 'whoami' && method === 'GET') {
      const d = auth.devices().find((x) => x.id === deviceId);
      return send(res, 200, { companion: app.persona.name, device: d ? { id: d.id, label: d.label, scope: 'extension' } : null, disclosureAccepted: Boolean(app.settings.get().disclosureAcceptedAt), disclosure: disclosureText(app.persona.name, appLanguage(app.settings.get())) });
    }
    if (a === 'device' && b === 'logout' && method === 'POST') {
      auth.signOut(deviceId);
      return send(res, 200, { ok: true });
    }
    if (a !== 'ext') throw new HttpError(403, LINES.only);
    if (b === 'state' && method === 'GET') {
      const s = settings.get();
      const d = auth.devices().find((x) => x.id === deviceId);
      const details = (app.myDetails ?? myDetailsFor(app.store.db)).get();
      return send(res, 200, { companion: app.persona.name, device: d?.label ?? '', on: s.on, forms: s.forms, teach: s.teach, privateLocal: privateLocalOn(), hasDetails: Object.keys(details).length > 0, disclosureAccepted: Boolean(app.settings.get().disclosureAcceptedAt) });
    }
    if (b === 'ask' && method === 'POST') {
      ready(deviceId, 'ask');
      requireDisclosure(req);
      const p = cleanPage(await readJson(req, 256 * 1024));
      if (!p.url || (!p.text.trim() && !p.selection && !p.question)) throw new HttpError(400, LINES.empty);
      let host = '';
      try {
        host = new URL(p.url).hostname;
      } catch {
        /* cleaned already */
      }
      const conv = app.store.createConversation({ title: (p.title || host).slice(0, 120), channel: EXT_CHANNEL, channelKey: `${deviceId}:${randomBytes(6).toString('base64url')}` });
      const url = `${origin(req)}/#c=${conv.id}`;
      // U5.33: the page is outside content: nothing that changes something runs without the owner's OK.
      const r = await externalTurn(app, conv.id, askMessage(p), { outsideContent: true }, { stopOnApproval: true });
      audit({ action: `extension.${p.mode}`, who: who(), role: role(), channel: EXT_CHANNEL, outcome: r.error && !r.text ? 'failed' : 'ok' });
      if (r.busy) throw new HttpError(409, LINES.busy);
      if (r.error && !r.text.trim() && !r.waiting) throw new HttpError(502, LINES.failed);
      return send(res, 200, { reply: r.text.trim(), notices: r.notices, ...(r.waiting ? { waiting: r.waiting } : {}), conversationId: conv.id, url });
    }
    if (b === 'save' && method === 'POST') {
      ready(deviceId, 'share');
      const p = cleanPage(await readJson(req, 256 * 1024));
      if (!p.url || (!p.text.trim() && !p.selection)) throw new HttpError(400, LINES.empty);
      const lib = app.library;
      if (!lib) throw new HttpError(503, LINES.noLibrary);
      const bytes = Buffer.from(pageMarkdown(p, app.now()), 'utf8');
      // The same page saved again (same words) is the same document; the date line is left out of the match.
      const same = lib.list().find((d) => d.keep && d.name === pageFileName(p) && d.origin === 'library');
      const doc = same ?? lib.add({ name: pageFileName(p), bytes, keep: true, origin: 'library' });
      if (!same) {
        app.libraryNudge?.();
        app.events?.publish({ type: 'library', id: doc.id });
      }
      audit({ action: 'extension.save', who: who(), role: role(), channel: EXT_CHANNEL, outcome: 'ok' });
      return send(res, 200, { id: doc.id, name: doc.name, url: `${origin(req)}/#view=library:${doc.id}` });
    }
    if (b === 'fill' && method === 'POST') {
      ready(deviceId, 'widget');
      if (!settings.get().forms) throw new HttpError(403, LINES.forms);
      const body = await readJson(req, 128 * 1024);
      const fields = (Array.isArray(body.fields) ? body.fields : []).filter((f): f is ExtField => Boolean(f) && typeof f === 'object' && typeof (f as ExtField).ref === 'string');
      const details = (app.myDetails ?? myDetailsFor(app.store.db)).get();
      const plan = fillPlanFor(fields, details, String(body.title ?? '').slice(0, 200));
      audit({ action: 'extension.fill', who: who(), role: role(), channel: EXT_CHANNEL, outcome: 'ok', keys: [`fills:${plan.fills.length}`, `skipped:${plan.skipped.length}`] });
      return send(res, 200, {
        fills: plan.fills.map((f) => ({ ref: f.ref, label: f.label, value: f.value, ...(f.key ? { key: f.key } : {}) })),
        skipped: plan.skipped.map((s) => ({ ref: s.ref, label: s.label, why: s.why })),
        unmatched: plan.unmatched.slice(0, 50),
        hasDetails: Object.keys(details).length > 0,
      });
    }
    if (b === 'teach' && method === 'POST') {
      ready(deviceId, 'share');
      if (!settings.get().teach) throw new HttpError(403, LINES.teach);
      const t = cleanTeaching(await readJson(req, 256 * 1024));
      if (!t.steps.some((s) => s.kind !== 'go')) throw new HttpError(400, LINES.noSteps);
      const item = new TaughtStore(app.dataDir, () => app.now()).add(t, deviceId);
      app.events?.publish({ type: 'skills' });
      audit({ action: 'extension.teach', who: who(), role: role(), channel: EXT_CHANNEL, outcome: 'ok', keys: [`steps:${t.steps.length}`] });
      return send(res, 200, { id: item.id, name: titleOf(item), url: `${origin(req)}/#view=settings:ab-skills` });
    }
    throw new HttpError(403, LINES.only);
  }

  const routes: RouteHandler = async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a === 'ext') throw new HttpError(403, LINES.notExt);
    if (a !== 'extension' || b !== undefined) return NEXT;
    if (ctx.opts.demo) throw new HttpError(403, 'Not on the demo.');
    const paired = () => auth.devices().filter((d) => d.kind === 'extension').length;
    if (method === 'GET') return send(res, 200, { ...settings.get(), paired: paired() });
    if (method === 'PUT') {
      const next = settings.set(await readJson(req));
      return send(res, 200, { ...next, paired: paired() });
    }
    return NEXT;
  };
  return { api, routes };
}
