// Phase 6: Telegram bridge. Long polling (no public webhook needed). The owner links their account
// with a one-time code; their DMs go to one owner conversation with everything (tools via
// Approve/Deny buttons, memory, reminders). Other people only if the owner allows it: then each
// chat is a "partner" conversation with no tools, no memory, no adult content and its own AI
// disclosure. Groups: Sara answers when mentioned or replied to.
// Phase 43: more owners by user ID; owners can work with her (tools) in groups when allowed; she
// can also answer to her name without the @ and to @all / @everyone; adult groups by ID.
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
  reply_to_message?: { from?: TgUser };
  entities?: { type: string; offset: number; length: number }[];
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
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

  constructor(app: AppContext, opts: { apiBase?: string } = {}) {
    this.#app = app;
    this.#apiBase = opts.apiBase ?? 'https://api.telegram.org';
  }

  get #token(): string | undefined {
    return this.#app.vault.get(TELEGRAM_VAULT);
  }

  status(): { running: boolean; bot: string | null; linked: boolean; error: string | null } {
    return { running: Boolean(this.#abort), bot: this.#bot?.username ?? null, linked: Boolean(telegramSettings(this.#app).ownerChatId), error: this.#error ?? null };
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
        const updates = await this.#call<TgUpdate[]>('getUpdates', { offset: this.#offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, AbortSignal.any([signal, AbortSignal.timeout(65_000)]));
        backoff = 1000;
        this.#error = undefined;
        for (const u of updates) {
          this.#offset = u.update_id + 1;
          await this.handle(u).catch((err: Error) => console.warn(`telegram: ${err.message}`));
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
    for (const part of splitMessage(text)) await this.#call('sendMessage', { chat_id: chatId, text: part, ...extra });
  }

  /** Handles one update (public for tests). */
  async handle(u: TgUpdate): Promise<void> {
    const cfg = telegramSettings(this.#app);
    if (u.callback_query) {
      const q = u.callback_query;
      const m = q.data?.match(/^ap:([\w-]+):([01])$/);
      if (m && isTelegramOwner(cfg, q.from.id)) {
        const ok = this.#app.approvals.decide(m[1], m[2] === '1');
        await this.#call('answerCallbackQuery', { callback_query_id: q.id, text: this.#tr(ok ? (m[2] === '1' ? en('Allowed') : en('Denied')) : en('No longer waiting')) });
        if (q.message) await this.#call('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
      } else await this.#call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => undefined);
      return;
    }
    const msg = u.message;
    if (!msg?.from || msg.from.is_bot) return;
    const text = (msg.text ?? msg.caption ?? '').trim();
    const isPrivate = msg.chat.type === 'private';

    // Linking: /start CODE or /link CODE in a private chat.
    const link = text.match(/^\/(?:start|link)(?:@\w+)?\s+(\d{6})$/);
    if (isPrivate && link) {
      if (this.#link && this.#link.code === link[1] && Date.now() < this.#link.expires) {
        this.#link = undefined;
        this.#app.settings.update({ telegram: { ...cfg, ownerChatId: msg.chat.id } });
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
    // One turn at a time per conversation, in order.
    const prev = this.#queues.get(conv.id) ?? Promise.resolve();
    const next = prev.then(() => this.#turn(conv, msg.chat.id, content, isOwner, replyWithVoice, docs)).catch((err: Error) => console.warn(`telegram turn: ${err.message}`));
    this.#queues.set(conv.id, next);
    await next;
  }

  #called(msg: TgMessage, text: string, cfg: TelegramSettings): boolean {
    const me = this.#bot?.username ? `@${this.#bot.username}` : '';
    if (me && text.toLowerCase().includes(me.toLowerCase())) return true;
    if (msg.reply_to_message?.from?.id === this.#bot?.id) return true;
    if (cfg.answerName && nameCalled(text, this.#app.persona.name)) return true;
    return Boolean(cfg.answerEveryone && everyoneCalled(text));
  }

  #conversation(msg: TgMessage, isOwnerChat: boolean, ownerWork = false): Conversation {
    const key = String(msg.chat.id);
    const nsfw = msg.chat.type !== 'private' && (telegramSettings(this.#app).nsfwChatIds ?? []).includes(msg.chat.id);
    // Owner work in a group is its own conversation ("-work"): tools and memory, but the group is
    // shared, so it stays non-sexual unless the group is an adult one.
    const channel = ownerWork ? (nsfw ? 'telegram-work-nsfw' : 'telegram-work') : nsfw ? 'telegram-nsfw' : 'telegram';
    const existing = this.#app.store.findChannelConversation(channel, key, isOwnerChat || ownerWork ? 'owner' : 'partner');
    if (existing) return existing;
    const group = `the group "${msg.chat.title ?? 'group'}"`;
    const partner = isOwnerChat || ownerWork ? null : msg.chat.type === 'private' ? msg.from?.first_name || msg.from?.username || 'someone' : group;
    const title = isOwnerChat ? 'Telegram' : ownerWork ? `Telegram work: ${group}` : `Telegram: ${partner}`;
    return this.#app.store.createConversation({ title, channel, channelKey: key, partner });
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

  async #turn(conv: Conversation, chatId: number, content: string, isOwner: boolean, voice = false, docs: SharedDoc[] = []): Promise<void> {
    const app = this.#app;
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
      // Spoken replies: short ones as a voice note (with code or long text, as text).
      if (voice && t.length <= 1200 && !t.includes('```')) {
        void this.#call('sendChatAction', { chat_id: chatId, action: 'record_voice' }).catch(() => undefined);
        if (await this.sendVoice(chatId, t)) continue;
      }
      await paceLikeTyping(app, t, since, () => void this.#call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined));
      await this.send(chatId, t);
      since = Date.now();
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
