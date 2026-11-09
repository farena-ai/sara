import type { ServerResponse } from 'node:http';
import type { BusinessPolicy } from './policy.ts';
import { BusinessAccessError } from './policy.ts';
import type { WorkspaceContext } from './types.ts';

export interface BusinessContentEvent { readonly kind: 'content.changed' | 'audience.changed'; }
export class BusinessEventLimitError extends Error {
  constructor() { super('Too many requests.'); }
}
interface Subscription { context: WorkspaceContext; response: ServerResponse; dispose: () => void }

/** Fixed metadata only. No global stream or caller-controlled title/snippet/event text. */
export class BusinessEvents {
  readonly #policy: BusinessPolicy;
  readonly #subscriptions = new Set<Subscription>();
  #closed = false;
  constructor(policy: BusinessPolicy) { this.#policy = policy; }
  get size(): number { return this.#subscriptions.size; }
  subscribe(context: WorkspaceContext, response: ServerResponse): void {
    if (this.#closed) throw new BusinessAccessError(404);
    this.#policy.revalidateWorkspace(context, 'read');
    const actorCount = [...this.#subscriptions].filter(s => s.context.principal.identityId === context.principal.identityId).length;
    if (actorCount >= 4 || this.#subscriptions.size >= 256) throw new BusinessEventLimitError();
    let timer: ReturnType<typeof setTimeout>;
    const subscription: Subscription = { context, response, dispose: () => {
      this.#subscriptions.delete(subscription); clearTimeout(timer); response.off('close', subscription.dispose); response.off('error', subscription.dispose);
      if (!response.destroyed && !response.writableEnded) response.end();
    } };
    // This timeout belongs to a live connection's credential lifetime, not an operational watcher.
    const expire = () => {
      if (context.principal.expiresAt <= Date.now()) subscription.dispose();
      else { timer = setTimeout(expire, Math.min(context.principal.expiresAt - Date.now(), 2_147_483_647)); timer.unref(); }
    };
    timer = setTimeout(expire, Math.max(1, Math.min(context.principal.expiresAt - Date.now(), 2_147_483_647))); timer.unref();
    this.#subscriptions.add(subscription); response.once('close', subscription.dispose); response.once('error', subscription.dispose);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    response.write(': connected\n\n');
  }
  revalidateAll(): void {
    for (const subscription of this.#subscriptions) {
      try { this.#policy.revalidateWorkspace(subscription.context, 'read'); } catch { subscription.dispose(); }
    }
  }
  publish(workspaceId: string, event: BusinessContentEvent): void {
    if (event.kind !== 'content.changed' && event.kind !== 'audience.changed') return;
    for (const subscription of this.#subscriptions) {
      try { this.#policy.revalidateWorkspace(subscription.context, 'read'); } catch { subscription.dispose(); continue; }
      if (subscription.context.workspaceId !== workspaceId) continue;
      // Construct a new DTO: excess runtime fields never enter the wire payload.
      if (!subscription.response.write(`event: workspace\ndata: ${JSON.stringify({ kind: event.kind, workspaceId })}\n\n`)) subscription.dispose();
    }
  }
  close(): void { this.#closed = true; for (const subscription of this.#subscriptions) subscription.dispose(); }
}
