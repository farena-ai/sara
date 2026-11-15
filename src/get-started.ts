// R2 (docs/design/ROADMAP_R.md "Easy for anyone to start", docs/GETTING_STARTED.md): the guided
// setup after the first sign-in, the sample-data tour and the starter packs.
//
// - Guided setup: five steps (a model, mail, calendar, the phone, the computer), each ticked by what
//   is really connected (nothing to mark by hand), each skippable; where the person is and what they
//   skipped is kept in their own space (get-started.json in the data folder, so a household member's
//   progress is their own). The steps open the existing connect pages; nothing new connects here.
// - Sample space: "Show me with examples" writes sample-space.json in the same folder and nothing
//   else. No row of any real table is ever written, so examples can't mix with real data, and one
//   Remove deletes the file. The words of the examples live in the app (web/get-started-words.js).
// - Starter packs: household, small business, sales, student. A pack picks Try cards, adds its
//   routines as automations that stay off until the person presses Allow (one press each), orders
//   Today's sections and gives her one line of persona hint. Switching packs or None undoes what the
//   pack did (automations still off are removed; one the person turned on stays theirs).
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from './chat.ts';
import { automationsFor, type Draft } from './automations.ts';
import { getLayout, putLayout, SECTIONS, type SectionId } from './today-layout.ts';
import { PACK_HINTS } from './pack-hint.ts';

export { packNote } from './pack-hint.ts';

export const STEPS = ['model', 'mail', 'calendar', 'phone', 'computer'] as const;
export type StepId = (typeof STEPS)[number];
export const isStep = (s: unknown): s is StepId => (STEPS as readonly string[]).includes(s as string);

export const PROGRESS_FILE = 'get-started.json';
export const SAMPLE_FILE = 'sample-space.json';

export interface Progress {
  /** Steps the person skipped (a connected step counts as done whatever is here). */
  skipped: StepId[];
  /** The step the guide shows next time. */
  at: StepId;
  /** The guide was shown once after the first sign-in (it then lives on Today and in Settings). */
  offered: boolean;
  /** The person closed the guide with Finish (Today's card goes away). */
  finished: boolean;
  pack: PackState | null;
}
export interface PackState {
  id: PackId;
  appliedAt: string;
  /** The automations this pack added (removed again on revert while still off). */
  automations: number[];
  /** Today's section order before the pack (put back on revert). */
  sectionsBefore: SectionId[];
}

const fresh = (): Progress => ({ skipped: [], at: 'model', offered: false, finished: false, pack: null });

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
function writeJsonFile(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

export function readProgress(app: Pick<AppContext, 'dataDir'>): Progress {
  const raw = readJsonFile(join(app.dataDir, PROGRESS_FILE)) as Partial<Progress> | undefined;
  const p = fresh();
  if (!raw || typeof raw !== 'object') return p;
  p.skipped = Array.isArray(raw.skipped) ? [...new Set(raw.skipped.filter(isStep))] : [];
  p.at = isStep(raw.at) ? raw.at : 'model';
  p.offered = raw.offered === true;
  p.finished = raw.finished === true;
  const pk = raw.pack as Partial<PackState> | null | undefined;
  if (pk && isPack(pk.id)) {
    p.pack = {
      id: pk.id,
      appliedAt: String(pk.appliedAt ?? ''),
      automations: Array.isArray(pk.automations) ? pk.automations.filter((n) => Number.isInteger(n)) : [],
      sectionsBefore: Array.isArray(pk.sectionsBefore) ? pk.sectionsBefore.filter((s): s is SectionId => (SECTIONS as readonly string[]).includes(s)) : [...SECTIONS],
    };
  }
  return p;
}
export function writeProgress(app: Pick<AppContext, 'dataDir'>, p: Progress): void {
  writeJsonFile(join(app.dataDir, PROGRESS_FILE), p);
}

// ------------------------------------------------------------------ what is really connected

export interface Connected {
  /** Signed-in device labels (src/auth.ts deviceLabel: "Sara app on Windows", "Safari on iPhone"). */
  devices: string[];
  pushDevices: number;
  member?: boolean;
}

const PHONE = /Sara app on (iPhone|Android)|on (iPhone|Android)$/;
const COMPUTER = /^Sara app on (Windows|Mac|Linux)$/;

/** Which steps are done now, read from what is connected (only reads). */
export function detect(app: AppContext, c: Connected): Record<StepId, boolean> {
  const s = app.settings.get();
  const subs = app.subscriptions;
  const model = Boolean(s.defaultProviderId && s.defaultModel) || (Array.isArray(s.autoJobs) && s.autoJobs.length > 0 && s.providers.length > 0) || (!c.member && Boolean(subs?.grokStatus().signedIn || subs?.claudeStatus().signedIn || subs?.chatgpt?.status().signedIn));
  let accounts: { calendar: boolean }[] = [];
  try {
    accounts = app.mailAccounts?.list() ?? [];
  } catch {
    accounts = [];
  }
  const g = (() => {
    try {
      return app.google?.status();
    } catch {
      return undefined;
    }
  })();
  const mail = Boolean(g?.gmail) || accounts.length > 0;
  const calendar = Boolean(g?.calendar) || accounts.some((a) => a.calendar);
  const phone = c.pushDevices > 0 || c.devices.some((d) => PHONE.test(d));
  let hands = 0;
  try {
    hands = app.hands?.devices().length ?? 0;
  } catch {
    hands = 0;
  }
  const computer = hands > 0 || c.devices.some((d) => COMPUTER.test(d));
  return { model, mail, calendar, phone, computer };
}

export interface StepView {
  id: StepId;
  state: 'done' | 'skipped' | 'todo';
}
export interface GuideView {
  steps: StepView[];
  /** The step to show: the saved one, or the first not done when the saved one is done. */
  at: StepId;
  done: number;
  total: number;
  offered: boolean;
  finished: boolean;
  /** Every step is done or skipped. */
  complete: boolean;
  pack: PackId | null;
  samples: boolean;
}

/** A member's models are set up by the owner: their guide has no model step. */
export const stepsFor = (member: boolean): StepId[] => (member ? STEPS.filter((s) => s !== 'model') : [...STEPS]);

export function guideView(app: AppContext, c: Connected): GuideView {
  const p = readProgress(app);
  const d = detect(app, c);
  const ids = stepsFor(Boolean(c.member));
  const steps = ids.map((id) => ({ id, state: d[id] ? 'done' : p.skipped.includes(id) ? 'skipped' : 'todo' }) as StepView);
  let at = ids.includes(p.at) ? p.at : ids[0];
  if (d[at]) at = steps.find((s) => s.state === 'todo')?.id ?? at;
  return {
    steps,
    at,
    done: steps.filter((s) => s.state === 'done').length,
    total: steps.length,
    offered: p.offered,
    finished: p.finished,
    complete: steps.every((s) => s.state !== 'todo'),
    pack: p.pack?.id ?? null,
    samples: existsSync(join(app.dataDir, SAMPLE_FILE)),
  };
}

export type StepAction = 'skip' | 'resume' | 'go';
/** skip: skipped and on to the next; resume: not skipped any more and shown; go: just shown. */
export function stepAction(app: AppContext, id: StepId, action: StepAction, member = false): Progress {
  const p = readProgress(app);
  const ids = stepsFor(member);
  if (!ids.includes(id)) throw new Error('That step is not part of your setup.');
  if (action === 'skip') {
    if (!p.skipped.includes(id)) p.skipped.push(id);
    p.at = ids[Math.min(ids.indexOf(id) + 1, ids.length - 1)];
  } else {
    if (action === 'resume') p.skipped = p.skipped.filter((s) => s !== id);
    p.at = id;
    p.finished = false;
  }
  writeProgress(app, p);
  return p;
}
export function markGuide(app: AppContext, what: { offered?: boolean; finished?: boolean }): Progress {
  const p = readProgress(app);
  if (what.offered !== undefined) p.offered = what.offered;
  if (what.finished !== undefined) p.finished = what.finished;
  writeProgress(app, p);
  return p;
}
/** Start over: every skip forgotten, back at the first step (the pack and samples stay). */
export function restartGuide(app: AppContext): Progress {
  const p = readProgress(app);
  const next = { ...fresh(), offered: true, pack: p.pack };
  writeProgress(app, next);
  return next;
}

// ------------------------------------------------------------------ the sample space

export const SAMPLE_KINDS = ['bill', 'package', 'watch', 'decision', 'invoice'] as const;
export type SampleKind = (typeof SAMPLE_KINDS)[number];
export interface SampleCard {
  id: string;
  kind: SampleKind;
  /** The day it is about (a bill's due day, a package's arrival), local YYYY-MM-DD. */
  day: string;
  sample: true;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The example cards (fixed, invented; their words are in the app). */
export function sampleCards(today: string): SampleCard[] {
  const at: Record<SampleKind, number> = { bill: 3, package: 1, watch: 0, decision: 0, invoice: -12 };
  return SAMPLE_KINDS.map((kind) => ({ id: `sample-${kind}`, kind, day: addDays(today, at[kind]), sample: true }));
}

export function readSamples(app: Pick<AppContext, 'dataDir'>): { on: boolean; loadedAt: string | null; cards: SampleCard[] } {
  const raw = readJsonFile(join(app.dataDir, SAMPLE_FILE)) as { loadedAt?: unknown; cards?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.cards)) return { on: false, loadedAt: null, cards: [] };
  const cards = (raw.cards as Partial<SampleCard>[])
    .filter((c) => c && (SAMPLE_KINDS as readonly string[]).includes(c.kind as string) && /^\d{4}-\d{2}-\d{2}$/.test(String(c.day)))
    .map((c) => ({ id: `sample-${c.kind}`, kind: c.kind as SampleKind, day: String(c.day), sample: true as const }));
  return { on: true, loadedAt: typeof raw.loadedAt === 'string' ? raw.loadedAt : null, cards };
}

/** Loads the examples into the sample space (the one file). Real tables are never written. */
export function loadSamples(app: AppContext, today: string): SampleCard[] {
  const cards = sampleCards(today);
  writeJsonFile(join(app.dataDir, SAMPLE_FILE), { loadedAt: app.now().toISOString(), cards });
  return cards;
}
/** Removes every example (the whole sample space). True when there was one. */
export function removeSamples(app: Pick<AppContext, 'dataDir'>): boolean {
  const f = join(app.dataDir, SAMPLE_FILE);
  if (!existsSync(f)) return false;
  rmSync(f, { force: true });
  return true;
}

// ------------------------------------------------------------------ starter packs

export const PACKS = ['household', 'business', 'sales', 'student'] as const;
export type PackId = (typeof PACKS)[number];
export const isPack = (s: unknown): s is PackId => (PACKS as readonly string[]).includes(s as string);

export interface PackDef {
  id: PackId;
  /** Try cards (web/try-cards.js ids) this pack shows, in order. */
  tryCards: string[];
  /** Today's section order. */
  sections: SectionId[];
  /** Routines, added as automations that stay off until Allow. */
  routines: Draft[];
  /** One line for her (English; the model answers in the person's language). */
  hint: string;
}

const morning = (name: string, prompt: string, days?: number[]): Draft => ({ name, trigger: days ? { kind: 'schedule', every: 'week', days, time: '08:00' } : { kind: 'schedule', every: 'weekdays', time: '08:00' }, actions: [{ kind: 'task', prompt }] });

export const PACK_DEFS: Record<PackId, PackDef> = {
  household: {
    id: 'household',
    tryCards: ['spending', 'near', 'decide', 'watch', 'form'],
    sections: ['day', 'needs', 'her', 'more', 'work'],
    routines: [
      morning('Bills due this week', 'Look at my bills and reminders due in the next 7 days and send me a short list with amounts and due days.', [1]),
      { name: 'Weekend plan', trigger: { kind: 'schedule', every: 'week', days: [5], time: '17:00' }, actions: [{ kind: 'notify', text: 'Want help planning the weekend? Ask me for ideas, chores and the grocery list.', how: 'phone' }] },
    ],
    hint: PACK_HINTS.household,
  },
  business: {
    id: 'business',
    tryCards: ['invoice', 'spending', 'form', 'decide'],
    sections: ['needs', 'day', 'work', 'her', 'more'],
    routines: [
      morning('Unpaid invoices', 'List my unpaid invoices and quotes waiting for an answer, oldest first, with amounts. Suggest who to follow up with today.'),
      { name: 'Friday money check', trigger: { kind: 'schedule', every: 'week', days: [5], time: '15:00' }, actions: [{ kind: 'task', prompt: 'Sum up this week: money in, money out, invoices sent and paid, and anything I owe a reply.' }] },
    ],
    hint: PACK_HINTS.business,
  },
  sales: {
    id: 'sales',
    tryCards: ['invoice', 'decide', 'watch', 'form'],
    sections: ['needs', 'day', 'work', 'her', 'more'],
    routines: [
      morning('Follow-ups due', 'List the clients and leads with a next step due today or overdue, with what I promised them. Draft nothing; just the list.'),
      { name: 'Pipeline on Monday', trigger: { kind: 'schedule', every: 'week', days: [1], time: '08:30' }, actions: [{ kind: 'task', prompt: 'Give me my pipeline: leads, quoted, won this month, and the three deals most worth my time this week.' }] },
    ],
    hint: PACK_HINTS.sales,
  },
  student: {
    id: 'student',
    tryCards: ['form', 'decide', 'near', 'watch'],
    sections: ['day', 'her', 'needs', 'work', 'more'],
    routines: [
      { name: 'Sunday study plan', trigger: { kind: 'schedule', every: 'week', days: [0], time: '18:00' }, actions: [{ kind: 'task', prompt: 'Plan my study week: classes and deadlines from my calendar and reminders, with time blocks for each assignment.' }] },
      morning('Due soon', 'Tell me which assignments, exams and forms are due in the next 3 days.'),
    ],
    hint: PACK_HINTS.student,
  },
};

export interface PackResult {
  pack: PackId | null;
  added: number[];
  removed: number[];
  kept: number[];
}

/** Undoes the current pack (if any): its automations still off go, Today's order comes back. */
export function revertPack(app: AppContext): PackResult {
  const p = readProgress(app);
  const out: PackResult = { pack: null, added: [], removed: [], kept: [] };
  if (!p.pack) return out;
  const autos = automationsFor(app);
  for (const id of p.pack.automations) {
    const a = autos.get(id);
    if (!a) continue;
    if (a.enabled) out.kept.push(id);
    else if (autos.remove(id)) out.removed.push(id);
  }
  // Today's order goes back only when it is still the pack's (a later change of their own stays).
  const now = getLayout(app).prefs.sections;
  if (now.join() === PACK_DEFS[p.pack.id].sections.join()) putLayout(app, { sections: p.pack.sectionsBefore });
  p.pack = null;
  writeProgress(app, p);
  return out;
}

/** Applies a pack (the previous one is undone first). Its routines are added switched off. */
export function applyPack(app: AppContext, id: PackId): PackResult {
  const before = revertPack(app);
  const def = PACK_DEFS[id];
  const autos = automationsFor(app);
  const added: number[] = [];
  for (const d of def.routines) {
    try {
      const a = autos.create(d, { by: 'settings' });
      autos.setEnabled(a.id, false);
      added.push(a.id);
    } catch {
      /* at the automations cap: the pack still applies without this routine */
    }
  }
  const sectionsBefore = getLayout(app).prefs.sections;
  putLayout(app, { sections: def.sections });
  const p = readProgress(app);
  p.pack = { id, appliedAt: app.now().toISOString(), automations: added, sectionsBefore };
  writeProgress(app, p);
  return { pack: id, added, removed: before.removed, kept: before.kept };
}
