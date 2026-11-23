// X1: one or two more tries when a model's server is briefly busy, before anything of the reply
// arrived. Before, a single 429 or 503 went straight to the next model in the chain or to an error.
// Never after the first event (nothing is said twice, no tool call runs twice), never when the turn
// was stopped, and never for errors that will not get better (a bad key, a bad request).
import { ProviderError } from './types.ts';

export const RETRY = {
  /** Extra tries after the first. */
  tries: 2,
  /** Wait before the first retry; each next wait is three times longer, up to maxMs. */
  baseMs: 1000,
  maxMs: 8000,
};

/** Busy or briefly broken (408, 409, 425, 429, 5xx), or the connection dropped. */
export function retryable(err: unknown): boolean {
  if (err instanceof ProviderError) {
    const s = err.status;
    if (s === undefined) return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated|overloaded/i.test(err.message);
    return s === 408 || s === 409 || s === 425 || s === 429 || (s >= 500 && s <= 599);
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string } } | undefined;
  if (!e || e.name === 'AbortError') return false;
  return (e.name === 'TypeError' && /fetch failed|terminated/i.test(e.message ?? '')) || /^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_SOCKET)$/.test(e.cause?.code ?? '');
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Streams from `start`, starting again when it fails with a retryable error before its first event.
 * `onRetry` hears each retry (for the log). Jitter keeps many chats from retrying in step.
 */
export async function* retryingStream<T>(start: () => AsyncIterable<T>, signal?: AbortSignal, o: { tries?: number; baseMs?: number; maxMs?: number; onRetry?: (err: unknown, attempt: number, waitMs: number) => void; random?: () => number } = {}): AsyncGenerator<T> {
  const tries = o.tries ?? RETRY.tries;
  const base = o.baseMs ?? RETRY.baseMs;
  const max = o.maxMs ?? RETRY.maxMs;
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      for await (const ev of start()) {
        started = true;
        yield ev;
      }
      return;
    } catch (err) {
      if (started || attempt >= tries || signal?.aborted || !retryable(err)) throw err;
      const ms = Math.round(Math.min(max, base * 3 ** attempt) * (0.75 + 0.5 * (o.random ?? Math.random)()));
      o.onRetry?.(err, attempt + 1, ms);
      await wait(ms, signal);
    }
  }
}
