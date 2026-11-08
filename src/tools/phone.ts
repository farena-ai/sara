// EC24 (docs/ops/EC24_DESIGN.md): Sara borrows the owner's phone (a helper device he switched on)
// for one picture, one location fix or one screen picture. Each use is approved on that device
// (Allow once / Deny); these tools only ask and wait. Owner only: never in a household member's
// space, a partner's or a group chat; in private local mode (or a private chat) only with a model
// that runs on this computer, and that is checked before the phone is asked.
import type { AppContext } from '../chat.ts';
import { isGroupChannel } from '../group.ts';
import { privateLocalOn } from '../net-guard.ts';
import { HELPER_TIMEOUT_MS, type HelperKind, type HelperResult } from '../phone-helper.ts';
import type { Tool, ToolContext } from './types.ts';

export const PHONE_TOOLS = ['phone_camera', 'phone_location', 'phone_screen'] as const;
const reasonParam = { type: 'string', description: 'Why you need it, in a few words he will read on the prompt (e.g. "to see the plant you asked about").' };

const WORDS: Record<HelperKind, string> = { camera: 'a picture from his phone camera', location: 'his location', screen: 'a picture of his screen' };

/** Plain words for every way the phone can say no or not answer. */
function failed(kind: HelperKind, r: Extract<HelperResult, { ok: false }>): string {
  switch (r.outcome) {
    case 'denied':
      return `He tapped Deny on his phone, so you don't have ${WORDS[kind]}. Don't ask again for this unless he asks you to.`;
    case 'timeout':
      return `His phone didn't answer within ${Math.round(HELPER_TIMEOUT_MS / 1000)} seconds (it may be locked, or Sara isn't open on it). Tell him and carry on without it.`;
    case 'cancelled':
      return 'The request was cancelled before his phone answered.';
    case 'unsupported':
      return kind === 'screen' ? "His device can't share its screen from the browser (phones usually can't). Ask him to send a screenshot instead." : `His device can't give ${WORDS[kind]} here.`;
    case 'off':
      return 'Phone as a helper is turned off on this server by the policy.';
    case 'no-device':
      return 'No helper device is switched on (Settings → Devices and sign-in → Phone as a helper).';
    default:
      return `His phone tried but couldn't give ${WORDS[kind]}. Tell him and carry on without it.`;
  }
}

export function createPhoneTools(app: AppContext): Tool[] {
  const available = () => !app.member && !app.demo && Boolean(app.phoneHelper?.available());
  /** Refusals that come before the phone is asked (owner's own chats; pictures stay local when they must). */
  const before = (ctx: ToolContext, picture: boolean): string | undefined => {
    if (!app.phoneHelper || app.member) return 'Phone as a helper is not available here.';
    const conv = ctx.conversationId ? app.store.getConversation(ctx.conversationId) : undefined;
    if (!conv || conv.partner || isGroupChannel(conv.channel)) return "Not asked: you can borrow his phone only in your own chats with him.";
    if ((privateLocalOn() || conv.private) && ctx.modelLocal !== true) return "Not asked: here what comes from his phone may go only to a model on this computer, and yours isn't.";
    if (picture && !app.uploads) return 'Not asked: pictures are not saved in this conversation (off the record).';
    return undefined;
  };
  const picture = (kind: 'camera' | 'screen'): Tool => ({
    defaultPermission: 'auto',
    spec: {
      name: kind === 'camera' ? 'phone_camera' : 'phone_screen',
      description:
        kind === 'camera'
          ? "Ask the owner's phone to take one picture right now with its camera, when he wants you to look at something where he is. His phone shows a full-screen prompt with your reason; nothing is taken unless he taps Allow once. You see the picture and it is on your reply for him."
          : "Ask the owner's helper device for one picture of its screen right now (a screen share of a single frame). It shows a full-screen prompt with your reason and the browser's own screen picker; nothing is taken unless he allows it. Most phones can't share the screen from the browser.",
      parameters: { type: 'object', properties: { reason: reasonParam, ...(kind === 'camera' ? { camera: { type: 'string', enum: ['back', 'front'], description: 'back (default) or front (selfie)' } } : {}) }, required: ['reason'] },
    },
    isAvailable: available,
    source: 'built-in',
    summarize: (a) => `${kind === 'camera' ? 'phone camera' : 'phone screen'}: ${String(a.reason ?? '').slice(0, 80)}`,
    async run(args, ctx) {
      const no = before(ctx, true);
      if (no) return no;
      const r = await app.phoneHelper!.request(kind, { reason: String(args.reason ?? ''), facing: args.camera === 'front' ? 'front' : 'back', signal: ctx.signal });
      if (!r.ok) return failed(kind, r);
      if (r.kind === 'location') return failed(kind, { ok: false, outcome: 'error' });
      const up = app.uploads!.save(`data:${r.image.mime};base64,${r.image.data.toString('base64')}`);
      ctx.attachImage?.(up.id);
      const what = kind === 'camera' ? `He allowed it: one picture from his phone's camera${r.device ? ` (${r.device})` : ''}.` : `He allowed it: one picture of his screen${r.device ? ` (${r.device})` : ''}.`;
      if (ctx.canSee !== false && ctx.showModel) {
        ctx.showModel(up.id);
        return `${what} It's attached for you to look at, and on your reply for him.`;
      }
      const described = await ctx.describeImage?.({ mime: r.image.mime, data: r.image.data.toString('base64') }).catch(() => undefined);
      if (described) return `${what} Your model can't see pictures, so the picture model described it:\n${described}`;
      return `${what} Your model can't see pictures and no picture model is set, so you can't tell what is in it; say so honestly. It's on your reply for him.`;
    },
  });
  const location: Tool = {
    defaultPermission: 'auto',
    spec: {
      name: 'phone_location',
      description:
        "Ask the owner's phone where it is right now (one fix). Approximate (about 1 km) unless precise is true; ask precise only when he needs directions or an exact spot. His phone shows a full-screen prompt with your reason; nothing is sent unless he taps Allow once. Use it for this answer only: don't save it to memory unless he asks.",
      parameters: { type: 'object', properties: { reason: reasonParam, precise: { type: 'boolean', description: 'The exact spot instead of about 1 km (the prompt says so)' } }, required: ['reason'] },
    },
    isAvailable: available,
    source: 'built-in',
    summarize: (a) => `phone location${a.precise === true ? ' (exact)' : ''}: ${String(a.reason ?? '').slice(0, 80)}`,
    async run(args, ctx) {
      const no = before(ctx, false);
      if (no) return no;
      const r = await app.phoneHelper!.request('location', { reason: String(args.reason ?? ''), precise: args.precise === true, signal: ctx.signal });
      if (!r.ok) return failed('location', r);
      if (r.kind !== 'location') return failed('location', { ok: false, outcome: 'error' });
      return r.precise
        ? `He allowed it. His phone is at ${r.lat}, ${r.lon} (accurate to about ${r.accuracy} m). Use it for this answer only.`
        : `He allowed it. His phone is near ${r.lat}, ${r.lon} (approximate: about ${r.accuracy >= 1000 ? `${Math.round(r.accuracy / 1000)} km` : `${r.accuracy} m`}). Use it for this answer only.`;
    },
  };
  return [picture('camera'), location, picture('screen')];
}
