// Phase 6: Discord bridge. Gateway WebSocket (Node's built-in client) for incoming messages, REST
// for replies. The owner links their account with a one-time code in a DM; owner DMs go to one
// owner conversation with everything (tool approvals as buttons). In servers she answers when
// called, as a partner conversation per channel: no tools, no memory, nothing private; adult
// content only in adult channels (Discord's age-restricted ones or those the owner lists).
// Phase 43: more owners by user ID; owners can work with her (tools) in servers when allowed; she
// can also answer to her name without the @ and to @everyone / @here.
// Phase 47: other bots (off by default, optionally only named ones). A bot is a partner like anyone
// (no tools, nothing private, the full safety layer), its lines are tagged "(bot)", and a loop guard
// per channel keeps two bots from talking forever: after botTurnLimit bot-triggered replies she
// waits for a person to write there, and botHourlyCap caps bot-triggered replies per hour.
import { accessInfo } from '../platform.ts';
import { copyOwnerTurnToRoom, roomConversation, roomNote } from './room.ts';
import { netFetch, openWebSocket, privateLocalOn } from '../net-guard.ts';
import { randomInt } from 'node:crypto';
import { appLanguage, en, tr } from '../i18n.ts';
import type { AppContext, ChatEvent } from '../chat.ts';
import type { HubEvent } from '../events.ts';
import { disclosureText } from '../safety.ts';
import { speechOf } from '../speech.ts';
import { paceLikeTyping } from './pace.ts';
import { identityOf } from '../persona.ts';
import type { Conversation } from '../store.ts';
import { takeChatDocument, type SharedDoc } from '../library/intake.ts';
import { MAX_DOC_BYTES } from '../library/store.ts';
import { closeProgress, deliverOutgoing, DISCORD_FILE_OUT, FIRST_4_LINE, MAX_PHOTO_IN_BYTES, MAX_PHOTOS_IN, openProgress, othersPhotosOn, Outgoing, PHOTO_SIZE_LINE, PHOTOS_OFF_LINE, photoQuotaHit, progressOn, progressSettings, QUOTA_LINE, takeIncoming, takeLeftoverProgress, type IncomingFile, type MediaPort } from './media.ts';
import { finalLine, ProgressMessage } from './progress.ts';
import { PRIO_FILE, PRIO_REPLY, RateLimited, realClock, SendQueue, type Clock } from './sendq.ts';
import type { TurnExtra } from './telegram.ts';
import { adultModeOn } from '../settings.ts';
import { readFileSync } from 'node:fs';
import { nameCalled } from './rules.ts';
import { askerLanguage, chatsSettings, commandAllowed, DESCRIPTIONS, DISCORD_LOCALES, DISCORD_NAMES, isCommandName, MENU_COMMANDS, menuHash, modelChoices, nearlyFullOffer, nextSession, OTHER_LANGS, ownerLanguage, parseCommand, runCommand, say, setSessionModel, type Asker, type BridgeAdapter, type CommandReply, type ModelPick, type ParsedCommand, type Place } from './commands.ts';
import { channelProjectId, discordRoomName, noteRoom, roomOf, roomStale } from './rooms.ts';
import { deleteLine, editLine, keepRoomByKey, leftRoom, logLine, maybeSummarize, noteHerLine, reading, setSeesAll, type KeepRoom, type Who } from './keepup.ts';
import { roomTurn } from './now.ts';

export interface DiscordSettings {
  enabled: boolean;
  ownerUserId?: string;
  /** Answer in servers when mentioned (as a labelled AI). */
  allowServers: boolean;
  /** Also send reminders and messages she starts herself to the owner's DMs. */
  mirror: boolean;
  /** Phase 43: more owners (Discord user IDs) besides the linked one. */
  ownerUserIds?: string[];
  /** Owners get her tools in server channels too (everyone else still gets the partner chat). */
  ownerWorkInServers?: boolean;
  /** Channels she treats as adult (with Adult mode on), besides Discord's age-restricted ones. */
  nsfwChannelIds?: string[];
  /** Answer when her name is said in a server, without the @. */
  answerName?: boolean;
  /** Answer @everyone and @here. */
  answerEveryone?: boolean;
  /** Phase 47: answer other bots (same triggers as people) in server channels. */
  answerBots?: boolean;
  /** Bot user IDs or names she may answer; empty = any bot (when answerBots is on). */
  botAllowList?: string[];
  /** Replies to bots in a channel before a person must write there (1..10). */
  botTurnLimit?: number;
  /** At most this many bot-triggered replies per channel in any 60 minutes. */
  botHourlyCap?: number;
}

export const DEFAULT_DISCORD: DiscordSettings = { enabled: false, allowServers: false, mirror: false, ownerUserIds: [], ownerWorkInServers: false, nsfwChannelIds: [], answerName: false, answerEveryone: false, answerBots: false, botAllowList: [], botTurnLimit: 2, botHourlyCap: 20 };

export const BOT_TURN_LIMIT_MAX = 10;
export const BOT_HOURLY_CAP_MAX = 120;
/** Said once when the loop guard stops her, until a person writes in that channel again. */
export const BOT_WAIT_LINE = "I'll wait for a person to jump in before I keep going.";
const HOUR_MS = 3600_000;

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
export const botTurnLimitOf = (cfg: DiscordSettings): number => clampInt(cfg.botTurnLimit, 1, BOT_TURN_LIMIT_MAX, 2);
export const botHourlyCapOf = (cfg: DiscordSettings): number => clampInt(cfg.botHourlyCap, 1, BOT_HOURLY_CAP_MAX, 20);

/** Bot IDs or names the owner typed (commas or new lines), trimmed and de-duplicated. */
export function cleanBotList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v.map(String) : String(v ?? '').split(/[,;\n]+/);
  const out: string[] = [];
  for (const raw of parts) {
    const t = raw.trim().replace(/^@/, '').slice(0, 64);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, 50);
}

/** The linked owner and any owner IDs saved with her. */
export function isDiscordOwner(cfg: DiscordSettings, userId: string | undefined): boolean {
  return Boolean(userId) && (userId === cfg.ownerUserId || (cfg.ownerUserIds ?? []).includes(userId!));
}
export const DISCORD_VAULT = 'bridge:discord';
const MAX_LEN = 1900;
// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT (privileged: enable it in the developer portal)
export const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

export function discordSettings(app: AppContext): DiscordSettings {
  return { ...DEFAULT_DISCORD, ...app.settings.get().discord };
}

export interface GatewaySocket {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

export type GatewayConnect = (url: string) => GatewaySocket;

const nodeConnect: GatewayConnect = (url) => {
  const ws = openWebSocket(url);
  const sock: GatewaySocket = {
    send: (d) => ws.send(d),
    close: () => ws.close(),
    onmessage: null,
    onclose: null,
  };
  ws.addEventListener('message', (e) => sock.onmessage?.(String(e.data)));
  ws.addEventListener('close', (e) => sock.onclose?.(e.code));
  return sock;
};

interface DUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
/** Phase 107: an INTERACTION_CREATE (2 = slash command, 3 = button or select, 4 = autocomplete). */
interface DInteraction {
  id: string;
  token: string;
  type?: number;
  application_id?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id: string };
  locale?: string;
  data?: { custom_id?: string; name?: string; values?: string[]; options?: { name: string; value?: unknown; focused?: boolean }[] };
  user?: DUser;
  member?: { user: DUser };
}
/** Discord's own status line on the menu (others see less than the owner; checked on every use). */
const DISCORD_STATUS = en('How full this chat is (the owner sees more)');
interface DMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DUser;
  content: string;
  mentions?: DUser[];
  mention_everyone?: boolean;
  /** Set when a webhook posted it (treated as a bot). */
  webhook_id?: string;
  attachments?: { id?: string; url: string; filename?: string; content_type?: string; size?: number; duration_secs?: number; description?: string }[];
  /** 8192 = voice message */
  flags?: number;
  /** Phase 110: when it was sent (ISO), and the message it replies to. */
  timestamp?: string;
  message_reference?: { message_id?: string } | null;
  referenced_message?: { id?: string; author?: DUser } | null;
}
const MAX_NOTE_BYTES = 20 * 1024 * 1024;

export function splitDiscord(text: string, max = MAX_LEN): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class DiscordBridge {
  readonly #app: AppContext;
  readonly #api: string;
  readonly #gateway: string;
  readonly #connect: GatewayConnect;
  #sock: GatewaySocket | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #seq: number | null = null;
  #me: DUser | undefined;
  #error: string | undefined;
  #stopped = true;
  #link: { code: string; expires: number; misses: number } | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #nsfw = new Map<string, boolean>();
  /** Phase 108 (B3): channel names and servers from GET /channels (refreshed at most daily) and server names. */
  readonly #chanInfo = new Map<string, { name?: string; guildId?: string }>();
  readonly #guildNames = new Map<string, { name?: string; at: number }>();
  readonly #dmChannel = new Map<string, string>();
  readonly #queues = new Map<string, Promise<void>>();
  /** Phase 47 loop guard per channel (in memory; kept across reconnects, reset on restart of Sara). */
  readonly #botGuard = new Map<string, { replies: number; told: boolean; times: number[] }>();
  /** Phase 107: the application id from READY (the command menu and interaction edits need it). */
  #appId: string | undefined;
  readonly #waiting = new Map<string, number>();
  readonly #cleared = new Map<string, number>();
  readonly #aborts = new Map<string, AbortController>();
  readonly #picks = new Map<string, ModelPick[]>();
  /** Phase 107: the command menu registration that is running (tests await it). */
  menus: Promise<unknown> = Promise.resolve();

  /** Phase 115 (BR1 B2): the send pacer (her reply first, then files, then progress edits; 429 and buckets). */
  readonly sendq: SendQueue;
  readonly #clock: Clock;

  constructor(app: AppContext, opts: { api?: string; gateway?: string; connect?: GatewayConnect; clock?: Clock } = {}) {
    this.#app = app;
    this.#api = opts.api ?? 'https://discord.com/api/v10';
    this.#gateway = opts.gateway ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
    this.#connect = opts.connect ?? nodeConnect;
    this.#clock = opts.clock ?? realClock;
    this.sendq = new SendQueue({ clock: this.#clock });
  }

  get #token(): string | undefined {
    return this.#app.vault.get(DISCORD_VAULT);
  }

  status(): { running: boolean; bot: string | null; linked: boolean; error: string | null; menu: { at: string | null; error: string | null } | null } {
    const m = this.#app.store.bridgeMenu('discord');
    return { running: Boolean(this.#me) && !this.#stopped, bot: this.#me?.username ?? null, linked: Boolean(discordSettings(this.#app).ownerUserId), error: this.#error ?? null, menu: m ? { at: m.at, error: m.error } : null };
  }

  /**
   * Phase 107 (CH1, §4.5): the global command list for one bulk overwrite: the 7 commands with
   * localised names and descriptions, in servers and her DMs (contexts 0, 1), shown to everyone
   * (default_member_permissions null: the server refuses, so he sees them where he isn't an admin).
   * Switched off: an empty list (removes them).
   */
  menuBody(): unknown[] {
    const app = this.#app;
    if (!chatsSettings(app).native) return [];
    const loc = (text: string) => Object.fromEntries(OTHER_LANGS.map((l) => [DISCORD_LOCALES[l], say(app, l, text).slice(0, 100)]));
    const opt = (name: string, description: string, type: number, more: Record<string, unknown> = {}) => ({ type, name, description: say(app, 'en', description), description_localizations: loc(description), ...more });
    const choice = (name: string, value: string) => ({ name: say(app, 'en', name), name_localizations: loc(name), value });
    return MENU_COMMANDS.map((n) => {
      const description = n === 'status' ? DISCORD_STATUS : DESCRIPTIONS[n];
      const options =
        n === 'new'
          ? [opt('for', en('Who gets the fresh start'), 3, { required: false, choices: [choice(en('me'), 'me'), choice(en('the whole room'), 'room')] })]
          : n === 'model'
            ? [opt('name', en('Model name (leave empty for the list)'), 3, { required: false, autocomplete: true })]
            : n === 'remember'
              ? [opt('text', en('What to remember'), 3, { required: true, max_length: 400 })]
              : [];
      return { type: 1, name: n, name_localizations: DISCORD_NAMES[n], description: say(app, 'en', description).slice(0, 100), description_localizations: loc(description), contexts: [0, 1], default_member_permissions: null, ...(options.length ? { options } : {}) };
    });
  }

  /** One bulk overwrite of the global commands, skipped when the list hasn't changed; `force` = "Register menus now". */
  async registerMenus(force = false): Promise<{ ok: boolean; skipped?: boolean; calls?: number; error?: string }> {
    const store = this.#app.store;
    if (!this.#appId) return { ok: false, error: en('Not connected to Discord yet.') };
    const body = this.menuBody();
    const hash = menuHash({ app: this.#appId, body });
    const prev = store.bridgeMenu('discord');
    if (!force && prev?.hash === hash && !prev.error) return { ok: true, skipped: true, calls: 0 };
    try {
      await this.#rest('PUT', `/applications/${this.#appId}/commands`, body);
      store.setBridgeMenu('discord', { hash, at: this.#app.now().toISOString(), error: null });
      return { ok: true, calls: 1 };
    } catch (err) {
      const error = (err as Error).message.slice(0, 300);
      store.setBridgeMenu('discord', { hash: null, at: prev?.at ?? null, error });
      return { ok: false, error };
    }
  }

  async #rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await netFetch(`${this.#api}${path}`, {
      method,
      headers: { authorization: `Bot ${this.#token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return this.#answer<T>(method, path, res);
  }

  /** Phase 115: a REST answer. A 429 becomes RateLimited (`retry_after`, seconds); an empty bucket pauses that channel. */
  async #answer<T>(method: string, path: string, res: Response): Promise<T> {
    const lane = /^\/channels\/(\d+)/.exec(path)?.[1];
    if (lane && res.headers.get('x-ratelimit-remaining') === '0') this.sendq.pause(`dc:${lane}`, Math.ceil(Number(res.headers.get('x-ratelimit-reset-after') ?? 1) * 1000));
    if (res.status === 204) return undefined as T;
    const j = (await res.json().catch(() => ({}))) as T & { message?: string; retry_after?: number };
    if (res.status === 429) throw new RateLimited(Math.ceil(Number(j.retry_after ?? res.headers.get('retry-after') ?? 1) * 1000), `Discord ${method}: too many requests`);
    if (!res.ok) throw new Error(`Discord ${method} ${path.split('/').slice(0, 3).join('/')}: ${j.message ?? res.status}`);
    return j;
  }

  /** Phase 115: a multipart message (files[n] + payload_json), like sendVoice. */
  async #multipart<T>(path: string, form: FormData): Promise<T> {
    const res = await netFetch(`${this.#api}${path}`, { method: 'POST', headers: { authorization: `Bot ${this.#token}` }, body: form, signal: AbortSignal.timeout(120_000) });
    return this.#answer<T>('POST', path, res);
  }

  async restart(): Promise<void> {
    this.stop();
    if (!discordSettings(this.#app).enabled || !this.#token) return;
    // Phase 67: Discord is on the internet: paused while nothing may leave this computer.
    if (privateLocalOn()) {
      this.#error = 'Paused in private local mode.';
      return;
    }
    try {
      this.#me = await this.#rest<DUser>('GET', '/users/@me');
      this.#error = undefined;
    } catch (err) {
      this.#error = (err as Error).message;
      return;
    }
    this.#stopped = false;
    this.#unsubscribe = this.#app.events?.subscribe((ev) => void this.#mirror(ev));
    this.#open();
  }

  /** Phase 115: the start-up pass over progress messages a restart left open (tests await it). */
  leftovers: Promise<void> = Promise.resolve();
  async #closeLeftovers(): Promise<void> {
    let rows: ReturnType<typeof takeLeftoverProgress> = [];
    try {
      rows = takeLeftoverProgress(this.#app, 'discord');
    } catch {
      return;
    }
    for (const r of rows) await this.#rest('PATCH', `/channels/${r.chatId}/messages/${r.messageId}`, { content: finalLine({ kind: 'restart' }, 0, 0, ownerLanguage(this.#app), true), components: [] }).catch(() => undefined);
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    this.#sock?.close();
    this.#sock = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  newLinkCode(): string {
    const code = String(randomInt(100000, 1000000));
    this.#link = { code, expires: Date.now() + 10 * 60_000, misses: 0 };
    return code;
  }

  #open(): void {
    const sock = this.#connect(this.#gateway);
    this.#sock = sock;
    sock.onmessage = (data) => void this.#onGateway(data).catch((err: Error) => console.warn(`discord: ${err.message}`));
    sock.onclose = (code) => {
      clearInterval(this.#heartbeat);
      if (this.#stopped) return;
      // 4004 = bad token, 4014 = privileged intent (Message Content) not enabled.
      if (code === 4004 || code === 4014) {
        this.#error = code === 4014 ? 'Turn on "Message Content Intent" for the bot in the Discord developer portal.' : 'The bot token was rejected.';
        this.#stopped = true;
        return;
      }
      setTimeout(() => !this.#stopped && this.#open(), 5000).unref();
    };
  }

  async #onGateway(data: string): Promise<void> {
    const p = JSON.parse(data) as { op: number; d: unknown; s: number | null; t: string | null };
    if (p.s !== null && p.s !== undefined) this.#seq = p.s;
    if (p.op === 10) {
      const interval = (p.d as { heartbeat_interval: number }).heartbeat_interval;
      clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#sock?.send(JSON.stringify({ op: 1, d: this.#seq })), interval);
      this.#heartbeat.unref();
      this.#sock?.send(JSON.stringify({ op: 2, d: { token: this.#token, intents: DISCORD_INTENTS, properties: { os: 'linux', browser: 'sara', device: 'sara' } } }));
    } else if (p.op === 1) this.#sock?.send(JSON.stringify({ op: 1, d: this.#seq }));
    else if (p.op === 7 || p.op === 9) this.#sock?.close();
    else if (p.op === 0 && p.t === 'READY') {
      const d = p.d as { user: DUser; application?: { id?: string } };
      this.#me = d.user;
      // Phase 107: keep the application id and set the / menu (skipped when unchanged).
      if (d.application?.id) this.#appId = d.application.id;
      this.menus = this.registerMenus().catch((err: Error) => console.warn(`discord menus: ${err.message}`));
      // Phase 115 (BR1 §4.8): progress messages a restart left open get their final line (once).
      this.leftovers = this.#closeLeftovers();
    } else if (p.op === 0 && p.t === 'MESSAGE_CREATE') await this.handleMessage(p.d as DMessage);
    // Phase 110 (CH4, §7.3): edits and deletes in a room she keeps up with (covered by GUILD_MESSAGES).
    else if (p.op === 0 && p.t === 'MESSAGE_UPDATE') this.handleUpdate(p.d as Partial<DMessage> & { id: string; channel_id: string });
    else if (p.op === 0 && p.t === 'MESSAGE_DELETE') this.handleDelete(p.d as { id: string; channel_id: string });
    else if (p.op === 0 && p.t === 'GUILD_DELETE') this.#leftGuild((p.d as { id: string; unavailable?: boolean }));
    else if (p.op === 0 && p.t === 'INTERACTION_CREATE') await this.#onInteraction(p.d as DInteraction);
  }

  /** Phase 107: interactions by type first: commands, autocomplete, then buttons and selects. */
  async #onInteraction(i: DInteraction): Promise<void> {
    if (i.type === 2) return this.#onCommand(i);
    if (i.type === 4) return this.#onAutocomplete(i);
    if (i.data?.custom_id?.startsWith('md:')) return this.#onModelPick(i);
    const who = i.user ?? i.member?.user;
    // Phase 115 (BR1): the progress message's Stop (the same as /stop; owner only, checked here).
    const st = i.data?.custom_id?.match(/^st:([\w-]+)$/);
    if (st) {
      const owner = Boolean(who && isDiscordOwner(discordSettings(this.#app), who.id));
      const content = !owner ? say(this.#app, askerLanguage(i.locale), en('Only the person who runs me can stop this.')) : this.#tr(this.#stopTurn(st[1]) ? en('Stopping.') : en('Nothing to stop.'));
      return void (await this.#rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content, flags: 64 } }));
    }
    const m = i.data?.custom_id?.match(/^ap:([\w-]+):([01])$/);
    let reply = 'Only the owner can answer that.';
    if (m && who && isDiscordOwner(discordSettings(this.#app), who.id)) reply = this.#app.approvals.decide(m[1], m[2] === '1') ? this.#tr(m[2] === '1' ? en('Allowed.') : en('Denied.')) : this.#tr('That request is no longer waiting.');
    // Type 4 = reply with a message (ephemeral flag 64).
    await this.#rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content: reply, flags: 64 } });
  }

  /** Phase 107: where a command was used and by whom (the server decides; menus are only a display). */
  #placeOf(userId: string, guildId: string | undefined): { place: Place; fromOwner: boolean; ownerWork: boolean; reachable: boolean } {
    const cfg = discordSettings(this.#app);
    const fromOwner = isDiscordOwner(cfg, userId);
    const isDm = !guildId;
    const ownerWork = !isDm && fromOwner && cfg.ownerWorkInServers === true;
    const place: Place = isDm ? (fromOwner ? 'owner-dm' : 'partner-dm') : ownerWork ? 'work-room' : 'room';
    // DMs from others are ignored (as before); servers only when she answers there.
    return { place, fromOwner, ownerWork, reachable: isDm ? fromOwner : cfg.allowServers || ownerWork };
  }

  #adapter(channelId: string, place: Place, nsfw: boolean): BridgeAdapter {
    const app = this.#app;
    const ownerSide = place === 'owner-dm' || place === 'work-room';
    const channel = place === 'work-room' ? (nsfw ? 'discord-work-nsfw' : 'discord-work') : nsfw ? 'discord-nsfw' : 'discord';
    return {
      currentSession: () => app.store.currentChannelConversation(channel, channelId, ownerSide ? 'owner' : 'partner'),
      startSession: (prev) => (prev ? nextSession(app, prev) : this.#newConversation(channel, channelId, place === 'owner-dm', place === 'work-room')),
      ...(place === 'work-room' ? { roomSession: () => roomConversation(app, 'discord', channelId) } : {}),
      stopTurn: (id) => this.#stopTurn(id),
      clearQueue: (id) => this.#clearQueue(id),
      resetGuard: () => void this.#botGuard.delete(channelId),
      progressKey: { bridge: 'discord', key: channelId },
      // Phase 113: /bug and /idea link to the report sheet when the server knows its address.
      ...(accessInfo().url ? { appLink: accessInfo().url! } : {}),
    };
  }

  /** Phase 107: a slash command. Answered inside Discord's 3 seconds: at once, or "thinking…" first and the edit after. */
  async #onCommand(i: DInteraction): Promise<void> {
    const app = this.#app;
    const who = i.member?.user ?? i.user;
    const channelId = i.channel_id ?? i.channel?.id ?? '';
    const name = String(i.data?.name ?? '');
    const callback = (body: unknown) => this.#rest('POST', `/interactions/${i.id}/${i.token}/callback`, body);
    if (!who || !channelId || !isCommandName(name)) return void (await callback({ type: 4, data: { content: say(app, askerLanguage(i.locale), en('I don\'t know that command.')), flags: 64 } }));
    const at = this.#placeOf(who.id, i.guild_id);
    const lang = at.fromOwner ? ownerLanguage(app) : askerLanguage(i.locale);
    const asker: Asker = who.bot ? 'bot' : at.fromOwner ? 'owner' : 'person';
    const opt = (n: string) => String(i.data?.options?.find((o) => o.name === n)?.value ?? '');
    const cmd: ParsedCommand = { name, args: name === 'new' ? (opt('for') === 'room' ? 'room' : '') : name === 'model' ? opt('name') : name === 'remember' ? opt('text') : '', form: 'native' };
    if (!at.reachable || !commandAllowed(at.place, asker, name)) {
      const r = at.reachable ? await runCommand({ app, bridge: 'discord', place: at.place, who: asker, lang, cmd, adapter: this.#adapter(channelId, at.place, false) }) : { text: say(app, lang, en('Only the person who runs me can use that here.')) };
      return void (await callback({ type: 4, data: { content: r.text || '…', flags: 64, allowed_mentions: { parse: [] } } }));
    }
    // Private results (status, model, remember, help) only for the person who asked.
    const ephemeral = name === 'status' || name === 'model' || name === 'remember' || name === 'help' || name === 'settings';
    const deferred = name === 'status' || name === 'model' || name === 'new' || name === 'remember';
    if (deferred) await callback({ type: 5, data: { flags: ephemeral ? 64 : 0 } });
    let r: CommandReply;
    try {
      const nsfw = Boolean(i.guild_id) && (await this.#isNsfw(channelId));
      r = await runCommand({ app, bridge: 'discord', place: at.place, who: asker, lang, cmd, adapter: this.#adapter(channelId, at.place, nsfw) });
    } catch (err) {
      r = { text: say(app, lang, en('(Something went wrong: {error})'), { error: (err as Error).message }) };
    }
    const data: Record<string, unknown> = { content: r.text || say(app, lang, en('Nothing to stop.')), allowed_mentions: { parse: [] }, ...this.#components(r, lang) };
    if (r.approval) void r.approval.done.then((t) => this.#rest('POST', `/webhooks/${this.#appId ?? i.application_id}/${i.token}`, { content: t, flags: 64 })).catch(() => undefined);
    if (deferred) await this.#rest('PATCH', `/webhooks/${this.#appId ?? i.application_id}/${i.token}/messages/@original`, data);
    else await callback({ type: 4, data: { ...data, ...(ephemeral || r.ownerOnly || r.refused ? { flags: 64 } : {}) } });
  }

  /** Phase 107: the select for /model picks, or Allow / Deny for a /remember that asks first. */
  #components(r: CommandReply, lang: string): Record<string, unknown> {
    if (r.choices?.length && r.conversationId) {
      this.#picks.set(r.conversationId, r.choices);
      return { components: [{ type: 1, components: [{ type: 3, custom_id: `md:${r.conversationId}`, placeholder: say(this.#app, lang, en('Pick a model')), options: r.choices.slice(0, 25).map((m, n) => ({ label: m.model.slice(0, 100), description: m.provider.slice(0, 100), value: String(n) })) }] }] };
    }
    if (r.approval) return { components: [{ type: 1, components: [{ type: 2, style: 3, label: say(this.#app, lang, en('Allow')), custom_id: `ap:${r.approval.id}:1` }, { type: 2, style: 4, label: say(this.#app, lang, en('Deny')), custom_id: `ap:${r.approval.id}:0` }] }] };
    return {};
  }

  /** Phase 107: /model name suggestions (the owner only; others get none). */
  async #onAutocomplete(i: DInteraction): Promise<void> {
    const who = i.member?.user ?? i.user;
    const typed = String(i.data?.options?.find((o) => o.focused)?.value ?? '').toLowerCase();
    const list = who && isDiscordOwner(discordSettings(this.#app), who.id) ? (await modelChoices(this.#app)).filter((m) => m.model.toLowerCase().includes(typed)).slice(0, 25) : [];
    await this.#rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 8, data: { choices: list.map((m) => ({ name: `${m.model} · ${m.provider}`.slice(0, 100), value: m.model.slice(0, 100) })) } });
  }

  /** Phase 107: a /model pick from the select (owner only, checked again). */
  async #onModelPick(i: DInteraction): Promise<void> {
    const app = this.#app;
    const who = i.member?.user ?? i.user;
    const convId = i.data!.custom_id!.slice(3);
    const callback = (body: unknown) => this.#rest('POST', `/interactions/${i.id}/${i.token}/callback`, body);
    if (!who || !isDiscordOwner(discordSettings(app), who.id)) return void (await callback({ type: 4, data: { content: say(app, askerLanguage(i.locale), en('Only the person who runs me can change that.')), flags: 64 } }));
    const lang = ownerLanguage(app);
    const conv = app.store.getConversation(convId);
    const pick = this.#picks.get(convId)?.[Number(i.data?.values?.[0])];
    if (!conv || !pick) return void (await callback({ type: 4, data: { content: say(app, lang, en('That list is out of date. Send /model again.')), flags: 64 } }));
    // Type 7 = update the message the select was on.
    await callback({ type: 7, data: { content: setSessionModel(app, conv, pick, lang), components: [] } });
  }

  /** Phase 107: a typed command (/new, !new, "Sara new") in a message that reached her. */
  async #typedCommand(msg: DMessage, cmd: ParsedCommand, place: Place, fromOwner: boolean, nsfw: boolean): Promise<void> {
    const app = this.#app;
    const lang = fromOwner ? ownerLanguage(app) : 'en';
    const r = await runCommand({ app, bridge: 'discord', place, who: fromOwner ? 'owner' : 'person', lang, cmd, adapter: this.#adapter(msg.channel_id, place, nsfw) });
    if (!r.text && !r.choices?.length) return;
    const extra = this.#components(r, lang);
    const room = place === 'room' || place === 'work-room';
    if (r.ownerOnly && room && !r.refused) {
      // Owner-only details from a server channel go to his DMs; the channel only hears that.
      const dm = await this.#rest<{ id: string }>('POST', '/users/@me/channels', { recipient_id: msg.author.id }).catch(() => undefined);
      if (dm?.id) {
        await this.send(dm.id, r.text, extra);
        if (r.approval) void r.approval.done.then((t) => this.send(dm.id, t)).catch(() => undefined);
        return void (await this.send(msg.channel_id, say(app, lang, en('I sent you the details in a direct message.'))));
      }
      return void (await this.send(msg.channel_id, say(app, lang, en('Send me a private message first, then try again.'))));
    }
    await this.send(msg.channel_id, r.text, extra);
    if (r.approval) void r.approval.done.then((t) => this.send(msg.channel_id, t)).catch(() => undefined);
  }

  #stopTurn(conversationId: string): boolean {
    if (this.#app.stopTurn?.(conversationId)) return true;
    const a = this.#aborts.get(conversationId);
    if (!a || a.signal.aborted) return false;
    a.abort(new Error('stopped'));
    return true;
  }

  #clearQueue(conversationId: string): number {
    const n = this.#waiting.get(conversationId) ?? 0;
    this.#cleared.set(conversationId, (this.#cleared.get(conversationId) ?? 0) + 1);
    this.#waiting.set(conversationId, 0);
    return n;
  }

  /** Phase 61: her app lines to the owner in the owner's app language (partners get the English ones). */
  #tr(text: string, params?: Record<string, unknown>): string {
    return tr(text, appLanguage(this.#app.settings.get()), params, identityOf(this.#app.persona));
  }

  async send(channelId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    for (const part of splitDiscord(text)) {
      // Phase 115 (B2): through the pacer, ahead of files and progress edits; a 429 waits and retries.
      const m = await this.sendq.send(`dc:${channelId}`, PRIO_REPLY, () => this.#rest<{ id?: string } | undefined>('POST', `/channels/${channelId}/messages`, { content: part, allowed_mentions: { parse: [] }, ...extra }));
      // Phase 110: her own lines in a room she keeps up with are logged too (with Discord's id).
      this.#herLine(channelId, m?.id, part);
    }
  }

  // ------------------------------------------------------------------ Phase 110 (CH4): keeping up

  #keeping(channelId: string): KeepRoom | undefined {
    try {
      const r = keepRoomByKey(this.#app, 'discord', channelId);
      return reading(r) ? r : undefined;
    } catch {
      return undefined;
    }
  }

  #herLine(channelId: string, id: string | undefined, text: string): void {
    const room = this.#keeping(channelId);
    if (!room || !this.#me) return;
    const line = logLine(this.#app, room, { platformId: id ?? null, authorId: this.#me.id, author: this.#app.persona.name, who: 'her', text });
    if (line) noteHerLine(this.#app, room, line.id);
  }

  /** A message's text as the log keeps it: mentions by name, attachments as [photo] [file: x.pdf] [voice message]. */
  #logText(msg: Partial<DMessage>): string {
    let t = String(msg.content ?? '');
    for (const u of msg.mentions ?? []) t = t.replace(new RegExp(`<@!?${u.id}>`, 'g'), `@${u.id === this.#me?.id ? this.#app.persona.name : u.global_name || u.username}`);
    const marks = (msg.attachments ?? []).map((a) => {
      const ct = a.content_type ?? '';
      if ((msg.flags ?? 0) & 8192 || ct.startsWith('audio/')) return '[voice message]';
      if (ct.startsWith('image/')) return '[photo]';
      if (ct.startsWith('video/')) return '[video]';
      return `[file: ${(a.filename ?? 'file').slice(0, 80)}]`;
    });
    return [t.trim(), ...marks].filter(Boolean).join(' ');
  }

  /**
   * §7.3 capture: runs first in handleMessage, before the bot guard and the called check, only for
   * rooms with keep-up on. It stores the line and nothing else (no turn, tool, hook or plugin event).
   */
  #passive(msg: DMessage): void {
    if (!msg.guild_id) return;
    const room = this.#keeping(msg.channel_id);
    if (!room) return;
    const isBot = Boolean(msg.author.bot || msg.webhook_id);
    const who: Who = isBot ? 'bot' : isDiscordOwner(discordSettings(this.#app), msg.author.id) ? 'owner' : 'person';
    const text = this.#logText(msg);
    if (!text) return;
    const at = msg.timestamp && !Number.isNaN(Date.parse(msg.timestamp)) ? new Date(Math.min(Date.parse(msg.timestamp), this.#app.now().getTime())).toISOString() : undefined;
    logLine(this.#app, room, { platformId: msg.id, authorId: msg.author.id, author: msg.author.global_name || msg.author.username, who, text, replyTo: msg.message_reference?.message_id ?? msg.referenced_message?.id ?? null, ...(at ? { at } : {}) });
    void maybeSummarize(this.#app, room);
  }

  /** MESSAGE_UPDATE (public for tests): the logged line takes the new text. */
  handleUpdate(d: Partial<DMessage> & { id: string; channel_id: string }): void {
    const room = this.#keeping(d.channel_id);
    if (!room || d.content === undefined) return;
    editLine(this.#app, room, d.id, this.#logText(d));
  }

  /** MESSAGE_DELETE (public for tests): a deleted message is removed from the log. */
  handleDelete(d: { id: string; channel_id: string }): void {
    const room = this.#keeping(d.channel_id);
    if (room) deleteLine(this.#app, room, d.id);
  }

  /** GUILD_DELETE without `unavailable`: she was removed from the server; keep-up stops in its channels. */
  #leftGuild(d: { id: string; unavailable?: boolean }): void {
    if (d.unavailable) return;
    for (const [ch, info] of this.#chanInfo) {
      if (info.guildId !== d.id) continue;
      const r = keepRoomByKey(this.#app, 'discord', ch);
      if (r) leftRoom(this.#app, r.id);
    }
  }

  /**
   * §7.2 the platform check: Sara already requires MESSAGE_CONTENT (4014 otherwise), so she sees
   * every message once connected; *Read Message History* is checked with one tiny read (the
   * opt-in backfill needs it).
   */
  async checkRoom(channelId: string): Promise<{ seesAll: string; history: boolean; reason?: string }> {
    const r = keepRoomByKey(this.#app, 'discord', channelId);
    if (!this.#me || this.#stopped) return { seesAll: r?.seesAll ?? 'no:not connected', history: false, reason: 'not connected' };
    let history = true;
    let reason: string | undefined;
    try {
      await this.#rest('GET', `/channels/${channelId}/messages?limit=1`);
    } catch (err) {
      history = false;
      reason = /Missing Access|Missing Permissions|403|50001|50013/i.test((err as Error).message) ? 'Read Message History is off for her in this channel' : (err as Error).message.slice(0, 160);
    }
    if (r) setSeesAll(this.#app, r.id, 'yes');
    return { seesAll: 'yes', history, ...(reason ? { reason } : {}) };
  }

  /** §7.3 start of the log: at opt-in, up to the last 100 messages from the past day (needs Read Message History). */
  async backfill(channelId: string): Promise<{ read: number; skipped?: string }> {
    const room = this.#keeping(channelId);
    if (!room) return { read: 0, skipped: 'keep-up is off' };
    let list: DMessage[];
    try {
      list = await this.#rest<DMessage[]>('GET', `/channels/${channelId}/messages?limit=100`);
    } catch (err) {
      return { read: 0, skipped: /Missing Access|Missing Permissions|403|50001|50013/i.test((err as Error).message) ? 'Read Message History is off for her in this channel' : (err as Error).message.slice(0, 160) };
    }
    const since = this.#app.now().getTime() - 24 * 3600_000;
    const day = (Array.isArray(list) ? list : []).filter((m) => m && m.id && m.author && Date.parse(m.timestamp ?? '') >= since).slice(0, 100).reverse();
    let read = 0;
    for (const m of day) {
      const who: Who = m.author.id === this.#me?.id ? 'her' : m.author.bot || m.webhook_id ? 'bot' : isDiscordOwner(discordSettings(this.#app), m.author.id) ? 'owner' : 'person';
      const text = this.#logText(m);
      if (!text) continue;
      const line = logLine(this.#app, room, { platformId: m.id, authorId: m.author.id, author: who === 'her' ? this.#app.persona.name : m.author.global_name || m.author.username, who, text, replyTo: m.message_reference?.message_id ?? null, at: new Date(Date.parse(m.timestamp!)).toISOString() });
      if (!line) continue;
      read++;
      // Her own lines from the last day are her "last line" (the topic then is what the room said up to it).
      if (who === 'her') noteHerLine(this.#app, room, line.id);
    }
    if (read) void maybeSummarize(this.#app, room);
    return { read };
  }

  async #isNsfw(channelId: string): Promise<boolean> {
    if ((discordSettings(this.#app).nsfwChannelIds ?? []).includes(channelId)) return true;
    if (!this.#nsfw.has(channelId)) {
      const ch = await this.#rest<{ nsfw?: boolean; name?: string; guild_id?: string }>('GET', `/channels/${channelId}`).catch(() => ({ nsfw: false }) as { nsfw?: boolean; name?: string; guild_id?: string });
      this.#nsfw.set(channelId, Boolean(ch.nsfw));
      this.#chanInfo.set(channelId, { ...(typeof ch.name === 'string' ? { name: ch.name } : {}), ...(typeof ch.guild_id === 'string' ? { guildId: ch.guild_id } : {}) });
    }
    return this.#nsfw.get(channelId)!;
  }

  /**
   * Phase 108 (B3): the room's real name ("#general · My Server", or the person in a DM) for the
   * app's row chips and session titles. The server's name is asked once a day at most; a failure
   * keeps the old name (or none), never the message.
   */
  async #noteRoom(msg: DMessage, nsfw: boolean): Promise<void> {
    const app = this.#app;
    if (!msg.guild_id) {
      noteRoom(app, { bridge: 'discord', key: msg.channel_id, kind: 'dm', title: msg.author.global_name || msg.author.username || 'DM' });
      return;
    }
    const cur = roomOf(app, 'discord', msg.channel_id);
    if (!roomStale(cur, app.now())) return;
    // New, or a day old: ask Discord (the nsfw flag comes along).
    let info = cur ? undefined : this.#chanInfo.get(msg.channel_id);
    if (!info?.name) {
      const ch = await this.#rest<{ nsfw?: boolean; name?: string; guild_id?: string }>('GET', `/channels/${msg.channel_id}`).catch(() => ({}) as { nsfw?: boolean; name?: string; guild_id?: string });
      info = { ...(typeof ch.name === 'string' ? { name: ch.name } : {}), ...(typeof ch.guild_id === 'string' ? { guildId: ch.guild_id } : {}) };
      this.#chanInfo.set(msg.channel_id, info);
      if (typeof ch.nsfw === 'boolean') this.#nsfw.set(msg.channel_id, ch.nsfw);
    }
    if (!info.name) return;
    const gid = info.guildId ?? msg.guild_id;
    let g = this.#guildNames.get(gid);
    if (!g || Date.now() - g.at > 24 * 3600_000) {
      const r = await this.#rest<{ name?: string }>('GET', `/guilds/${gid}`).catch(() => ({}) as { name?: string });
      g = { ...(typeof r.name === 'string' ? { name: r.name } : g?.name ? { name: g.name } : {}), at: Date.now() };
      this.#guildNames.set(gid, g);
    }
    const room = noteRoom(app, { bridge: 'discord', key: msg.channel_id, kind: 'room', title: info.name, parentTitle: g.name ?? null, adult: nsfw });
    // Sessions still called by the placeholder ("Discord channel 1234") get the real name; his own titles stay.
    const name = discordRoomName(room);
    const tail = msg.channel_id.slice(-4);
    if (name) for (const c of app.store.sessionsByKey(msg.channel_id, ['discord', 'discord-nsfw', 'discord-work', 'discord-work-nsfw'])) {
      if (c.title === `Discord channel ${tail}`) app.store.renameQuietly(c.id, `Discord: ${name}`);
      else if (c.title === `Discord work: channel ${tail}`) app.store.renameQuietly(c.id, `Discord work: ${name}`);
    }
  }

  /** Handles one MESSAGE_CREATE (public for tests). */
  async handleMessage(msg: DMessage): Promise<void> {
    if (msg.author.id === this.#me?.id) return; // her own messages (and her own webhooks; send() logs them)
    // Phase 110 (CH4): in a room she keeps up with, every line is logged first (before the bot guard and the called check).
    this.#passive(msg);
    const cfg = discordSettings(this.#app);
    const isDm = !msg.guild_id;
    const isBot = Boolean(msg.author.bot || msg.webhook_id);
    if (isBot) {
      if (!this.#botMayCall(msg, cfg)) return;
    } else if (!isDm) this.#personSpoke(msg.channel_id);
    const text = msg.content.trim();
    const link = text.match(/^[/!]link\s+(\d{6})$/);
    if (isDm && link) {
      if (this.#link && this.#link.code === link[1] && Date.now() < this.#link.expires) {
        this.#link = undefined;
        this.#app.settings.update({ discord: { ...cfg, ownerUserId: msg.author.id } });
        this.#dmChannel.set(msg.author.id, msg.channel_id);
        await this.send(msg.channel_id, `${this.#tr("Linked. It's me, {name}.", { name: this.#app.persona.name })} (${disclosureText(this.#app.persona.name, appLanguage(this.#app.settings.get()))})`);
      } else {
        // Five wrong tries and the code is gone (no guessing it in the 10 minutes it lasts).
        if (this.#link && ++this.#link.misses >= 5) this.#link = undefined;
        await this.send(msg.channel_id, this.#tr('That code is wrong or expired. Get a new one in Settings → Discord.'));
      }
      return;
    }
    const fromOwner = !isBot && isDiscordOwner(cfg, msg.author.id);
    const isOwnerDm = isDm && fromOwner;
    if (isOwnerDm) this.#dmChannel.set(msg.author.id, msg.channel_id);
    // Phase 43: an owner working with her in a server channel (tools, her memory).
    const ownerWork = !isDm && fromOwner && cfg.ownerWorkInServers === true;
    // Phase 107: a typed command reaches her in a DM, with an @mention, or as "Sara new" (the name
    // form names her). Bots run no commands. It runs before the queue, so /stop works mid-reply.
    if (!isBot && text && (isOwnerDm || (!isDm && (cfg.allowServers || ownerWork)))) {
      const me = this.#me?.id ? new RegExp(`^<@!?${this.#me.id}>[\\s,:]*`) : undefined;
      const bare = me ? text.replace(me, '') : text;
      const mentioned = bare !== text;
      const cmd = parseCommand(bare, { herName: this.#app.persona.name, namePrefix: chatsSettings(this.#app).namePrefix, addressed: mentioned });
      if (cmd && (isDm || mentioned || cmd.form === 'name')) {
        const place: Place = isOwnerDm ? 'owner-dm' : ownerWork ? 'work-room' : 'room';
        return this.#typedCommand(msg, cmd, place, fromOwner, !isDm && (await this.#isNsfw(msg.channel_id)));
      }
    }
    if (!isOwnerDm) {
      if (isDm) return; // DMs from others: ignored (servers only, when allowed)
      if (isBot) {
        /* already checked in #botMayCall (servers on, or a channel an owner works in) */
      } else if (!cfg.allowServers && !ownerWork) return;
      else if (!this.#called(msg, cfg)) return;
    }
    // Phase 11: voice messages (and audio clips) are transcribed.
    let heard = '';
    const note = msg.attachments?.find((a) => (a.content_type ?? '').startsWith('audio/'));
    if (!text && note && !isBot) {
      try {
        if ((note.size ?? 0) > MAX_NOTE_BYTES) throw new Error('that voice message is too long for me.');
        heard = await speechOf(this.#app).hearNote(note.url, {}, MAX_NOTE_BYTES);
      } catch (err) {
        await this.send(msg.channel_id, isOwnerDm ? this.#tr("I couldn't listen to that: {error}", { error: (err as Error).message }) : "Sorry, I can't listen to voice messages right now.");
        return;
      }
      if (!heard) return void (await this.send(msg.channel_id, isOwnerDm ? this.#tr("I couldn't make out any words in that one. Try again?") : "I couldn't make out any words in that one. Try again?"));
    }
    const isOwner = isOwnerDm || ownerWork;
    // Phase 115 (BR1 §4.2): pictures are seen like a photo from the app (2.47 filtered them out and
    // ignored a message with only a picture). Bots' pictures are never looked at.
    const pictures = isBot ? [] : (msg.attachments ?? []).filter((a) => /^image\/(jpeg|png|webp|gif)$/i.test(a.content_type ?? ''));
    // Phase 44: documents from an owner go to her library (or are read once, if the message says so).
    const docs: SharedDoc[] = [];
    const files = (msg.attachments ?? []).filter((a) => !(a.content_type ?? '').startsWith('audio/') && !(a.content_type ?? '').startsWith('image/') && !(a.content_type ?? '').startsWith('video/'));
    if (!text && !heard && !(files.length && isOwner) && !pictures.length) return;
    const nsfw = !isDm && (await this.#isNsfw(msg.channel_id));
    await this.#noteRoom(msg, nsfw).catch((err: Error) => console.warn(`discord room name: ${err.message}`));
    const conv = this.#conversation(msg, isOwnerDm, nsfw, ownerWork);
    const place: Place = isOwnerDm ? 'owner-dm' : ownerWork ? 'work-room' : 'room';
    let extra: TurnExtra = {};
    let pictureText = '';
    if (pictures.length) {
      const lang = isOwner ? ownerLanguage(this.#app) : 'en';
      const line = (t: string) => this.send(msg.channel_id, say(this.#app, lang, t));
      const who = isOwner ? 'owner' : 'person';
      if (!isOwner && !othersPhotosOn(this.#app, 'discord', msg.channel_id)) await line(PHOTOS_OFF_LINE);
      else if (photoQuotaHit(this.#app, 'discord', msg.channel_id, who, place)) await line(QUOTA_LINE);
      else {
        const fit = pictures.filter((a) => (a.size ?? 0) <= MAX_PHOTO_IN_BYTES);
        if (fit.length < pictures.length) await line(PHOTO_SIZE_LINE);
        const got: IncomingFile[] = [];
        // Signed CDN links expire: downloaded at once.
        for (const a of fit.slice(0, MAX_PHOTOS_IN)) {
          try {
            const res = await netFetch(a.url, { signal: AbortSignal.timeout(120_000) });
            if (!res.ok) throw new Error(`download failed (${res.status})`);
            got.push({ bytes: Buffer.from(await res.arrayBuffer()), ...(a.filename ? { name: a.filename } : {}), ...(a.content_type ? { mime: a.content_type } : {}), ...(a.description ? { alt: a.description } : {}), ...(a.id ? { ref: a.id } : {}) });
          } catch (err) {
            await this.send(msg.channel_id, isOwner ? this.#tr("I couldn't get that file: {error}", { error: (err as Error).message }) : say(this.#app, lang, en("I couldn't look at that picture right now.")));
          }
        }
        if (got.length) {
          const shown = (msg.author.global_name || msg.author.username).replace(/[[\]]/g, '') || 'someone';
          const adult = adultModeOn(this.#app.settings.get()) && nsfw;
          const taken = await takeIncoming(this.#app, conv, { bridge: 'discord', chatKey: msg.channel_id, who, name: shown, place, adult }, got);
          if (taken.blocked) return void (await this.send(msg.channel_id, taken.blocked.why === 'minor' ? taken.blocked.reply : say(this.#app, lang, taken.blocked.reply)));
          for (const r of taken.refused) await line(r);
          if (fit.length > MAX_PHOTOS_IN && (taken.images.length || taken.othersPhotos.length)) await line(FIRST_4_LINE);
          extra = { ...(taken.images.length ? { images: taken.images } : {}), ...(taken.othersPhotos.length ? { othersPhotos: taken.othersPhotos } : {}), via: 'discord' };
          // The sender's alt text is part of their message (others' only reaches her inside the fence).
          const alts = isOwner ? got.filter((g) => g.alt).map((g) => ` [image description: ${g.alt!.replace(/\s+/g, ' ').slice(0, 300)}]`).join('') : '';
          pictureText = `${alts}${taken.described}`;
        }
      }
      if (!text && !heard && !(files.length && isOwner) && !extra.images && !extra.othersPhotos) return;
    }
    if (files.length && isOwner) {
      for (const f of files.slice(0, 5)) {
        try {
          if ((f.size ?? 0) > MAX_DOC_BYTES) throw new Error(`it's over ${MAX_DOC_BYTES / 1024 / 1024} MB`);
          const res = await netFetch(f.url, { signal: AbortSignal.timeout(120_000) });
          if (!res.ok) throw new Error(`download failed (${res.status})`);
          const r = await takeChatDocument(this.#app, conv, { name: f.filename ?? decodeURIComponent(new URL(f.url).pathname.split('/').pop() ?? 'document'), bytes: Buffer.from(await res.arrayBuffer()) }, text);
          if (r.problem) await this.send(msg.channel_id, r.problem);
          else docs.push(r.doc!);
        } catch (err) {
          await this.send(msg.channel_id, this.#tr("I couldn't get that file: {error}", { error: (err as Error).message }));
        }
      }
    }
    if (!text && !heard && !docs.length && !extra.images && !extra.othersPhotos) return;
    const said = (heard ? `🎤 ${heard}` : text || (docs.length ? `📄 ${docs.map((d) => d.name).join(', ')}` : extra.images || extra.othersPhotos ? '(photo)' : '')) + pictureText;
    // Bots are tagged as bots; a person can't pass as one by naming themselves "… (bot)".
    const shown = (msg.author.global_name || msg.author.username).replace(/\s*\(bot\)\s*$/i, '').replace(/[[\]]/g, '') || msg.author.username;
    const name = isBot ? `${shown} (bot)` : shown;
    const content = isDm ? said : `[${name}]: ${said.replace(new RegExp(`<@!?${this.#me?.id}>`, 'g'), `@${this.#app.persona.name}`)}`;
    const voice = speechOf(this.#app).replyWithVoice(Boolean(heard));
    if (isBot && !(await this.#takeBotTurn(msg.channel_id, cfg))) return;
    const prev = this.#queues.get(conv.id) ?? Promise.resolve();
    // Phase 107: /reset and /new drop the turns still waiting here.
    const gen = this.#cleared.get(conv.id) ?? 0;
    this.#waiting.set(conv.id, (this.#waiting.get(conv.id) ?? 0) + 1);
    const where = { place: (isOwnerDm ? 'owner-dm' : ownerWork ? 'work-room' : 'room') as Place, lang: isOwner ? ownerLanguage(this.#app) : 'en', userId: msg.author.id, msgId: msg.id, replyTo: msg.message_reference?.message_id ?? msg.referenced_message?.id ?? null };
    const next = prev
      .then(() => {
        if ((this.#cleared.get(conv.id) ?? 0) !== gen) return;
        this.#waiting.set(conv.id, Math.max(0, (this.#waiting.get(conv.id) ?? 1) - 1));
        return this.#turn(conv, msg.channel_id, content, isOwner, voice, docs, where, extra);
      })
      .catch((err: Error) => console.warn(`discord turn: ${err.message}`));
    this.#queues.set(conv.id, next);
    await next;
  }

  /** Phase 47: a bot's message reaches her only when bots are on, it's allowed, in a server channel she's in, and she's called. */
  #botMayCall(msg: DMessage, cfg: DiscordSettings): boolean {
    if (!msg.guild_id || !cfg.answerBots) return false; // DMs from bots: always ignored
    const list = (cfg.botAllowList ?? []).map((x) => x.trim()).filter(Boolean);
    if (list.length) {
      // Security review (L5): IDs only (the bot's user ID, or a webhook's ID). Names aren't unique
      // and a webhook can post under any name. A list of names only (from before) lets no bot in.
      const ids = list.filter((x) => /^\d{1,25}$/.test(x));
      const who = [msg.author.id, ...(msg.webhook_id ? [msg.webhook_id] : [])].filter(Boolean);
      if (!ids.some((x) => who.includes(x))) return false;
    }
    // A server channel she's in: servers allowed, or a channel where an owner works with her.
    const workChannel = cfg.ownerWorkInServers === true && Boolean(this.#app.store.findChannelConversation('discord-work', msg.channel_id) || this.#app.store.findChannelConversation('discord-work-nsfw', msg.channel_id));
    if (!cfg.allowServers && !workChannel) return false;
    return this.#called(msg, cfg);
  }

  /** A person wrote in the channel: the bot count starts again. */
  #personSpoke(channelId: string): void {
    const g = this.#botGuard.get(channelId);
    if (g) {
      g.replies = 0;
      g.told = false;
    }
  }

  /** Loop guard: true (and counted) when she may answer this bot now. Synchronous up to the decision. */
  async #takeBotTurn(channelId: string, cfg: DiscordSettings): Promise<boolean> {
    const now = this.#app.now().getTime();
    const g = this.#botGuard.get(channelId) ?? { replies: 0, told: false, times: [] };
    this.#botGuard.set(channelId, g);
    g.times = g.times.filter((t) => now - t < HOUR_MS);
    if (g.times.length >= botHourlyCapOf(cfg)) return false; // silent until the hour frees up
    if (g.replies >= botTurnLimitOf(cfg)) {
      if (!g.told) {
        g.told = true;
        await this.send(channelId, BOT_WAIT_LINE).catch((err: Error) => console.warn(`discord: ${err.message}`));
      }
      return false;
    }
    g.replies++;
    g.times.push(now);
    return true;
  }

  /** In a server: @mention, a reply to her, and (when switched on) her name or @everyone / @here. */
  #called(msg: DMessage, cfg: DiscordSettings): boolean {
    if (msg.mentions?.some((u) => u.id === this.#me?.id) || msg.referenced_message?.author?.id === this.#me?.id) return true;
    if (cfg.answerName && nameCalled(msg.content, this.#app.persona.name)) return true;
    return Boolean(cfg.answerEveryone && msg.mention_everyone);
  }

  #conversation(msg: DMessage, isOwnerDm: boolean, nsfw: boolean, ownerWork = false): Conversation {
    // Owner work in a server channel is its own conversation ("-work"): tools and memory, but the
    // channel is shared, so it stays non-sexual unless the channel is an adult one.
    const channel = ownerWork ? (nsfw ? 'discord-work-nsfw' : 'discord-work') : nsfw ? 'discord-nsfw' : 'discord';
    // Phase 107: the chat's current session (the newest one /new hasn't closed).
    const existing = this.#app.store.currentChannelConversation(channel, msg.channel_id, isOwnerDm || ownerWork ? 'owner' : 'partner');
    return existing ?? this.#newConversation(channel, msg.channel_id, isOwnerDm, ownerWork);
  }

  #newConversation(channel: string, channelId: string, isOwnerDm: boolean, ownerWork: boolean): Conversation {
    const who = isOwnerDm || ownerWork ? 'owner' : 'partner';
    // Every session of the chat was closed from the app: the next one continues the chain.
    const last = this.#app.store.latestChannelConversation(channel, channelId, who);
    if (last) return nextSession(this.#app, last);
    const partner = isOwnerDm || ownerWork ? null : `people in a Discord channel`;
    // Phase 108: the room's real name when it is known (B3), else the placeholder that is renamed once it is.
    const name = discordRoomName(roomOf(this.#app, 'discord', channelId));
    const title = isOwnerDm ? 'Discord' : ownerWork ? `Discord work: ${name ?? `channel ${channelId.slice(-4)}`}` : name ? `Discord: ${name}` : `Discord channel ${channelId.slice(-4)}`;
    // Phase 108 (CH2): a chat's first session goes into the Discord project (later ones follow the last one's project).
    return this.#app.store.createConversation({ title, titleSource: 'placeholder', channel, channelKey: channelId, partner, projectId: channelProjectId(this.#app, channel) });
  }

  /** Sends her reply as an audio clip (MP3) with the text alongside. */
  async sendVoice(channelId: string, text: string): Promise<boolean> {
    const speech = speechOf(this.#app);
    if (!speech.canSendNotes()) return false;
    try {
      const audio = await speech.speak(text);
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: text.slice(0, MAX_LEN), allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: 'voice.mp3' }] }));
      form.append('files[0]', new Blob([new Uint8Array(audio.data)], { type: audio.type }), 'voice.mp3');
      const res = await netFetch(`${this.#api}/channels/${channelId}/messages`, { method: 'POST', headers: { authorization: `Bot ${this.#token}` }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return true;
    } catch (err) {
      console.warn(`discord voice: ${(err as Error).message}`);
      return false;
    }
  }

  async #turn(conv: Conversation, channelId: string, content: string, isOwner: boolean, voice = false, docs: SharedDoc[] = [], where?: { place: Place; lang: string; userId: string; msgId?: string; replyTo?: string | null }, extra: TurnExtra = {}): Promise<void> {
    const app = this.#app;
    let fill: { used: number; budget: number; dropped: number } | undefined;
    for (let i = 0; i < 600 && app.isBusy?.(conv.id); i++) await new Promise((r) => setTimeout(r, 1000));
    const started = Date.now();
    // Phase 115 (BR1): her pictures and files (sent after the turn) and the live progress message.
    const out = new Outgoing();
    const progress = where && isOwner && progressOn(app, 'discord', channelId, where.place) ? this.#progress(conv, channelId) : undefined;
    let pictureError = false;
    // Phase 115: app lines (errors) never become a picture's caption.
    const errorLines = new Set<string>();
    void this.#rest('POST', `/channels/${channelId}/typing`).catch(() => undefined);
    const typing = setInterval(() => void this.#rest('POST', `/channels/${channelId}/typing`).catch(() => undefined), 8000);
    let reply = '';
    const outgoing: string[] = [];
    const sends: Promise<unknown>[] = [];
    const flush = () => {
      if (reply.trim()) outgoing.push(reply.trim());
      reply = '';
    };
    const onEvent = (ev: ChatEvent) => {
      progress?.event(ev);
      // Fixes 2.47: her pictures and screenshots were made and never arrived.
      if (isOwner) out.onEvent(ev);
      if (ev.type === 'token') reply += ev.text;
      else if (ev.type === 'replace') reply = ev.text;
      else if (ev.type === 'context') fill = { used: ev.used, budget: ev.budget, dropped: ev.dropped };
      else if (ev.type === 'tool_call') flush();
      else if (ev.type === 'claim_check') ev.correcting ? (reply = '') : flush();
      else if (ev.type === 'notice') sends.push(this.send(channelId, `ℹ️ ${isOwner && ev.key ? this.#tr(ev.key, ev.params) : ev.text}`));
      else if (ev.type === 'approval' && isOwner) {
        sends.push(
          this.send(channelId, `${this.#tr('She wants to: {what}', { what: ev.summary })}${ev.contradiction ? `
⚠️ ${this.#tr('This goes against something you decided: “{note}”', { note: ev.contradiction.note })}` : ''}${ev.sandbox ? `
🧪 ${this.#tr('Ran in a sandbox copy first: {files}. Allow applies only these file changes; Deny discards them.', { files: `+${ev.sandbox.counts.added} ~${ev.sandbox.counts.changed} −${ev.sandbox.counts.removed}` })}${ev.sandbox.verdict === 'flagged' ? ` ⚠️ ${ev.sandbox.findings.filter((x) => x.severity === 'high' || x.severity === 'medium').map((x) => x.title).join('; ')}` : ''}` : ''}${ev.advisory ? `\n🛡️ ${this.#tr('Known vulnerability: {packages}. Allow installs it anyway (recorded as your override).', { packages: ev.advisory.packages.map((p) => `${p.name} ${p.version} (${p.vulns.map((v) => v.id).slice(0, 2).join(', ')})`).join('; ') })}` : ''}`, {
            components: [{ type: 1, components: [{ type: 2, style: 3, label: this.#tr('Allow'), custom_id: `ap:${ev.approvalId}:1` }, { type: 2, style: 4, label: this.#tr('Deny'), custom_id: `ap:${ev.approvalId}:0` }] }],
          }),
        );
      } else if (ev.type === 'error') {
        flush();
        if (extra.images?.length && /image|vision|picture|multimodal/i.test(ev.message) && !pictureError) {
          pictureError = true;
          outgoing.push(isOwner ? this.#tr("I can't see pictures with the model I'm using. Set a picture model in Settings → Which model does what.") : "Sorry, I can't answer right now.");
        } else if (ev.message !== 'Stopped.') {
          const line = isOwner ? this.#tr('(Something went wrong: {error})', { error: ev.message }) : "Sorry, I can't answer right now.";
          errorLines.add(line);
          outgoing.push(line);
        }
      }
    };
    try {
      // 2.35.1: in a shared channel the owner's side sees the room, and the room hears him (src/bridges/room.ts).
      const room = conv.channel.startsWith('discord-work') ? roomConversation(app, 'discord', channelId) : undefined;
      // Phase 110 (CH4, §7.5): with keep-up on, "the room right now" (fed from the room log) instead of the raw lines.
      const now = where && where.place !== 'owner-dm' ? await roomTurn(app, 'discord', channelId, { replyTo: where.replyTo ?? null, callerId: where.msgId ?? null, conversationId: conv.id }).catch(() => ({}) as Awaited<ReturnType<typeof roomTurn>>) : {};
      const note = now.roomNow ? undefined : roomNote(app, room);
      const opts = { ...extra, ...(docs.length ? { docs } : {}), ...(note ? { roomNote: note } : {}), ...(now.roomNow ? { roomNow: now.roomNow } : {}), ...(now.roomId !== undefined ? { roomId: now.roomId } : {}), ...(now.roomCrisis ? { roomCrisis: true } : {}) };
      if (app.runTracked) await app.runTracked(conv.id, content, onEvent, opts);
      else {
        const { runTurn } = await import('../chat.ts');
        const stop = new AbortController();
        this.#aborts.set(conv.id, stop);
        try {
          for await (const ev of runTurn(app, conv.id, content, stop.signal, opts)) onEvent(ev);
        } finally {
          if (this.#aborts.get(conv.id) === stop) this.#aborts.delete(conv.id);
        }
      }
      flush();
      copyOwnerTurnToRoom(app, room, content, outgoing.join('\n\n'));
    } finally {
      clearInterval(typing);
    }
    const closing = progress?.finish();
    await Promise.allSettled(sends);
    // Pictures first (her reply as the message text when it fits), then files, then her text.
    if (out.items.length && where) {
      const sent = await deliverOutgoing(app, app.store.getConversation(conv.id) ?? conv, { bridge: 'discord', chatKey: channelId, place: where.place, lang: ownerLanguage(app) }, this.#mediaPort(channelId), out.items, outgoing.length === 1 && !errorLines.has(outgoing[0]) ? outgoing[0] : '').catch((err: Error) => ({ captionUsed: false, lines: [this.#tr("I couldn't send the picture here ({reason}). It's in the app.", { reason: err.message.slice(0, 120) })] }));
      if (sent.captionUsed) outgoing.splice(0, 1);
      outgoing.push(...sent.lines);
    }
    let since = started;
    for (const t of outgoing) {
      if (voice && t.length <= 1200 && !t.includes('```') && (await this.sendVoice(channelId, t))) continue;
      await paceLikeTyping(app, t, since, () => void this.#rest('POST', `/channels/${channelId}/typing`).catch(() => undefined));
      await this.send(channelId, t);
      since = Date.now();
    }
    await closing?.catch(() => undefined);
    // Phase 107 (§4.7): nearly full: she offers /new once (in a channel he works in, in his DMs).
    if (where) {
      const line = nearlyFullOffer(app, app.store.getConversation(conv.id) ?? conv, fill, where.lang, where.place);
      if (line) {
        const to = where.place === 'work-room' ? await this.#rest<{ id: string }>('POST', '/users/@me/channels', { recipient_id: where.userId }).then((d) => d.id).catch(() => undefined) : channelId;
        if (to) await this.send(to, `ℹ️ ${line}`).catch(() => undefined);
      }
    }
  }

  /** Phase 115 (BR1 §4.8): the progress message of one turn (POST, then PATCH in place). */
  #progress(conv: Conversation, channelId: string): ProgressMessage {
    const app = this.#app;
    const ps = progressSettings(app);
    const lang = ownerLanguage(app);
    const components = (stop: boolean) => (stop ? [{ type: 1, components: [{ type: 2, style: 2, label: `⏹ ${say(app, lang, en('Stop'))}`, custom_id: `st:${conv.id}` }] }] : []);
    return new ProgressMessage({
      port: {
        create: async (text, stop) => (await this.#rest<{ id?: string }>('POST', `/channels/${channelId}/messages`, { content: text, allowed_mentions: { parse: [] }, components: components(stop) }))?.id,
        edit: (ref, text, stop) => this.#rest('PATCH', `/channels/${channelId}/messages/${ref}`, { content: text, components: components(stop) }).then(() => undefined),
        remove: (ref) => this.#rest('DELETE', `/channels/${channelId}/messages/${ref}`).then(() => undefined),
      },
      queue: this.sendq,
      key: `dc:${channelId}`,
      clock: this.#clock,
      afterMs: ps.afterSeconds * 1000,
      intervalMs: 2500,
      final: ps.final,
      lang,
      owner: true,
      scrub: (t) => app.redactor.redact(t),
      onOpen: (ref) => openProgress(app, conv.id, 'discord', channelId, ref),
      onClose: () => closeProgress(app, conv.id),
    }).start();
  }

  /** Phase 115 (BR1 §4.3): pictures and files as one multipart message each (files[n], payload_json). */
  #mediaPort(channelId: string): MediaPort {
    const post = (files: { path: string; mime: string; name: string }[], content: string | undefined, alt: string) => {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ ...(content ? { content } : {}), allowed_mentions: { parse: [] }, attachments: files.map((f, n) => ({ id: n, filename: f.name, ...(alt ? { description: alt } : {}) })) }));
      files.forEach((f, n) => form.append(`files[${n}]`, new Blob([new Uint8Array(readFileSync(f.path))], { type: f.mime }), f.name));
      return this.sendq.send(`dc:${channelId}`, PRIO_FILE, () => this.#multipart<{ id?: string; attachments?: { id: string }[] }>(`/channels/${channelId}/messages`, form));
    };
    const ext = (mime: string) => (mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/gif' ? 'gif' : 'jpg');
    return {
      maxPhotoBytes: DISCORD_FILE_OUT,
      maxFileBytes: DISCORD_FILE_OUT,
      captionMax: 1900,
      sendPhotos: async (files, caption) => {
        const m = await post(files.map((f, n) => ({ ...f, name: `photo-${n + 1}.${ext(f.mime)}` })), caption, say(this.#app, ownerLanguage(this.#app), en('A photo from Sara')));
        return (m?.attachments ?? []).map((a) => a.id);
      },
      sendFile: async (f, caption) => (await post([f], caption, ''))?.attachments?.[0]?.id,
    };
  }

  /** Phase 115: a small test picture to the owner's DMs (Settings → Discord → Send me a test picture). */
  async testPicture(png: Buffer): Promise<void> {
    const dm = await this.#ownerDm();
    if (!dm) throw new Error(en('Link your Discord first.'));
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ content: this.#tr('A test picture from Sara. Pictures and files reach you here.'), attachments: [{ id: 0, filename: 'test.png', description: 'A test picture' }] }));
    form.append('files[0]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'test.png');
    await this.sendq.send(`dc:${dm}`, PRIO_FILE, () => this.#multipart(`/channels/${dm}/messages`, form));
  }

  async #ownerDm(): Promise<string | undefined> {
    const owner = discordSettings(this.#app).ownerUserId;
    if (!owner) return undefined;
    if (!this.#dmChannel.has(owner)) {
      const ch = await this.#rest<{ id: string }>('POST', '/users/@me/channels', { recipient_id: owner });
      this.#dmChannel.set(owner, ch.id);
    }
    return this.#dmChannel.get(owner);
  }

  async #mirror(ev: HubEvent): Promise<void> {
    if (ev.type !== 'message' || ev.message.role === 'notice') return;
    const cfg = discordSettings(this.#app);
    if (!cfg.ownerUserId) return;
    const conv = this.#app.store.getConversation(ev.conversationId);
    if (conv?.partner) return;
    // Her DMs with an owner and owner work channels get their own reminders back where they were set.
    const isOwnerConv = conv?.channel === 'discord' || Boolean(conv?.channel.startsWith('discord-work'));
    if (!isOwnerConv && !cfg.mirror) return;
    const ch = isOwnerConv ? conv!.channelKey! : await this.#ownerDm().catch(() => undefined);
    if (ch) await this.send(ch, ev.reason === 'reminder' ? `⏰ ${ev.message.content}` : ev.message.content).catch((err: Error) => (this.#error = err.message));
  }
}
