import type { AppContext } from '../chat.ts';
import { deliveryFor, type DeliveryDescriptor } from '../delivery.ts';
import { RateLimited, type Priority, type SendQueue } from './sendq.ts';

/** Only a definite remote refusal permits a fallback. */
export class DeliveryRejected extends Error {
  constructor() { super('Platform rejected the message'); }
}
export class DeliveryUncertain extends Error {
  constructor() { super('Message outcome is unknown; review it before sending again'); }
}

export function messageRefs(bridge: 'telegram' | 'discord', value: unknown, expected = 1): string[] {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length !== expected) throw new DeliveryUncertain();
  return rows.map(row => {
    const value = (row as Record<string, unknown> | null)?.[bridge === 'telegram' ? 'message_id' : 'id'];
    const valid = bridge === 'telegram'
      ? Number.isSafeInteger(value) && Number(value) > 0
      : typeof value === 'string' && /^\d{1,24}$/.test(value) && !/^0+$/.test(value);
    if (!valid) throw new DeliveryUncertain();
    return String(value);
  });
}

/** Save before queue admission and transport; only explicit 429 retries this identity. */
export async function sendDelivery<T>(
  app: AppContext, queue: SendQueue, key: string, priority: Priority,
  descriptor: DeliveryDescriptor, transport: (nonce: string) => Promise<T>, expected = 1,
): Promise<T | undefined> {
  const store = deliveryFor(app);
  const record = store.enqueue(descriptor);
  try {
    return await queue.send(key, priority, async () => {
      store.attempt(record.id);
      try {
        const value = await transport(record.nonce);
        store.acknowledge(record.id, messageRefs(descriptor.bridge, value, expected));
        return value;
      } catch (err) {
        if (err instanceof RateLimited) {
          store.rateLimited(record.id);
          throw err;
        }
        if (err instanceof DeliveryRejected) {
          store.fail(record.id);
          throw err;
        }
        try { store.unknown(record.id); }
        catch { /* A failed write leaves attempted for conservative boot recovery. */ }
        throw new DeliveryUncertain();
      }
    });
  } catch (err) {
    if (err instanceof RateLimited) {
      store.fail(record.id);
      throw new DeliveryRejected();
    }
    throw err;
  }
}

/** Retain allowlisted file metadata only, never FormData, transport URLs or bytes. */
export function formReview(form: FormData, text = ''): { text: string; attachments?: { name: string; mime?: string; size: number }[] } {
  const attachments: { name: string; mime?: string; size: number }[] = [];
  for (const value of form.values()) {
    if (typeof value !== 'string') {
      attachments.push({ name: value.name.split(/[\\/]/).at(-1)!.slice(0, 255), ...(value.type ? { mime: value.type } : {}), size: value.size });
    }
  }
  return { text, ...(attachments.length ? { attachments } : {}) };
}
