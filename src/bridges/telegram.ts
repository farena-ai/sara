import { sendDelivery, formReview, DeliveryRejected, DeliveryUncertain } from './delivery.ts';
import { PRIO_EDIT, type Priority } from './sendq.ts';
// Phase 6: Telegram bridge. Long polling (no public webhook needed). The owner links their account
// with a one-time code; their DMs go to one owner conversation with everything (tools via
// Approve/Deny buttons, memory, reminders). Other people only if the owner allows it: then each
// chat is a "partner" conversation with no tools, no memory, no adult content and its own AI
// disclosure. Groups: Sara answers when mentioned or replied to.
// Phase 43: more owners by user ID; owners can work with her (tools) in groups when allowed; she
// can also answer to her name without the @ and to @all / @everyone; adult groups by ID.
import { accessInfo } from '../platform.ts';
import { copyOwnerTurnToRoom, roomConversation, roomNote } from './room.ts';
import { netFetch, privateLocalOn } from '../net-guard.ts';
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
import { everyoneCalled, nameCalled } from './rules.ts';
import { afterTurnExtras, askerLanguage, chatButton, chatsSettings, menuHash, OWNER_ONLY_COMMANDS, menuList, nearlyFullOffer, nextSession, OTHER_LANGS, ownerLanguage, parseCommand, runCommand, say, setSessionModel, TELEGRAM_LANGS, type Asker, type BridgeAdapter, type CommandName, type CommandReply, type ModelPick, type ParsedCommand, type Place } from './commands.ts';
import { channelProjectId, noteRoom } from './rooms.ts';
import { editLine, keepRoomByKey, leftRoom, logLine, maybeSummarize, noteHerLine, reading, setSeesAll, type KeepRoom, type Who } from './keepup.ts';
import { roomTurn } from './now.ts';
import { closeProgress, deliverOutgoing, FIRST_4_LINE, MAX_PHOTO_IN_BYTES, MAX_PHOTOS_IN, openProgress, othersPhotosOn, Outgoing, PHOTO_SIZE_LINE, PHOTOS_OFF_LINE, photoQuotaHit, progressOn, progressSettings, QUOTA_LINE, takeIncoming, takeLeftoverProgress, TELEGRAM_FILE_OUT, TELEGRAM_PHOTO_OUT, type IncomingFile, type MediaPort } from './media.ts';
import { finalLine, ProgressMessage } from './progress.ts';
import { PENDING_LINES, pendingFor, snippet, whileBusySettings, type PendingItem } from '../pending.ts';
import { PRIO_FILE, PRIO_REPLY, RateLimited, realClock, SendQueue, type Clock } from './sendq.ts';
import { readFileSync } from 'node:fs';
import { adultModeOn } from '../settings.ts';

export interface TelegramSettings {
  enabled: boolean;
  /** Chat id of the owner's private chat with the bot (set by linking). */
  ownerChatId?: number;
  /** Let people other than the owner talk to her (as a labelled AI). */
  allowOthers: boolean;
  /** Also send reminders and messages she starts herself to the owner's Telegram. */
  mirror: boolean;
  /** Phase 43: more owners (Telegram user IDs) besides the linked one. */
  ownerUserIds?: number[];
  /** Owners get her tools in groups too (everyone else still gets the partner chat). */
  ownerWorkInGroups?: boolean;
  /** Group chats she treats as adult (with Adult mode on). */
  nsfwChatIds?: number[];
  /** Answer when her name is said in a group, without the @ (needs the bot's privacy mode off). */
  answerName?: boolean;
  /** Answer @all / @everyone in a group. */
  answerEveryone?: boolean;
}

/** Phase 115: what a chat-app turn adds to the turn options (pictures, where it came from). */
export interface TurnExtra {
  images?: string[];
  othersPhotos?: string[];
  via?: string;
  /** Phase 116: the queued message this turn runs (src/pending.ts). */
  pendingId?: string;
}

export const DEFAULT_TELEGRAM: TelegramSettings = { enabled: false, allowOthers: false, mirror: true, ownerUserIds: [], ownerWorkInGroups: false, nsfwChatIds: [], answerName: false, answerEveryone: false };

/** The linked owner (their private chat id is their user id) and any owner IDs saved with her. */
export function isTelegramOwner(cfg: TelegramSettings, userId: number | undefined): boolean {
  return userId !== undefined && (userId === cfg.ownerChatId || (cfg.ownerUserIds ?? []).includes(userId));
}
/** Longest voice note she listens to (Telegram's bot download limit is 20 MB). */
const MAX_NOTE_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_VAULT = 'bridge:telegram';
const MAX_LEN = 4000;

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
  /** Phase 107: the user's app language (IETF tag), for command replies. */
  language_code?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  voice?: { file_id: string; duration?: number; file_size?: number };
  audio?: { file_id: string; duration?: number; file_size?: number };
  /** Phase 115 (BR1): the same picture at several sizes (smallest first). */
  photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
  /** Phase 115: an album's pictures arrive as separate updates sharing this id. */
  media_group_id?: string;
  /** Phase 44: a file (PDF, Word…) the owner sends goes to her library. */
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: { message_id?: number; from?: TgUser };
  entities?: { type: string; offset: number; length: number }[];
  /** Phase 110: when it was sent (Unix seconds). */
  date?: number;
  video?: unknown;
  sticker?: { emoji?: string };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  /** Phase 110 (CH4): an edit in a group she keeps up with updates the logged line. */
  edited_message?: TgMessage;
  /** Phase 110: her own membership changed (removed from a group: keep-up stops there). */
  my_chat_member?: { chat: { id: number; type: string }; new_chat_member?: { status?: string } };
  callback_query?: { id: string; from: TgUser; data?: string; message?: TgMessage };
}

export function telegramSettings(app: AppContext): TelegramSettings {
  return { ...DEFAULT_TELEGRAM, ...app.settings.get().telegram };
}

/** Splits a long reply into Telegram-sized messages, preferring paragraph/line breaks. */
export function splitMessage(text: string, max = MAX_LEN): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export class TelegramBridge {
  readonly #app: AppContext;
  readonly #apiBase: string;
  #abort: AbortController | undefined;
  #offset = 0;
  #bot: TgUser | undefined;
  #error: string | undefined;
  #link: { code: string; expires: number; misses: number } | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #toldNo = new Set<number>();
  // Phase 116 (BR2 B5): one turn per conversation at a time, through the server's one queue
  // (src/pending.ts), shared with the web app, Discord and plugin bridges.
  /** Phase 107: the bridge's own Stop for turns it runs without the server's tracking (tests, bare apps). */
  readonly #aborts = new Map<string, AbortController>();
  /** Phase 107: the last /model choices shown per session (the buttons carry their index). */
  readonly #picks = new Map<string, ModelPick[]>();
  /** Phase 107: the command menu registration that is running (tests await it). */
  menus: Promise<unknown> = Promise.resolve();
  /** Phase 115 (BR1 B2): the send pacer (her reply first, then files, then progress edits). */
  readonly sendq: SendQueue;
  readonly #clock: Clock;
  readonly #albumMs: number;
  /** Phase 115: album pictures waiting for the rest of their group (1.5 s after the last one). */
  readonly #albums = new Map<string, { msgs: TgMessage[]; timer: NodeJS.Timeout; go: (msgs: TgMessage[]) => Promise<void> }>();
  /** Phase 115: the album turns started (tests await them). */
  albumTurns: Promise<unknown>[] = [];

  constructor(app: AppContext, opts: { apiBase?: string; clock?: Clock; albumMs?: number } = {}) {
    this.#app = app;
    this.#apiBase = opts.apiBase ?? 'https://api.telegram.org';
    this.#clock = opts.clock ?? realClock;
    this.#albumMs = opts.albumMs ?? 1500;
    this.sendq = new SendQueue({ clock: this.#clock });
  }

  get #token(): string | undefined {
    return this.#app.vault.get(TELEGRAM_VAULT);
  }

  status(): { running: boolean; bot: string | null; linked: boolean; error: string | null; menu: { at: string | null; error: string | null } | null } {
    const m = this.#app.store.bridgeMenu('telegram');
    return { running: Boolean(this.#abort), bot: this.#bot?.username ?? null, linked: Boolean(telegramSettings(this.#app).ownerChatId), error: this.#error ?? null, menu: m ? { at: m.at, error: m.error } : null };
  }

  async #call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const token = this.#token;
    if (!token) throw new Error('No Telegram bot token');
    const res = await netFetch(`${this.#apiBase}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(30_000) });
    return this.#result<T>(method, res);
  }

  /** Phase 115: a Bot API answer; a 429 becomes RateLimited (`parameters.retry_after`, seconds). */
  async #result<T>(method: string, res: Response): Promise<T> {
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    const creating = ['sendMessage', 'sendPhoto', 'sendMediaGroup', 'sendDocument', 'sendVoice'].includes(method);
    if (creating && res.status >= 500) throw new DeliveryUncertain();
    if (!j.ok && (res.status === 429 || j.error_code === 429)) throw new RateLimited(Math.ceil(Number(j.parameters?.retry_after ?? 1) * 1000), `Telegram ${method}: too many requests`);
    if (!res.ok || j.ok !== true) {
      if (!creating) throw new Error(`Telegram ${method}: ${j.description ?? `HTTP ${res.status}`}`);
      if ((res.status >= 400 && res.status < 500) || (j.error_code && j.error_code >= 400 && j.error_code < 500)) throw new DeliveryRejected();
      throw new DeliveryUncertain();
    }
    return j.result as T;
  }

  /** Phase 115: a multipart upload (sendPhoto, sendMediaGroup, sendDocument), like sendVoice. */
  async #upload<T>(method: string, form: FormData): Promise<T> {
    const res = await netFetch(`${this.#apiBase}/bot${this.#token}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    return this.#result<T>(method, res);
  }

  #sendNative<T>(method: string, body: Record<string, unknown>, priority: Priority = PRIO_REPLY): Promise<T | undefined> {
    return sendDelivery(this.#app, this.sendq, `tg:${body.chat_id}`, priority,
      { bridge: 'telegram', operation: method, destination: String(body.chat_id), review: { text: String(body.text ?? body.caption ?? '') } },
      () => this.#call<T>(method, body));
  }

  #sendUpload<T>(method: string, form: FormData, text?: string): Promise<T | undefined> {
    const chat = String(form.get('chat_id'));
    const expected = method === 'sendMediaGroup' ? (JSON.parse(String(form.get('media'))) as unknown[]).length : 1;
    return sendDelivery(this.#app, this.sendq, `tg:${chat}`, PRIO_FILE,
      { bridge: 'telegram', operation: method, destination: chat, review: formReview(form, text ?? String(form.get('caption') ?? '')) },
      () => this.#upload<T>(method, form), expected);
  }

  /** (Re)starts polling according to settings. */
  async restart(): Promise<void> {
    this.stop();
    const cfg = telegramSettings(this.#app);
    if (!cfg.enabled || !this.#token) return;
    // Phase 67: Telegram is on the internet: paused while nothing may leave this computer.
    if (privateLocalOn()) {
      this.#error = 'Paused in private local mode.';
      return;
    }
    try {
      this.#bot = await this.#call<TgUser>('getMe');
      this.#error = undefined;
    } catch (err) {
      this.#error = (err as Error).message.replace(this.#token ?? '', '***');
      return;
    }
    this.#abort = new AbortController();
    this.#unsubscribe = this.#app.events?.subscribe((ev) => void this.#mirror(ev));
    // Phase 115 (BR1 §4.8): progress messages a restart left open get their final line (once, best effort).
    this.leftovers = this.#closeLeftovers();
    void this.#loop(this.#abort.signal);
    // Phase 107: her commands in Telegram's / menu (skipped when nothing changed since last time).
    this.menus = this.registerMenus().catch((err: Error) => console.warn(`telegram menus: ${err.message}`));
  }

  /**
   * Phase 107 (CH1, §4.5): the setMyCommands calls for every scope and language. Owners' private
   * chats (and, with owner work in groups, each owner in each group he works in) get the full list;
   * other private chats new/reset/stop/status/help (or only help when others can't talk to her);
   * groups help and status. Each list in English (the owner's: his app language) and once more per
   * language_code (es fr de pt it). Scopes are only a display: every command is checked again.
   */
  menuPlan(): { method: 'setMyCommands' | 'deleteMyCommands'; body: Record<string, unknown> }[] {
    const app = this.#app;
    const cfg = telegramSettings(app);
    const owners = [...new Set([cfg.ownerChatId, ...(cfg.ownerUserIds ?? [])].filter((x): x is number => typeof x === 'number' && x > 0))];
    // Phase 116: /steer, /queue and /btw in the owner's lists. Phase 123: /compact next to /new.
    const full: CommandName[] = ['new', 'compact', 'reset', 'stop', 'status', 'help', 'model', 'remember', 'continue', 'settings', 'steer', 'queue', 'btw'];
    const groups = cfg.ownerWorkInGroups ? app.store.channelKeys('telegram-work').map(Number).filter((n) => Number.isFinite(n) && n < 0) : [];
    const scopes: { scope: Record<string, unknown>; names: CommandName[]; owner: boolean }[] = [
      { scope: { type: 'all_private_chats' }, names: cfg.allowOthers ? ['new', 'reset', 'stop', 'status', 'help'] : ['help'], owner: false },
      { scope: { type: 'all_group_chats' }, names: ['help', 'status'], owner: false },
      ...owners.map((id) => ({ scope: { type: 'chat', chat_id: id }, names: full, owner: true })),
      ...groups.flatMap((g) => owners.map((id) => ({ scope: { type: 'chat_member', chat_id: g, user_id: id }, names: full, owner: true }))),
    ];
    const native = chatsSettings(app).native;
    const out: { method: 'setMyCommands' | 'deleteMyCommands'; body: Record<string, unknown> }[] = [];
    for (const sc of scopes) {
      const base = sc.owner ? ownerLanguage(app) : 'en';
      out.push(native ? { method: 'setMyCommands', body: { commands: menuList(app, sc.names, base, sc.owner), scope: sc.scope } } : { method: 'deleteMyCommands', body: { scope: sc.scope } });
      for (const l of OTHER_LANGS) out.push(native ? { method: 'setMyCommands', body: { commands: menuList(app, sc.names, l, sc.owner), scope: sc.scope, language_code: TELEGRAM_LANGS[l] } } : { method: 'deleteMyCommands', body: { scope: sc.scope, language_code: TELEGRAM_LANGS[l] } });
    }
    return out;
  }

  /** Registers the menus (all calls) unless the same lists were registered before; `force` = "Register menus now". */
  async registerMenus(force = false): Promise<{ ok: boolean; skipped?: boolean; calls?: number; error?: string }> {
    const store = this.#app.store;
    const plan = this.menuPlan();
    const hash = menuHash(plan);
    const prev = store.bridgeMenu('telegram');
    if (!force && prev?.hash === hash && !prev.error) return { ok: true, skipped: true, calls: 0 };
    try {
      for (const c of plan) await this.#call(c.method, c.body);
      store.setBridgeMenu('telegram', { hash, at: this.#app.now().toISOString(), error: null });
      return { ok: true, calls: plan.length };
    } catch (err) {
      const error = (err as Error).message.replace(this.#token ?? '', '***').slice(0, 300);
      store.setBridgeMenu('telegram', { hash: null, at: prev?.at ?? null, error });
      return { ok: false, error };
    }
  }

  /** Phase 115: the start-up pass over progress messages a restart left open (tests await it). */
  leftovers: Promise<void> = Promise.resolve();
  async #closeLeftovers(): Promise<void> {
    let rows: ReturnType<typeof takeLeftoverProgress> = [];
    try {
      rows = takeLeftoverProgress(this.#app, 'telegram');
    } catch {
      return;
    }
    for (const r of rows) await this.#call('editMessageText', { chat_id: Number(r.chatId), message_id: Number(r.messageId), text: finalLine({ kind: 'restart' }, 0, 0, ownerLanguage(this.#app), true), reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    // Phase 116 (BR2 §5.3): messages that waited when Sara restarted don't run by themselves; the owner hears once.
    try {
      const pend = pendingFor(this.#app);
      for (const it of pend.untold('telegram')) {
        pend.markTold(it.id);
        const chatId = Number(it.meta.where?.chatId);
        if (it.sender === 'person' || !Number.isFinite(chatId)) continue;
        await this.send(chatId, say(this.#app, ownerLanguage(this.#app), PENDING_LINES.restarted, { text: snippet(it.content) })).catch(() => undefined);
      }
    } catch (err) {
      console.warn(`telegram: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  newLinkCode(): string {
    const code = String(randomInt(100000, 1000000));
    this.#link = { code, expires: Date.now() + 10 * 60_000, misses: 0 };
    return code;
  }

  async #loop(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const updates = await this.#call<TgUpdate[]>('getUpdates', { offset: this.#offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'edited_message', 'my_chat_member'] }, AbortSignal.any([signal, AbortSignal.timeout(65_000)]));
        backoff = 1000;
        this.#error = undefined;
        for (const u of updates) {
          this.#offset = u.update_id + 1;
          // Phase 107: the loop doesn't wait for her reply (only until the turn is queued), so a
          // /stop or /reset sent while she answers is read at once.
          await this.handle(u, { queued: true }).catch((err: Error) => console.warn(`telegram: ${err.message}`));
        }
      } catch (err) {
        if (signal.aborted) return;
        this.#error = (err as Error).message.replace(this.#token ?? '', '***');
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(60_000, backoff * 2);
      }
    }
  }

  /** Phase 61: her app lines to the owner in the owner's app language (partners get the English ones). */
  #tr(text: string, params?: Record<string, unknown>): string {
    return tr(text, appLanguage(this.#app.settings.get()), params, identityOf(this.#app.persona));
  }

  async send(chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
    for (const part of splitMessage(text)) {
      // Phase 115 (B2): through the pacer, ahead of files and progress edits; a 429 waits and retries.
      const m = await this.#sendNative<{ message_id?: number }>('sendMessage', { ...extra, chat_id: chatId, text: part });
      // Phase 110: her own lines in a group she keeps up with are logged too (with Telegram's id).
      this.#herLine(chatId, m?.message_id, part);
    }
  }

  // ------------------------------------------------------------------ Phase 110 (CH4): keeping up

  #keeping(chatId: number): KeepRoom | undefined {
    if (chatId > 0) return undefined; // private chats are not rooms
    try {
      const r = keepRoomByKey(this.#app, 'telegram', String(chatId));
      return reading(r) ? r : undefined;
    } catch {
      return undefined;
    }
  }

  #herLine(chatId: number, id: number | undefined, text: string): void {
    const room = this.#keeping(chatId);
    if (!room) return;
    const line = logLine(this.#app, room, { platformId: id === undefined ? null : String(id), authorId: String(this.#bot?.id ?? 'her'), author: this.#app.persona.name, who: 'her', text });
    if (line) noteHerLine(this.#app, room, line.id);
  }

  /** A message's text as the log keeps it (attachments as [photo] [file: x.pdf] [voice message]; voice isn't transcribed passively). */
  #logText(msg: TgMessage): string {
    const marks = [msg.photo ? '[photo]' : '', msg.voice || msg.audio ? '[voice message]' : '', msg.video ? '[video]' : '', msg.document ? `[file: ${(msg.document.file_name ?? 'file').slice(0, 80)}]` : '', msg.sticker ? `[sticker${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ''}]` : ''].filter(Boolean);
    return [(msg.text ?? msg.caption ?? '').trim(), ...marks].filter(Boolean).join(' ');
  }

  /** §7.3 capture: first in handle(), before the bot check and the called check; only for groups with keep-up on. */
  #passive(msg: TgMessage): void {
    if (msg.chat.type === 'private' || !msg.from) return;
    const room = this.#keeping(msg.chat.id);
    if (!room) return;
    const who: Who = msg.from.is_bot ? (msg.from.id === this.#bot?.id ? 'her' : 'bot') : isTelegramOwner(telegramSettings(this.#app), msg.from.id) ? 'owner' : 'person';
    const text = this.#logText(msg);
    if (!text) return;
    const at = msg.date ? new Date(Math.min(msg.date * 1000, this.#app.now().getTime())).toISOString() : undefined;
    logLine(this.#app, room, { platformId: String(msg.message_id), authorId: String(msg.from.id), author: msg.from.first_name || msg.from.username || 'someone', who, text, replyTo: msg.reply_to_message?.message_id !== undefined ? String(msg.reply_to_message.message_id) : null, ...(at ? { at } : {}) });
    void maybeSummarize(this.#app, room);
  }

  /**
   * §7.2 the platform check: `getMe.can_read_all_group_messages` (privacy mode off, then re-added)
   * or the bot is an admin of the group (`getChatMember`). Otherwise keep-up is refused (or paused)
   * with the fix steps.
   */
  async checkRoom(chatId: number): Promise<{ seesAll: string; reason?: string }> {
    const r = keepRoomByKey(this.#app, 'telegram', String(chatId));
    let seesAll = 'no:not connected';
    try {
      const me = await this.#call<TgUser & { can_read_all_group_messages?: boolean }>('getMe');
      this.#bot = me;
      if (me.can_read_all_group_messages) seesAll = 'yes';
      else {
        const m = await this.#call<{ status?: string }>('getChatMember', { chat_id: chatId, user_id: me.id }).catch(() => ({}) as { status?: string });
        if (m.status === 'administrator' || m.status === 'creator') seesAll = 'admin';
        else if (m.status === 'left' || m.status === 'kicked') seesAll = 'no:left';
        else seesAll = 'no:privacy';
      }
    } catch (err) {
      seesAll = `no:${(err as Error).message.replace(this.#token ?? '', '***').slice(0, 120)}`;
    }
    if (r) {
      setSeesAll(this.#app, r.id, seesAll);
      if (seesAll === 'no:left') leftRoom(this.#app, r.id);
    }
    return { seesAll, ...(seesAll.startsWith('no:') ? { reason: seesAll.slice(3) } : {}) };
  }

  /** Handles one update (public for tests). `queued`: return once the turn is queued, not when it's done. */
  async handle(u: TgUpdate, o: { queued?: boolean } = {}): Promise<void> {
    const cfg = telegramSettings(this.#app);
    if (u.callback_query) {
      const q = u.callback_query;
      // Phase 107: a /model pick (owner only, checked again here).
      const md = q.data?.match(/^md:([\w-]+):(\d{1,3})$/);
      if (md) return this.#modelPicked(q, md[1], Number(md[2]), cfg);
      // Phase 115 (BR1): the progress message's Stop (the same as /stop; owner only, checked here).
      const st = q.data?.match(/^st:([\w-]+)$/);
      if (st) {
        if (!isTelegramOwner(cfg, q.from.id)) return void (await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: say(this.#app, askerLanguage(q.from.language_code), en('Only the person who runs me can stop this.')) }).catch(() => undefined));
        const stopped = this.#stopTurn(st[1]);
        return void (await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: this.#tr(stopped ? en('Stopping.') : en('Nothing to stop.')) }).catch(() => undefined));
      }
      // Phase 119: the ⏰ buttons and the pickup offer (owner only, checked here).
      if (q.data && /^(wm|pk|cu):/.test(q.data)) {
        if (!isTelegramOwner(cfg, q.from.id)) return void (await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: say(this.#app, askerLanguage(q.from.language_code), en('Only the owner can answer that.')) }).catch(() => undefined));
        const r = chatButton(this.#app, q.data);
        await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: (r?.text ?? '').slice(0, 190) }).catch(() => undefined);
        if (q.message) {
          if (r?.edit) await this.#call('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: r.edit, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
          else await this.#call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
        }
        return;
      }
      const m = q.data?.match(/^ap:([\w-]+):([01])$/);
      if (m && isTelegramOwner(cfg, q.from.id)) {
        const ok = this.#app.approvals.decide(m[1], m[2] === '1');
        await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: this.#tr(ok ? (m[2] === '1' ? en('Allowed') : en('Denied')) : en('No longer waiting')) });
        if (q.message) await this.#call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      } else await this.#call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
      return;
    }
    // Phase 110 (CH4): edits in a group she keeps up with; her own removal from a group stops keep-up there.
    if (u.edited_message) {
      const e = u.edited_message;
      const room = this.#keeping(e.chat.id);
      if (room) editLine(this.#app, room, String(e.message_id), this.#logText(e));
      return;
    }
    if (u.my_chat_member) {
      const st = u.my_chat_member.new_chat_member?.status;
      const r = keepRoomByKey(this.#app, 'telegram', String(u.my_chat_member.chat.id));
      if (r && (st === 'left' || st === 'kicked')) leftRoom(this.#app, r.id);
      return;
    }
    const msg = u.message;
    // Phase 110: in a group she keeps up with, every line is logged first (bots too, marked).
    if (msg) this.#passive(msg);
    if (!msg?.from || msg.from.is_bot) return;
    const text = (msg.text ?? msg.caption ?? '').trim();
    const isPrivate = msg.chat.type === 'private';

    // Linking: /start CODE or /link CODE in a private chat.
    const link = text.match(/^\/(?:start|link)(?:@\w+)?\s+(\d{6})$/);
    if (isPrivate && link) {
      if (this.#link && this.#link.code === link[1] && Date.now() < this.#link.expires) {
        this.#link = undefined;
        this.#app.settings.update({ telegram: { ...cfg, ownerChatId: msg.chat.id } });
        // Phase 107: his private chat gets the full command menu.
        this.menus = this.registerMenus().catch((err: Error) => console.warn(`telegram menus: ${err.message}`));
        await this.send(msg.chat.id, `${this.#tr("Linked. It's me, {name}. Text me here any time.", { name: this.#app.persona.name })} (${disclosureText(this.#app.persona.name, appLanguage(this.#app.settings.get()))})`);
      } else {
        // Five wrong tries and the code is gone (no guessing it in the 10 minutes it lasts).
        if (this.#link && ++this.#link.misses >= 5) this.#link = undefined;
        await this.send(msg.chat.id, this.#tr('That code is wrong or expired. Get a new one in Settings → Telegram.'));
      }
      return;
    }

    const fromOwner = isTelegramOwner(cfg, msg.from.id);
    const isOwnerChat = isPrivate && fromOwner;
    // Phase 43: an owner working with her in a group (tools, her memory).
    const ownerWork = !isPrivate && fromOwner && cfg.ownerWorkInGroups === true;
    const isOwner = isOwnerChat || ownerWork;
    const place: Place = isPrivate ? (fromOwner ? 'owner-dm' : 'partner-dm') : ownerWork ? 'work-room' : 'room';
    // Phase 107: commands come first (before the queue, so /stop and /reset work while she answers).
    // Others' plain /start keeps today's hello; a chat she doesn't talk in gets no commands either.
    const cmd = text && !msg.document ? parseCommand(text, { herName: this.#app.persona.name, botUsername: this.#bot?.username, namePrefix: chatsSettings(this.#app).namePrefix }) : undefined;
    // Phase 119: /when and /continue don't exist for anyone else (their line stays a message).
    if (cmd && !(cmd.name === 'start' && !fromOwner) && !(OWNER_ONLY_COMMANDS.has(cmd.name) && !fromOwner) && (isOwnerChat || ownerWork || cfg.allowOthers)) return this.#command(msg, cmd, place, fromOwner);
    if (!isOwnerChat) {
      if (!cfg.allowOthers && !ownerWork) {
        if (isPrivate && !this.#toldNo.has(msg.chat.id)) {
          this.#toldNo.add(msg.chat.id);
          await this.send(msg.chat.id, `Hi! I'm ${this.#app.persona.name}, an AI companion. I only chat with the person who runs me here.`);
        }
        return;
      }
      // Groups: when mentioned or replied to (and, when switched on, her name or @all / @everyone).
      if (!isPrivate && !this.#called(msg, text, cfg)) return;
    }
    // Phase 115 (BR1 §4.2): photos (and pictures sent "as a file") are seen like a photo from the app.
    // Fixes 2.47: a captioned photo was answered as text only (the picture was dropped silently).
    const imageDoc = msg.document && /^image\/(jpeg|png|webp|gif)$/i.test(msg.document.mime_type ?? '') && (msg.document.file_size ?? 0) <= MAX_PHOTO_IN_BYTES ? msg.document : undefined;
    if (msg.photo?.length || imageDoc) {
      const c = { isOwner: isOwnerChat || ownerWork, isOwnerChat, ownerWork, place, fromOwner };
      const group = msg.media_group_id ? `${msg.chat.id}:${msg.media_group_id}` : undefined;
      if (!group) return this.#photos([msg], c, o.queued === true);
      // An album: its pictures arrive one update each; they become one message 1.5 s after the last.
      const held = this.#albums.get(group);
      if (held) {
        clearTimeout(held.timer);
        held.msgs.push(msg);
      }
      const entry = held ?? { msgs: [msg], timer: undefined as unknown as NodeJS.Timeout, go: (msgs: TgMessage[]) => this.#photos(msgs, c, true) };
      entry.timer = setTimeout(() => {
        this.#albums.delete(group);
        this.albumTurns.push(entry.go(entry.msgs).catch((err: Error) => console.warn(`telegram album: ${err.message}`)));
      }, this.#albumMs);
      entry.timer.unref?.();
      this.#albums.set(group, entry);
      return;
    }
    // Phase 11: voice notes are transcribed and answered (with a voice note, if set up).
    let heard = '';
    const note = msg.voice ?? msg.audio;
    if (!text && note) {
      try {
        heard = await this.#hear(note);
      } catch (err) {
        await this.send(msg.chat.id, isOwner ? this.#tr("I couldn't listen to that: {error}", { error: (err as Error).message }) : "Sorry, I can't listen to voice notes right now. Could you type it?");
        return;
      }
      if (!heard) {
        await this.send(msg.chat.id, isOwner ? this.#tr("I couldn't make out any words in that one. Try again?") : "I couldn't make out any words in that one. Try again?");
        return;
      }
    }
    // Phase 44: documents from an owner go to her library (or are read once, if the caption says so).
    const docs: SharedDoc[] = [];
    if (msg.document) {
      if (!isOwner) return void (await this.send(msg.chat.id, "I only keep documents for the person who runs me."));
      try {
        const bytes = await this.#download(msg.document);
        const r = await takeChatDocument(this.#app, this.#conversation(msg, isOwnerChat, ownerWork), { name: msg.document.file_name ?? 'document', bytes }, text);
        if (r.problem) return void (await this.send(msg.chat.id, r.problem));
        docs.push(r.doc!);
      } catch (err) {
        return void (await this.send(msg.chat.id, this.#tr("I couldn't get that file: {error}", { error: (err as Error).message })));
      }
    }
    if (!text && !heard && !docs.length) return;

    const conv = this.#conversation(msg, isOwnerChat, ownerWork);
    const from = msg.from.first_name || msg.from.username || 'someone';
    const said = heard ? `🎤 ${heard}` : text || (docs.length ? `📄 ${docs[0].name}` : '');
    const content = isPrivate ? said.replace(/^\/start\b\s*/, '') || 'Hi!' : `[${from}]: ${said}`;
    const replyWithVoice = speechOf(this.#app).replyWithVoice(Boolean(heard));
    const said2 = await this.#enqueue(msg, conv, content, isOwner, replyWithVoice, docs, place, fromOwner, {}, o.queued === true);
    if (said2) await this.send(msg.chat.id, said2);
  }

  /**
   * One turn at a time per conversation, in order (Phase 116: the server's one queue). While she
   * works, the owner's plain message is a steer or waits its turn (`chats.whileBusy`, or /steer and
   * /queue); everyone else's always waits. /reset and /new drop what waits.
   */
  async #enqueue(msg: TgMessage, conv: Conversation, content: string, isOwner: boolean, voice: boolean, docs: SharedDoc[], place: Place, fromOwner: boolean, extra: TurnExtra, queued: boolean, explicit?: 'steer' | 'queue'): Promise<string> {
    const app = this.#app;
    const where = { place, lang: fromOwner ? ownerLanguage(app) : askerLanguage(msg.from?.language_code), ownerChat: msg.from!.id, msgId: String(msg.message_id), replyTo: msg.reply_to_message?.message_id !== undefined ? String(msg.reply_to_message.message_id) : null };
    const pend = pendingFor(app);
    const runner = async (item?: PendingItem) => {
      // A note she got after her last step: answered now as its own turn.
      if (item?.kind === 'steer') await this.send(msg.chat.id, say(app, where.lang, PENDING_LINES.moved)).catch(() => undefined);
      await this.#turn(conv, msg.chat.id, content, isOwner, voice, docs, where, { ...extra, ...(item ? { pendingId: item.id } : {}) }).catch((err: Error) => console.warn(`telegram turn: ${err.message}`));
    };
    if (!pend.busy(conv.id)) {
      const next = pend.run(conv.id, () => runner());
      if (!queued) await next;
      return '';
    }
    // She's working: a steer (the owner, when that's the default or he said /steer) or a queued turn.
    const cfg = whileBusySettings(app);
    const sender = isOwner ? 'owner' : 'person';
    const kind = sender === 'person' ? 'queue' : (explicit ?? cfg.whileBusy);
    const r = pend.add(conv.id, { kind, content, sender, meta: { source: 'telegram', ...(extra.images?.length ? { images: extra.images } : {}), ...(docs.length ? { docs } : {}), where: { chatId: msg.chat.id, msgId: msg.message_id, place, lang: where.lang } } }, (item) => runner(item), { queueMax: cfg.queueMax });
    const line = (t: string, p?: Record<string, unknown>) => say(app, where.lang, t, p);
    if (!r.ok) return line(r.reason === 'steers' ? PENDING_LINES.steers : PENDING_LINES.full, { max: cfg.queueMax });
    if (r.item.kind === 'steer' && r.item.state === 'waiting') {
      // 👀 on his message; a short line when the reaction can't be set.
      const ok = await this.#call('setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '👀' }] }).then(() => true, () => false);
      return ok ? '' : line(PENDING_LINES.steered);
    }
    if (r.item.kind === 'steer') return '';
    return line(PENDING_LINES.queued, { n: r.waiting });
  }

  /**
   * Phase 115 (BR1 §4.2, §4.6): one message's pictures (or an album's). The owner's are seen like
   * web photos; someone else's only when the place allows it, described first. Caps (the largest
   * size ≤ 8 MB, 4 a message) and the daily quota are checked before anything is downloaded.
   */
  async #photos(msgs: TgMessage[], c: { isOwner: boolean; isOwnerChat: boolean; ownerWork: boolean; place: Place; fromOwner: boolean }, queued: boolean): Promise<void> {
    const app = this.#app;
    const msg = msgs[0];
    const chatId = msg.chat.id;
    const key = String(chatId);
    const lang = c.fromOwner ? ownerLanguage(app) : askerLanguage(msg.from?.language_code);
    const line = (text: string) => this.send(chatId, say(app, lang, text));
    const who = c.isOwner ? 'owner' : 'person';
    if (!c.isOwner && !othersPhotosOn(app, 'telegram', key)) return void (await line(PHOTOS_OFF_LINE));
    if (photoQuotaHit(app, 'telegram', key, who, c.place)) return void (await line(QUOTA_LINE));
    const picks = msgs.map((m) => (m.photo?.length ? [...m.photo].filter((p) => (p.file_size ?? 0) <= MAX_PHOTO_IN_BYTES).sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0) || (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0] : m.document)).filter((f): f is { file_id: string; file_size?: number } => Boolean(f));
    if (!picks.length) return void (await line(PHOTO_SIZE_LINE));
    const files: IncomingFile[] = [];
    for (const f of picks.slice(0, MAX_PHOTOS_IN)) {
      try {
        files.push({ bytes: await this.#download(f), ref: f.file_id });
      } catch (err) {
        await this.send(chatId, c.isOwner ? this.#tr("I couldn't get that file: {error}", { error: (err as Error).message }) : say(app, lang, en("I couldn't look at that picture right now.")));
      }
    }
    if (!files.length) return;
    const conv = this.#conversation(msg, c.isOwnerChat, c.ownerWork);
    const from = msg.from?.first_name || msg.from?.username || 'someone';
    const adult = adultModeOn(app.settings.get()) && (conv.channel.endsWith('-nsfw') || c.place === 'partner-dm');
    const taken = await takeIncoming(app, conv, { bridge: 'telegram', chatKey: key, who, name: from, place: c.place, adult }, files);
    if (taken.blocked) return void (await this.send(chatId, taken.blocked.why === 'minor' ? taken.blocked.reply : say(app, lang, taken.blocked.reply)));
    for (const r of taken.refused) await line(r);
    if (!taken.images.length && !taken.othersPhotos.length) return;
    if (picks.length > MAX_PHOTOS_IN) await line(FIRST_4_LINE);
    const caption = (msgs.find((m) => m.caption?.trim())?.caption ?? '').trim();
    const said = `${caption || '(photo)'}${taken.described}`;
    const content = msg.chat.type === 'private' ? said : `[${from}]: ${said}`;
    const said2 = await this.#enqueue(msg, conv, content, c.isOwner, false, [], c.place, c.fromOwner, { ...(taken.images.length ? { images: taken.images } : {}), ...(taken.othersPhotos.length ? { othersPhotos: taken.othersPhotos } : {}), via: 'telegram' }, queued);
    if (said2) await this.send(chatId, said2);
  }

  #called(msg: TgMessage, text: string, cfg: TelegramSettings): boolean {
    const me = this.#bot?.username ? `@${this.#bot.username}` : '';
    if (me && text.toLowerCase().includes(me.toLowerCase())) return true;
    if (msg.reply_to_message?.from?.id === this.#bot?.id) return true;
    if (cfg.answerName && nameCalled(text, this.#app.persona.name)) return true;
    return Boolean(cfg.answerEveryone && everyoneCalled(text));
  }

  #channelOf(msg: TgMessage, ownerWork: boolean): string {
    const nsfw = msg.chat.type !== 'private' && (telegramSettings(this.#app).nsfwChatIds ?? []).includes(msg.chat.id);
    // Owner work in a group is its own conversation ("-work"): tools and memory, but the group is
    // shared, so it stays non-sexual unless the group is an adult one.
    return ownerWork ? (nsfw ? 'telegram-work-nsfw' : 'telegram-work') : nsfw ? 'telegram-nsfw' : 'telegram';
  }

  /** Phase 107: the chat's current session (the newest one /new hasn't closed), if any. */
  #current(msg: TgMessage, isOwnerChat: boolean, ownerWork = false): Conversation | undefined {
    return this.#app.store.currentChannelConversation(this.#channelOf(msg, ownerWork), String(msg.chat.id), isOwnerChat || ownerWork ? 'owner' : 'partner');
  }

  #conversation(msg: TgMessage, isOwnerChat: boolean, ownerWork = false): Conversation {
    const key = String(msg.chat.id);
    const channel = this.#channelOf(msg, ownerWork);
    const who = isOwnerChat || ownerWork ? 'owner' : 'partner';
    // Phase 108 (B3): the room's real name, for the app's row chips (a DM, or the group's title).
    noteRoom(this.#app, { bridge: 'telegram', key, kind: msg.chat.type === 'private' ? 'dm' : 'room', title: msg.chat.type === 'private' ? msg.from?.first_name || msg.from?.username || 'DM' : msg.chat.title ?? 'group', adult: channel.endsWith('-nsfw') });
    const existing = this.#app.store.currentChannelConversation(channel, key, who);
    if (existing) return existing;
    // Every session of the chat was closed from the app: the next one continues the chain.
    const last = this.#app.store.latestChannelConversation(channel, key, who);
    if (last) return nextSession(this.#app, last);
    const group = `the group "${msg.chat.title ?? 'group'}"`;
    const partner = isOwnerChat || ownerWork ? null : msg.chat.type === 'private' ? msg.from?.first_name || msg.from?.username || 'someone' : group;
    const title = isOwnerChat ? 'Telegram' : ownerWork ? `Telegram work: ${group}` : `Telegram: ${partner}`;
    // Phase 108 (CH2): a chat's first session goes into the Telegram project (later ones follow the last one's project).
    return this.#app.store.createConversation({ title, titleSource: 'placeholder', channel, channelKey: key, partner, projectId: channelProjectId(this.#app, channel) });
  }

  /** Phase 107: runs a command and sends its reply (owner-only details from a group go to his private chat). */
  async #command(msg: TgMessage, cmd: ParsedCommand, place: Place, fromOwner: boolean): Promise<void> {
    const app = this.#app;
    const chatId = msg.chat.id;
    const isOwnerChat = place === 'owner-dm';
    const ownerWork = place === 'work-room';
    const who: Asker = fromOwner ? 'owner' : 'person';
    const lang = fromOwner ? ownerLanguage(app) : askerLanguage(msg.from?.language_code);
    const adapter: BridgeAdapter = {
      currentSession: () => this.#current(msg, isOwnerChat, ownerWork),
      startSession: (prev) => (prev ? nextSession(app, prev) : this.#conversation(msg, isOwnerChat, ownerWork)),
      ...(ownerWork ? { roomSession: () => roomConversation(app, 'telegram', String(chatId)) } : {}),
      stopTurn: (id) => this.#stopTurn(id),
      clearQueue: (id) => this.#clearQueue(id),
      // Phase 116: /steer and /queue (owner; /queue also for someone in their own DM).
      take: async (kind, text) => {
        const conv = this.#conversation(msg, isOwnerChat, ownerWork);
        const from = msg.from?.first_name || msg.from?.username || 'someone';
        const content = msg.chat.type === 'private' ? text : `[${from}]: ${text}`;
        return this.#enqueue(msg, conv, content, isOwnerChat || ownerWork, false, [], place, fromOwner, {}, true, kind);
      },
      settingsWhere: undefined,
      progressKey: { bridge: 'telegram', key: String(chatId) },
      // Phase 113: /bug and /idea link to the report sheet when the server knows its address.
      ...(accessInfo().url ? { appLink: accessInfo().url! } : {}),
    };
    const r = await runCommand({ app, bridge: 'telegram', place, who, lang, cmd, adapter });
    await this.#deliver(chatId, msg.from!.id, place, r, lang, msg.message_id);
  }

  /** Sends a command reply where it belongs: buttons for picks and approvals; owner-only details privately. */
  async #deliver(chatId: number, userId: number, place: Place, r: CommandReply, lang: string, replyTo?: number): Promise<void> {
    if (!r.text && !r.choices?.length) return;
    const room = place === 'room' || place === 'work-room';
    const to = r.ownerOnly && room && !r.refused ? userId : chatId;
    const extra: Record<string, unknown> = {};
    // Phase 116: a /btw answer replies to the question.
    if (r.aside && to === chatId && replyTo !== undefined) extra.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (r.choices?.length && r.conversationId) {
      this.#picks.set(r.conversationId, r.choices);
      extra.reply_markup = { inline_keyboard: r.choices.slice(0, 20).map((m, i) => [{ text: `${m.model} · ${m.provider}`.slice(0, 60), callback_data: `md:${r.conversationId}:${i}` }]) };
    } else if (r.approval) {
      extra.reply_markup = { inline_keyboard: [[{ text: say(this.#app, lang, en('Allow')), callback_data: `ap:${r.approval.id}:1` }, { text: say(this.#app, lang, en('Deny')), callback_data: `ap:${r.approval.id}:0` }]] };
      void r.approval.done.then((t) => this.send(to, t)).catch(() => undefined);
    } else if (r.buttons?.length) {
      // Phase 123: Undo under a /compact reply.
      extra.reply_markup = { inline_keyboard: [r.buttons.slice(0, 4).map((b) => ({ text: b.label.slice(0, 60), callback_data: b.data }))] };
    }
    try {
      await this.send(to, r.text, extra);
      if (to !== chatId) await this.send(chatId, say(this.#app, lang, en('I sent you the details in our private chat.')));
    } catch (err) {
      // He never opened a private chat with the bot: Telegram refuses; nothing private goes to the group.
      if (to !== chatId) await this.send(chatId, say(this.#app, lang, en('Send me a private message first, then try again.'))).catch(() => undefined);
      else throw err;
    }
  }

  /** Phase 107: a /model button (owner only). */
  async #modelPicked(q: NonNullable<TgUpdate['callback_query']>, convId: string, index: number, cfg: TelegramSettings): Promise<void> {
    const lang = ownerLanguage(this.#app);
    const conv = this.#app.store.getConversation(convId);
    const pick = this.#picks.get(convId)?.[index];
    if (!isTelegramOwner(cfg, q.from.id)) return void (await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: say(this.#app, askerLanguage(q.from.language_code), en('Only the person who runs me can change that.')) }).catch(() => undefined));
    if (!conv || !pick) return void (await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: say(this.#app, lang, en('That list is out of date. Send /model again.')) }).catch(() => undefined));
    const line = setSessionModel(this.#app, conv, pick, lang);
    await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: line.slice(0, 190) }).catch(() => undefined);
    if (q.message) {
      await this.#call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      await this.send(q.message.chat.id, line);
    }
  }

  /** Phase 107: Stop for /stop, /reset and /new: the server's tracked turn, or the bridge's own. */
  #stopTurn(conversationId: string): boolean {
    if (this.#app.stopTurn?.(conversationId)) return true;
    const a = this.#aborts.get(conversationId);
    if (!a || a.signal.aborted) return false;
    a.abort(new Error('stopped'));
    return true;
  }

  #clearQueue(conversationId: string): number {
    return pendingFor(this.#app).clear(conversationId);
  }

  /** Downloads a file the owner sent (Telegram lets bots download up to 20 MB). */
  async #download(f: { file_id: string; file_size?: number }): Promise<Buffer> {
    if ((f.file_size ?? 0) > MAX_NOTE_BYTES) throw new Error('Telegram only lets me download files up to 20 MB. Add it on the Library page instead.');
    const file = await this.#call<{ file_path?: string }>('getFile', { file_id: f.file_id });
    if (!file.file_path) throw new Error('Telegram did not give me the file.');
    const res = await netFetch(`${this.#apiBase}/file/bot${this.#token}/${file.file_path}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Downloads a voice note and transcribes it. */
  async #hear(note: { file_id: string; file_size?: number }): Promise<string> {
    if ((note.file_size ?? 0) > MAX_NOTE_BYTES) throw new Error('that voice note is too long for me.');
    const file = await this.#call<{ file_path?: string }>('getFile', { file_id: note.file_id });
    if (!file.file_path) throw new Error('Telegram did not give me the file.');
    return speechOf(this.#app).hearNote(`${this.#apiBase}/file/bot${this.#token}/${file.file_path}`, {}, MAX_NOTE_BYTES);
  }

  /** Sends her reply as a voice note (MP3; Telegram shows it as a voice message). */
  async sendVoice(chatId: number, text: string): Promise<boolean> {
    const speech = speechOf(this.#app);
    if (!speech.canSendNotes()) return false;
    let dispatching = false;
    try {
      const audio = await speech.speak(text);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([new Uint8Array(audio.data)], { type: audio.type }), audio.type.includes('mpeg') ? 'voice.mp3' : 'voice.ogg');
      dispatching = true;
      await this.#sendUpload('sendVoice', form, text);
      return true;
    } catch (err) {
      if (dispatching && !(err instanceof DeliveryRejected)) throw err;
      console.warn(`telegram voice note: ${(err as Error).message.replace(this.#token ?? '', '***')}`);
      return false;
    }
  }

  async #turn(conv: Conversation, chatId: number, content: string, isOwner: boolean, voice = false, docs: SharedDoc[] = [], where?: { place: Place; lang: string; ownerChat: number; msgId?: string; replyTo?: string | null }, extra: TurnExtra = {}): Promise<void> {
    const app = this.#app;
    let fill: { used: number; budget: number; dropped: number } | undefined;
    // Phase 116: a web turn in the same conversation shares the one queue (no more waiting here).
    const started = Date.now();
    // Phase 115 (BR1): her pictures and files (sent after the turn) and the live progress message.
    const out = new Outgoing();
    const progress = where && isOwner && progressOn(app, 'telegram', String(chatId), where.place) ? this.#progress(conv, chatId) : undefined;
    let pictureError = false;
    // Phase 115: app lines (errors) never become a picture's caption.
    const errorLines = new Set<string>();
    const typing = setInterval(() => void this.#call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined), 4500);
    void this.#call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
    let reply = '';
    const outgoing: string[] = [];
    const flush = () => {
      if (reply.trim()) outgoing.push(reply.trim());
      reply = '';
    };
    const sends: Promise<unknown>[] = [];
    const onEvent = (ev: ChatEvent) => {
      progress?.event(ev);
      // Fixes 2.47: her pictures (a selfie asked for here) and screenshots were made and never arrived.
      if (isOwner) out.onEvent(ev);
      if (ev.type === 'token') reply += ev.text;
      else if (ev.type === 'replace') reply = ev.text;
      else if (ev.type === 'context') fill = { used: ev.used, budget: ev.budget, dropped: ev.dropped };
      else if (ev.type === 'tool_call') flush();
      else if (ev.type === 'claim_check') {
        // The flagged reply is replaced by her correction.
        if (ev.correcting) reply = '';
        else flush();
      } else if (ev.type === 'notice') sends.push(this.send(chatId, `ℹ️ ${isOwner && ev.key ? this.#tr(ev.key, ev.params) : ev.text}`));
      else if (ev.type === 'approval' && isOwner) {
        sends.push(
          this.send(chatId, `${this.#tr('She wants to: {what}', { what: ev.summary })}${ev.contradiction ? `
⚠️ ${this.#tr('This goes against something you decided: “{note}”', { note: ev.contradiction.note })}` : ''}${ev.sandbox ? `
🧪 ${this.#tr('Ran in a sandbox copy first: {files}. Allow applies only these file changes; Deny discards them.', { files: `+${ev.sandbox.counts.added} ~${ev.sandbox.counts.changed} −${ev.sandbox.counts.removed}` })}${ev.sandbox.verdict === 'flagged' ? ` ⚠️ ${ev.sandbox.findings.filter((x) => x.severity === 'high' || x.severity === 'medium').map((x) => x.title).join('; ')}` : ''}` : ''}${ev.advisory ? `\n🛡️ ${this.#tr('Known vulnerability: {packages}. Allow installs it anyway (recorded as your override).', { packages: ev.advisory.packages.map((p) => `${p.name} ${p.version} (${p.vulns.map((v) => v.id).slice(0, 2).join(', ')})`).join('; ') })}` : ''}`, {
            reply_markup: { inline_keyboard: [[{ text: this.#tr('Allow'), callback_data: `ap:${ev.approvalId}:1` }, { text: this.#tr('Deny'), callback_data: `ap:${ev.approvalId}:0` }]] },
          }),
        );
      } else if (ev.type === 'error') {
        flush();
        // Phase 115 (§4.5): a model that can't take pictures gets a plain line on bridges.
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
      const room = conv.channel.startsWith('telegram-work') ? roomConversation(app, 'telegram', String(chatId)) : undefined;
      // Phase 110 (CH4, §7.5): with keep-up on, "the room right now" (fed from the room log) instead of the raw lines.
      const now = chatId < 0 && where ? await roomTurn(app, 'telegram', String(chatId), { replyTo: where.replyTo ?? null, callerId: where.msgId ?? null, conversationId: conv.id }).catch(() => ({}) as Awaited<ReturnType<typeof roomTurn>>) : {};
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
    // The progress message turns into its summary line (its edit waits behind her answer in the pacer).
    const closing = progress?.finish().catch(() => undefined);
    await Promise.allSettled(sends);
    // Pictures first (her reply as the caption when it fits), then files, then her text.
    if (out.items.length && where) {
      const sent = await deliverOutgoing(app, app.store.getConversation(conv.id) ?? conv, { bridge: 'telegram', chatKey: String(chatId), place: where.place, lang: ownerLanguage(app) }, this.#mediaPort(chatId), out.items, outgoing.length === 1 && !errorLines.has(outgoing[0]) ? outgoing[0] : '').catch((err: Error) => {
        if (err instanceof DeliveryUncertain) throw err;
        return { captionUsed: false, lines: [this.#tr("I couldn't send the picture here ({reason}). It's in the app.", { reason: err.message.slice(0, 120) })] };
      });
      if (sent.captionUsed) outgoing.splice(0, 1);
      outgoing.push(...sent.lines);
    }
    // Phase 119: the auto pickup's marker first; the ⏰ buttons and the pickup offer after her reply.
    const extras = where && isOwner ? afterTurnExtras(app, conv.id, where.place) : undefined;
    if (extras?.before) outgoing.unshift(extras.before);
    let since = started;
    for (const t of outgoing) {
      // Spoken replies: short ones as a voice note (with code or long text, as text).
      if (voice && t.length <= 1200 && !t.includes('```')) {
        void this.#call('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => undefined);
        if (await this.sendVoice(chatId, t)) continue;
      }
      await paceLikeTyping(app, t, since, () => void this.#call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined));
      await this.send(chatId, t);
      since = Date.now();
    }
    await closing?.catch(() => undefined);
    for (const row of extras?.rows ?? []) await this.send(chatId, row.text, row.buttons.length ? { reply_markup: { inline_keyboard: [row.buttons.map((b) => ({ text: b.label, callback_data: b.data }))] } } : {}).catch(() => undefined);
    // Phase 107 (§4.7): nearly full: she offers /new once (in a room he works in, privately to him).
    if (where) {
      const fresh = app.store.getConversation(conv.id) ?? conv;
      const line = nearlyFullOffer(app, fresh, fill, where.lang, where.place);
      if (line) await this.send(where.place === 'work-room' ? where.ownerChat : chatId, `ℹ️ ${line}`).catch(() => undefined);
    }
  }

  /** Phase 115 (BR1 §4.8): the progress message of one turn (posted after `afterSeconds`, edited in place). */
  #progress(conv: Conversation, chatId: number): ProgressMessage {
    const app = this.#app;
    const ps = progressSettings(app);
    const lang = ownerLanguage(app);
    const kb = (stop: boolean) => ({ inline_keyboard: stop ? [[{ text: `⏹ ${tr(en('Stop'), lang)}`, callback_data: `st:${conv.id}` }]] : [] });
    const notModified = (err: Error) => {
      if (!/not modified/i.test(err.message)) throw err;
    };
    return new ProgressMessage({
      port: {
        createQueued: true,
        create: async (text, stop) => {
          const m = await this.#sendNative<{ message_id?: number }>('sendMessage', { chat_id: chatId, text, reply_markup: kb(stop) }, PRIO_EDIT);
          return m?.message_id !== undefined ? String(m.message_id) : undefined;
        },
        edit: (ref, text, stop) => this.#call('editMessageText', { chat_id: chatId, message_id: Number(ref), text, reply_markup: kb(stop) }).then(() => undefined, notModified),
        remove: (ref) => this.#call('deleteMessage', { chat_id: chatId, message_id: Number(ref) }).then(() => undefined),
      },
      queue: this.sendq,
      key: `tg:${chatId}`,
      clock: this.#clock,
      afterMs: ps.afterSeconds * 1000,
      // A group's 20-a-minute cap is shared with her replies.
      intervalMs: chatId < 0 ? 6000 : 3000,
      final: ps.final,
      lang,
      owner: true,
      scrub: (t) => app.redactor.redact(t),
      onOpen: (ref) => openProgress(app, conv.id, 'telegram', String(chatId), ref),
      onClose: () => closeProgress(app, conv.id),
    }).start();
  }

  /** Phase 115 (BR1 §4.3): photos (sendPhoto, or an album) and documents, multipart like sendVoice. */
  #mediaPort(chatId: number): MediaPort {
    const blob = (path: string, mime: string) => new Blob([new Uint8Array(readFileSync(path))], { type: mime });
    return {
      maxPhotoBytes: TELEGRAM_PHOTO_OUT,
      maxFileBytes: TELEGRAM_FILE_OUT,
      captionMax: 1024,
      sendPhotos: async (files, caption) => {
        if (files.length === 1) {
          const form = new FormData();
          form.append('chat_id', String(chatId));
          form.append('photo', blob(files[0].path, files[0].mime), files[0].name);
          if (caption) form.append('caption', caption);
          const m = await this.#sendUpload<{ photo?: { file_id: string }[] }>('sendPhoto', form);
          return [m?.photo?.at(-1)?.file_id ?? ''];
        }
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('media', JSON.stringify(files.map((f, n) => ({ type: 'photo', media: `attach://p${n}`, ...(n === 0 && caption ? { caption } : {}) }))));
        files.forEach((f, n) => form.append(`p${n}`, blob(f.path, f.mime), f.name));
        const list = await this.#sendUpload<{ photo?: { file_id: string }[] }[]>('sendMediaGroup', form, caption);
        return (list ?? []).map((m) => m.photo?.at(-1)?.file_id ?? '');
      },
      sendFile: async (f, caption) => {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('document', blob(f.path, f.mime), f.name);
        if (caption) form.append('caption', caption.slice(0, 1024));
        const m = await this.#sendUpload<{ document?: { file_id: string } }>('sendDocument', form);
        return m?.document?.file_id;
      },
    };
  }

  /** Phase 115: a small test picture to the owner's chat (Settings → Telegram → Send me a test picture). */
  async testPicture(png: Buffer): Promise<void> {
    const chat = telegramSettings(this.#app).ownerChatId;
    if (!chat) throw new Error(en('Link your Telegram first.'));
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'test.png');
    form.append('caption', this.#tr('A test picture from Sara. Pictures and files reach you here.'));
    await this.#sendUpload('sendPhoto', form);
  }

  /** E4: linked to the owner's own private chat (a group id is negative and never counts) and running. */
  ownerLinked(): boolean {
    const id = telegramSettings(this.#app).ownerChatId;
    return Boolean(this.#abort) && typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
  }

  /** E4: a short note to the owner's own private chat only (watch alerts he turned on). */
  async toOwner(text: string): Promise<boolean> {
    if (!this.ownerLinked()) return false;
    try {
      await this.send(telegramSettings(this.#app).ownerChatId!, text);
      return true;
    } catch (err) {
      this.#error = (err as Error).message;
      return false;
    }
  }

  /** Reminders and messages she starts herself also go to the owner's Telegram. */
  async #mirror(ev: HubEvent): Promise<void> {
    if (ev.type !== 'message' || ev.message.role === 'notice') return;
    const cfg = telegramSettings(this.#app);
    if (!cfg.ownerChatId) return;
    const conv = this.#app.store.getConversation(ev.conversationId);
    if (conv?.partner) return;
    // Her chats with an owner and owner work groups get their own reminders back where they were set.
    const ownChat = conv && !conv.partner && (conv.channel === 'telegram' || conv.channel.startsWith('telegram-work')) && conv.channelKey ? Number(conv.channelKey) : undefined;
    const isTelegramConv = ownChat !== undefined;
    if (!isTelegramConv && !cfg.mirror) return;
    await this.send(ownChat ?? cfg.ownerChatId, ev.reason === 'reminder' ? `⏰ ${ev.message.content}` : ev.message.content).catch((err: Error) => {
      this.#error = err.message;
    });
  }
}
