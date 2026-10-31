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
import { nameCalled } from './rules.ts';

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
  referenced_message?: { author?: DUser } | null;
  attachments?: { url: string; filename?: string; content_type?: string; size?: number; duration_secs?: number }[];
  /** 8192 = voice message */
  flags?: number;
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
  readonly #dmChannel = new Map<string, string>();
  readonly #queues = new Map<string, Promise<void>>();
  /** Phase 47 loop guard per channel (in memory; kept across reconnects, reset on restart of Sara). */
  readonly #botGuard = new Map<string, { replies: number; told: boolean; times: number[] }>();

  constructor(app: AppContext, opts: { api?: string; gateway?: string; connect?: GatewayConnect } = {}) {
    this.#app = app;
    this.#api = opts.api ?? 'https://discord.com/api/v10';
    this.#gateway = opts.gateway ?? 'wss://gateway.discord.gg/?v=10&encoding=json';
    this.#connect = opts.connect ?? nodeConnect;
  }

  get #token(): string | undefined {
    return this.#app.vault.get(DISCORD_VAULT);
  }

  status(): { running: boolean; bot: string | null; linked: boolean; error: string | null } {
    return { running: Boolean(this.#me) && !this.#stopped, bot: this.#me?.username ?? null, linked: Boolean(discordSettings(this.#app).ownerUserId), error: this.#error ?? null };
  }

  async #rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await netFetch(`${this.#api}${path}`, {
      method,
      headers: { authorization: `Bot ${this.#token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return undefined as T;
    const j = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new Error(`Discord ${method} ${path.split('/').slice(0, 3).join('/')}: ${j.message ?? res.status}`);
    return j;
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
    else if (p.op === 0 && p.t === 'READY') this.#me = (p.d as { user: DUser }).user;
    else if (p.op === 0 && p.t === 'MESSAGE_CREATE') await this.handleMessage(p.d as DMessage);
    else if (p.op === 0 && p.t === 'INTERACTION_CREATE') await this.#onInteraction(p.d as { id: string; token: string; data?: { custom_id?: string }; user?: DUser; member?: { user: DUser } });
  }

  async #onInteraction(i: { id: string; token: string; data?: { custom_id?: string }; user?: DUser; member?: { user: DUser } }): Promise<void> {
    const who = i.user ?? i.member?.user;
    const m = i.data?.custom_id?.match(/^ap:([\w-]+):([01])$/);
    let reply = 'Only the owner can answer that.';
    if (m && who && isDiscordOwner(discordSettings(this.#app), who.id)) reply = this.#app.approvals.decide(m[1], m[2] === '1') ? this.#tr(m[2] === '1' ? en('Allowed.') : en('Denied.')) : this.#tr('That request is no longer waiting.');
    // Type 4 = reply with a message (ephemeral flag 64).
    await this.#rest('POST', `/interactions/${i.id}/${i.token}/callback`, { type: 4, data: { content: reply, flags: 64 } });
  }

  /** Phase 61: her app lines to the owner in the owner's app language (partners get the English ones). */
  #tr(text: string, params?: Record<string, unknown>): string {
    return tr(text, appLanguage(this.#app.settings.get()), params, identityOf(this.#app.persona));
  }

  async send(channelId: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    for (const part of splitDiscord(text)) await this.#rest('POST', `/channels/${channelId}/messages`, { content: part, allowed_mentions: { parse: [] }, ...extra });
  }

  async #isNsfw(channelId: string): Promise<boolean> {
    if ((discordSettings(this.#app).nsfwChannelIds ?? []).includes(channelId)) return true;
    if (!this.#nsfw.has(channelId)) {
      const ch = await this.#rest<{ nsfw?: boolean }>('GET', `/channels/${channelId}`).catch(() => ({ nsfw: false }));
      this.#nsfw.set(channelId, Boolean(ch.nsfw));
    }
    return this.#nsfw.get(channelId)!;
  }

  /** Handles one MESSAGE_CREATE (public for tests). */
  async handleMessage(msg: DMessage): Promise<void> {
    if (msg.author.id === this.#me?.id) return; // her own messages (and her own webhooks)
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
    // Phase 44: documents from an owner go to her library (or are read once, if the message says so).
    const docs: SharedDoc[] = [];
    const files = (msg.attachments ?? []).filter((a) => !(a.content_type ?? '').startsWith('audio/') && !(a.content_type ?? '').startsWith('image/') && !(a.content_type ?? '').startsWith('video/'));
    if (!text && !heard && !(files.length && isOwner)) return;
    const nsfw = !isDm && (await this.#isNsfw(msg.channel_id));
    const conv = this.#conversation(msg, isOwnerDm, nsfw, ownerWork);
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
    if (!text && !heard && !docs.length) return;
    const said = heard ? `🎤 ${heard}` : text || (docs.length ? `📄 ${docs.map((d) => d.name).join(', ')}` : '');
    // Bots are tagged as bots; a person can't pass as one by naming themselves "… (bot)".
    const shown = (msg.author.global_name || msg.author.username).replace(/\s*\(bot\)\s*$/i, '').replace(/[[\]]/g, '') || msg.author.username;
    const name = isBot ? `${shown} (bot)` : shown;
    const content = isDm ? said : `[${name}]: ${said.replace(new RegExp(`<@!?${this.#me?.id}>`, 'g'), `@${this.#app.persona.name}`)}`;
    const voice = speechOf(this.#app).replyWithVoice(Boolean(heard));
    if (isBot && !(await this.#takeBotTurn(msg.channel_id, cfg))) return;
    const prev = this.#queues.get(conv.id) ?? Promise.resolve();
    const next = prev.then(() => this.#turn(conv, msg.channel_id, content, isOwner, voice, docs)).catch((err: Error) => console.warn(`discord turn: ${err.message}`));
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
    const existing = this.#app.store.findChannelConversation(channel, msg.channel_id, isOwnerDm || ownerWork ? 'owner' : 'partner');
    if (existing) return existing;
    const partner = isOwnerDm || ownerWork ? null : `people in a Discord channel`;
    const title = isOwnerDm ? 'Discord' : ownerWork ? `Discord work: channel ${msg.channel_id.slice(-4)}` : `Discord channel ${msg.channel_id.slice(-4)}`;
    return this.#app.store.createConversation({ title, channel, channelKey: msg.channel_id, partner });
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

  async #turn(conv: Conversation, channelId: string, content: string, isOwner: boolean, voice = false, docs: SharedDoc[] = []): Promise<void> {
    const app = this.#app;
    for (let i = 0; i < 600 && app.isBusy?.(conv.id); i++) await new Promise((r) => setTimeout(r, 1000));
    const started = Date.now();
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
      if (ev.type === 'token') reply += ev.text;
      else if (ev.type === 'replace') reply = ev.text;
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
        if (ev.message !== 'Stopped.') outgoing.push(isOwner ? this.#tr('(Something went wrong: {error})', { error: ev.message }) : "Sorry, I can't answer right now.");
      }
    };
    try {
      // 2.35.1: in a shared channel the owner's side sees the room, and the room hears him (src/bridges/room.ts).
      const room = conv.channel.startsWith('discord-work') ? roomConversation(app, 'discord', channelId) : undefined;
      const note = roomNote(app, room);
      const opts = { ...(docs.length ? { docs } : {}), ...(note ? { roomNote: note } : {}) };
      if (app.runTracked) await app.runTracked(conv.id, content, onEvent, opts);
      else {
        const { runTurn } = await import('../chat.ts');
        for await (const ev of runTurn(app, conv.id, content, undefined, opts)) onEvent(ev);
      }
      flush();
      copyOwnerTurnToRoom(app, room, content, outgoing.join('\n\n'));
    } finally {
      clearInterval(typing);
    }
    await Promise.allSettled(sends);
    let since = started;
    for (const t of outgoing) {
      if (voice && t.length <= 1200 && !t.includes('```') && (await this.sendVoice(channelId, t))) continue;
      await paceLikeTyping(app, t, since, () => void this.#rest('POST', `/channels/${channelId}/typing`).catch(() => undefined));
      await this.send(channelId, t);
      since = Date.now();
    }
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
