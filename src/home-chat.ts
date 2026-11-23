// Y5 (docs/CHATS.md "From her"): one home for what she sends on her own. Owner report (2026-11-23):
// "when the harness sends a proactive message it attaches it to a random session". It did: the
// morning briefing, check-ins, weekly reviews, the roundup of smaller things, plugin notes and
// reminders set outside a chat all went to "the most recent chat", whatever that happened to be (a
// coding project, a one-off question). Now they go to one chat that is hers to start: a normal chat
// (answer in it and she replies there), marked by its channel key so the app can show it in a fixed
// place at the top of the list.
//
// Something she was asked for in a chat still answers in that chat (a reminder set there, a watch
// made there); Settings → Alerts and destinations still sends a feed elsewhere when the person says so.
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import type { Conversation } from './store.ts';

/** The channel key of the home chat (channel 'web'). */
export const HOME_KEY = 'home';

export const isHomeChat = (c: Pick<Conversation, 'channel' | 'channelKey' | 'partner'> | null | undefined): boolean => Boolean(c && c.channel === 'web' && c.channelKey === HOME_KEY && !c.partner);

type HomeApp = Pick<AppContext, 'store' | 'settings' | 'persona'> & { demo?: boolean };

/** The home chat when it exists (never makes it). */
export function findHomeChat(app: HomeApp): Conversation | undefined {
  const c = app.store.findChannelConversation('web', HOME_KEY, 'owner');
  return c && isHomeChat(c) ? c : undefined;
}

/**
 * The chat for what she starts on her own. Made on first use, and only once the person has written to
 * her at least once (a brand-new install's first chat is the person's own, never one she made).
 * Archived by the person? It comes back when she next has something to say.
 */
export function homeChat(app: HomeApp, o: { create?: boolean } = {}): Conversation | undefined {
  const have = findHomeChat(app);
  if (have) return have.archivedAt ? (app.store.updateConversation(have.id, { archived: false }) ?? have) : have;
  // Never on the demo: its data folder has to stay empty (src/main.ts refuses to start otherwise).
  if (o.create === false || app.demo || !app.store.firstOwnerMessageAt()) return undefined;
  const title = trOwner(en('From {name}'), app.settings.get(), { name: app.persona.name });
  return app.store.createConversation({ title, titleSource: 'owner', channel: 'web', channelKey: HOME_KEY, mode: 'chat' });
}

/**
 * Where she posts something of her own: the home chat, or (before the person has ever written, when
 * there is no home chat yet) the most recent ordinary chat as before.
 */
export function ownChat(app: HomeApp): Conversation | undefined {
  return homeChat(app) ?? app.store.listConversations().find((c) => c.channel === 'web' && c.mode === 'chat' && !c.partner && !c.private && !c.archivedAt);
}
