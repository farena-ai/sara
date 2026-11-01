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
import { askerLanguage, chatsSettings, menuHash, menuList, nearlyFullOffer, nextSession, OTHER_LANGS, ownerLanguage, parseCommand, runCommand, say, setSessionModel, TELEGRAM_LANGS, type Asker, type BridgeAdapter, type CommandName, type CommandReply, type ModelPick, type ParsedCommand, type Place } from './commands.ts';
import { channelProjectId, noteRoom } from './rooms.ts';
import { editLine, keepRoomByKey, leftRoom, logLine, maybeSummarize, noteHerLine, reading, setSeesAll, type KeepRoom, type Who } from './keepup.ts';
import { roomTurn } from './now.ts';

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
  photo?: unknown;
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
  /** Telegram chats waiting for their turn (one turn per conversation at a time). */
  readonly #queues = new Map<string, Promise<void>>();
  /** Phase 107: turns waiting in each queue, and a counter /reset and /new bump to drop them. */
  readonly #waiting = new Map<string, number>();
  readonly #cleared = new Map<string, number>();
  /** Phase 107: the bridge's own Stop for turns it runs without the server's tracking (tests, bare apps). */
  readonly #aborts = new Map<string, AbortController>();
  /** Phase 107: the last /model choices shown per session (the buttons carry their index). */
  readonly #picks = new Map<string, ModelPick[]>();
  /** Phase 107: the command menu registration that is running (tests await it). */
  menus: Promise<unknown> = Promise.resolve();

  constructor(app: AppContext, opts: { apiBase?: string } = {}) {
    this.#app = app;
    this.#apiBase = opts.apiBase ?? 'https://api.telegram.org';
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
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description ?? `HTTP ${res.status}`}`);
    return j.result as T;
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
    const full: CommandName[] = ['new', 'reset', 'stop', 'status', 'help', 'model', 'remember', 'settings'];
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
      const m = await this.#call<{ message_id?: number } | undefined>('sendMessage', { chat_id: chatId, text: part, ...extra });
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
    if (cmd && !(cmd.name === 'start' && !fromOwner) && (isOwnerChat || ownerWork || cfg.allowOthers)) return this.#command(msg, cmd, place, fromOwner);
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
    if (!text && !heard && !docs.length) {
      if (msg.photo) await this.send(msg.chat.id, isOwner ? this.#tr('I can only read text and voice notes here for now. Tell me about it?') : 'I can only read text and voice notes here for now. Tell me about it?');
      return;
    }

    const conv = this.#conversation(msg, isOwnerChat, ownerWork);
    const from = msg.from.first_name || msg.from.username || 'someone';
    const said = heard ? `🎤 ${heard}` : text || (docs.length ? `📄 ${docs[0].name}` : '');
    const content = isPrivate ? said.replace(/^\/start\b\s*/, '') || 'Hi!' : `[${from}]: ${said}`;
    const replyWithVoice = speechOf(this.#app).replyWithVoice(Boolean(heard));
    // One turn at a time per conversation, in order. Phase 107: /reset and /new drop waiting turns.
    const prev = this.#queues.get(conv.id) ?? Promise.resolve();
    const gen = this.#cleared.get(conv.id) ?? 0;
    this.#waiting.set(conv.id, (this.#waiting.get(conv.id) ?? 0) + 1);
    const where = { place, lang: fromOwner ? ownerLanguage(this.#app) : askerLanguage(msg.from.language_code), ownerChat: msg.from.id, msgId: String(msg.message_id), replyTo: msg.reply_to_message?.message_id !== undefined ? String(msg.reply_to_message.message_id) : null };
    const next = prev
      .then(() => {
        if ((this.#cleared.get(conv.id) ?? 0) !== gen) return;
        this.#waiting.set(conv.id, Math.max(0, (this.#waiting.get(conv.id) ?? 1) - 1));
        return this.#turn(conv, msg.chat.id, content, isOwner, replyWithVoice, docs, where);
      })
      .catch((err: Error) => console.warn(`telegram turn: ${err.message}`));
    this.#queues.set(conv.id, next);
    if (!o.queued) await next;
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
      settingsWhere: undefined,
      // Phase 113: /bug and /idea link to the report sheet when the server knows its address.
      ...(accessInfo().url ? { appLink: accessInfo().url! } : {}),
    };
    const r = await runCommand({ app, bridge: 'telegram', place, who, lang, cmd, adapter });
    await this.#deliver(chatId, msg.from!.id, place, r, lang);
  }

  /** Sends a command reply where it belongs: buttons for picks and approvals; owner-only details privately. */
  async #deliver(chatId: number, userId: number, place: Place, r: CommandReply, lang: string): Promise<void> {
    if (!r.text && !r.choices?.length) return;
    const room = place === 'room' || place === 'work-room';
    const to = r.ownerOnly && room && !r.refused ? userId : chatId;
    const extra: Record<string, unknown> = {};
    if (r.choices?.length && r.conversationId) {
      this.#picks.set(r.conversationId, r.choices);
      extra.reply_markup = { inline_keyboard: r.choices.slice(0, 20).map((m, i) => [{ text: `${m.model} · ${m.provider}`.slice(0, 60), callback_data: `md:${r.conversationId}:${i}` }]) };
    } else if (r.approval) {
      extra.reply_markup = { inline_keyboard: [[{ text: say(this.#app, lang, en('Allow')), callback_data: `ap:${r.approval.id}:1` }, { text: say(this.#app, lang, en('Deny')), callback_data: `ap:${r.approval.id}:0` }]] };
      void r.approval.done.then((t) => this.send(to, t)).catch(() => undefined);
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
    const n = this.#waiting.get(conversationId) ?? 0;
    this.#cleared.set(conversationId, (this.#cleared.get(conversationId) ?? 0) + 1);
    this.#waiting.set(conversationId, 0);
    return n;
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
    try {
      const audio = await speech.speak(text);
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([new Uint8Array(audio.data)], { type: audio.type }), audio.type.includes('mpeg') ? 'voice.mp3' : 'voice.ogg');
      const res = await netFetch(`${this.#apiBase}/bot${this.#token}/sendVoice`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!j.ok) throw new Error(j.description ?? `HTTP ${res.status}`);
      return true;
    } catch (err) {
      console.warn(`telegram voice note: ${(err as Error).message.replace(this.#token ?? '', '***')}`);
      return false;
    }
  }

  async #turn(conv: Conversation, chatId: number, content: string, isOwner: boolean, voice = false, docs: SharedDoc[] = [], where?: { place: Place; lang: string; ownerChat: number; msgId?: string; replyTo?: string | null }): Promise<void> {
    const app = this.#app;
    let fill: { used: number; budget: number; dropped: number } | undefined;
    // Wait while a web turn runs in the same conversation.
    for (let i = 0; i < 600 && app.isBusy?.(conv.id); i++) await new Promise((r) => setTimeout(r, 1000));
    const started = Date.now();
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
        if (ev.message !== 'Stopped.') outgoing.push(isOwner ? this.#tr('(Something went wrong: {error})', { error: ev.message }) : "Sorry, I can't answer right now.");
      }
    };
    try {
      // 2.35.1: in a shared channel the owner's side sees the room, and the room hears him (src/bridges/room.ts).
      const room = conv.channel.startsWith('telegram-work') ? roomConversation(app, 'telegram', String(chatId)) : undefined;
      // Phase 110 (CH4, §7.5): with keep-up on, "the room right now" (fed from the room log) instead of the raw lines.
      const now = chatId < 0 && where ? await roomTurn(app, 'telegram', String(chatId), { replyTo: where.replyTo ?? null, callerId: where.msgId ?? null, conversationId: conv.id }).catch(() => ({}) as Awaited<ReturnType<typeof roomTurn>>) : {};
      const note = now.roomNow ? undefined : roomNote(app, room);
      const opts = { ...(docs.length ? { docs } : {}), ...(note ? { roomNote: note } : {}), ...(now.roomNow ? { roomNow: now.roomNow } : {}), ...(now.roomId !== undefined ? { roomId: now.roomId } : {}), ...(now.roomCrisis ? { roomCrisis: true } : {}) };
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
    await Promise.allSettled(sends);
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
    // Phase 107 (§4.7): nearly full: she offers /new once (in a room he works in, privately to him).
    if (where) {
      const fresh = app.store.getConversation(conv.id) ?? conv;
      const line = nearlyFullOffer(app, fresh, fill, where.lang, where.place);
      if (line) await this.send(where.place === 'work-room' ? where.ownerChat : chatId, `ℹ️ ${line}`).catch(() => undefined);
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
