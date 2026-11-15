// R5 (docs/PHONE_CALLS.md): the telephony provider adapter. Sara talks to a phone network through one
// small interface; the first implementation speaks Twilio's protocol (Programmable Voice webhooks,
// TwiML answers and a bidirectional Media Streams WebSocket carrying 8 kHz μ-law audio). Other
// providers with Twilio-compatible APIs work by changing the API base. SIP trunks or WebRTC gateways
// (a PBX, a SIP provider) would be a second implementation of the same interface: answer a call with
// a media stream, place a call, hang up, start recording; see the doc's "Other providers" note.
//
// No number is bought and nothing is called here: every request goes through netFetch with the
// owner's own account SID and token from the vault, only after the owner switched phone calls on.
import { createHmac } from 'node:crypto';
import { netFetch } from './net-guard.ts';
import { safeEqual } from './webhook-verify.ts';

export type ProviderId = 'twilio' | 'sip';
export const PROVIDERS: readonly ProviderId[] = ['twilio', 'sip'];

export interface Credentials {
  sid: string;
  token: string;
}

/** One inbound or answered call, as the provider's webhook describes it. */
export interface CallInfo {
  callId: string;
  from: string;
  to: string;
  direction: 'inbound' | 'outbound';
  status?: string;
  seconds?: number;
}

/** What the media stream sends (provider-neutral). */
export type StreamEvent =
  | { type: 'start'; streamId: string; callId: string; params: Record<string, string> }
  | { type: 'media'; audio: Buffer }
  | { type: 'mark'; name: string }
  | { type: 'stop' }
  | { type: 'other' };

export interface TelephonyProvider {
  readonly id: ProviderId;
  /** Checks a webhook really came from the provider (signature over the public URL and the form). */
  verify(url: string, params: Record<string, string>, signature: string | undefined): boolean;
  /** The call a webhook describes. */
  callInfo(params: Record<string, string>): CallInfo;
  /** The answer to a call webhook: connect it to Sara's media stream (with one-time parameters). */
  answerWithStream(streamUrl: string, params: Record<string, string>): { type: string; body: string };
  /** The answer that turns a call away (phone calls off). */
  reject(): { type: string; body: string };
  /** Places a call that, once answered, connects to the media stream. */
  place(o: { to: string; from: string; streamUrl: string; params: Record<string, string>; statusUrl: string; maxSeconds: number }): Promise<{ callId: string }>;
  hangup(callId: string): Promise<void>;
  /** Starts recording a live call (only after the spoken consent line). */
  record(callId: string): Promise<void>;
  /** A media stream message, parsed. */
  parseStream(text: string): StreamEvent;
  /** Messages to the media stream: her audio, a mark (tells when it finished playing), clear (barge-in). */
  audioMessage(streamId: string, ulaw: Buffer): string;
  markMessage(streamId: string, name: string): string;
  clearMessage(streamId: string): string;
}

export class TelephonyError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** TwiML that connects the call to a bidirectional Media Stream with custom parameters. */
export function streamTwiml(streamUrl: string, params: Record<string, string>): string {
  const p = Object.entries(params)
    .map(([k, v]) => `<Parameter name="${xml(k)}" value="${xml(v)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}">${p}</Stream></Connect></Response>`;
}

/** Twilio's request signature: base64 HMAC-SHA1 of the full URL plus each POST field name and value, sorted by name. */
export function twilioSignature(token: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

export interface TwilioOptions {
  creds: Credentials;
  /** Twilio-compatible API base (tests: a fake). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class TwilioProvider implements TelephonyProvider {
  readonly id = 'twilio' as const;
  readonly #c: Credentials;
  readonly #base: string;
  readonly #fetch: typeof fetch;

  constructor(o: TwilioOptions) {
    this.#c = o.creds;
    this.#base = (o.apiBase ?? 'https://api.twilio.com').replace(/\/+$/, '');
    this.#fetch = o.fetchImpl ?? netFetch;
  }

  verify(url: string, params: Record<string, string>, signature: string | undefined): boolean {
    if (!signature || !this.#c.token) return false;
    return safeEqual(twilioSignature(this.#c.token, url, params), signature);
  }

  callInfo(p: Record<string, string>): CallInfo {
    const dir = String(p.Direction ?? '').startsWith('outbound') ? 'outbound' : 'inbound';
    return { callId: String(p.CallSid ?? ''), from: String(p.From ?? ''), to: String(p.To ?? ''), direction: dir, ...(p.CallStatus ? { status: String(p.CallStatus) } : {}), ...(p.CallDuration ? { seconds: Number(p.CallDuration) || 0 } : {}) };
  }

  answerWithStream(streamUrl: string, params: Record<string, string>): { type: string; body: string } {
    return { type: 'text/xml', body: streamTwiml(streamUrl, params) };
  }

  reject(): { type: string; body: string } {
    return { type: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="rejected"/></Response>' };
  }

  async #post(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const url = `${this.#base}/2010-04-01/Accounts/${encodeURIComponent(this.#c.sid)}${path}`;
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${this.#c.sid}:${this.#c.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let why = text.slice(0, 200);
      try {
        why = String((JSON.parse(text) as { message?: string }).message ?? why);
      } catch {
        /* not JSON */
      }
      throw new TelephonyError(`The phone provider said ${res.status}: ${why}`, res.status === 401 ? 401 : 502);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async place(o: { to: string; from: string; streamUrl: string; params: Record<string, string>; statusUrl: string; maxSeconds: number }): Promise<{ callId: string }> {
    const j = await this.#post('/Calls.json', {
      To: o.to,
      From: o.from,
      Twiml: streamTwiml(o.streamUrl, o.params),
      StatusCallback: o.statusUrl,
      StatusCallbackEvent: 'completed',
      TimeLimit: String(Math.max(60, Math.round(o.maxSeconds))),
      Timeout: '30',
    });
    const callId = String(j.sid ?? '');
    if (!callId) throw new TelephonyError('The phone provider did not return a call id.');
    return { callId };
  }

  async hangup(callId: string): Promise<void> {
    await this.#post(`/Calls/${encodeURIComponent(callId)}.json`, { Status: 'completed' });
  }

  async record(callId: string): Promise<void> {
    await this.#post(`/Calls/${encodeURIComponent(callId)}/Recordings.json`, { RecordingChannels: 'dual' });
  }

  parseStream(text: string): StreamEvent {
    let m: { event?: string; start?: { streamSid?: string; callSid?: string; customParameters?: Record<string, string> }; streamSid?: string; media?: { payload?: string; track?: string }; mark?: { name?: string } };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return { type: 'other' };
    }
    if (m.event === 'start') return { type: 'start', streamId: String(m.start?.streamSid ?? m.streamSid ?? ''), callId: String(m.start?.callSid ?? ''), params: { ...(m.start?.customParameters ?? {}) } };
    if (m.event === 'media' && typeof m.media?.payload === 'string' && (!m.media.track || m.media.track === 'inbound')) return { type: 'media', audio: Buffer.from(m.media.payload, 'base64') };
    if (m.event === 'mark') return { type: 'mark', name: String(m.mark?.name ?? '') };
    if (m.event === 'stop') return { type: 'stop' };
    return { type: 'other' };
  }

  audioMessage(streamId: string, ulaw: Buffer): string {
    return JSON.stringify({ event: 'media', streamSid: streamId, media: { payload: ulaw.toString('base64') } });
  }
  markMessage(streamId: string, name: string): string {
    return JSON.stringify({ event: 'mark', streamSid: streamId, mark: { name } });
  }
  clearMessage(streamId: string): string {
    return JSON.stringify({ event: 'clear', streamSid: streamId });
  }
}

/** A phone number as the provider wants it (E.164: +15125550100), or '' when it isn't one. */
export function e164(input: string, defaultCountry = '1'): string {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const plus = s.startsWith('+') || s.startsWith('00');
  const digits = s.replace(/^00/, '').replace(/(?:x|ext\.?)\s*\d+$/i, '').replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  if (plus) return `+${digits}`;
  if (defaultCountry === '1' && digits.length === 10) return `+1${digits}`;
  if (defaultCountry === '1' && digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

/** The same number, however it was written. */
export const sameNumber = (a: string, b: string): boolean => Boolean(e164(a)) && e164(a) === e164(b);
