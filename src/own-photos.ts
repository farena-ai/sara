// E7 (B2s): now and then she sends a picture on her own, like a person would ("here's my walk").
// Off by default. Runs from her life tick (src/life.ts, no timer of its own) under the same rules
// as her own messages: quiet hours, the daily limit (a picture counts as one of her messages), never
// while her last own message is unanswered, only in the owner's own 1:1 chat in the app. At most one
// a day, a monthly limit, and a message is saved only when the picture is really attached.
import { bondContext, type AppContext } from './chat.ts';
import { appLanguage, languageLine, talkLanguage } from './i18n.ts';
import { personalize } from './identity.ts';
import { complete, inQuiet, proactiveSettings } from './life.ts';
import { localDate } from './memory-worker.ts';
import { ownerEvidenceConversation } from './owner-evidence.ts';
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
  /** MNT2: also to the owner's Telegram/Discord DM (as a picture, off by default). */
  toApps?: boolean;
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
  sent?: { messageId: number; caption: string };
  skipped?: string;
}

/**
 * One try. `force` = the owner's "Send one now" (he is there: the schedule, quiet hours and the
 * daily limit don't apply; the monthly limit and every content rule do).
 */
export async function maybeOwnPhoto(app: AppContext, opts: { force?: boolean; random?: () => number } = {}): Promise<OwnPhotoResult> {
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
  // The owner's own 1:1 chat in the app: never a group, room, work channel, partner or other app.
  const conv = app.store.listConversations().find((c) => c.mode === 'chat' && c.channel === 'web' && ownerEvidenceConversation(app, c.id));
  if (!conv) return { skipped: 'no chat' };
  if (app.isBusy?.(conv.id)) return { skipped: 'busy' };
  const msgs = app.store.messages(conv.id).filter((m) => m.role !== 'notice');
  const lastMsg = msgs.at(-1);
  if (!opts.force && lastMsg?.role === 'assistant' && lastMsg.meta?.proactive) return { skipped: 'unanswered' };
  if (!opts.force && (opts.random ?? Math.random)() > CHANCE) return { skipped: 'not this time' };

  const owner = s.ownerName?.trim() || 'the owner';
  const explicitOk = adultModeOn(s) && !isWorkChannel(conv.channel);
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
  const ctx = { workspaceDir: '', signal: AbortSignal.timeout(8 * 60_000), sandbox: app.sandbox, conversationId: conv.id, attachImage: (id: string) => images.push(id), unattended: !opts.force } as ToolContext;
  try {
    await take.run({ scene }, ctx);
  } catch (err) {
    return { skipped: `no picture: ${(err as Error).message}` };
  }
  // Only claim a picture that is really there.
  const shown = images.filter((id) => app.uploads?.get(id));
  if (!shown.length) return { skipped: 'no picture' };
  if (disclosureDue(app.store.lastDisclosureAt(), now)) {
    const text = disclosureText(app.persona.name, appLanguage(s));
    const n = app.store.addMessage(conv.id, 'notice', `disclosure:${text}`);
    app.events?.publish({ type: 'message', conversationId: conv.id, message: { ...n, content: text, meta: { kind: 'disclosure' } }, reason: 'proactive' });
  }
  const msg = app.store.addMessage(conv.id, 'assistant', app.redactor.redact(caption), { proactive: { reason: 'picture' }, images: shown });
  if (app.inner) app.inner.save({ ...app.inner.get(now), lastProactiveAt: now.toISOString(), proactiveDay: today, proactiveCount: sentToday + 1 });
  app.settings.update({ photos: { ...photoSettings(app.settings), own: { ...ownPhotoSettings(app), sent: [now.toISOString(), ...(own.sent ?? [])].slice(0, 40) } } });
  app.events?.publish({ type: 'message', conversationId: conv.id, message: msg, reason: 'proactive' });
  return { sent: { messageId: msg.id, caption: msg.content } };
}
