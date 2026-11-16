// E7 (B2s): now and then she sends a picture on her own, like a person would ("here's my walk").
// Off by default. Runs from her life tick (src/life.ts, no timer of its own) under the same rules
// as her own messages: quiet hours, the daily limit (a picture counts as one of her messages), never
// while her last own message is unanswered, only in the owner's own 1:1 chat in the app. At most one
// a day, a monthly limit, and a message is saved only when the picture is really attached.
import { bondContext, type AppContext } from './chat.ts';
import { appLanguage, en, languageLine, talkLanguage } from './i18n.ts';
import { say } from './bridges/commands.ts';
import { personalize } from './identity.ts';
import { complete, inQuiet, proactiveSettings } from './life.ts';
import { localDate } from './memory-worker.ts';
import { appReady, ownerWebChat, ownerWebChats, placeChat } from './destinations.ts';
import { ownerEvidenceConversation } from './owner-evidence.ts';
import { mediaSettings } from './bridges/media.ts';
import { backgroundConversation, type Conversation } from './store.ts';
import { existsSync } from 'node:fs';
import { buildSystemPrompt, identityOf } from './persona.ts';
import { CHILD_WORDS, photoSettings } from './photos.ts';
import type { PhotoEngine } from './image-engines.ts';
import { zonedParts } from './planner.ts';
import { checkClaims } from './receipts.ts';
import { detectExplicit, detectMinorSexualContent, disclosureDue, disclosureText, isWorkChannel } from './safety.ts';
import { adultModeOn } from './settings.ts';
import type { ToolContext } from './tools/types.ts';

export type OwnPhotoPace = 'rarely' | 'sometimes' | 'often';
export const OWN_PACES: readonly OwnPhotoPace[] = ['rarely', 'sometimes', 'often'];

export interface OwnPhotoSettings {
  on: boolean;
  often: OwnPhotoPace;
  /** At most this many pictures on her own in a calendar month. */
  monthlyCap: number;
  /** When she sent them (ISO, newest first, kept 40). */
  sent?: string[];
  /** MNT2: also to the owner's Telegram/Discord DM (as a picture, off by default). Replaced by `dest`. */
  toApps?: boolean;
  /** Where her pictures go (Settings → Pictures from her → Send her pictures to). */
  dest?: OwnDest;
  /** Chats made for her pictures: 'own' ("Pictures from <her name>") or 'project:<id>' → conversation id. */
  made?: Record<string, string>;
}

/** Here in the app: a chat just for her pictures, one of the owner's chats, a project's chat, or nowhere (apps only). */
export type OwnPlace = 'own' | 'chat' | 'project' | 'none';
export const OWN_PLACES: readonly OwnPlace[] = ['own', 'chat', 'project', 'none'];
export interface OwnDest {
  here: OwnPlace;
  chatId?: string;
  projectId?: number;
  telegram?: boolean;
  discord?: boolean;
}
/** One place a picture went (or would go), for the status line. */
export interface OwnTarget {
  kind: 'chat' | 'project' | 'telegram' | 'discord';
  name?: string;
}

export const DEFAULT_OWN_PHOTOS: OwnPhotoSettings = { on: false, often: 'rarely', monthlyCap: 8 };
/** Days between pictures at least, and pictures per week on average. */
const GAP_DAYS: Record<OwnPhotoPace, number> = { rarely: 6, sometimes: 2, often: 1 };
const PER_WEEK: Record<OwnPhotoPace, number> = { rarely: 1, sometimes: 2.5, often: 7 };
/** Chance per eligible life tick (every 10 minutes), so it doesn't feel like a timer. */
const CHANCE = 0.06;
const OWNER_AWAY_DAYS = 7;

/** Approximate price of one picture in US dollars (an estimate; check your provider). */
export const PICTURE_PRICE: Record<PhotoEngine, number | undefined> = { grok: 0.07, openai: 0.04, comfyui: 0, tool: undefined };

export function ownPhotoSettings(app: Pick<AppContext, 'settings'>): OwnPhotoSettings {
  return { ...DEFAULT_OWN_PHOTOS, ...app.settings.get().photos?.own };
}

/** About how many pictures a month and what they cost (undefined when unknown, 0 when free). */
export function monthlyEstimate(engine: PhotoEngine, o: Pick<OwnPhotoSettings, 'often' | 'monthlyCap'>, grokSubscription = false): { pictures: number; dollars: number | undefined } {
  const pictures = Math.min(Math.round(PER_WEEK[o.often] * 4.35), o.monthlyCap);
  const price = engine === 'grok' && grokSubscription ? 0 : PICTURE_PRICE[engine];
  return { pictures, dollars: price === undefined ? undefined : Math.round(pictures * price * 100) / 100 };
}

function thisMonth(sent: string[] | undefined, now: Date, tz: string | undefined): number {
  const m = localDate(now.toISOString(), tz).slice(0, 7);
  return (sent ?? []).filter((s) => localDate(s, tz).slice(0, 7) === m).length;
}

export interface OwnPhotoResult {
  sent?: { messageId: number; caption: string; conversationId?: string; to: OwnTarget[] };
  skipped?: string;
  /** Chosen places that didn't get it (an app not connected, or sending failed), with the reason. */
  missed?: { kind: 'telegram' | 'discord'; why: string }[];
}

/** The destination, with the old "also to my chat apps" switch read as before (a chat here + both apps). */
export function ownDest(own: OwnPhotoSettings): OwnDest {
  const d = own.dest;
  if (d && OWN_PLACES.includes(d.here)) return { here: d.here, ...(d.chatId ? { chatId: d.chatId } : {}), ...(d.projectId ? { projectId: d.projectId } : {}), telegram: d.telegram === true, discord: d.discord === true };
  return { here: 'own', telegram: own.toApps === true, discord: own.toApps === true };
}

/** "Pictures from <her name>", in the owner's language (the chat made for her pictures). */
export const ownChatTitle = (app: AppContext) => say(app, appLanguage(app.settings.get()), en('Pictures from {name}'), { name: app.persona?.name || 'Sara' });

// The owner's own chats, the app check and the chat placing are shared with every alert (src/destinations.ts).
export { ownerWebChat, ownerWebChats };
export const ownAppReady = appReady;

/** Where pictures go, for the status line; the chat here is made on first use (`create`). */
function placeHere(app: AppContext, own: OwnPhotoSettings, dest: OwnDest, create: boolean): { conv?: Conversation; target?: OwnTarget; skipped?: string } {
  if (dest.here === 'none') return {};
  // Stored keys stay as they were: 'own' and 'project:<id>' in photos.own.made.
  return placeChat(app, {
    here: dest.here === 'own' ? 'dedicated' : dest.here,
    chatId: dest.chatId,
    projectId: dest.projectId,
    key: 'own',
    projectKey: (id) => `project:${id}`,
    title: ownChatTitle(app),
    made: own.made,
    save: (key, id) => app.settings.update({ photos: { ...photoSettings(app.settings), own: { ...ownPhotoSettings(app), made: { ...ownPhotoSettings(app).made, [key]: id } } } }),
    create,
  });
}

/** The places her next picture goes, without making anything. */
export function ownTargets(app: AppContext): { to: OwnTarget[]; missing: ('telegram' | 'discord')[]; problem?: string } {
  const own = ownPhotoSettings(app);
  const dest = ownDest(own);
  const here = placeHere(app, own, dest, false);
  const to: OwnTarget[] = here.target ? [here.target] : [];
  const missing: ('telegram' | 'discord')[] = [];
  for (const k of ['telegram', 'discord'] as const) if (dest[k]) (ownAppReady(app, k) ? to.push({ kind: k }) : missing.push(k));
  return { to, missing, ...(here.skipped ? { problem: here.skipped } : {}) };
}

export type OwnStep = 'scene' | 'picture' | 'sending';

/**
 * One try. `force` = the owner's "Send one now" (he is there: the schedule, quiet hours and the
 * daily limit don't apply; the monthly limit and every content rule do).
 */
export async function maybeOwnPhoto(app: AppContext, opts: { force?: boolean; random?: () => number; onStep?: (step: OwnStep) => void } = {}): Promise<OwnPhotoResult> {
  if (app.member || app.demo || app.offRecord) return { skipped: 'not here' };
  const own = ownPhotoSettings(app);
  if (!own.on && !opts.force) return { skipped: 'off' };
  const photos = photoSettings(app.settings);
  if (photos.mode !== 'new') return { skipped: 'new pictures off' };
  const take = app.tools.get('take_photo');
  if (!take || (take.isAvailable && !take.isAvailable()) || app.tools.permission('take_photo', app.settings.get().toolPermissions) === 'never') return { skipped: 'no picture engine' };
  const s = app.settings.get();
  const tz = s.timeZone;
  const now = app.now();
  const today = localDate(now.toISOString(), tz);
  const state = app.inner?.get(now);
  const sentToday = state && state.proactiveDay === today ? state.proactiveCount : 0;
  if (!opts.force) {
    const cfg = proactiveSettings(app);
    if (!cfg.enabled) return { skipped: 'her messages off' };
    if (inQuiet(zonedParts(now, tz).h, cfg.quietStart, cfg.quietEnd)) return { skipped: 'quiet hours' };
    if (sentToday >= cfg.maxPerDay) return { skipped: 'daily limit' };
    const last = own.sent?.[0];
    if (last && localDate(last, tz) === today) return { skipped: 'one a day' };
    if (last && (now.getTime() - new Date(last).getTime()) / 86_400_000 < GAP_DAYS[own.often]) return { skipped: 'not yet' };
  }
  if (thisMonth(own.sent, now, tz) >= own.monthlyCap) return { skipped: 'monthly limit' };
  const lastOwner = app.store.lastOwnerMessageAt();
  if (!lastOwner) return { skipped: 'never talked' };
  if (!opts.force && now.getTime() - lastOwner.getTime() > OWNER_AWAY_DAYS * 86_400_000) return { skipped: 'owner away' };
  // Where it goes: the chosen place here (never a group, room, work channel, partner or another
  // person's chat) and/or the owner's own Telegram/Discord chat with her.
  const dest = ownDest(own);
  const here = placeHere(app, own, dest, false);
  if (here.skipped) return { skipped: here.skipped };
  const apps = (['telegram', 'discord'] as const).filter((k) => dest[k]);
  const missed: NonNullable<OwnPhotoResult['missed']> = apps.filter((k) => !ownAppReady(app, k)).map((k) => ({ kind: k, why: 'not connected' }));
  const sendApps = apps.filter((k) => ownAppReady(app, k));
  if (dest.here === 'none' && !sendApps.length) return { skipped: apps.length ? 'apps not connected' : 'no destination', ...(missed.length ? { missed } : {}) };
  if (dest.here === 'none' && !mediaSettings(app).send) return { skipped: 'app pictures off' };
  // The owner's latest own chat gives the scene its context (read only; nothing is sent there unless chosen).
  const recent = app.store.listConversations().find((c) => c.mode === 'chat' && c.channel === 'web' && ownerEvidenceConversation(app, c.id));
  const conv = here.conv ?? recent ?? backgroundConversation(app.store, ownChatTitle(app));
  if (here.conv && app.isBusy?.(here.conv.id)) return { skipped: 'busy' };
  const msgs = conv.id ? app.store.messages(conv.id).filter((m) => m.role !== 'notice') : [];
  const lastMsg = msgs.at(-1);
  if (!opts.force && lastMsg?.role === 'assistant' && lastMsg.meta?.proactive) return { skipped: 'unanswered' };
  // Her last picture went somewhere he may not have answered (a chat just for pictures, an app).
  if (!opts.force && own.sent?.[0] && lastOwner.getTime() < new Date(own.sent[0]).getTime()) return { skipped: 'unanswered' };
  if (!opts.force && (opts.random ?? Math.random)() > CHANCE) return { skipped: 'not this time' };

  const owner = s.ownerName?.trim() || 'the owner';
  // Explicit only where every destination allows it (the owner's own DMs; never a work channel).
  const channels = [...(dest.here === 'none' ? [] : ['web']), ...sendApps];
  const explicitOk = adultModeOn(s) && !channels.some((c) => isWorkChannel(c));
  const system = buildSystemPrompt(app.persona, {
    now,
    timeZone: tz,
    ownerName: s.ownerName,
    day: app.life?.get(today),
    ...bondContext(app, state?.closeness ?? 0),
    language: languageLine(talkLanguage(s, app.store.ownerMessagesSince(new Date(now.getTime() - 7 * 86_400_000).toISOString())[0])),
  });
  const note = personalize(`[Note from the app, not from ${owner}: you decide to send ${owner} a picture of yourself right now, the way someone close would: what you're doing, where you are or what you're wearing, fitting your day and the recent chat. Reply with exactly two lines. SCENE: what the picture shows (place, what you're doing and wearing, framing). CAPTION: one short, natural line in your voice to go with it. ${explicitOk ? '' : 'Keep it non-explicit. '}Never anything involving minors. Don't mention this note. If nothing feels natural right now, reply with exactly SKIP.]`, identityOf(app.persona));
  const history = msgs.slice(-12).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim()).map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  opts.onStep?.('scene');
  const raw = (await complete(app, conv, [{ role: 'system', content: system }, ...history, { role: 'user', content: note }], 220, 'quick')).trim();
  if (!raw || /^skip\b/i.test(raw)) return { skipped: 'model chose not to' };
  const scene = /SCENE:\s*(.+)/i.exec(raw)?.[1]?.trim().slice(0, 500) ?? '';
  const caption = (/CAPTION:\s*(.+)/i.exec(raw)?.[1]?.trim() ?? '').replace(/^["']|["']$/g, '').slice(0, 300);
  if (!scene || !caption) return { skipped: 'model chose not to' };
  // Same rules as any picture and any reply: never minors, explicit only where allowed, no unbacked claims.
  if (CHILD_WORDS.test(scene) || detectMinorSexualContent(scene, { fromHer: true }) || detectMinorSexualContent(caption, { fromHer: true })) return { skipped: 'failed checks' };
  if (!explicitOk && (detectExplicit(scene) || detectExplicit(caption))) return { skipped: 'failed checks' };
  if (checkClaims(caption, []).length) return { skipped: 'failed checks' };

  const images: string[] = [];
  const ctx = { workspaceDir: '', signal: AbortSignal.timeout(8 * 60_000), sandbox: app.sandbox, conversationId: here.conv?.id ?? (conv.id || undefined), attachImage: (id: string) => images.push(id), unattended: !opts.force } as ToolContext;
  opts.onStep?.('picture');
  try {
    await take.run({ scene }, ctx);
  } catch (err) {
    return { skipped: `no picture: ${(err as Error).message}` };
  }
  // Only claim a picture that is really there.
  const shown = images.filter((id) => app.uploads?.get(id));
  if (!shown.length) return { skipped: 'no picture' };
  opts.onStep?.('sending');
  const text = app.redactor.redact(caption);
  const to: OwnTarget[] = [];
  // The owner's own Telegram/Discord chat with her, straight from here (not a mirror of another chat).
  let appConv: Conversation | undefined;
  if (sendApps.length && !mediaSettings(app).send) for (const k of sendApps.splice(0)) missed.push({ kind: k, why: 'app pictures off' });
  const files = shown.map((id) => ({ id, f: app.uploads!.get(id)! })).filter((x) => existsSync(x.f.path)).map((x) => ({ path: x.f.path, mime: x.f.mime, name: x.id }));
  for (const k of sendApps) {
    try {
      const c = await app.bridges![k]!.sendOwnPicture(files, text);
      appConv ??= c;
      to.push({ kind: k });
    } catch (err) {
      missed.push({ kind: k, why: (err as Error).message.slice(0, 200) });
    }
  }
  // Kept here too, so it is in her Photos and the chat's history: the chosen place, or (apps only) her chat in that app.
  const place = dest.here === 'none' ? appConv : placeHere(app, ownPhotoSettings(app), dest, true).conv;
  if (dest.here !== 'none' && here.target) to.unshift(here.target);
  if (!to.length || !place) return { skipped: `not delivered: ${missed.map((m) => m.why).join('; ') || 'no place'}`, ...(missed.length ? { missed } : {}) };
  if (disclosureDue(app.store.lastDisclosureAt(), now)) {
    const d = disclosureText(app.persona.name, appLanguage(s));
    const n = app.store.addMessage(place.id, 'notice', `disclosure:${d}`);
    app.events?.publish({ type: 'message', conversationId: place.id, message: { ...n, content: d, meta: { kind: 'disclosure' } }, reason: 'proactive' });
  }
  const msg = app.store.addMessage(place.id, 'assistant', text, { proactive: { reason: 'picture' }, images: shown });
  if (app.inner) app.inner.save({ ...app.inner.get(now), lastProactiveAt: now.toISOString(), proactiveDay: today, proactiveCount: sentToday + 1 });
  app.settings.update({ photos: { ...photoSettings(app.settings), own: { ...ownPhotoSettings(app), sent: [now.toISOString(), ...(own.sent ?? [])].slice(0, 40) } } });
  app.events?.publish({ type: 'message', conversationId: place.id, message: msg, reason: 'proactive' });
  return { sent: { messageId: msg.id, caption: msg.content, conversationId: place.id, to }, ...(missed.length ? { missed } : {}) };
}

/** "Send one now" in the background: one at a time; the page asks how it goes. */
export interface OwnPhotoJob {
  running: boolean;
  step: OwnStep | 'done';
  engine: PhotoEngine;
  startedAt: string;
  result?: OwnPhotoResult;
  error?: string;
}
const JOBS = new WeakMap<object, OwnPhotoJob>();
const jobKey = (app: AppContext): object => app.settings;

export function ownPhotoJob(app: AppContext): OwnPhotoJob | undefined {
  return JOBS.get(jobKey(app));
}

export function startOwnPhotoJob(app: AppContext, run: typeof maybeOwnPhoto = maybeOwnPhoto): { started: boolean; job: OwnPhotoJob } {
  const was = JOBS.get(jobKey(app));
  if (was?.running) return { started: false, job: was };
  const job: OwnPhotoJob = { running: true, step: 'scene', engine: photoSettings(app.settings).engine ?? 'grok', startedAt: app.now().toISOString() };
  JOBS.set(jobKey(app), job);
  void run(app, { force: true, onStep: (step) => (job.step = step) })
    .then((result) => (job.result = result))
    .catch((err: Error) => (job.result = { skipped: `no picture: ${err.message}` }))
    .finally(() => {
      job.running = false;
      job.step = 'done';
    });
  return { started: true, job };
}
