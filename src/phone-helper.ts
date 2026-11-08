// EC24 (docs/ops/EC24_DESIGN.md): the owner's phone (or any signed-in browser he opts in) lends its
// camera, location or screen to Sara, one use at a time, approved on that device. This is the server
// side: which sessions are helper devices (session ids only, in <data>/phone-helper.json), the
// requests waiting for Allow once / Deny (memory only, dropped when settled), the checks on what
// comes back, the coarse location rounding, the policy pin and one audit row per request.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { audit } from './audit-trail.ts';
import type { EventHub } from './events.ts';
import { HttpError } from './http.ts';
import { policy } from './policy-profile.ts';

export type HelperKind = 'camera' | 'location' | 'screen';
export const HELPER_KINDS: readonly HelperKind[] = ['camera', 'location', 'screen'];
/** How long a phone has to answer (the prompt shows the seconds left). */
export const HELPER_TIMEOUT_MS = 90_000;
/** The largest picture a device may send back (decoded bytes). */
export const IMAGE_MAX_BYTES = 1_500_000;
/** The request body cap for an answer (a base64 picture plus a little JSON). */
export const ANSWER_MAX_BODY = Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 64_000;

export interface HelperDevice {
  id: string;
  label: string;
  since: string;
}
export interface HelperRequestView {
  id: string;
  kind: HelperKind;
  reason: string;
  precise: boolean;
  facing?: 'back' | 'front';
  expiresAt: string;
}
export type HelperResult =
  | { ok: true; kind: 'camera' | 'screen'; image: { mime: string; data: Buffer }; device: string }
  | { ok: true; kind: 'location'; lat: number; lon: number; accuracy: number; precise: boolean; device: string }
  | { ok: false; outcome: 'denied' | 'timeout' | 'cancelled' | 'error' | 'unsupported' | 'off' | 'no-device'; device?: string };

interface Pending extends HelperRequestView {
  settle: (r: HelperResult, state?: 'done' | 'cancelled') => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/** A picture from a device: a JPEG/PNG/WebP data URL whose bytes match its type, at most IMAGE_MAX_BYTES. */
export function parseImage(raw: unknown): { mime: string; data: Buffer } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(raw ?? ''));
  if (!m) throw new HttpError(400, 'That is not a picture Sara can use.');
  if ((m[2].length * 3) / 4 > IMAGE_MAX_BYTES + 3) throw new HttpError(413, 'The picture is too large.');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > IMAGE_MAX_BYTES) throw new HttpError(413, 'The picture is too large.');
  if (!MAGIC[m[1]](data)) throw new HttpError(400, 'That is not a picture Sara can use.');
  return { mime: m[1], data };
}

/** Coarse unless asked: 0.01° (about 1 km) and an accuracy of at least 1000 m; precise keeps 5 decimals. */
export function coarse(lat: number, lon: number, accuracy: number, precise: boolean): { lat: number; lon: number; accuracy: number } {
  const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
  const acc = Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : 1000;
  return precise ? { lat: r(lat, 5), lon: r(lon, 5), accuracy: acc } : { lat: r(lat, 2), lon: r(lon, 2), accuracy: Math.max(1000, acc) };
}

const clean = (s: unknown, max: number) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export class PhoneHelper {
  readonly #file: string | undefined;
  readonly #events: EventHub | undefined;
  readonly #timeoutMs: number;
  readonly #alive: (sessionId: string) => boolean;
  readonly #label: (sessionId: string) => string | undefined;
  #devices: { id: string; since: string }[] = [];
  readonly #pending = new Map<string, Pending>();

  constructor(o: { dir?: string; events?: EventHub; timeoutMs?: number; alive?: (sessionId: string) => boolean; label?: (sessionId: string) => string | undefined } = {}) {
    this.#file = o.dir ? join(o.dir, 'phone-helper.json') : undefined;
    this.#events = o.events;
    this.#timeoutMs = o.timeoutMs ?? HELPER_TIMEOUT_MS;
    this.#alive = o.alive ?? (() => true);
    this.#label = o.label ?? (() => undefined);
    if (this.#file && existsSync(this.#file)) {
      try {
        const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as { devices?: { id?: unknown; since?: unknown }[] };
        this.#devices = (raw.devices ?? []).filter((d) => typeof d.id === 'string' && d.id).map((d) => ({ id: String(d.id), since: String(d.since ?? '') }));
      } catch (err) {
        console.warn(`phone helper: ${(err as Error).message}`);
      }
    }
  }

  #save(): void {
    if (this.#file) writeFileSync(this.#file, `${JSON.stringify({ version: 1, devices: this.#devices }, null, 2)}\n`);
  }

  /** The opted-in devices that are still signed in. */
  devices(): HelperDevice[] {
    return this.#devices.filter((d) => this.#alive(d.id)).map((d) => ({ id: d.id, since: d.since, label: this.#label(d.id) ?? '' }));
  }
  isDevice(sessionId: string | undefined): boolean {
    return Boolean(sessionId) && this.#devices.some((d) => d.id === sessionId) && this.#alive(sessionId!);
  }
  /** Opt a signed-in device in or out. Turning it on is refused (409) under the pin. */
  setDevice(sessionId: string, on: boolean): void {
    if (on) policy().guard('phoneHelper', !policy().phoneHelperOn);
    this.#devices = this.#devices.filter((d) => d.id !== sessionId && this.#alive(d.id));
    if (on) this.#devices.push({ id: sessionId, since: new Date().toISOString() });
    this.#save();
  }
  /** Whether her tools are offered: the pin allows it and a helper device is signed in. */
  available(): boolean {
    return policy().phoneHelperOn && this.devices().length > 0;
  }

  /** Waiting requests (a page opened after the ask shows the prompt too). */
  pending(): HelperRequestView[] {
    return [...this.#pending.values()].map(({ id, kind, reason, precise, facing, expiresAt }) => ({ id, kind, reason, precise, expiresAt, ...(facing ? { facing } : {}) }));
  }

  /** Ask the helper devices; resolves with what came back or why nothing did. Never throws. */
  request(kind: HelperKind, o: { reason: string; precise?: boolean; facing?: 'back' | 'front'; signal?: AbortSignal }): Promise<HelperResult> {
    const record = (outcome: 'ok' | 'refused' | 'failed', device?: string) => audit({ action: `phone.${kind}`, role: 'owner', who: 'owner', channel: 'web', outcome, ...(device ? { target: device } : {}) });
    if (!policy().phoneHelperOn) {
      record('refused');
      return Promise.resolve({ ok: false, outcome: 'off' });
    }
    if (!this.devices().length) {
      record('failed');
      return Promise.resolve({ ok: false, outcome: 'no-device' });
    }
    if (o.signal?.aborted) return Promise.resolve({ ok: false, outcome: 'cancelled' });
    const id = randomUUID();
    const view: HelperRequestView = { id, kind, reason: clean(o.reason, 200), precise: kind === 'location' && o.precise === true, expiresAt: new Date(Date.now() + this.#timeoutMs).toISOString(), ...(kind === 'camera' && o.facing === 'front' ? { facing: 'front' as const } : kind === 'camera' ? { facing: 'back' as const } : {}) };
    return new Promise<HelperResult>((resolve) => {
      const onAbort = () => end({ ok: false, outcome: 'cancelled' }, 'cancelled');
      const end = (r: HelperResult, state: 'done' | 'expired' | 'cancelled') => {
        if (!this.#pending.has(id)) return;
        const p = this.#pending.get(id)!;
        clearTimeout(p.timer);
        this.#pending.delete(id);
        o.signal?.removeEventListener('abort', onAbort);
        this.#events?.publish({ type: 'helper', id, kind, state });
        record(r.ok ? 'ok' : r.outcome === 'denied' ? 'refused' : 'failed', 'device' in r ? r.device : undefined);
        resolve(r);
      };
      const timer = setTimeout(() => end({ ok: false, outcome: 'timeout' }, 'expired'), this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { ...view, timer, settle: (r, state = 'done') => end(r, state) });
      o.signal?.addEventListener('abort', onAbort, { once: true });
      this.#events?.publish({ type: 'helper', id, kind, state: 'asking', reason: view.reason, precise: view.precise, expiresAt: view.expiresAt, ...(view.facing ? { facing: view.facing } : {}) });
    });
  }

  /**
   * A device's answer. 404: no such waiting request (answered, expired, cancelled). 403: not a
   * helper device. A bad payload (400/413) fails the request too, so she never waits on a broken phone.
   */
  answer(id: string, sessionId: string | undefined, body: Record<string, unknown>): void {
    const p = this.#pending.get(id);
    if (!p) throw new HttpError(404, 'This request has already ended.');
    if (!this.isDevice(sessionId)) throw new HttpError(403, 'Turn on Phone as a helper on this device first.');
    const device = this.#label(sessionId!) ?? '';
    if (body.allow !== true) return p.settle({ ok: false, outcome: 'denied', device });
    if (body.error !== undefined) return p.settle({ ok: false, outcome: body.error === 'unsupported' ? 'unsupported' : 'error', device });
    try {
      if (p.kind === 'location') {
        const lat = Number(body.lat);
        const lon = Number(body.lon);
        if (body.lat === undefined || body.lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'That location is not valid.');
        const c = coarse(lat, lon, Number(body.accuracy), p.precise);
        return p.settle({ ok: true, kind: 'location', ...c, precise: p.precise, device });
      }
      return p.settle({ ok: true, kind: p.kind, image: parseImage(body.image), device });
    } catch (err) {
      p.settle({ ok: false, outcome: 'error', device });
      throw err;
    }
  }

  /** Ends every waiting request (the policy was pinned off, the server stops). */
  cancelAll(): void {
    for (const p of [...this.#pending.values()]) p.settle({ ok: false, outcome: 'cancelled' }, 'cancelled');
  }
}
