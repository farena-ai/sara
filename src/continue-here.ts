// W1.3 (docs/design/W1CONTINUE.md): continue on another device. Each of the person's devices tells
// the server where it is (open chat, unsent draft, the message at the top of the screen, Talk on,
// the live view in sight). When the person opens Sara on another device within a short window, that
// device gets one offer: "Continue where you left off on your PC — 2 minutes ago" (W0.6 ages).
// "Continue on my phone" pushes the same spot to the person's phone.
//
// Per person: the state is a small JSON file in the person's own data folder (a household member's
// app has its own dataDir), so nothing is ever offered across household members. Nothing here calls
// a model or copies messages: the offer points at a chat the person already has.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppContext } from './chat.ts';
import { writeFileAtomic } from './fs-util.ts';
import { isGroupChannel } from './group.ts';
import { en, trOwner } from './i18n.ts';
import { ageWords } from './time-sense.ts';

export type DeviceKind = 'phone' | 'tablet' | 'pc' | 'mac' | 'computer';
export const DEVICE_KINDS: readonly DeviceKind[] = ['phone', 'tablet', 'pc', 'mac', 'computer'];
export const DEFAULT_WITHIN_MIN = 30;
const MAX_WITHIN_MIN = 240;
const MAX_DRAFT = 4000;
const MAX_DEVICES = 8;
/** A pushed handoff shows in the Android app's check for this long. */
const HANDOFF_MS = 30 * 60_000;

export interface ContinueSettings { on: boolean; withinMin: number }
export interface Spot {
  device: string;
  kind: DeviceKind;
  conversationId: string;
  draft: string;
  /** Message id at the top of the screen (0 = the end of the chat). */
  scroll: number;
  talk: boolean;
  /** Live view (D3 canvas) id in sight, if any. */
  canvas: number;
  at: string;
}
export interface Offer extends Spot { title: string; ago: string }
export interface Handoff { id: string; conversationId: string; title: string; draft: string; from: DeviceKind; at: string }
interface State { settings: ContinueSettings; spots: Spot[]; dismissed: Record<string, string>; handoff?: Handoff }

export interface NoteInput { device: string; kind?: string; conversationId: string; draft?: string; scroll?: number; talk?: boolean; canvas?: number }

/** Which kind of device a user agent is (the card says "your PC", "your phone"…). */
export function deviceKind(ua: string): DeviceKind {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile|SaraPhone/i.test(ua))) return 'tablet';
  if (/SaraPhone|iPhone|Android|Mobile/i.test(ua)) return 'phone';
  if (/Windows/i.test(ua)) return 'pc';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  return 'computer';
}

const cleanDevice = (d: unknown): string => {
  const s = typeof d === 'string' ? d.trim() : '';
  if (!/^[\w-]{6,64}$/.test(s)) throw new ContinueError(400, en('A device id is needed.'));
  return s;
};
const num = (v: unknown, max = Number.MAX_SAFE_INTEGER) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max ? v : 0);

export class ContinueError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ContinueHere {
  readonly #app: AppContext;
  readonly #file: string;
  constructor(app: AppContext) {
    this.#app = app;
    this.#file = join(app.dataDir, 'continue-here.json');
  }

  #read(): State {
    const base: State = { settings: { on: true, withinMin: DEFAULT_WITHIN_MIN }, spots: [], dismissed: {} };
    if (!existsSync(this.#file)) return base;
    try {
      const j = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<State>;
      return { settings: { ...base.settings, ...(j.settings ?? {}) }, spots: Array.isArray(j.spots) ? j.spots : [], dismissed: j.dismissed && typeof j.dismissed === 'object' ? j.dismissed : {}, ...(j.handoff ? { handoff: j.handoff } : {}) };
    } catch {
      return base;
    }
  }
  #write(s: State): void {
    writeFileAtomic(this.#file, JSON.stringify(s));
  }
  #now(): Date {
    return this.#app.now();
  }
  /** A chat that may follow the person: their own, not a shared room, group chat or off the record. */
  #conversation(id: string) {
    const c = this.#app.store.getConversation(id);
    if (!c) throw new ContinueError(404, en('Conversation not found.'));
    if (c.partner || isGroupChannel(c.channel)) return undefined;
    return c;
  }
  #off(): boolean {
    return Boolean(this.#app.offRecord || this.#app.demo);
  }

  settings(): ContinueSettings {
    return this.#read().settings;
  }
  setSettings(p: Partial<ContinueSettings>): ContinueSettings {
    const s = this.#read();
    if (typeof p.on === 'boolean') s.settings.on = p.on;
    if (typeof p.withinMin === 'number' && Number.isFinite(p.withinMin)) s.settings.withinMin = Math.min(MAX_WITHIN_MIN, Math.max(5, Math.round(p.withinMin)));
    // Switched off: forget where each device was (the drafts included).
    if (!s.settings.on) {
      s.spots = [];
      delete s.handoff;
    }
    this.#write(s);
    return s.settings;
  }

  /** This device is here now. Returns false when nothing was noted (off, or a chat that never follows). */
  note(n: NoteInput): boolean {
    const device = cleanDevice(n.device);
    const s = this.#read();
    if (!s.settings.on || this.#off()) return false;
    const conv = this.#conversation(String(n.conversationId ?? ''));
    if (!conv) return false;
    const spot: Spot = {
      device,
      kind: (DEVICE_KINDS as readonly string[]).includes(String(n.kind)) ? (n.kind as DeviceKind) : 'computer',
      conversationId: conv.id,
      draft: typeof n.draft === 'string' ? n.draft.slice(0, MAX_DRAFT) : '',
      scroll: num(n.scroll),
      talk: n.talk === true,
      canvas: num(n.canvas),
      at: this.#now().toISOString(),
    };
    s.spots = [spot, ...s.spots.filter((x) => x.device !== device)].slice(0, MAX_DEVICES);
    this.#write(s);
    return true;
  }

  /** The one offer for this device: the newest spot of another device inside the window. */
  offer(device: string, lang?: string): Offer | null {
    const me = cleanDevice(device);
    const s = this.#read();
    if (!s.settings.on || this.#off()) return null;
    const now = this.#now().getTime();
    const mine = s.spots.find((x) => x.device === me);
    const other = s.spots.find((x) => x.device !== me);
    if (!other) return null;
    const at = Date.parse(other.at);
    if (!(now - at <= s.settings.withinMin * 60_000)) return null;
    if (mine && Date.parse(mine.at) >= at) return null;
    if (s.dismissed[me] && Date.parse(s.dismissed[me]) >= at) return null;
    let conv;
    try {
      conv = this.#conversation(other.conversationId);
    } catch {
      return null;
    }
    if (!conv) return null;
    return { ...other, title: conv.title, ago: ageWords(Math.max(0, now - at), lang) };
  }

  /** Not now: this device skips every spot up to `at`. */
  dismiss(device: string, at?: string): void {
    const me = cleanDevice(device);
    const s = this.#read();
    const when = at && !Number.isNaN(Date.parse(at)) ? at : this.#now().toISOString();
    s.dismissed[me] = when;
    for (const k of Object.keys(s.dismissed)) if (!s.spots.some((x) => x.device === k) && k !== me) delete s.dismissed[k];
    this.#write(s);
  }

  /** Continue on my phone: keep the handoff for the phone app's check and push it to the phones. */
  async toPhone(n: NoteInput): Promise<{ sent: number; phones: number; handoff: Handoff }> {
    const s = this.#read();
    if (!s.settings.on || this.#off()) throw new ContinueError(409, en('Continue on another device is switched off.'));
    const conv = this.#conversation(String(n.conversationId ?? ''));
    if (!conv) throw new ContinueError(400, en('This chat can’t follow you to another device.'));
    if (n.device) this.note({ ...n, conversationId: conv.id });
    const kind = (DEVICE_KINDS as readonly string[]).includes(String(n.kind)) ? (n.kind as DeviceKind) : 'computer';
    const handoff: Handoff = { id: randomUUID(), conversationId: conv.id, title: conv.title, draft: typeof n.draft === 'string' ? n.draft.slice(0, MAX_DRAFT) : '', from: kind, at: this.#now().toISOString() };
    const fresh = this.#read();
    fresh.handoff = handoff;
    this.#write(fresh);
    this.#app.events?.publish({ type: 'continue', conversationId: conv.id, handoff: handoff.id } as never);
    const push = this.#app.push as { sendPhones?: (p: { title: string; body: string; url: string; tag?: string }) => Promise<{ sent: number; phones?: number }> } | undefined;
    const title = this.#app.persona?.name ?? 'Sara';
    const st = this.#app.settings.get();
    const body = (push as { settings?: { preview?: boolean } } | undefined)?.settings?.preview === false ? trOwner('Open the app to see it.', st) : trOwner('Continue where you left off: {title}', st, { title: conv.title });
    const r = push?.sendPhones ? await push.sendPhones({ title, body, url: `/#c=${conv.id}`, tag: `continue-${conv.id}` }).catch(() => ({ sent: 0, phones: 0 })) : { sent: 0, phones: 0 };
    return { sent: r.sent, phones: r.phones ?? r.sent, handoff };
  }

  /** The handoff the Android app's check shows (only while it is fresh). */
  handoff(): Handoff | undefined {
    const h = this.#read().handoff;
    if (!h || this.#now().getTime() - Date.parse(h.at) > HANDOFF_MS) return undefined;
    return h;
  }
}

const cache = new WeakMap<AppContext, ContinueHere>();
/** The person's continue-here state (each space its own, members included). */
export function continueHereOf(app: AppContext): ContinueHere {
  let c = cache.get(app);
  if (!c) cache.set(app, (c = new ContinueHere(app)));
  return c;
}
