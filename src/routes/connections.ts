// Connections: Google, Home Assistant, chat bridges, Alexa, other apps, reports, the event stream.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { alexaModel } from '../alexa.ts';
import { botHourlyCapOf, botTurnLimitOf, cleanBotList, DISCORD_VAULT, discordSettings } from '../bridges/discord.ts';
import { cleanDiscordIds, cleanTelegramIds } from '../bridges/rules.ts';
import { TELEGRAM_VAULT, telegramSettings } from '../bridges/telegram.ts';
import type { TurnOptions } from '../chat.ts';
import { as400, fromPhoneApp, fromSaraApp, HttpError, readJson, safeDecode, SECURITY_HEADERS, send } from '../http.ts';
import { appLanguage } from '../i18n.ts';
import { netFetch, privateLocalOn } from '../net-guard.ts';
import { cleanOrigins, otherAppsSettings } from '../other-apps.ts';
import { cleanPresence, PRESENCE_KINDS, presenceSettings } from '../presence.ts';
import { DEFAULT_REPORT_INBOX, REASON_LABELS, validReason } from '../reports.ts';
import { disclosureText } from '../safety.ts';
import { adultModeOn } from '../settings.ts';
import { clearTodayCache } from '../today.ts';
import { ACTION_WORDS, RECONNECT_TEXT } from '../gmail-organize.ts';
import { ENTITY_ID, haCall, switchPlan } from '../home-switch.ts';
import { cleanHomeUrl, HOME_VAULT, type HaState } from '../tools/home.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

/** Hardening M4: the channel of the conversations the Home Assistant integration makes. */
export const HA_CHANNEL = 'home-assistant';

export function createConnectionsRoutes(ctx: RouteCtx): RouteHandler {
  const { alexa, app, auth, ctxOf, demoOwner, opts, spaceId, visitorKey, webRoot } = ctx;
  /** Push channel: reminders, proactive messages, planner/memory changes. */
  function streamEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no', connection: 'keep-alive', ...SECURITY_HEADERS });
    res.write(': connected\n\n');
    const write = (chunk: string) => {
      if (!res.destroyed && !res.writableEnded) res.write(chunk);
    };
    const me = app.companionId ?? 'main';
    const off = app.events?.subscribeAll((ev) => {
      // Phase 31: another companion's message or call shows as a notice (switch to her to see it).
      if (ev.companion && ev.companion !== me && ev.type !== 'planner' && ev.type !== 'board') {
        if (ev.type !== 'message' && ev.type !== 'ring') return;
        const other = opts.companions?.get(ev.companion);
        if (!other) return;
        const note = { companion: ev.companion, name: other.app.persona.name, kind: ev.type, ...(ev.type === 'ring' ? { ring: ev.ring } : { conversationId: ev.conversationId, messageId: ev.message.id, role: ev.message.role, preview: ev.message.role === 'assistant' ? other.app.redactor.redact(ev.message.content).slice(0, 140) : '' }) };
        return write(`event: other\ndata: ${JSON.stringify(note)}\n\n`);
      }
      const out = ev.type === 'message' ? { ...ev, message: { ...ev.message, ...(ev.message.meta ? { meta: app.redactor.redactValue(ev.message.meta) } : {}) } } : ev;
      write(`event: ${ev.type}\ndata: ${JSON.stringify(out)}\n\n`);
    });
    const heartbeat = setInterval(() => write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      off?.();
    });
  }
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    if (a === 'events' && !b && method === 'GET') return streamEvents(req, res);

    if (a === 'bridges' && b === 'discord') {
      const dc = app.bridges?.discord;
      if (!dc) throw new HttpError(404, 'Discord bridge is not available');
      const view = () => {
        const s = discordSettings(app);
        return {
          ...dc.status(),
          enabled: s.enabled,
          allowServers: s.allowServers,
          mirror: s.mirror,
          linked: Boolean(s.ownerUserId),
          linkedId: s.ownerUserId ?? null,
          ownerUserIds: s.ownerUserIds ?? [],
          ownerWorkInServers: s.ownerWorkInServers === true,
          answerName: s.answerName === true,
          answerEveryone: s.answerEveryone === true,
          answerBots: s.answerBots === true,
          botAllowList: s.botAllowList ?? [],
          botTurnLimit: botTurnLimitOf(s),
          botHourlyCap: botHourlyCapOf(s),
          // Adult channels are part of Adult mode: only while it's on, and never in the phone and desktop apps.
          ...(fromSaraApp(req) || !adultModeOn(app.settings.get()) ? {} : { nsfwChannelIds: s.nsfwChannelIds ?? [] }),
          hasToken: Boolean(app.vault.get(DISCORD_VAULT)),
        };
      };
      if (!c && method === 'GET') return send(res, 200, await view());
      if (!c && method === 'PUT') {
        const body = await readJson(req);
        let tokenChanged = false;
        if (typeof body.token === 'string') {
          const t = body.token.trim();
          if (t && !/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(t)) throw new HttpError(400, 'That does not look like a Discord bot token.');
          if (t !== (app.vault.get(DISCORD_VAULT) ?? '')) tokenChanged = true;
          t ? app.vault.set(DISCORD_VAULT, t) : app.vault.delete(DISCORD_VAULT);
        }
        const cur = discordSettings(app);
        const before = JSON.stringify(app.settings.get().discord ?? null);
        app.settings.update({
          discord: {
            ...cur,
            ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
            ...(body.allowServers !== undefined ? { allowServers: Boolean(body.allowServers) } : {}),
            ...(body.mirror !== undefined ? { mirror: Boolean(body.mirror) } : {}),
            ...(body.ownerUserIds !== undefined ? { ownerUserIds: cleanDiscordIds(body.ownerUserIds) } : {}),
            ...(body.ownerWorkInServers !== undefined ? { ownerWorkInServers: Boolean(body.ownerWorkInServers) } : {}),
            ...(body.answerName !== undefined ? { answerName: Boolean(body.answerName) } : {}),
            ...(body.answerEveryone !== undefined ? { answerEveryone: Boolean(body.answerEveryone) } : {}),
            ...(body.answerBots !== undefined ? { answerBots: Boolean(body.answerBots) } : {}),
            ...(body.botAllowList !== undefined ? { botAllowList: cleanBotList(body.botAllowList) } : {}),
            ...(body.botTurnLimit !== undefined ? { botTurnLimit: botTurnLimitOf({ ...cur, botTurnLimit: Number(body.botTurnLimit) }) } : {}),
            ...(body.botHourlyCap !== undefined ? { botHourlyCap: botHourlyCapOf({ ...cur, botHourlyCap: Number(body.botHourlyCap) }) } : {}),
            ...(body.nsfwChannelIds !== undefined && !fromSaraApp(req) && adultModeOn(app.settings.get()) ? { nsfwChannelIds: cleanDiscordIds(body.nsfwChannelIds) } : {}),
            ...(body.unlink === true ? { ownerUserId: undefined } : {}),
          },
        });
        // H1: only a change to the bot's own settings reconnects it (autosave elsewhere must not drop the gateway).
        if (tokenChanged || JSON.stringify(app.settings.get().discord ?? null) !== before) await dc.restart();
        return send(res, 200, await view());
      }
      if (c === 'link' && method === 'POST') {
        const st = dc.status();
        if (!st.running) throw new HttpError(400, st.error ? `Discord isn't connected: ${st.error}` : 'Turn Discord on and save a bot token first.');
        return send(res, 200, { code: dc.newLinkCode(), bot: st.bot });
      }
    }

    if (a === 'bridges' && b === 'telegram') {
      const tg = app.bridges?.telegram;
      if (!tg) throw new HttpError(404, 'Telegram bridge is not available');
      const view = () => {
        const s = telegramSettings(app);
        return {
          ...tg.status(),
          enabled: s.enabled,
          allowOthers: s.allowOthers,
          mirror: s.mirror,
          linked: Boolean(s.ownerChatId),
          linkedId: s.ownerChatId ?? null,
          ownerUserIds: s.ownerUserIds ?? [],
          ownerWorkInGroups: s.ownerWorkInGroups === true,
          answerName: s.answerName === true,
          answerEveryone: s.answerEveryone === true,
          ...(fromSaraApp(req) || !adultModeOn(app.settings.get()) ? {} : { nsfwChatIds: s.nsfwChatIds ?? [] }),
          hasToken: Boolean(app.vault.get(TELEGRAM_VAULT)),
        };
      };
      if (!c && method === 'GET') return send(res, 200, await view());
      if (!c && method === 'PUT') {
        const body = await readJson(req);
        let tokenChanged = false;
        if (typeof body.token === 'string') {
          const t = body.token.trim();
          if (t && !/^\d{5,}:[\w-]{30,}$/.test(t)) throw new HttpError(400, 'That does not look like a bot token from @BotFather.');
          if (t !== (app.vault.get(TELEGRAM_VAULT) ?? '')) tokenChanged = true;
          t ? app.vault.set(TELEGRAM_VAULT, t) : app.vault.delete(TELEGRAM_VAULT);
        }
        const cur = telegramSettings(app);
        const before = JSON.stringify(app.settings.get().telegram ?? null);
        app.settings.update({
          telegram: {
            ...cur,
            ...(body.enabled !== undefined ? { enabled: Boolean(body.enabled) } : {}),
            ...(body.allowOthers !== undefined ? { allowOthers: Boolean(body.allowOthers) } : {}),
            ...(body.mirror !== undefined ? { mirror: Boolean(body.mirror) } : {}),
            ...(body.ownerUserIds !== undefined ? { ownerUserIds: cleanTelegramIds(body.ownerUserIds).filter((n) => n > 0) } : {}),
            ...(body.ownerWorkInGroups !== undefined ? { ownerWorkInGroups: Boolean(body.ownerWorkInGroups) } : {}),
            ...(body.answerName !== undefined ? { answerName: Boolean(body.answerName) } : {}),
            ...(body.answerEveryone !== undefined ? { answerEveryone: Boolean(body.answerEveryone) } : {}),
            ...(body.nsfwChatIds !== undefined && !fromSaraApp(req) && adultModeOn(app.settings.get()) ? { nsfwChatIds: cleanTelegramIds(body.nsfwChatIds).filter((n) => n < 0) } : {}),
            ...(body.unlink === true ? { ownerChatId: undefined } : {}),
          },
        });
        if (tokenChanged || JSON.stringify(app.settings.get().telegram ?? null) !== before) await tg.restart();
        return send(res, 200, await view());
      }
      if (c === 'link' && method === 'POST') {
        const st = tg.status();
        if (!st.running) throw new HttpError(400, st.error ? `Telegram isn't connected: ${st.error}` : 'Turn Telegram on and save a bot token first.');
        return send(res, 200, { code: tg.newLinkCode(), bot: st.bot });
      }
    }
    // Phase 14: Google (Gmail + Calendar) on the owner's own Google app.
    if (a === 'google') {
      const g = app.google;
      if (!g) throw new HttpError(404, 'Not available');
      const origin = typeof req.headers.origin === 'string' && req.headers.origin !== 'null' ? req.headers.origin : `${opts.trustProxy && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
      const redirect = `${origin}/api/google/callback`;
      if (!b && method === 'GET') return send(res, 200, { ...g.status(), redirect });
      if (!b && method === 'DELETE') {
        clearTodayCache();
        await g.disconnect();
        return send(res, 200, g.status());
      }
      if (b === 'client' && method === 'PUT') {
        const body = await readJson(req);
        try {
          g.setClient(String(body.clientId ?? ''), String(body.clientSecret ?? ''));
        } catch (err) {
          throw as400(err);
        }
        return send(res, 200, { ...g.status(), redirect });
      }
      if (b === 'client' && method === 'DELETE') {
        await g.disconnect();
        g.forgetClient();
        return send(res, 200, g.status());
      }
      // Gmail organizing: the result card's Undo button (exactly the emails that change touched).
      if (b === 'undo' && c && method === 'POST') {
        const gm = app.gmail;
        if (!gm) throw new HttpError(404, 'Not available');
        if (!gm.canOrganize()) throw new HttpError(409, RECONNECT_TEXT);
        const problem = gm.undoProblem(c);
        if (problem) throw new HttpError(409, problem);
        const r = gm.get(c)!;
        const verb = ACTION_WORDS[r.action]?.verb.toLowerCase() ?? r.action;
        try {
          const out = await gm.execute(`Gmail: undo "${verb}" on ${r.count.toLocaleString('en-US')} emails`, r.count, r.conversationId ?? undefined, undefined, (signal, progress) => gm.undo(c, { ...(signal ? { signal } : {}), progress }), { action: r.action });
          const done = /^\[gmail-result (\{.*\})\]$/m.exec(out.text);
          return send(res, 200, { ...(out.job ? { job: out.job } : {}), ...(done ? (JSON.parse(done[1]) as Record<string, unknown>) : {}) });
        } catch (err) {
          throw as400(err);
        }
      }
      if (b === 'connect' && method === 'POST') {
        try {
          return send(res, 200, { url: g.authUrl(redirect) });
        } catch (err) {
          throw as400(err);
        }
      }
    }
    // "Report this reply" (Phase 19).
    if (a === 'reports' && app.reports) {
      if (!b && method === 'GET') {
        // Demo visitors only see their own reports.
        const reports = opts.demo ? app.reports.list().filter((r) => r.conversationId !== null && demoOwner.get(r.conversationId) === visitorKey(req)) : app.reports.list();
        return send(res, 200, { reports, inbox: opts.reportInbox && !opts.demo ? app.reports.inbox() : null, reasons: REASON_LABELS });
      }
      if (!b && method === 'POST') {
        const body = await readJson(req);
        if (!validReason(body.reason)) throw new HttpError(400, 'Choose a reason.');
        const convId = String(body.conversationId ?? '');
        const cx = ctxOf(convId);
        if (opts.demo && demoOwner.get(convId) !== visitorKey(req)) throw new HttpError(404, 'Conversation not found');
        const msg = cx.store.messages(convId).find((m) => m.id === Number(body.messageId));
        if (!msg || msg.role !== 'assistant') throw new HttpError(404, 'That reply is gone.');
        const report = app.reports.add({ messageId: msg.id, conversationId: convId, text: app.redactor.redact(msg.content), reason: body.reason, note: typeof body.note === 'string' ? body.note : '', ...(typeof msg.meta?.model === 'string' ? { model: msg.meta.model } : {}) });
        if (cx === app) cx.store.updateMessageMeta(msg.id, { reported: body.reason });
        const to = opts.reportTo ?? DEFAULT_REPORT_INBOX;
        let sent = false;
        if (body.toDeveloper !== false && to !== 'off') sent = await app.reports.send(report.id, { platform: fromPhoneApp(req) ? (/iPhone|iPad/.test(String(req.headers['user-agent'])) ? 'ios' : 'android') : 'web', appVersion: opts.info?.version ?? 'dev' }, to);
        return send(res, 201, { ok: true, sent });
      }
    }
    // Phase 29: Home Assistant (address in settings, token in the vault).
    // Phase 72: smart-home presence (per companion): what she reacts to and how, the entity pickers, a test.
    if (a === 'home' && (b === 'presence' || b === 'entities')) {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const base = app.settings.get().home?.url;
      const token = app.vault.get(HOME_VAULT);
      if (b === 'entities' && !c && method === 'GET') {
        if (!base || !token) throw new HttpError(400, 'Connect Home Assistant first.');
        const want = String(new URL(req.url ?? '/', 'http://x').searchParams.get('domains') ?? '').split(',').map((x) => x.trim()).filter((x) => /^[a-z_]{1,40}$/.test(x)).slice(0, 8);
        const r = await netFetch(`${base}/api/states`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' }).catch((err: Error) => err);
        if (r instanceof Error || !r.ok) throw new HttpError(502, 'Couldn’t read the list from Home Assistant.');
        const all = (await r.json().catch(() => [])) as { entity_id?: string; state?: string; attributes?: { friendly_name?: unknown } }[];
        const list = (Array.isArray(all) ? all : []).filter((x) => typeof x.entity_id === 'string' && (!want.length || want.includes(x.entity_id.split('.')[0])));
        // 2.7.1: canSwitch = Today's Home tile may switch it itself (src/home-switch.ts); else Ask Sara.
        const switchable = (x: (typeof list)[number]) => {
          const plan = switchPlan(x as HaState);
          return plan.ok || plan.why === 'unreachable';
        };
        return send(res, 200, { entities: list.slice(0, 500).map((x) => ({ id: x.entity_id, name: typeof x.attributes?.friendly_name === 'string' ? x.attributes.friendly_name.slice(0, 80) : x.entity_id, state: String(x.state ?? '').slice(0, 40), canSwitch: switchable(x) })) });
      }
      // 2.7.1: Today's Home tile switches a light, switch, fan or blind itself (the owner pressing it;
      // no approval card). Locks, alarms, garage doors and the like are refused: those keep Ask Sara
      // (src/home-switch.ts). Members never get here (no 'home' in MEMBER_ROUTES); the demo is refused above.
      if (b === 'entities' && c && parts[3] === 'toggle' && !parts[4] && method === 'POST') {
        const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
        const id = safeDecode(c);
        if (!ENTITY_ID.test(id)) throw new HttpError(400, 'An entity id looks like light.kitchen.');
        if (!base || !token) throw new HttpError(400, 'Connect Home Assistant first.');
        const before = await haCall<HaState>(base, token, `/api/states/${id}`);
        if (before.status === 404) throw new HttpError(404, 'Home Assistant has no such device.');
        if (!before.data) throw new HttpError(502, 'Couldn’t reach Home Assistant.');
        const want = body.to === 'on' || body.to === 'off' ? body.to : undefined;
        const plan = switchPlan(before.data, want);
        if (!plan.ok) throw plan.why === 'unreachable' ? new HttpError(409, 'Home Assistant can’t reach it right now.') : new HttpError(403, 'Ask Sara for this one: it only changes after you say yes.', { askSara: true });
        const done = await haCall(base, token, `/api/services/${plan.domain}/${plan.service}`, { method: 'POST', body: { entity_id: id } });
        if (!done.status || done.status >= 400) throw new HttpError(502, 'Home Assistant didn’t make the change.');
        // Read it back, so the tile shows what really happened.
        const after = await haCall<HaState>(base, token, `/api/states/${id}`);
        const now = after.data ?? before.data;
        const name = typeof now.attributes?.friendly_name === 'string' ? now.attributes.friendly_name.slice(0, 80) : id;
        return send(res, 200, { id, name, state: String(now.state ?? '').slice(0, 40), was: String(before.data.state ?? '').slice(0, 40), asked: plan.to });
      }
      const view = () => ({ ...presenceSettings(app), connected: Boolean(base && token), log: app.presence?.log ?? [] });
      if (b === 'presence' && !c && method === 'GET') return send(res, 200, view());
      if (b === 'presence' && !c && method === 'PUT') {
        const body = await readJson(req);
        try {
          app.settings.update({ presence: cleanPresence(body, presenceSettings(app)) });
        } catch (err) {
          throw as400(err);
        }
        return send(res, 200, view());
      }
      if (b === 'presence' && c === 'test' && method === 'POST') {
        const body = await readJson(req);
        const kind = PRESENCE_KINDS.find((k) => k === body.kind) ?? 'arrive';
        if (!base || !token) throw new HttpError(400, 'Connect Home Assistant first.');
        if (!app.presence) throw new HttpError(400, 'Presence isn’t available here.');
        return send(res, 200, await app.presence.fire(kind, presenceSettings(app), true));
      }
      throw new HttpError(404, 'Not found');
    }
    if (a === 'home' && !b) {
      if (method === 'GET') {
        const base = app.settings.get().home?.url;
        const token = app.vault.get(HOME_VAULT);
        if (!base || !token) return send(res, 200, { url: base ?? '', hasToken: Boolean(token), ok: false });
        const r = await netFetch(`${base}/api/config`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000), redirect: 'error' }).catch((err: Error) => err);
        if (r instanceof Error) return send(res, 200, { url: base, hasToken: true, ok: false, error: `Couldn't reach it from this server (${r.message}).` });
        if (r.status === 401) return send(res, 200, { url: base, hasToken: true, ok: false, error: 'Home Assistant refused the token.' });
        const cfg = r.ok ? ((await r.json().catch(() => ({}))) as { location_name?: string; version?: string }) : {};
        return send(res, 200, { url: base, hasToken: true, ok: r.ok, name: cfg.location_name ?? null, version: cfg.version ?? null, ...(r.ok ? {} : { error: `Home Assistant said ${r.status}.` }) });
      }
      if (method === 'PUT') {
        const body = await readJson(req);
        if (body.url === '' || body.remove === true) {
          app.settings.update({ home: undefined });
          app.vault.delete(HOME_VAULT);
          return send(res, 200, { url: '', hasToken: false });
        }
        let url: string;
        try {
          url = cleanHomeUrl(String(body.url ?? ''));
        } catch (err) {
          throw as400(err);
        }
        const token = String(body.token ?? '').trim();
        if (token && !/^[\w.-]{20,1000}$/.test(token)) throw new HttpError(400, 'That does not look like a Home Assistant access token.');
        if (!token && !app.vault.get(HOME_VAULT)) throw new HttpError(400, 'Paste a long-lived access token too.');
        app.settings.update({ home: { url } });
        if (token) app.vault.set(HOME_VAULT, token);
        return send(res, 200, { url, hasToken: true });
      }
    }
    // Phase 57: Settings → Connections → Other apps: the switches, the allowed browser addresses and the keys.
    // The stdio bridge for MCP apps that start a program (Claude Desktop): one standalone file.
    // Phase 72: Settings → Other apps → Alexa: the skill id (owner), one-time link codes, linked Alexas.
    if (a === 'alexa') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const myCompanion = app.companionId ?? 'main';
      const ownerOnly = () => {
        if (opts.member) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
      };
      const view = () => {
        const cfg = app.settings.get().alexa ?? {};
        return {
          configured: Boolean(cfg.skillId),
          ...(opts.member ? {} : { skillId: cfg.skillId ?? '', quick: cfg.quick === true }),
          owner: !opts.member,
          privateLocal: privateLocalOn(),
          codeExpiresAt: alexa.links.pendingCode(spaceId, myCompanion) ?? null,
          links: alexa.links.list(spaceId).map((l) => ({ id: l.id, companion: opts.companions?.get(l.companion)?.app.persona.name ?? app.persona.name, mine: l.companion === myCompanion, linkedAt: l.linkedAt, lastUsedAt: l.lastUsedAt ?? null })),
        };
      };
      if (!b && method === 'GET') return send(res, 200, view());
      if (!b && method === 'PUT') {
        ownerOnly();
        const body = await readJson(req);
        const cur = app.settings.get().alexa ?? {};
        let skillId = cur.skillId;
        if (body.skillId !== undefined) {
          const v = String(body.skillId ?? '').trim();
          if (v && !/^amzn1\.ask\.skill\.[0-9a-f-]{36}$/i.test(v)) throw new HttpError(400, 'A skill id looks like amzn1.ask.skill.1234abcd-…: copy it from the Alexa developer console (Your skills → View Skill ID).');
          skillId = v || undefined;
        }
        app.settings.update({ alexa: { ...(skillId ? { skillId } : {}), quick: typeof body.quick === 'boolean' ? body.quick : cur.quick === true } });
        return send(res, 200, view());
      }
      if (b === 'code' && !c && method === 'POST') {
        await readJson(req);
        if (privateLocalOn()) throw new HttpError(403, 'Private local mode is on: Alexa needs Amazon, so it is paused.');
        if (!(app.settings.get().alexa ?? {}).skillId) throw new HttpError(400, 'Set up the Alexa skill first: the owner adds its skill id here.');
        try {
          return send(res, 200, alexa.links.makeCode(spaceId, myCompanion));
        } catch (err) {
          throw as400(err);
        }
      }
      if (b === 'links' && c && !parts[3] && method === 'DELETE') {
        if (!alexa.links.unlink(spaceId, c)) throw new HttpError(404, 'That Alexa is not linked.');
        return send(res, 200, view());
      }
      if (b === 'model' && !c && method === 'GET') {
        const name = String(new URL(req.url ?? '/', 'http://x').searchParams.get('invocation') ?? '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 50);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="sara-alexa-model.json"', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(JSON.stringify(alexaModel(name.split(' ').length >= 2 ? name : undefined), null, 2));
      }
      throw new HttpError(404, 'Not found');
    }
    if (a === 'other-apps' && b === 'bridge' && method === 'GET') {
      const f = join(webRoot, '..', 'src', 'mcp-bridge.ts');
      if (!existsSync(f)) throw new HttpError(404, 'The bridge file is not in this install.');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="sara-mcp.ts"', 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void createReadStream(f).pipe(res);
    }
    if (a === 'other-apps' && !b) {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      const view = () => ({ ...otherAppsSettings(app.settings.get()), keys: auth.devices().filter((d) => d.kind === 'api').map(({ id, label, createdAt, lastSeen }) => ({ id, label, createdAt, lastSeen })) });
      if (method === 'GET') return send(res, 200, view());
      if (method === 'PUT') {
        const body = await readJson(req);
        const cur = app.settings.get().otherApps ?? {};
        let origins = cur.origins ?? [];
        if (body.origins !== undefined) {
          try {
            origins = cleanOrigins(body.origins);
          } catch (err) {
            throw as400(err);
          }
        }
        app.settings.update({ otherApps: { tools: typeof body.tools === 'boolean' ? body.tools : cur.tools === true, changes: typeof body.changes === 'boolean' ? body.changes : cur.changes === true, origins } });
        return send(res, 200, view());
      }
    }
    return NEXT;
  };
}

/** Hardening M4: Home Assistant's own routes (see the doc comment inside). */
export function createHomeAssistantApi(ctx: RouteCtx): (req: IncomingMessage, res: ServerResponse, method: string, parts: string[], deviceId: string) => Promise<void> {
  const { active, app, auth, me, opts, prunePush, requireDisclosure, runBackground, streamChat } = ctx;
  /**
   * Hardening M4: what the Home Assistant integration's token may do (it asked for this scope when it
   * signed in). Only: who she is, accept the AI notice, list companions, and talk in the conversations
   * this token made itself (channel 'home-assistant', key `<device id>:…`): list them, make one, rename
   * one, read it, send a message, decline her approvals there. Nothing else: no other conversation, no
   * memories, files, settings or devices. Her turns run without her tools unless the owner lets other
   * apps use them (Settings → Connections → Other apps), and with the external-app memory rule (M3).
   */
  async function homeAssistantApi(req: IncomingMessage, res: ServerResponse, method: string, parts: string[], deviceId: string): Promise<void> {
    const [a, b, c] = parts;
    const prefix = `${deviceId}:`;
    const own = (id: string) => {
      const conv = app.store.getConversation(id);
      return conv && conv.channel === HA_CHANNEL && String(conv.channelKey ?? '').startsWith(prefix) ? conv : undefined;
    };
    const mine = () => app.store.listConversations().filter((x) => x.channel === HA_CHANNEL && String(x.channelKey ?? '').startsWith(prefix));
    const turnOpts = (): TurnOptions => ({ noTools: !otherAppsSettings(app.settings.get()).tools, externalApp: true });
    if (a === 'device' && b === 'whoami' && method === 'GET') {
      const d = auth.devices().find((x) => x.id === deviceId);
      return send(res, 200, { companion: app.persona.name, device: d ? { id: d.id, label: d.label, scope: 'home-assistant' } : null, disclosureAccepted: Boolean(app.settings.get().disclosureAcceptedAt), disclosure: disclosureText(app.persona.name, appLanguage(app.settings.get())) });
    }
    if (a === 'device' && b === 'logout' && method === 'POST') {
      auth.signOut(deviceId);
      prunePush();
      return send(res, 200, { ok: true });
    }
    if (a === 'disclosure' && b === 'accept' && method === 'POST') {
      app.settings.update({ disclosureAcceptedAt: app.now().toISOString() });
      return send(res, 200, { ok: true });
    }
    if (a === 'companions' && !b && method === 'GET' && opts.companions) {
      // Names only (no pictures or settings).
      return send(res, 200, { companions: opts.companions.view(app.companionId ?? 'main').map((x) => ({ id: x.id, name: x.name, main: x.main })) });
    }
    if (a === 'conversations' && !b && method === 'GET') return send(res, 200, mine().map((x) => ({ ...x, working: active.has(x.id) })));
    if (a === 'conversations' && !b && method === 'POST') {
      await readJson(req);
      if (mine().length >= 500) throw new HttpError(429, 'Home Assistant has made 500 conversations: delete some in Sara first.');
      return send(res, 201, app.store.createConversation({ title: 'Home Assistant', channel: HA_CHANNEL, channelKey: `${prefix}${randomBytes(6).toString('base64url')}` }));
    }
    if (a === 'conversations' && b) {
      const conv = own(b);
      if (!conv) throw new HttpError(404, 'Conversation not found');
      if (!c && method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, app.store.updateConversation(b, body.title !== undefined ? { title: String(body.title).slice(0, 120) } : {}));
      }
      if (c === 'messages' && !parts[3] && method === 'GET') {
        const sp = new URL(req.url ?? '/', 'http://x').searchParams;
        const page = app.store.messagesPage(b, { limit: Math.min(200, Math.max(1, Number(sp.get('limit')) || 50)) });
        return send(res, 200, { messages: page.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.createdAt })), earlier: page.earlier });
      }
      if (c === 'messages' && !parts[3] && method === 'POST') {
        requireDisclosure(req);
        const body = await readJson(req);
        const content = String(body.content ?? '').trim();
        if (!content) throw new HttpError(400, 'Message is empty');
        if (content.length > 100_000) throw new HttpError(413, 'Message too long');
        if (body.background === true) {
          if (active.has(b)) throw new HttpError(409, me('Sara is still working on this conversation. Wait for her or press Stop.'), { errorKey: 'Sara is still working on this conversation. Wait for her or press Stop.' });
          void runBackground(b, content, turnOpts());
          return send(res, 202, { ok: true });
        }
        return streamChat(req, res, b, content, turnOpts());
      }
    }
    // Declining what she asked for in its own conversations (approving is for the owner, in Sara).
    if (a === 'approvals' && b && method === 'POST') {
      const body = await readJson(req);
      if (body.approved !== false) throw new HttpError(403, 'Approve her actions in Sara itself.');
      if (!mine().some((x) => app.approvals.pendingFor(x.id).includes(b)) || !app.approvals.decide(b, false)) throw new HttpError(404, 'That request is no longer waiting.');
      return send(res, 200, { ok: true });
    }
    throw new HttpError(403, 'Home Assistant can only talk with her in its own conversations.');
  }
  return homeAssistantApi;
}
