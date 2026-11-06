// Phase 107 (CH1): chat commands in every channel (docs/design/CHATS.md §4, building block B1).
//
// One layer for every bridge (Telegram, Discord, plugin bridges) and the web app: it reads a line
// as a command (a native menu command, a typed /new or !new, or her name and one command word when
// that is the whole message), checks on the server who may run it in this place, runs it against a
// small adapter the bridge provides, and returns the reply in the asker's language. Commands never
// go to a model and never become messages of the conversation: a `command:<name>` notice is stored
// instead, so the web view shows what happened. The platform's menus are only a display: Telegram
// scopes and Discord's permissions are never trusted (§2.1, §2.2, §4.3).
import { createHash } from 'node:crypto';
import { contextFill, resolveFor, type AppContext } from '../chat.ts';
import { appLanguage, en, toLang, tr as translate } from '../i18n.ts';
import { identityOf } from '../persona.ts';
import { localDate } from '../memory-worker.ts';
import type { Conversation } from '../store.ts';
import { nextPlaceholder } from '../titles.ts';
import { turnBudgetFor, turnBudgetSettings } from '../budget.ts';
import { checkFromWords, goalsFor, parseGoalCommand } from '../goals.ts';
import { fmtEvery, loopsFor, parseLoopCommand } from '../loops.ts';
import { checkOptions, defaultChecks } from '../persist.ts';
import { answerFire, idFromList, mentionLines, mentionSettings, mergeMentionSettings, ownChat, parseWhenCommand, rememberList, setMention } from '../mentions.ts';
import { pickupsFor, placeName } from '../pickup.ts';
import { leanSettings as leanSettingsOf } from '../lean.ts';
import { compactAllowed as compactAllowedOf, getFold as getFoldSync, undoFold as undoFoldSync } from '../compact.ts';

export type CommandName = 'new' | 'reset' | 'stop' | 'status' | 'help' | 'model' | 'remember' | 'start' | 'settings' | 'bug' | 'idea' | 'progress' | 'steer' | 'queue' | 'btw' | 'goal' | 'loop' | 'when' | 'continue' | 'problems' | 'compact' | 'tools';
/** Where the line was written: his DM, someone else's DM, a shared room, a room where he works with her. */
export type Place = 'owner-dm' | 'partner-dm' | 'room' | 'work-room';
/** Who wrote it (decided by the bridge from the platform user id, never by a name). */
export type Asker = 'owner' | 'person' | 'bot';

/** The commands in the platforms' menus, in menu order. */
// Phase 119 (RECALL §5.4, §11 Q14): /continue is in the menus; /when is typed (and in /help).
// Phase 123 (LEAN §5.9, §11 Q8): /compact is in the menus, next to /new; /tools is typed.
export const MENU_COMMANDS = ['new', 'compact', 'reset', 'stop', 'status', 'help', 'model', 'remember', 'continue'] as const;
// Phase 113: /bug and /idea (Report a problem, Suggest something) are typed, not in the menus.
// Phase 115 (BR1): /progress on|off (the live progress message in this chat), typed, owner only.
// Phase 116 (BR2 §5.7): /steer, /queue and /btw take text (owner only; /queue also for someone in their own DM).
export const BUSY_COMMANDS = ['steer', 'queue', 'btw'] as const;
// Phase 118 (PERSIST §4.10, §5.8): /goal and /loop, typed, owner only, never in someone else's chat.
export const PERSIST_COMMANDS = ['goal', 'loop'] as const;
/** Phase 119: owner-only commands that don't exist for anyone else (their line stays a normal message). */
export const OWNER_ONLY_COMMANDS: ReadonlySet<CommandName> = new Set(['when', 'continue', 'problems']);
const ALL: readonly CommandName[] = [...MENU_COMMANDS, 'start', 'settings', 'bug', 'idea', 'progress', ...BUSY_COMMANDS, ...PERSIST_COMMANDS, 'when', 'problems', 'tools'];
export const isCommandName = (s: string): s is CommandName => (ALL as readonly string[]).includes(s);

/** One line per command (menus and /help). The owner's /status says more than the one others get. */
export const DESCRIPTIONS: Record<CommandName, string> = {
  new: en('Start a fresh session (the last one is kept)'),
  reset: en('Clear a stuck reply and listen again'),
  stop: en('Stop her current reply'),
  status: en('Model, how full this chat is, and budget'),
  help: en('What you can do here'),
  model: en('Pick the model for this session'),
  remember: en('Save a note in her memory'),
  start: en('Say hello'),
  settings: en('Where her settings are'),
  bug: en('Report a problem to the people who make Sara'),
  idea: en('Suggest something to the people who make Sara'),
  progress: en('Show or hide her progress message in this chat (on / off)'),
  steer: en('Tell her something now: she reads it before her next step'),
  queue: en('Queue a message for when she has finished'),
  btw: en('A quick side question while she works (not saved)'),
  goal: en('Keep going until it’s done: a goal for this chat that only a check you pick can end'),
  loop: en('Repeat something in this chat on a timer, until a time or a condition'),
  when: en('Reminders for when a person or topic comes up (list, add, forget)'),
  continue: en('Pick up our chat from your other app here'),
  problems: en('The latest type errors in this chat’s project (check, on, off)'),
  compact: en('Tidy the older part of this chat into a summary (undo, show)'),
  tools: en('Which tools she has in this chat (all, lean, +name, -name)'),
};
/** /status as others see it (no model, no budget). */
export const PUBLIC_STATUS = en('How full this chat is');

/**
 * Words for the name form (\"Sara new\"), in the six languages, without accents (matched after
 * folding). `remember` and `model` take an argument, so they need the slash or ! form.
 */
export const COMMAND_WORDS: Readonly<Partial<Record<CommandName, readonly string[]>>> = {
  new: ['new', 'nuevo', 'nueva', 'nouveau', 'nouvelle', 'neu', 'novo', 'nova', 'nuovo', 'nuova'],
  reset: ['reset', 'reiniciar', 'restablecer', 'reinitialiser', 'zurucksetzen', 'redefinir', 'reimposta', 'resetta'],
  stop: ['stop', 'para', 'parar', 'detente', 'arrete', 'arreter', 'stopp', 'halt', 'ferma', 'fermati'],
  status: ['status', 'estado', 'statut', 'etat', 'stato'],
  help: ['help', 'ayuda', 'aide', 'hilfe', 'ajuda', 'aiuto'],
  // Phase 123 (LEAN §4.9, §5.9).
  compact: ['compact', 'compactar', 'resumir', 'ordenar', 'compacter', 'kompakt', 'compattare'],
  tools: ['tools', 'herramientas', 'outils', 'werkzeuge', 'ferramentas', 'strumenti'],
};

/** Discord's localised command names (lowercase, its naming rule) by Discord locale. */
export const DISCORD_NAMES: Readonly<Record<(typeof MENU_COMMANDS)[number], Record<string, string>>> = {
  new: { 'es-ES': 'nuevo', fr: 'nouveau', de: 'neu', 'pt-BR': 'novo', it: 'nuovo' },
  reset: { 'es-ES': 'reiniciar', fr: 'réinitialiser', de: 'zurücksetzen', 'pt-BR': 'redefinir', it: 'reimposta' },
  stop: { 'es-ES': 'detener', fr: 'arrêter', de: 'stopp', 'pt-BR': 'parar', it: 'ferma' },
  status: { 'es-ES': 'estado', fr: 'statut', de: 'status', 'pt-BR': 'status', it: 'stato' },
  help: { 'es-ES': 'ayuda', fr: 'aide', de: 'hilfe', 'pt-BR': 'ajuda', it: 'aiuto' },
  model: { 'es-ES': 'modelo', fr: 'modèle', de: 'modell', 'pt-BR': 'modelo', it: 'modello' },
  remember: { 'es-ES': 'recordar', fr: 'retenir', de: 'merken', 'pt-BR': 'lembrar', it: 'ricorda' },
  continue: { 'es-ES': 'continuar', fr: 'continuer', de: 'fortsetzen', 'pt-BR': 'continuar', it: 'continua' },
  compact: { 'es-ES': 'compactar', fr: 'compacter', de: 'kompakt', 'pt-BR': 'compactar', it: 'compattare' },
};
/** Sara's languages → Discord locales and Telegram language codes (two letters; pt-BR is `pt`). */
export const DISCORD_LOCALES: Readonly<Record<string, string>> = { es: 'es-ES', fr: 'fr', de: 'de', 'pt-BR': 'pt-BR', it: 'it' };
export const TELEGRAM_LANGS: Readonly<Record<string, string>> = { es: 'es', fr: 'fr', de: 'de', 'pt-BR': 'pt', it: 'it' };
export const OTHER_LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;

/** Owner settings for commands (Settings → Telegram / Discord → Commands). */
export interface ChatsSettings {
  continuity?: { enabled?: boolean };
  /** R1B: shared roleplay scenes (default on; malformed fails closed in shared-scenes-policy.ts). */
  scenes?: { enabled?: boolean };
  commands?: { native?: boolean; namePrefix?: boolean };
  offerNew?: boolean;
  /** Phase 109 (CH3): titles that grow (src/titles.ts `titleSettings`). */
  titles?: { auto?: boolean; model?: 'local' | 'quick'; dailyCap?: number };
}
export function chatsSettings(app: AppContext): { native: boolean; namePrefix: boolean; offerNew: boolean } {
  const c = (app.settings.get() as { chats?: ChatsSettings }).chats ?? {};
  return { native: c.commands?.native !== false, namePrefix: c.commands?.namePrefix !== false, offerNew: c.offerNew !== false };
}

/**
 * Who may run what, where (§4.3). Bots run nothing. The owner runs everything everywhere. Someone
 * else: in their own private chat new, reset, stop, status and help; in a room only help and the
 * short status. /start is open (the bridge keeps today's hello for others).
 */
export function commandAllowed(place: Place, who: Asker, name: CommandName): boolean {
  if (who === 'bot') return false;
  if (who === 'owner') return true;
  if (OWNER_ONLY_COMMANDS.has(name)) return false;
  if (name === 'help' || name === 'status' || name === 'start') return true;
  return place === 'partner-dm' && (name === 'new' || name === 'reset' || name === 'stop' || name === 'queue');
}

/**
 * Phase 128 (PL2b, POLISH2 §4.3, N19): the `/` menu in the app's message box, in this order. One list
 * for the menu, the generated command table in docs/CHATS.md and the drift test against the Telegram
 * and Discord menus (test/phase128b). Lines come from DESCRIPTIONS. `args`: the command takes words
 * after it (the menu leaves a space). `own`: only in your own one-to-one chats (not in group chats,
 * partner chats or off the record). `member`: a household member may use it in their own space too.
 */
export const APP_MENU: readonly { name: CommandName; args?: boolean; own?: boolean; member?: boolean }[] = [
  { name: 'goal', args: true, own: true },
  { name: 'loop', args: true, own: true },
  { name: 'compact', own: true },
  { name: 'tools', own: true },
  { name: 'when', args: true, own: true },
  { name: 'continue', own: true },
  { name: 'btw', args: true, member: true },
  { name: 'queue', args: true, member: true },
  { name: 'steer', args: true, member: true },
  { name: 'stop', member: true },
  { name: 'new', member: true },
  { name: 'reset', member: true },
  { name: 'status', member: true },
  { name: 'model', args: true, own: true },
  { name: 'remember', args: true, own: true },
  { name: 'problems', own: true },
  { name: 'help', member: true },
  { name: 'bug', args: true, member: true },
  { name: 'idea', args: true, member: true },
];
/** GET /api/chat-menu: the menu for the owner or a household member, in the app's language. */
export function appMenu(app: AppContext, o: { member: boolean }): { name: CommandName; line: string; args: boolean; own: boolean }[] {
  const lang = ownerLanguage(app);
  return APP_MENU.filter((c) => !o.member || c.member).map((c) => ({ name: c.name, line: say(app, lang, DESCRIPTIONS[c.name]), args: Boolean(c.args), own: Boolean(c.own) }));
}
/** The command table of docs/CHATS.md (between <!-- appmenu:start --> and <!-- appmenu:end -->), generated by scripts/gen-guide.ts. */
export function appMenuTable(): string {
  const rows = APP_MENU.map((c) => `| \`/${c.name}\` | ${DESCRIPTIONS[c.name]} | ${c.member ? 'You and household members' : c.own ? 'You, in your own chats' : 'You'} |`);
  return ['| Command | What it does | Who sees it in the app |', '|---|---|---|', ...rows].join('\n');
}

/** The command table per place (GET /api/chats/commands, the help page, tests). */
export function commandTable(): { name: CommandName; description: string; places: Record<Place, { owner: boolean; person: boolean }> }[] {
  const places: Place[] = ['owner-dm', 'partner-dm', 'room', 'work-room'];
  return ALL.map((name) => ({ name, description: DESCRIPTIONS[name], places: Object.fromEntries(places.map((p) => [p, { owner: commandAllowed(p, 'owner', name), person: commandAllowed(p, 'person', name) }])) as Record<Place, { owner: boolean; person: boolean }> }));
}

export interface ParsedCommand {
  name: CommandName;
  args: string;
  form: 'native' | 'typed' | 'name';
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TYPED = /^[/!]([a-z_]{2,32})(?:@(\w+))?(?:\s+([\s\S]*))?$/i;

/**
 * Reads one line as a command (§4.4), or undefined for a normal message. `/new@otherbot` is for
 * another bot (not a command). Unknown words stay messages (people type /shrug). The name form
 * counts only when the whole message is her name (or @bot) and one command word.
 */
export function parseCommand(text: string, o: { herName: string; botUsername?: string; namePrefix: boolean; addressed?: boolean }): ParsedCommand | undefined {
  let t = text.trim();
  if (!t || t.length > 4000) return undefined;
  // `addressed`: the bridge already removed a leading mention of her (Discord's <@id>).
  let addressed = o.addressed === true;
  if (o.botUsername) {
    const lead = new RegExp(`^@${esc(o.botUsername)}(?![\\w])[\\s,:]*`, 'i');
    if (lead.test(t)) {
      t = t.replace(lead, '');
      addressed = true;
    }
  }
  const m = TYPED.exec(t);
  if (m) {
    const name = m[1].toLowerCase();
    if (m[2] && (!o.botUsername || m[2].toLowerCase() !== o.botUsername.toLowerCase())) return undefined;
    if (!isCommandName(name)) return undefined;
    return { name, args: (m[3] ?? '').trim(), form: 'typed' };
  }
  if (!o.namePrefix) return undefined;
  let rest = t;
  if (!addressed) {
    const n = o.herName.trim();
    if (!n) return undefined;
    const lead = new RegExp(`^@?${esc(n)}(?![\\p{L}\\p{N}_])[\\s,:;!.\\-–—]*`, 'iu');
    if (!lead.test(rest)) return undefined;
    rest = rest.replace(lead, '');
  }
  // "Sara, status?" is a question to her, not a command: no question mark.
  const w = /^(\p{L}+)[\s.!]*$/u.exec(rest);
  if (!w) return undefined;
  const word = fold(w[1]);
  for (const [name, words] of Object.entries(COMMAND_WORDS) as [CommandName, readonly string[]][]) if (words.includes(word)) return { name, args: '', form: 'name' };
  return undefined;
}

/** A platform's language code (Telegram `language_code`, Discord `locale`) → one of the six, else English. */
export function askerLanguage(code: unknown): string {
  return toLang(code) ?? 'en';
}

/** What a bridge lets the command layer do (§3.1 B1). */
export interface BridgeAdapter {
  /** The asker's current session here (undefined: none yet). */
  currentSession(): Conversation | undefined;
  /** Opens the next session after `prev` (or the first one when there is none). */
  startSession(prev: Conversation | undefined): Conversation;
  /** Work rooms: the room's own conversation (`/new room` starts its next session; his /stop stops it too). */
  roomSession?(): Conversation | undefined;
  /** Stops a running turn there (true when one was running). */
  stopTurn(conversationId: string): boolean;
  /** Drops turns waiting in this bridge's queue for the conversation; returns how many. */
  clearQueue(conversationId: string): number;
  /** Resets the bot loop guard of this channel (Discord). */
  resetGuard?(): void;
  /** Where her settings are (a link when the server knows its address). */
  settingsWhere?: string;
  /** Phase 113: the app's address for "open the report sheet" (when the server knows it). */
  appLink?: string;
  /** Phase 115 (BR1): this chat's place for /progress (bridge and chat key; the choice lives on its room row). */
  progressKey?: { bridge: string; key: string };
  /**
   * Phase 116 (BR2 §5.7): /steer and /queue with their text (the bridge's own runner keeps its reply
   * path). Returns the line to say ('' = nothing, e.g. a reaction was set instead).
   */
  take?(kind: 'steer' | 'queue', text: string): Promise<string> | string;
}

export interface ModelPick {
  providerId: string;
  provider: string;
  model: string;
}

export interface CommandReply {
  /** What to say ('' = nothing). */
  text: string;
  /** Owner-only details: ephemeral on Discord, sent to the owner's DM from a Telegram group. */
  ownerOnly?: boolean;
  /** Refused for this asker (one short line, nothing else happened). */
  refused?: boolean;
  /** /model without a name: the choices (buttons, a select, a numbered list) for `conversationId`. */
  choices?: ModelPick[];
  conversationId?: string;
  /** /remember waiting for the owner's OK: the approval to show Allow/Deny for, and the line after it. */
  approval?: { id: string; summary: string; done: Promise<string> };
  /** The session /new opened. */
  opened?: Conversation;
  /** Phase 113: the web app opens the report sheet with this (from /bug or /idea). */
  report?: { kind: 'bug' | 'idea'; text: string };
  /** Phase 116: a /btw answer (marked as a side note; never stored). */
  aside?: boolean;
  /** Phase 123: buttons under the reply (Telegram inline keyboard, Discord components); plugin bridges get the typed form. */
  buttons?: { label: string; data: string }[];
}

export interface CommandContext {
  app: AppContext;
  /** 'telegram' | 'discord' | 'plugin-<name>' | 'web' */
  bridge: string;
  place: Place;
  who: Asker;
  /** The asker's language (the owner: the app language; others: what the platform says). */
  lang: string;
  cmd: ParsedCommand;
  adapter: BridgeAdapter;
}

/** Translates a command reply for the asker (the companion's name filled in). */
export function say(app: AppContext, lang: string, text: string, params?: Record<string, unknown>): string {
  return translate(text, lang, params, identityOf(app.persona));
}

/** The owner's language (the app language), for owner replies. */
export const ownerLanguage = (app: AppContext): string => appLanguage(app.settings.get());

/** Stores the `command:<name>` notice the web view shows (never sent to a model). */
function notice(app: AppContext, conv: Conversation | undefined, name: CommandName | 'offer', meta: Record<string, unknown> = {}): void {
  if (!conv) return;
  const m = app.store.addMessage(conv.id, 'notice', `command:${name}`, { command: name, ...meta });
  app.events?.publish({ type: 'message', conversationId: conv.id, message: { id: m.id, role: m.role, content: m.content, createdAt: m.createdAt, meta: m.meta }, reason: 'proactive' });
}

/** Ends `prev` and opens the next session of the same chat (same project; a clean start). Used by /new and the web route. */
export function nextSession(app: AppContext, prev: Conversation, overrides: { title?: string } = {}): Conversation {
  app.store.endConversation(prev.id);
  const next = app.store.createConversation({
    // Phase 109 (CH3): a fresh placeholder with the day ("Telegram · Oct 31"), not the old session's title.
    title: overrides.title ?? nextPlaceholder(app, prev),
    titleSource: 'placeholder',
    channel: prev.channel,
    channelKey: prev.channelKey,
    partner: prev.partner,
    workspace: prev.workspace,
    mode: prev.mode,
    private: prev.private,
    projectId: prev.projectId,
    sessionOf: prev.sessionOf ?? prev.id,
  });
  notice(app, prev, 'new', { to: next.id });
  notice(app, next, 'new', { from: prev.id, title: prev.title });
  // An owner session is summarised now by the memory worker (partner chats have no memory by rule).
  if (!prev.partner) app.memoryNudge?.();
  // Phase 109: the closed session gets its final title from what it covered (when it had 6 new messages).
  void app.titles?.atNew(prev.id);
  return next;
}

/** Runs one command (already parsed) and returns what to say. Permissions are checked here, every time. */
export async function runCommand(c: CommandContext): Promise<CommandReply> {
  const { app, cmd, place, who } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (!commandAllowed(place, who, cmd.name)) {
    if (who === 'bot') return { text: '', refused: true };
    if (cmd.name === 'remember') return { text: tr("I don't keep memories in this chat."), refused: true };
    if (cmd.name === 'model') return { text: tr('Only the person who runs me can change that.'), refused: true };
    return { text: tr('Only the person who runs me can use that here.'), refused: true };
  }
  const conv = c.adapter.currentSession();
  switch (cmd.name) {
    case 'help':
    case 'start':
      // Phase 120 (PRECISE §5.8): /help refs lists the @-references typed in a chat.
      if (cmd.name === 'help' && /^(refs?|references?|@)$/i.test(cmd.args.trim()) && who === 'owner') return { text: refsHelp(app, c) };
      return { text: helpText(app, c) };
    case 'settings':
      return { text: c.adapter.settingsWhere ? tr('Her settings: {where}', { where: c.adapter.settingsWhere }) : tr('Open Sara, then Settings → {bridge}.', { bridge: bridgeName(c.bridge) }), ownerOnly: true };
    case 'new':
      return newCommand(c, conv);
    case 'reset':
      return resetCommand(c, conv);
    case 'stop': {
      // Phase 118: /stop stops the turn and pauses the chat's goal (a loop's tick stops; the loop stays).
      const goalWas = conv ? app.goals?.standing(conv.id) : undefined;
      if (conv && who === 'owner') app.goals?.onStopCommand(conv.id);
      let stopped = conv ? c.adapter.stopTurn(conv.id) : false;
      if (goalWas && (goalWas.state === 'running' || goalWas.state === 'checking')) stopped = true;
      // In a room he works in, his /stop also stops her reply to the room.
      if (place === 'work-room' && c.adapter.roomSession) {
        const room = c.adapter.roomSession();
        if (room && c.adapter.stopTurn(room.id)) stopped = true;
      }
      if (!stopped) return { text: '' };
      notice(app, conv, 'stop');
      return { text: tr('Stopped.') };
    }
    case 'status':
      return statusCommand(c, conv);
    case 'model':
      return modelCommand(c, conv);
    case 'remember':
      return rememberCommand(c, conv);
    case 'bug':
    case 'idea':
      return reportCommand(c, conv);
    case 'progress':
      return progressCommand(c);
    case 'steer':
    case 'queue':
      return takeCommand(c);
    case 'btw':
      return btwCommand(c, conv);
    case 'goal':
      return goalCommand(c, conv);
    case 'loop':
      return loopCommand(c, conv);
    case 'when':
      return whenCommand(c, conv);
    case 'continue':
      return continueCommand(c, conv);
    case 'problems':
      return problemsCommand(c, conv);
    case 'compact':
      return compactCommand(c, conv);
    case 'tools':
      return toolsCommand(c, conv);
  }
}

/** Phase 123 (LEAN §5.9): /compact [focus] · /compact undo · /compact show (owner only, his DM and work session). */
async function compactCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (c.place === 'partner-dm' || c.place === 'room') return { text: tr('Only the person who runs me can use that here.'), refused: true };
  const { compactAllowed, compactNow, foldSummaryText, undoFold } = await import('../compact.ts');
  if (!conv || !talked(app, conv)) return { text: tr('This chat is already short; nothing to tidy.') };
  if (!compactAllowed(app, conv)) return { text: tr("I don't tidy this kind of chat."), refused: true };
  const arg = c.cmd.args.trim();
  const sub = fold(arg);
  if (/^(undo|deshacer|annuler|ruckgangig|desfazer|annulla)$/.test(sub)) {
    const r = undoFold(app, conv.id);
    return { text: r ? tr('Untidied: she reads the earlier messages again.') : tr('Nothing is tidied in this chat.') };
  }
  if (/^(show|mostrar|montrer|zeigen|mostra)$/.test(sub)) {
    const t = foldSummaryText(app, conv.id);
    return { text: t ? `${tr('The tidy summary:')}\n${t}` : tr('Nothing is tidied in this chat.') };
  }
  const run = async (): Promise<string> => {
    const r = await compactNow(app, conv, { ...(arg ? { focus: arg } : {}), trigger: c.bridge === 'web' ? 'command' : 'command', place: c.bridge });
    if ('skipped' in r) return r.skipped === 'refused' ? tr("I can't keep that in a summary.") : r.skipped === 'not-here' ? tr("I don't tidy this kind of chat.") : tr('This chat is already short; nothing to tidy.');
    const f = r.fold;
    const how = f.kind === 'plain' ? tr('as a plain list') : f.local ? tr('written on this computer') : tr('written by the quick model');
    const extra = f.kind === 'plain' && f.safety.why === 'cap' ? ` ${tr("Today's tidy budget is used up.")}` : '';
    return `${tr('Tidied {n} earlier messages into a summary ({how}).', { n: f.folded, how })}${extra} ${tr('Send /compact undo to put them back, or /compact show to read it.')}`;
  };
  // A turn in progress is never changed: the tidy waits until she's done (at most 10 minutes).
  if (app.isBusy?.(conv.id)) {
    void (async () => {
      for (let i = 0; i < 600 && app.isBusy?.(conv.id); i++) await new Promise((r) => setTimeout(r, 1000));
      await run().catch(() => undefined);
    })();
    return { text: tr("She's working; I'll tidy when she's done.") };
  }
  const text = await run();
  const cur = (await import('../compact.ts')).currentFold(app, conv.id);
  return { text, ...(cur && text.includes('/compact undo') ? { buttons: [{ label: tr('Undo'), data: `cu:${cur.id}` }] } : {}) };
}

/** Phase 123 (LEAN §4.9): /tools · /tools all · /tools lean · /tools +name · /tools -name (zero model calls). */
async function toolsCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (c.place === 'partner-dm' || c.place === 'room' || app.member) return { text: tr('Only the person who runs me can use that here.'), refused: true };
  const lean = await import('../lean.ts');
  const cv = conv ?? c.adapter.startSession(undefined);
  lean.ensureLeanTables(app.store.db);
  const arg = c.cmd.args.trim();
  const turn = app.store.messages(cv.id).filter((m) => m.role === 'user').at(-1)?.id ?? 0;
  if (/^all$/i.test(arg)) {
    lean.setLeanOff(app.store.db, cv.id, true);
    return { text: tr('Every tool is offered in this chat now. /tools lean goes back to the short list.'), ownerOnly: c.place === 'work-room' };
  }
  if (/^lean$/i.test(arg)) {
    lean.setLeanOff(app.store.db, cv.id, false);
    return { text: tr('Back to the short list in this chat.'), ownerOnly: c.place === 'work-room' };
  }
  const pm = /^([+-])\s*([\w:.-]{2,80})$/.exec(arg);
  if (pm) {
    const name = pm[2];
    const known = app.tools.list().some((t) => t.spec.name === name || lean.familyOf(t).id === name || lean.familyOf(t).id.replace(/^(mcp|plugin):/, '') === name);
    if (!known) return { text: tr('No tool or group called “{name}” here.', { name }), ownerOnly: c.place === 'work-room' };
    lean.setChatPin(app.store.db, cv.id, name, pm[1] === '+', turn, app.now().toISOString());
    return { text: pm[1] === '+' ? tr('{name} is offered every turn in this chat.', { name }) : tr('{name} is back to “when needed”.', { name }), ownerOnly: c.place === 'work-room' };
  }
  return { text: lean.toolsReport(app, cv), ownerOnly: c.place === 'work-room' };
}

/** Phase 120 (PRECISE §5.8): the six reference forms, in his language. */
function refsHelp(app: AppContext, c: CommandContext): string {
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  return [
    tr('Attach with @ (type it in your message):'),
    `@file:src/app.ts · @file:src/app.ts:10-25: ${tr('a file, or some of its lines')}`,
    `@folder:src: ${tr('a folder’s file list')}`,
    `@diff · @diff:staged: ${tr('your uncommitted changes')}`,
    `@branch: ${tr('this branch compared with the default branch')}`,
    `@problem: ${tr('the latest type errors')}`,
    `@url:https://…: ${tr('a web page')}`,
  ].join('\n');
}

/** Phase 120 (PRECISE §4.13): /problems · /problems check · /problems on · /problems off (owner only). */
async function problemsCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (c.place === 'partner-dm' || c.place === 'room') return { text: tr('Only the person who runs me can use that here.'), refused: true };
  if (!conv) return { text: tr('No project in this chat.'), ownerOnly: true };
  const { checksDb, fullCheck, latestProblems, projectsOf, diagLine } = await import('../diagnostics.ts');
  const { wsOf } = await import('../persist.ts');
  let ws: string;
  try {
    ws = wsOf(app, conv);
  } catch {
    return { text: tr('No project in this chat.'), ownerOnly: true };
  }
  const project = projectsOf(ws)[0];
  if (!project) return { text: tr('No project in this chat.'), ownerOnly: true };
  const workspace = conv.workspace || 'main';
  const arg = fold(c.cmd.args.trim());
  const db = checksDb(app);
  if (arg === 'off' || arg === 'on') {
    const cur = db.choice(workspace, project.path);
    const { detectCheckers } = await import('../diagnostics.ts');
    db.setChoice({ ...cur, state: arg, checkers: cur.checkers.length ? cur.checkers : detectCheckers(project.dir).filter((k) => k.installed).map((k) => k.id), decidedAt: app.now().toISOString() });
    return { text: arg === 'off' ? tr('Checks after her edits are off in this project.') : tr('Checks after her edits are on in this project.'), ownerOnly: c.place === 'work-room' };
  }
  if (arg === 'check') await fullCheck(app, workspace, ws, project, AbortSignal.timeout(300_000));
  const p = latestProblems(app, workspace, project.path);
  if (!p.checked) return { text: tr('No checks have run in this project yet. Send /problems check to run one.'), ownerOnly: c.place === 'work-room' };
  const errs = p.diags.filter((d) => d.severity === 'error');
  if (!errs.length) return { text: tr('No type errors in this project.'), ownerOnly: c.place === 'work-room' };
  const lines = errs.slice(0, 10).map(diagLine);
  return { text: `${tr('{n} type errors:', { n: errs.length })}\n${lines.join('\n')}${errs.length > 10 ? `\n${tr('and {n} more', { n: errs.length - 10 })}` : ''}`, ownerOnly: c.place === 'work-room' };
}

/** Phase 119 (RECALL §4.2, §4.7): /when · /when Dan: he owes me $20 · /when forget 2 · again 2 · keep 2 · off · on. */
function whenCommand(c: CommandContext, conv: Conversation | undefined): CommandReply {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  // In a work room it answers him privately (ephemeral / his DM); in someone else's chat or a room: one line.
  if (c.place === 'partner-dm' || c.place === 'room') return { text: tr('I keep those for our own chats.'), refused: true };
  const work = c.place === 'work-room';
  const p = parseWhenCommand(c.cmd.args);
  const key = `${c.bridge}:${conv?.id ?? ''}`;
  const pl = app.planner;
  if (!pl) return { text: tr('The planner is not available here.'), ownerOnly: true };
  switch (p.sub) {
    case 'list': {
      if (work) return { text: tr('Say /when in our own chat: I keep those for our own chats.'), ownerOnly: true };
      const lines = mentionLines(app);
      rememberList(key, lines.map((l) => l.id));
      return { text: lines.length ? `${tr('When it comes up:')}\n${lines.map((l, i) => `${i + 1}. ${l.line}`).join('\n')}` : tr('Nothing is waiting to come up. Add one like this: /when {example}', { example: 'Dan: he owes me $20' }) };
    }
    case 'help':
      return { text: tr('Add one like this: /when {example}', { example: 'Dan: he owes me $20' }), ownerOnly: work };
    case 'off':
    case 'on':
      mergeMentionSettings(app, { on: p.sub === 'on' });
      return { text: p.sub === 'off' ? tr('Paused. Say /when on to turn them back on.') : tr('On again. Reminders you asked for come up when you mention them.'), ownerOnly: work };
    case 'forget':
    case 'again':
    case 'keep': {
      const id = idFromList(key, p.n);
      const r = pl.reminder(id);
      if (!r || r.trigger !== 'mention') return { text: tr('No reminder #{n}. Send /when for the list.', { n: p.n }), ownerOnly: work };
      if (p.sub === 'forget') pl.cancelReminder(id);
      else pl.rearmMention(id, app.now());
      app.events?.publish({ type: 'planner', what: 'reminders' });
      return { text: p.sub === 'forget' ? tr('Forgot #{id}: “{text}”.', { id, text: r.text }) : tr('#{id} will come up again next time: “{text}”.', { id, text: r.text }), ownerOnly: work };
    }
    case 'set': {
      if (work || !ownChat(app, conv ?? c.adapter.currentSession())) return { text: tr('Say it to me in our own chat: I keep those for our own chats.'), ownerOnly: true };
      const cv = conv ?? c.adapter.startSession(undefined);
      // A name ("Dan") is a person key when it's a card; other words are a topic.
      const isName = /^\p{Lu}[\p{L}'’-]*$/u.test(p.topic);
      const r = setMention(app, { text: p.text, ...(isName ? { person: p.topic } : { topic: p.topic }), each: p.each, conversationId: cv.id });
      if (!r.ok) return { text: tr(r.message) };
      const st = mentionSettings(app);
      return { text: [tr('⏰ When {what} comes up: “{text}”', { what: r.card.what, text: r.reminder.text }), r.reminder.each ? tr('Every time ({n} times at most)', { n: st.each.fires }) : tr('Once'), tr('#{id} · /when forget {id} to undo', { id: r.reminder.id })].join('\n'), conversationId: cv.id };
    }
  }
}

/** Phase 119 (RECALL §5.4): /continue · here · 2 · telegram|discord|app|signal… · off. */
function continueCommand(c: CommandContext, conv: Conversation | undefined): CommandReply {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (c.place !== 'owner-dm' || app.member) return { text: tr('Not in a shared room: I pick up our own chats only.'), refused: true, ownerOnly: true };
  const pk = pickupsFor(app);
  const cv = conv ?? c.adapter.startSession(undefined);
  if (!pk || !pk.takesPart(cv)) return { text: tr('Not in a shared room: I pick up our own chats only.'), refused: true };
  const arg = fold(c.cmd.args.trim()).replace(/^here\b\s*/, '');
  if (/^(off|undo|stop|no)$/.test(arg)) {
    const was = pk.undo(cv.id);
    return { text: was ? tr('Undone: I let go of our chat from {place}. Nothing was copied.', { place: tr(placeName(was.sourceChannel)) }) : tr('Nothing is picked up here.'), conversationId: cv.id };
  }
  let list = pk.candidates(cv.id);
  if (!list.length) return { text: tr("There's nothing recent in your other chats to pick up."), conversationId: cv.id };
  const n = /^\d$/.test(arg) ? Number(arg) : 0;
  if (arg && !n) {
    const want = arg === 'app' || arg === 'web' ? 'web' : arg;
    list = list.filter((x) => x.from === want || x.from === `plugin-${want}` || x.from.startsWith(want));
    if (!list.length) return { text: tr("There's nothing recent in your other chats to pick up."), conversationId: cv.id };
  }
  if (!n && !arg && list.length > 1) {
    return { text: [tr('Which one?'), ...list.map((x, i) => `${i + 1}. ${tr(x.place)} · ${x.place === 'the app' && x.title && !x.preview.startsWith(x.title.replace(/…$/, '').slice(0, 40)) ? `“${x.title}” · ` : ''}${x.ago} · “${x.preview}”`), tr('Send /continue 2 for the second.')].join('\n'), conversationId: cv.id };
  }
  const pick = n ? list[n - 1] : list[0];
  if (!pick) return { text: tr('Send /continue 2 for the second.'), conversationId: cv.id };
  const r = pk.make(cv.id, pick.sourceId, 'command');
  if ('error' in r) return { text: tr(r.error), conversationId: cv.id };
  notice(app, cv, 'continue', { pickup: r.pickup.id });
  const folder = r.pickup.carried?.workspace ? ` ${tr('and the folder {folder}', { folder: r.pickup.carried.workspace })}` : '';
  return { text: `${tr('↪ Picking up from {place} ({ago}): “{preview}”', { place: tr(pick.place), ago: pick.ago, preview: pick.preview })}${folder}`, conversationId: cv.id };
}

/** Phase 119: a ⏰ button or a pickup button in a chat app (owner checked by the bridge). */
export function chatButton(app: AppContext, data: string): { text: string; edit?: string } | undefined {
  const lang = ownerLanguage(app);
  const tr = (text: string, params?: Record<string, unknown>) => say(app, lang, text, params);
  const wm = /^wm:(\d+):(done|again|forget)$/.exec(data);
  if (wm) {
    const r = answerFire(app, Number(wm[1]), wm[2] as 'done' | 'again' | 'forget');
    if (!r.ok) return { text: tr('No longer waiting') };
    return { text: wm[2] === 'done' ? tr('Done') : wm[2] === 'again' ? tr('It will come up again next time.') : tr('Forgotten.') };
  }
  // Phase 123: Undo under a /compact reply.
  const cu = /^cu:(\d+)$/.exec(data);
  if (cu) {
    const f = getFoldSync(app, Number(cu[1]));
    if (!f || f.undoneAt) return { text: tr('No longer waiting') };
    undoFoldSync(app, f.conversationId, f.id);
    return { text: tr('Untidied: she reads the earlier messages again.'), edit: tr('Untidied: she reads the earlier messages again.') };
  }
  const pk = /^pk:([0-9a-f]{16}):([01])$/.exec(data);
  if (pk) {
    const pks = pickupsFor(app);
    const row = pks?.get(pk[1]);
    if (!pks || !row || row.state !== 'offered') return { text: tr('No longer waiting') };
    if (pk[2] === '0') {
      pks.decline(row.id);
      return { text: tr('Okay, not now.'), edit: '' };
    }
    const r = pks.make(row.targetId, row.sourceId, 'offer', row.id);
    if ('error' in r) return { text: tr(r.error) };
    return { text: tr('↪ Continued from {place}', { place: tr(placeName(row.sourceChannel)) }), edit: tr('↪ Continued from {place}', { place: tr(placeName(row.sourceChannel)) }) };
  }
  return undefined;
}

/** Phase 118 (§4.10): /goal <text> [done when …] · start · pause · resume · stop · check … · status. */
function goalCommand(c: CommandContext, conv: Conversation | undefined): CommandReply {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (c.place === 'partner-dm' || c.place === 'room' || app.member) return { text: tr('Goals and repeats only work in your own chats with her.'), refused: true };
  const goals = goalsFor(app);
  const cv = conv ?? c.adapter.startSession(undefined);
  const p = parseGoalCommand(c.cmd.args);
  const g = goals.current(cv.id);
  const err = (r: { status: number; error: string }) => ({ text: tr(r.error) });
  switch (p.sub) {
    case 'status':
      return { text: g ? goals.statusLine(g) : tr('No goal in this chat. Say /goal and what she should keep going at.') };
    case 'start': {
      if (!g || g.state !== 'draft') return { text: tr('There is no goal waiting to start here.') };
      const r = goals.start(g.id);
      return 'error' in r ? err(r) : { text: goals.statusLine(r.goal) };
    }
    case 'pause':
      return { text: g ? goals.statusLine(goals.pause(g.id) ?? g) : tr('No goal in this chat. Say /goal and what she should keep going at.') };
    case 'resume': {
      if (!g) return { text: tr('No goal in this chat. Say /goal and what she should keep going at.') };
      const more = g.reason?.startsWith('cap:') ? { rounds: g.reason === 'cap:rounds' ? 2 : 0, minutes: g.reason === 'cap:minutes' ? 30 : 0, tokens: g.reason === 'cap:tokens' ? 500_000 : 0 } : {};
      const r = goals.resume(g.id, more);
      return 'error' in r ? err(r) : { text: goals.statusLine(r.goal) };
    }
    case 'stop':
      return { text: g ? goals.statusLine(goals.stop(g.id) ?? g) : tr('No goal in this chat. Say /goal and what she should keep going at.') };
    case 'retry': {
      if (!g) return { text: tr('No goal in this chat. Say /goal and what she should keep going at.') };
      const r = goals.retry(g.id);
      return 'error' in r ? err(r) : { text: goals.statusLine(r.goal) };
    }
    case 'check': {
      if (!g) return { text: tr('No goal in this chat. Say /goal and what she should keep going at.') };
      const r = goals.setChecks(g.id, [checkFromWords(p.check)]);
      return 'error' in r ? err(r) : { text: goals.statusLine(r.goal) };
    }
    case 'set': {
      const checks = p.check ? [checkFromWords(p.check)] : defaultChecks(checkOptions(app, cv));
      if (!checks.length) return { text: tr('Say what has to pass, like: /goal {example}', { example: 'make it green done when `npm test`' }) };
      const r = goals.create(cv.id, { text: p.text, checks, source: c.bridge, replace: g?.state === 'draft' });
      if ('error' in r) return err(r);
      const x = r.goal;
      return {
        text: [
          tr('🎯 Keep going until it’s done: {text}', { text: x.text }),
          tr('Done when: {check}', { check: x.checks.map((k) => k.words).join(' + ') }),
          tr('Up to {rounds} rounds · {minutes} min · {tokens} tokens', { rounds: x.caps.rounds, minutes: x.caps.minutes, tokens: x.caps.tokens.toLocaleString('en-US') }),
          tr('Send /goal start to begin.'),
        ].join('\n'),
        conversationId: cv.id,
      };
    }
  }
}

/** Phase 118 (§5.8): /loop every 10m[ for 1h | until 14:30 | 12 times][ until …]: … · start · list · pause/resume/stop [n|all]. */
function loopCommand(c: CommandContext, conv: Conversation | undefined): CommandReply {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (c.place === 'partner-dm' || c.place === 'room' || app.member) return { text: tr('Goals and repeats only work in your own chats with her.'), refused: true };
  const loops = loopsFor(app);
  const cv = conv ?? c.adapter.startSession(undefined);
  const p = parseLoopCommand(c.cmd.args);
  const err = (r: { status: number; error: string }) => ({ text: tr(r.error) });
  const live = loops.forConversation(cv.id).filter((l) => !['done', 'ended', 'stopped', 'draft'].includes(l.state));
  switch (p.sub) {
    case 'error':
      return { text: tr(p.error) };
    case 'list': {
      const lines = loops.listLines(cv.id);
      return { text: lines.length ? lines.join('\n') : tr('No repeats in this chat.') };
    }
    case 'start': {
      const d = loops.forConversation(cv.id).filter((l) => l.state === 'draft').at(-1);
      if (!d) return { text: tr('There is no repeat waiting to start here.') };
      const r = loops.start(d.id);
      return 'error' in r ? err(r) : { text: loops.listLines(cv.id).join('\n') };
    }
    case 'pause':
    case 'resume':
    case 'stop': {
      const targets = p.all ? live : p.n ? live.slice(p.n - 1, p.n) : live.length === 1 ? live : [];
      if (!targets.length) return { text: live.length ? loops.listLines(cv.id).join('\n') : tr('No repeats in this chat.') };
      for (const l of targets) {
        if (p.sub === 'pause') loops.pause(l.id);
        else if (p.sub === 'stop') loops.stop(l.id);
        else {
          const r = loops.resume(l.id);
          if ('error' in r) return err(r);
        }
      }
      return { text: loops.listLines(cv.id).join('\n') || tr('No repeats in this chat.') };
    }
    case 'set': {
      const r = loops.create(cv.id, { ...p.spec, source: c.bridge });
      if ('error' in r) return err(r);
      const l = r.loop;
      const card = loops.plan(p.spec);
      const ticks = card.ok ? card.card.ticks : l.maxTicks;
      const quiet = card.ok ? card.card.quietHours : '';
      return {
        text: [
          tr('🔁 Repeat in this chat: {prompt}', { prompt: l.prompt }),
          tr('{every} · for {hours} h · at most {n} times', { every: fmtEvery(l.everyMin), hours: Math.round(((card.ok ? card.card.forMin : 0) / 60) * 10) / 10, n: l.maxTicks }),
          tr('Quiet hours {hours}: no checks then. She tells you only when something changes.', { hours: quiet }),
          tr('About {n} replies, up to {tokens} tokens each.', { n: ticks, tokens: l.tickBudget.tokens.toLocaleString('en-US') }),
          tr('Send /loop start to begin.'),
        ].join('\n'),
        conversationId: cv.id,
      };
    }
  }
}

/** Phase 116 (BR2 §5.7): /steer and /queue. */
async function takeCommand(c: CommandContext): Promise<CommandReply> {
  const tr = (text: string, params?: Record<string, unknown>) => say(c.app, c.lang, text, params);
  const text = c.cmd.args.trim();
  if (!text) return { text: c.cmd.name === 'steer' ? tr('Tell me what to change after the command, like: /steer {example}', { example: 'use pnpm, not npm' }) : tr('Tell me what to do next after the command, like: /queue {example}', { example: 'then update the docs' }) };
  if (!c.adapter.take) return { text: tr('That only works in a chat with her.') };
  return { text: await c.adapter.take(c.cmd.name === 'steer' ? 'steer' : 'queue', text) };
}

/** Phase 116 (BR2 §5.6): /btw, a side question beside the work (nothing stored, no tools). */
async function btwCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const tr = (text: string, params?: Record<string, unknown>) => say(c.app, c.lang, text, params);
  const q = c.cmd.args.trim();
  const { answerAside, BTW_LINES } = await import('../btw.ts');
  if (!q) return { text: tr(BTW_LINES.empty), ownerOnly: true };
  const session = conv ?? c.adapter.startSession(undefined);
  const r = await answerAside(c.app, session, q, { owner: c.who === 'owner' });
  return { text: r.ok ? `💬 ${r.text}` : `💬 ${tr(r.key)}`, ownerOnly: true, aside: true };
}

/** Phase 116: "Cleared." plus how many waiting messages went (for /reset and /new). */
export function droppedLine(app: AppContext, lang: string, n: number): string {
  if (n <= 0) return '';
  return ` ${n === 1 ? say(app, lang, en('1 waiting message was dropped.')) : say(app, lang, en('{count} waiting messages were dropped.'), { count: n })}`;
}

/** Phase 115 (BR1): /progress on|off sets this chat's progress message; /progress alone says the state. */
async function progressCommand(c: CommandContext): Promise<CommandReply> {
  const tr = (text: string, params?: Record<string, unknown>) => say(c.app, c.lang, text, params);
  const k = c.adapter.progressKey;
  if (!k) return { text: tr('Progress messages are not available in this chat.') };
  const { progressOn, setRoomFlag } = await import('./media.ts');
  const arg = fold(c.cmd.args.trim());
  const on = /^(on|yes|si|oui|ja|sim|an|ein)$/.test(arg) ? true : /^(off|no|non|nein|nao|aus)$/.test(arg) ? false : undefined;
  if (on !== undefined) setRoomFlag(c.app, k.bridge, k.key, 'progress', on);
  const now = progressOn(c.app, k.bridge, k.key, c.place);
  return { text: now ? tr('Progress messages are on in this chat: on long jobs one message shows what I am doing. /progress off hides it.') : tr('Progress messages are off in this chat. /progress on shows them on long jobs.') };
}

const bridgeName = (b: string): string => (b === 'telegram' ? 'Telegram' : b === 'discord' ? 'Discord' : b === 'web' ? 'Sara' : b.replace(/^plugin-/, ''));

function helpText(app: AppContext, c: CommandContext): string {
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  const lines = (MENU_COMMANDS as readonly CommandName[])
    .filter((n) => commandAllowed(c.place, c.who, n))
    .map((n) => `/${n}: ${tr(n === 'status' && c.who !== 'owner' ? PUBLIC_STATUS : DESCRIPTIONS[n])}`);
  if (c.who === 'owner' && c.place === 'work-room') lines.push(`/new room: ${tr('Also start a new conversation for the whole room')}`);
  if (c.who === 'owner') for (const n of ['bug', 'idea'] as const) lines.push(`/${n}: ${tr(DESCRIPTIONS[n])}`);
  if (c.who === 'owner' && (c.place === 'owner-dm' || c.place === 'work-room')) lines.push(`/progress: ${tr(DESCRIPTIONS.progress)}`);
  if (c.who === 'owner') for (const n of BUSY_COMMANDS) lines.push(`/${n}: ${tr(DESCRIPTIONS[n])}`);
  if (c.who === 'owner' && c.place === 'owner-dm') lines.push(`/when: ${tr(DESCRIPTIONS.when)}`);
  if (c.who === 'owner' && (c.place === 'owner-dm' || c.place === 'work-room')) lines.push(`/problems: ${tr(DESCRIPTIONS.problems)}`, `/help refs: ${tr('Attach a file, your changes or a web page with @')}`);
  const name = chatsSettings(app).namePrefix && c.bridge !== 'web' ? `\n${tr('You can also write just my name and the word, like "{example}".', { example: `${app.persona.name} ${c.lang === 'de' ? 'neu' : 'new'}` })}` : '';
  return `${tr('What you can do here:')}\n${lines.join('\n')}${name}`;
}

async function newCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  const room = /^(room|sala|salle|raum|sala|stanza|everyone|all)$/i.test(fold(c.cmd.args.trim()));
  // Owner-only: "/new room" in a room he works in also starts a new conversation for the room.
  if (room && c.place === 'work-room' && c.who === 'owner' && c.adapter.roomSession) {
    const old = c.adapter.roomSession();
    const fresh = old ? nextSession(app, old) : undefined;
    const mine = conv && talked(app, conv) ? c.adapter.startSession(conv) : conv;
    return { text: tr('New session started for you and for the room. I kept the last ones.'), ...(mine ?? fresh ? { opened: (mine ?? fresh)! } : {}) };
  }
  if (!conv) {
    const fresh = c.adapter.startSession(undefined);
    return { text: tr('New session started.'), opened: fresh };
  }
  // Nothing said yet in this session: no need to close it.
  if (!talked(app, conv)) return { text: tr('This session is already fresh.'), opened: conv };
  c.adapter.stopTurn(conv.id);
  const dropped = c.adapter.clearQueue(conv.id);
  const fresh = c.adapter.startSession(conv);
  return { text: tr('New session started. I kept the last one ("{title}").', { title: conv.title }) + droppedLine(app, c.lang, dropped), opened: fresh };
}

/** Something was said in this session (a /new on an empty one changes nothing). */
const talked = (app: AppContext, conv: Conversation): boolean => app.store.messages(conv.id).some((m) => m.role === 'user' || m.role === 'assistant');

async function resetCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  if (!conv) return { text: tr("Cleared. I'm listening.") };
  // Waiting approvals are denied first (counted), then the turn is stopped and the queue emptied.
  let denied = 0;
  for (const id of app.approvals.pendingFor(conv.id)) if (app.approvals.decide(id, false)) denied++;
  // Phase 118: /reset stops the chat's goal and pauses its repeats.
  let paused = 0;
  if (c.who === 'owner') {
    app.goals?.onResetCommand(conv.id);
    paused = app.loops?.pauseAll(conv.id) ?? 0;
  }
  c.adapter.stopTurn(conv.id);
  const dropped = c.adapter.clearQueue(conv.id);
  c.adapter.resetGuard?.();
  // Let a stopped turn save its partial reply first (at most a second; Discord must answer in 3).
  for (let i = 0; i < 20 && app.isBusy?.(conv.id); i++) await new Promise((r) => setTimeout(r, 50));
  const last = app.store.messages(conv.id).filter((m) => m.role !== 'notice').at(-1);
  if (last?.role === 'user' && last.meta?.skipped !== true) app.store.updateMessageMeta(last.id, { skipped: true });
  notice(app, conv, 'reset', denied ? { denied } : {});
  const more = denied === 1 ? ` ${tr('1 request was cancelled.')}` : denied > 1 ? ` ${tr('{count} requests were cancelled.', { count: denied })}` : '';
  const reps = paused ? ` ${tr('{n} repeat(s) paused.', { n: paused })}` : '';
  return { text: `${tr("Cleared. I'm listening.")}${more}${droppedLine(app, c.lang, dropped)}${reps}` };
}

/** \"12.3k\" */
const k = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

async function statusCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  const fill = conv ? contextFill(app, conv) : { percent: 0, dropped: 0, used: 0, budget: 0 };
  if (c.who !== 'owner') return { text: tr("I'm {name}, an AI companion. This chat is {n}% full.", { name: app.persona.name, n: fill.percent }) };
  const lines: string[] = [];
  try {
    // No session here yet: what the first one would use (her default model).
    const { provider, model } = resolveFor(app, conv ?? ({ id: '', title: '', providerId: null, model: null, workspace: 'main', mode: 'chat', private: false, channel: c.bridge, channelKey: null, partner: null, projectId: null, archivedAt: null, tags: [], createdAt: '', updatedAt: '' } as Conversation), 'turn');
    lines.push(tr('Model: {model} ({provider})', { model, provider: provider.config.label }));
  } catch {
    lines.push(tr('Model: none set up yet'));
  }
  lines.push(tr('Context used: {n}%', { n: fill.percent }) + (fill.dropped > 0 ? ` (${tr('older parts left out')})` : ''));
  if (conv) {
    const msgs = app.store.messages(conv.id).filter((m) => m.role === 'user' || m.role === 'assistant').length;
    const mins = Math.max(0, Math.round((app.now().getTime() - new Date(conv.createdAt).getTime()) / 60_000));
    const age = mins < 60 ? tr('{n} min', { n: mins }) : mins < 48 * 60 ? tr('{n} h', { n: Math.round(mins / 60) }) : tr('{n} days', { n: Math.round(mins / 1440) });
    lines.push(tr('This session: {age}, {count} messages', { age, count: msgs }));
  } else lines.push(tr('No session here yet.'));
  if (app.usage) {
    const since = new Date(app.now().getTime() - 24 * 3600_000).toISOString();
    const t = app.usage.summary(since).total;
    const cost = t.billing.includes('api') ? tr('about ${usd}', { usd: t.usd.toFixed(2) }) : tr('no charge (local or subscription)');
    lines.push(tr('Last 24 hours: {tokens} tokens, {cost}', { tokens: k(t.tokens), cost }));
  }
  const budget = turnBudgetFor(turnBudgetSettings(app.settings.get()), conv?.mode === 'coding' || conv?.channel.includes('-work') ? 'coding' : 'chat');
  lines.push(budget?.tokens ? tr('Budget per reply: {tokens} tokens', { tokens: k(budget.tokens) }) : tr('Budget per reply: off'));
  const job = app.settings.get().jobBudget;
  if (job?.tokens || job?.usd) lines.push(tr('Budget per job: {limit}', { limit: [job.tokens ? `${k(job.tokens)} tokens` : '', job.usd ? `$${job.usd}` : ''].filter(Boolean).join(' · ') }));
  // Phase 118: one line for this chat's goal, one per repeat.
  const g = conv ? app.goals?.current(conv.id) : undefined;
  if (g && g.state !== 'draft') lines.push(app.goals!.statusLine(g));
  if (conv && app.loops) lines.push(...app.loops.listLines(conv.id));
  // Phase 119: while a pickup carries here.
  const pk = conv ? pickupsFor(app)?.statusLine(conv.id) : undefined;
  if (pk) lines.push(pk);
  return { text: lines.join('\n'), ownerOnly: true };
}

/** The models the owner can pick (the same list as the web picker: every connected provider's chat models). */
export async function modelChoices(app: AppContext): Promise<ModelPick[]> {
  const { connectedModels } = await import('../modelpicks.ts');
  const all = await connectedModels(app).catch(() => []);
  const seen = new Set<string>();
  const out: ModelPick[] = [];
  for (const m of all) {
    if (/embed|bge-|\be5-|gte-|minilm|whisper|tts|rerank/i.test(m.model)) continue;
    const key = `${m.providerId}\u0000${m.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerId: m.providerId, provider: m.provider, model: m.model });
  }
  const order = new Map(app.settings.get().providers.map((p, i) => [p.id, i]));
  return out.sort((a, b) => (order.get(a.providerId) ?? 99) - (order.get(b.providerId) ?? 99) || a.model.localeCompare(b.model)).slice(0, 100);
}

/** Sets (or clears) the model of one session, from a /model name or a pick. */
export function setSessionModel(app: AppContext, conv: Conversation, pick: ModelPick | 'default', lang: string): string {
  if (pick === 'default') {
    app.store.updateConversation(conv.id, { providerId: null, model: null });
    notice(app, conv, 'model', { model: null });
    return say(app, lang, 'This session uses your default model again.');
  }
  app.store.updateConversation(conv.id, { providerId: pick.providerId, model: pick.model });
  notice(app, conv, 'model', { providerId: pick.providerId, model: pick.model });
  return say(app, lang, 'This session now uses {model}.', { model: `${pick.model} (${pick.provider})` });
}

async function modelCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  const session = conv ?? c.adapter.startSession(undefined);
  const want = c.cmd.args.trim();
  if (/^(default|standard|predeterminado|por defecto|par defaut|defaut|padrao|predefinito)$/i.test(fold(want))) return { text: setSessionModel(app, session, 'default', c.lang), ownerOnly: true };
  const choices = await modelChoices(app);
  if (!want) {
    if (!choices.length) return { text: tr('No models to pick from yet: add one in Settings → Models.'), ownerOnly: true };
    return { text: tr('Pick a model for this session:'), choices: choices.slice(0, 25), conversationId: session.id, ownerOnly: true };
  }
  // "/model 2": the second of the list (plugin bridges show a numbered list).
  if (/^\d{1,3}$/.test(want) && choices[Number(want) - 1]) return { text: setSessionModel(app, session, choices[Number(want) - 1], c.lang), ownerOnly: true };
  const w = want.toLowerCase();
  const exact = choices.filter((m) => m.model.toLowerCase() === w);
  const part = exact.length ? exact : choices.filter((m) => m.model.toLowerCase().includes(w));
  if (part.length === 1) return { text: setSessionModel(app, session, part[0], c.lang), ownerOnly: true };
  if (!part.length) return { text: tr('I don\'t know a model called "{name}". Send /model to see the list.', { name: want.slice(0, 60) }), ownerOnly: true };
  return { text: tr('Several models match. Pick one:'), choices: part.slice(0, 25), conversationId: session.id, ownerOnly: true };
}

async function rememberCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  const session = conv ?? c.adapter.startSession(undefined);
  if (session.partner) return { text: tr("I don't keep memories in this chat."), refused: true };
  const fact = c.cmd.args.replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!fact) return { text: tr('Tell me what to remember, like: /remember {example}', { example: 'I water the ferns on Sundays' }), ownerOnly: true };
  const memory = app.memory;
  if (!memory) return { text: tr("My memory isn't available right now."), ownerOnly: true };
  // The same permission as her remember tool: Settings → Coding → Tools and approvals (remember_fact).
  const set = app.settings.get().toolPermissions?.remember_fact ?? 'auto';
  if (set === 'never') return { text: tr('Remembering on command is turned off in Settings.'), ownerOnly: true };
  const save = () => {
    const m = memory.add({ kind: 'fact', content: fact, conversationId: session.id, sourceMessageId: null, happenedOn: localDate(app.now().toISOString(), app.settings.get().timeZone), evidence: fact });
    notice(app, session, 'remember', { memoryId: m.id });
    return tr('Got it: "{text}".', { text: fact });
  };
  if (set === 'auto') return { text: save(), ownerOnly: true };
  const req = app.approvals.request(session.id, AbortSignal.timeout(10 * 60_000));
  const done = req.decision.then((ok) => (ok ? save() : tr("All right, I won't keep it.")));
  return { text: tr('Remember this? "{text}"', { text: fact }), approval: { id: req.id, summary: tr('Remember: {text}', { text: fact }), done }, ownerOnly: true };
}

/**
 * Phase 113: /bug and /idea. In the web app they open the report sheet (with the text, where the
 * person picks diagnostics). Elsewhere a bare /bug answers with where the sheet is; `/bug <text>`
 * files a quick report without diagnostics once the owner says yes on the confirm card.
 */
async function reportCommand(c: CommandContext, conv: Conversation | undefined): Promise<CommandReply> {
  const { app } = c;
  const kind = c.cmd.name === 'idea' ? 'idea' : 'bug';
  const tr = (text: string, params?: Record<string, unknown>) => say(app, c.lang, text, params);
  const text = c.cmd.args.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (c.bridge === 'web') return { text: kind === 'idea' ? tr('Opening Suggest something…') : tr('Opening Report a problem…'), report: { kind, text } };
  const where = c.adapter.appLink ? tr('Open Sara for the full form with diagnostics: {link}', { link: `${c.adapter.appLink}/#report=${kind}` }) : tr('Open Sara for the full form with diagnostics: Help → Report a problem.');
  if (!app.hub || app.hub.demo) return { text: tr('Reports are not available here.'), ownerOnly: true };
  if (!text) return { text: `${kind === 'idea' ? tr('Tell me your idea after the command, like: /idea {example}', { example: 'a dark mode for the planner' }) : tr('Tell me what went wrong after the command, like: /bug {example}', { example: 'the reminder came an hour late' })}\n${where}`, ownerOnly: true };
  const session = conv ?? c.adapter.startSession(undefined);
  const hub = app.hub;
  const req = app.approvals.request(session.id, AbortSignal.timeout(10 * 60_000));
  const done = req.decision.then(async (ok) => {
    if (!ok) return tr('All right, nothing was sent.');
    const { fileTicket } = await import('../hub.ts');
    const r = await fileTicket(hub, { kind, title: text.slice(0, 120), body: text });
    if (r.ok) return tr('Sent as {ticket}. You can follow it in Sara: Help → My reports.', { ticket: r.ticket });
    if (r.code === 'private') return tr("Reports can't be sent while “Nothing leaves this computer” is on.");
    if (r.code === 'limit') return tr('Too many reports today. Try again tomorrow.');
    return tr("The support desk didn't answer. Try again later.");
  });
  const summary = kind === 'idea' ? tr('Send this idea to the people who make Sara (no diagnostics): {text}', { text }) : tr('Send this problem report to the people who make Sara (no diagnostics): {text}', { text });
  return { text: `${summary}\n${where}`, approval: { id: req.id, summary, done }, ownerOnly: true };
}

// ---------------------------------------------------------------------------------------------
// "Nearly full": she offers /new once per session (§4.7)
// ---------------------------------------------------------------------------------------------

/** The share of the history budget at which she offers a fresh start. */
export const OFFER_AT = 0.85;

/**
 * After a turn: the first time a session crosses 85 % (or leaves older parts out), one app line,
 * once per session, never in a room's own conversation. Returns the line (in `lang`) or undefined.
 */
export function nearlyFullOffer(app: AppContext, conv: Conversation, fill: { used: number; budget: number; dropped: number } | undefined, lang: string, place: Place): string | undefined {
  if (!fill || !chatsSettings(app).offerNew || place === 'room') return undefined;
  if (!(fill.dropped > 0 || (fill.budget > 0 && fill.used / fill.budget >= OFFER_AT))) return undefined;
  if (app.store.messages(conv.id).some((m) => m.role === 'notice' && m.content === 'command:offer')) return undefined;
  // Phase 123 (LEAN §5.7): with automatic tidying on, the fold already happened (or will at the next
  // message); the line only goes out when it is off or the last automatic fold failed.
  const set = leanSettingsOf(app).compact;
  const lastAuto = app.store.messages(conv.id).findLast((m) => m.role === 'notice' && m.content.startsWith('compact:'));
  if (set.auto && compactAllowedOf(app, conv) && !(lastAuto?.meta?.autoOff)) return undefined;
  notice(app, conv, 'offer');
  return say(app, lang, en('This chat is getting long. Send /compact to tidy the older part, or /new for a fresh start.'));
}

// ---------------------------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------------------------

/** A stable hash of what would be registered (registration is skipped when it hasn't changed). */
export const menuHash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** One command list for a menu, in one language. */
export function menuList(app: AppContext, names: readonly CommandName[], lang: string, owner: boolean): { command: string; description: string }[] {
  return names.map((n) => ({ command: n, description: say(app, lang, n === 'status' && !owner ? PUBLIC_STATUS : DESCRIPTIONS[n]).slice(0, 100) }));
}

/**
 * Phase 119: what a chat app adds after her reply in his own DM: the auto pickup's first-line marker
 * (once), the ⏰ buttons for reminders that came up in it, and the pickup offer (once per switch).
 * `plain`: plugin bridges without buttons get one text line each instead.
 */
export function afterTurnExtras(app: AppContext, conversationId: string, place: Place, o: { plain?: boolean } = {}): { before?: string; rows: { text: string; buttons: { label: string; data: string }[] }[] } {
  const out: { before?: string; rows: { text: string; buttons: { label: string; data: string }[] }[] } = { rows: [] };
  if ((place !== 'owner-dm' && place !== 'work-room') || app.member) return out;
  const lang = ownerLanguage(app);
  const tr = (text: string, params?: Record<string, unknown>) => say(app, lang, text, params);
  // Phase 120 (PRECISE §5.8, §4.13): a reference that couldn't be attached (one line before her
  // reply), and the type errors her edits left (one plain line after it).
  {
    const page = app.store.messagesPage(conversationId, { limit: 30 }).messages;
    const lastUser = page.findLast((m) => m.role === 'user');
    const refused = Array.isArray(lastUser?.meta?.refs) ? (lastUser!.meta!.refs as { token: string; ok: boolean; why?: string }[]).filter((r) => !r.ok) : [];
    if (refused.length) out.before = refused.map((r) => tr("(I couldn't attach {token}: {why})", { token: r.token, why: tr(r.why ?? 'Not attached') })).join('\n');
    const lastHer = page.findLast((m) => m.role === 'assistant');
    const chk = lastHer && lastHer.id > (lastUser?.id ?? 0) ? (lastHer.meta?.checks as { state?: string; left?: number; checker?: string; files?: string[] } | undefined) : undefined;
    // Phase 123 (LEAN §5.7): an automatic fold before this reply: one line, once per fold.
    const auto = page.findLast((m) => m.role === 'notice' && m.content.startsWith('compact:') && (m.meta?.trigger === 'auto' || m.meta?.trigger === 'goal') && m.id > (lastUser?.id ?? 0));
    if (auto) out.before = [out.before, tr('(I tidied the older part of this chat to keep it in view. /compact undo to put it back.)')].filter(Boolean).join('\n');
    if (chk?.state === 'left' && chk.left) out.rows.push({ text: tr('⚠ {n} type errors left in {file} ({checker}).', { n: chk.left, file: chk.files?.[0] ?? '', checker: chk.checker ?? '' }), buttons: [] });
  }
  if (place !== 'owner-dm') return out;
  const pk = pickupsFor(app);
  if (pk?.autoMarked.delete(conversationId)) {
    const p = pk.active(conversationId);
    if (p) out.before = tr('↪ continued from {place} · /continue off to undo', { place: tr(placeName(p.sourceChannel)) });
  }
  const last = app.store.messagesPage(conversationId, { limit: 6 }).messages.findLast((m) => m.role === 'assistant');
  const chips = Array.isArray(last?.meta?.mentions) ? (last!.meta!.mentions as { fireId: number; reminderId: number; what: string; text: string; answer?: string | null }[]) : [];
  for (const ch of chips.filter((x) => !x.answer)) {
    out.rows.push(
      o.plain
        ? { text: tr('⏰ {what} came up. Send /when again {id} to keep it for next time.', { what: ch.what, id: ch.reminderId }), buttons: [] }
        : { text: `⏰ ${tr('{what} came up', { what: ch.what })}: “${ch.text}”`, buttons: [{ label: tr('Done'), data: `wm:${ch.fireId}:done` }, { label: tr('Again next time'), data: `wm:${ch.fireId}:again` }, { label: tr('Forget'), data: `wm:${ch.fireId}:forget` }] },
    );
  }
  const offer = pk && !pk.active(conversationId) ? pk.offer(conversationId) : undefined;
  if (offer) {
    out.rows.push(
      o.plain
        ? { text: tr('(Say /continue to pick up where we left off in {place}.)', { place: tr(offer.place) }), buttons: [] }
        : { text: tr('↪ Pick up our chat from {place}?', { place: tr(offer.place) }), buttons: [{ label: tr('Continue here'), data: `pk:${offer.id}:1` }, { label: tr('No'), data: `pk:${offer.id}:0` }] },
    );
  }
  return out;
}
