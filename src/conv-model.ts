/**
 * T63 (owner, 2026-11-28): the model a chat's NEXT message will use, for the model chip in the
 * message box. The same decision a turn makes (resolveChain, src/route-resolve.ts), named only: `dry`
 * makes no provider and meters nothing. `chosen` is the model set for this chat (PATCH
 * /api/conversations/:id providerId/model); `default` is what it uses with none set (her own model,
 * Auto, the Talking route or the server default). A turn reads the conversation when it starts, so a
 * change applies from the next message; a reply already being written keeps the model it started with.
 */
import { resolveChain, type AppContext } from './chat.ts';
import { turnJob } from './route-resolve.ts';
import type { Conversation } from './store.ts';

export interface ModelNamed {
  providerId: string;
  provider: string;
  model: string;
  /** Where the pick came from (conversation, companion, auto, chat, default, …). */
  from: string;
}

export interface NextModelView {
  /** This chat's own model (null: the default). */
  chosen: { providerId: string; model: string | null } | null;
  /** What the next message uses (null: nothing usable, e.g. no provider yet). */
  next: ModelNamed | null;
  /** What it would use with no model set for this chat. */
  default: ModelNamed | null;
  /** Why the next message can't use a model (a missing key, a private chat with a cloud model). */
  error?: string;
}

function firstOf(app: AppContext, conv: Conversation): { named: ModelNamed | null; error?: string } {
  const job = turnJob(app.settings.get(), conv, { photos: false, adult: false, research: false, quick: false }).job;
  try {
    const [first] = resolveChain(app, conv, job, false, true);
    if (!first) return { named: null };
    return { named: { providerId: first.provider.config.id, provider: first.provider.config.label, model: first.model, from: first.from } };
  } catch (err) {
    return { named: null, error: (err as Error).message };
  }
}

export function nextModelView(app: AppContext, conv: Conversation): NextModelView {
  const def = firstOf(app, { ...conv, providerId: null, model: null });
  const own = conv.providerId ? firstOf(app, conv) : def;
  const error = own.error ?? (conv.providerId ? undefined : def.error);
  return {
    chosen: conv.providerId ? { providerId: conv.providerId, model: conv.model ?? null } : null,
    next: own.named,
    default: def.named,
    ...(error ? { error } : {}),
  };
}
