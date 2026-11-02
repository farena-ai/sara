// Phase 128 (PL2b, docs/design/POLISH2.md §2.4 N27, Q6): *Next steps* on Today. Once every step of
// *Getting started* is done, Today shows three cards in its place, picked by the use choice, that
// point at what came since 2.48 and is otherwise only found in Settings: the chat apps, the Sara
// Store, Hey Sara (company) or the / menu (coding). Never while Getting started has a step left; never
// more than three; *Hide* puts them away on this device. Pure data here (test/ui-today.test.ts).

export const NEXT_HIDDEN_KEY = 'sara.nextStepsHidden';

/** The cards, in the app's language. `open`: a Settings page (settings:<id>) or `slash` (the message box with / typed). */
export function nextCards(t = (x) => x) {
  return {
    'chat-apps': { icon: 'chat', title: t('Text her from your phone’s chat apps'), text: t('Telegram, WhatsApp, Signal, Matrix, iMessage or email, each set up in a few checked steps.'), open: 'settings:co-telegram' },
    store: { icon: 'puzzle', title: t('Get more from the Sara Store'), text: t('Skills, companions and add-ons, checked by the Sara team, in one tap.'), open: 'settings:ab-store' },
    hey: { icon: 'mic', title: t('Say “Hey Sara”'), text: t('Talk to her hands-free in the Windows app, or hold a key to talk.'), open: 'settings:her-hey' },
    slash: { icon: 'terminal', title: t('Type / for commands'), text: t('/goal keeps her going until a check passes; /compact tidies a long chat.'), open: 'slash' },
    tools: { icon: 'puzzle', title: t('Get tool servers from the Store'), text: t('GitHub, a browser and docs lookups as tool servers, ready to switch on.'), open: 'settings:ab-store' },
    'coding-apps': { icon: 'chat', title: t('Hear from her when a job is done'), text: t('Telegram or Discord on your phone: she tells you when a long job ends.'), open: 'settings:co-telegram' },
  };
}
/** Three per use choice (company and both: chat apps, the Store, Hey Sara; coding: /, tool servers, chat apps). */
export const NEXT_BY_PATH = {
  company: ['chat-apps', 'store', 'hey'],
  both: ['chat-apps', 'store', 'hey'],
  coding: ['slash', 'tools', 'coding-apps'],
};

/**
 * The cards to show, or [] (Getting started not loaded, not finished, or Next steps hidden).
 * `checklist`: GET /api/checklist; `hidden`: the device's Hide; `t`: the app's t().
 */
export function nextSteps(checklist, hidden = false, t = (x) => x) {
  if (!checklist || hidden || !checklist.items?.length || checklist.items.some((i) => !i.done)) return [];
  const path = NEXT_BY_PATH[checklist.path] ? checklist.path : 'both';
  const cards = nextCards(t);
  return NEXT_BY_PATH[path].map((id) => ({ id, ...cards[id] }));
}
