// Phase 114 (PL1b, docs/design/POLISH.md §5 and F2): the first run in one queue. The setup wizard,
// the anonymous check-in's first-run notice and the tour offer never stack: each waits until nothing
// else covers the page, in that order, and the tour is offered only after her first reply. The use
// choice from wizard step 1 (company, coding or both) picks the tour, the starter chips and the
// order of Getting started; every feature stays available whatever is picked.
//
// No imports: the app passes its own t() in, so this file also runs in Node for the tests.

export const USE_PATHS = ['company', 'coding', 'both'];
/** A stored value as a use choice ('both' when missing or unknown), as the server's usePathOf. */
export const normPath = (p) => (USE_PATHS.includes(p) ? p : 'both');

/** The short tour offered after her first reply: Companion for company and both, Coder for coding. */
export const tourFor = (path) => (normPath(path) === 'coding' ? 'coding' : 'company');

/** The use choice cards of wizard step 1 (and the About you pick-list). */
export function pathChoices(t) {
  return [
    { id: 'company', icon: '💬', title: t('Company'), text: t('Talk, plan my day, remember things') },
    { id: 'coding', icon: '💻', title: t('Coding'), text: t('My projects, tests, reviews') },
    { id: 'both', icon: '✨', title: t('Both'), text: t('A bit of everything') },
  ];
}

/**
 * Starter chips. `where` is 'wizard' (the last step: 3 that send a real first message, plus the coder's
 * two setup links) or 'chat' (an empty chat: 4). Kinds: send = a message, code = a message in a coding
 * conversation, starter = the starter projects window, page = a Settings page.
 */
export function starterChips(path, where, t) {
  const p = normPath(path);
  const say = (label, text) => ({ kind: 'send', label, text: text ?? label });
  const code = (label, text) => ({ kind: 'code', label, text: text ?? label });
  const hello = say(t('Tell me about yourself'));
  const day = say(t('Plan my day with me'), t('Plan my day with me: what should I do first?'));
  const can = say(t('What can you do?'));
  const look = code(t('Look at my project'), t('Look at my project: what is in it and what would you improve first?'));
  const fix = code(t('Fix a failing test'), t('Help me fix a failing test in my project.'));
  const fresh = { kind: 'starter', label: t('Start a new project') };
  if (where === 'wizard') {
    if (p === 'company') return [hello, day, can];
    if (p === 'coding') return [look, fix, fresh, { kind: 'page', label: t('Connect GitHub'), page: 'ab-github' }, { kind: 'page', label: t('Use her from my editor'), page: 'co-apps' }];
    return [hello, day, look];
  }
  if (p === 'company') return [day, hello, can, say(t('Help me remember something'), t('Help me remember something important.'))];
  if (p === 'coding') return [look, fix, fresh, code(t('Review my changes'), t('Review the changes in my project and tell me what to fix.'))];
  return [day, hello, look, fix];
}

/** The tour offer's words: the stops are six, and Help keeps every tour (also the full one). */
export function offerText(path, t) {
  const p = normPath(path);
  if (p === 'coding') return t('New here? Seven quick stops show where coding with her happens. (Help in the sidebar has every tour, also the full one.)');
  return t('New here? Six quick stops show where everything is. (Help in the sidebar has every tour, also the full one.)');
}

/**
 * Windows and notes that cover the page right now. Today is a page (an open dialog under everything),
 * not an overlay; a note folded into the wizard is part of the wizard.
 */
export function overlayCount(doc) {
  const open = [...doc.querySelectorAll('dialog[open]')].filter((d) => d.id !== 'today').length;
  return open + doc.querySelectorAll('.hub-note:not([hidden]), .tour-offer, .tour-card').length;
}

/**
 * The queue. `add(id, show, ready?)` shows `show()` once nothing covers the page and `ready()` (if any)
 * says yes; one item at a time, in the order added. Checks again every `every` ms while anything waits,
 * and at once on `pump()` (the app calls it when a window closes or her reply lands).
 */
export function createQueue({ doc, timers = globalThis, every = 1500, busy } = {}) {
  const items = [];
  let timer = null;
  const covered = busy ?? (() => overlayCount(doc) > 0);
  const tick = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
    pump();
  };
  function pump() {
    while (items.length && !covered()) {
      const i = items.findIndex((x) => !x.ready || x.ready());
      if (i < 0) break;
      const [it] = items.splice(i, 1);
      it.show();
    }
    if (items.length && !timer) timer = timers.setTimeout(tick, every);
  }
  return {
    add(id, show, ready) {
      if (!items.some((x) => x.id === id)) items.push({ id, show, ready });
      pump();
    },
    drop(id) {
      const i = items.findIndex((x) => x.id === id);
      if (i >= 0) items.splice(i, 1);
    },
    has: (id) => items.some((x) => x.id === id),
    pump: tick,
    get waiting() {
      return items.map((x) => x.id);
    },
  };
}

/** Configuration is not a connectivity test. No provider call is made by this decision. */
export function todayAction(checklist, member, demo) {
  if (!checklist?.readiness) return 'plan';
  if (!checklist.readiness.modelConfigured && !member && !demo) return 'model';
  if (!checklist.readiness.firstReply) return 'message';
  return !member && !demo && normPath(checklist.path) === 'coding' && !checklist.items?.find((i) => i.id === 'project')?.done ? 'project' : 'plan';
}
