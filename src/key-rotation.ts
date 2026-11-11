// EC10 (docs/ops/EC10_DESIGN.md): several keys for one provider (`env:KEY_A | env:KEY_B` in the
// vault entry). When the provider refuses the key in use (401, 403, 429) before answering, the next
// key is used and the request is tried again, once per remaining key. Each move is an audit row.
import { ProviderError, type ChatRequest, type Provider, type StreamEvent } from './providers/types.ts';
import { parseReference } from './secret-sources.ts';
import type { Vault } from './vault.ts';

const REFUSED = new Set([401, 403, 429]);

/** The provider for `name`'s key, rotating through the keys of a multi-key reference on refusal. */
export function withKeyRotation(vault: Vault, name: string, make: (key: string | undefined) => Provider): Provider {
  let current = make(vault.get(name));
  const ref = typeof vault.reference === 'function' ? vault.reference(name) : undefined;
  const count = ref ? (parseReference(ref)?.length ?? 1) : 1;
  if (count < 2) return current;
  return {
    get config() {
      return current.config;
    },
    listModels: (signal?: AbortSignal) => current.listModels(signal),
    modelLimits: (model: string, signal?: AbortSignal) => current.modelLimits?.(model, signal) ?? Promise.resolve({}),
    loadedModels: (signal?: AbortSignal) => current.loadedModels?.(signal) ?? Promise.resolve(undefined),
    async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
      for (let attempt = 0; ; attempt++) {
        let started = false;
        try {
          for await (const ev of current.stream(req)) {
            started = true;
            yield ev;
          }
          return;
        } catch (err) {
          const refused = err instanceof ProviderError && err.status !== undefined && REFUSED.has(err.status);
          if (started || !refused || attempt >= count - 1 || !vault.rotate(name)) throw err;
          current = make(vault.get(name));
        }
      }
    },
  };
}
