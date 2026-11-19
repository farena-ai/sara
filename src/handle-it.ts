// W4.1 (docs/HANDLE_IT.md): "Handle it" on a renewal, a return, a bill reminder, a cancel suggestion
// and a form. Not a new engine: each press makes (or reuses) the source's R3 errand
// (src/errands.ts) with a finer plan, shows that plan first, and on Start runs it step by step with
// the existing tools (web/mail search, the form filler, a browser turn, mail sending) until it
// needs the person. It stops for their OK at sign-in (always theirs: she never types passwords),
// payment (always theirs: money is tracking only, she never pays) and sending. Always allow (W0.7)
// may skip tool and send cards here, never the sign-in, the submit or the payment. Pause holds it,
// Stop ends it, every finished step is a row on the action timeline (src/timeline.ts) and the end
// report lists each step's receipt (the tool's read-back, "read only", or "your word").
//
// Sources reuse their own starters, so the source rows keep pointing at the errand: renewals
// (src/renewals.ts renewalAction 'errand'), returns (src/money/purchases.ts startReturn), Maybe
// cancel (src/money/trim.ts trimAction 'cancel'); bills (src/money/store.ts) and Library forms are
// new here and are found again by the errand's `handleKind`/`handleRef` facts.
import { noteAlwaysAllowed, alwaysAllowOn } from './always-allow.ts';
import { addMonths } from './money/budget.ts';
import { localDay } from './biz/store.ts';
import type { AppContext } from './chat.ts';
import { ERRAND, ErrandError, errandHooks, errandsFor, stepOf, type Errand, type Step, type StepDraft } from './errands.ts';
import { en, trOwner } from './i18n.ts';
import { billStatus, scheduleBill } from './money/core.ts';
import { startReturn } from './money/purchases.ts';
import { moneyStore } from './money/store.ts';
import { trimAction } from './money/trim.ts';
import { renewalAction, renewalsOf } from './renewals.ts';
import { registerRevert, timelineOf, TimelineError, NEVER } from './timeline.ts';

export const HANDLE_KINDS = ['renewal', 'return', 'bill', 'cancel', 'form'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];
/** Where she stops for the person: sign in, pay, send, or an OK before a step that changes something. */
export type HandleStop = 'signin' | 'pay' | 'send' | 'ok';

export interface HandleStep {
  text: string;
  kind: Step['kind'];
  stop: HandleStop | null;
  status: Step['status'];
  result?: string;
}
export interface HandleView {
  id: number;
  goal: string;
  kind: HandleKind | null;
  status: Errand['status'];
  paused: boolean;
  steps: HandleStep[];
  done: number;
  total: number;
  /** The stop she is waiting at (when status is waiting_you). */
  stop: HandleStop | null;
  ask: string | null;
  receipts: { step: string; line: string; verified: string }[];
  summary: string | null;
  /** The end in a line or two (the card shows steps and receipts itself): why it stopped, what you paid. */
  outcome: string | null;
  conversationId: string | null;
  deadline: string | null;
}

type Plan = { text: string; d: StepDraft; collect?: string[] }[];
const SIGN_IN: Plan[number] = { text: en('Sign in on their site (you sign in; she never types passwords)'), d: { kind: 'browser', signIn: true } };

/** The finer plan per kind (null: keep the source's own errand template). */
const PLANS: Record<HandleKind, Plan | null> = {
  renewal: [
    { text: en('Find the official way to renew'), d: { kind: 'research', tool: 'web_search', args: { query: 'how to renew {what} official site' } }, collect: ['url', 'phone', 'email'] },
    SIGN_IN,
    { text: en('Fill the renewal form with My details (she stops before Submit)'), d: { kind: 'form' } },
    { text: en('Submit the form (only with your OK)'), d: { kind: 'browser', needsOk: true } },
    { text: en('Pay the fee on their site (you press Pay; she never pays)'), d: { kind: 'purchase' } },
  ],
  // The return template (find the receipt, how they take returns, the request email, wait) fits.
  return: null,
  bill: [
    { text: en('Find the bill in your mail'), d: { kind: 'research', tool: 'mail_search', args: { query: '{merchant} bill' } }, collect: ['amount', 'date'] },
    { text: en('Find their pay page'), d: { kind: 'research', tool: 'web_search', args: { query: '{merchant} pay bill online' } }, collect: ['url'] },
    SIGN_IN,
    { text: en('Pay on their site (you press Pay; she never pays)'), d: { kind: 'purchase' } },
    { text: en('Find the payment receipt in your mail'), d: { kind: 'research', tool: 'mail_search', args: { query: '{merchant} payment receipt' } } },
  ],
  cancel: [
    { text: en('Find how to cancel'), d: { kind: 'research', tool: 'web_search', args: { query: 'how to cancel {merchant} subscription' } }, collect: ['url', 'email', 'phone'] },
    SIGN_IN,
    { text: en('Open the cancel page and fill it (she stops before the final confirm)'), d: { kind: 'form' } },
    { text: en('Press the final confirm (only with your OK)'), d: { kind: 'browser', needsOk: true } },
  ],
  form: [
    { text: en('Fill your form “{form}” with My details (a filled copy; your original stays as it is)'), d: { kind: 'research' } },
    { text: en('Send or upload the filled form (only with your OK)'), d: { kind: 'browser', needsOk: true } },
  ],
};

export const HANDLE_LINES = [en('Unknown kind of thing to handle.'), en('That item was not found.'), en('This is not a Handle it errand.')];

const isKind = (k: unknown): k is HandleKind => (HANDLE_KINDS as readonly string[]).includes(String(k));
const cents = (n: number | null | undefined) => (typeof n === 'number' ? `$${(n / 100).toFixed(2)}` : '');

/** Where a step stops for the person (null: she does it on her own). */
export function stopOf(s: Pick<Step, 'kind' | 'signIn' | 'needsOk'>, kind: HandleKind | null): HandleStop | null {
  if (s.kind === 'purchase') return 'pay';
  if (s.signIn) return 'signin';
  if (s.kind === 'message') return 'send';
  if (s.kind === 'browser' && s.needsOk) return kind === 'form' ? 'send' : 'ok';
  if (s.kind === 'form' || s.kind === 'decide' || s.kind === 'call') return 'ok';
  return null;
}

function open(e: Errand | undefined): e is Errand {
  return Boolean(e) && e!.status !== 'stopped';
}

/** The errand this source already has (Handle it facts first, then the source's own link). */
function existing(app: AppContext, kind: HandleKind, ref: string): Errand | undefined {
  return errandsFor(app)
    .list()
    .find((e) => e.facts.handleKind === kind && e.facts.handleRef === ref && e.status !== 'stopped');
}

/** Makes or reuses the source's errand (planned, nothing runs) and gives it the Handle it plan. */
function sourceErrand(app: AppContext, kind: HandleKind, ref: string): { errand: Errand; facts: Record<string, string> } {
  const errands = errandsFor(app);
  const notFound = () => new ErrandError(404, en('That item was not found.'));
  switch (kind) {
    case 'renewal': {
      const row = renewalsOf(app).find((r) => r.id === ref);
      if (!row) throw notFound();
      const old = row.errandId ? errands.get(row.errandId) : undefined;
      if (open(old)) return { errand: old, facts: {} };
      const r = renewalAction(app, 'errand', { id: ref });
      return { errand: r.errand as Errand, facts: {} };
    }
    case 'return': {
      try {
        return { errand: startReturn(app, Number(ref)), facts: {} };
      } catch {
        throw notFound();
      }
    }
    case 'cancel': {
      try {
        const r = trimAction(app, ref, 'cancel');
        if (!r.errand) throw notFound();
        return { errand: r.errand, facts: {} };
      } catch {
        throw notFound();
      }
    }
    case 'bill': {
      const bill = moneyStore(app).bill(Number(ref));
      if (!bill || bill.done) throw notFound();
      const facts = { merchant: bill.name, ...(bill.amountCents !== null ? { amount: cents(bill.amountCents) } : {}) };
      return { errand: errands.start({ goal: `Pay my ${bill.name} bill${bill.amountCents !== null ? ` (${cents(bill.amountCents)})` : ''}`, facts }, { by: 'page' }), facts };
    }
    case 'form': {
      const doc = app.library?.get(Number(ref));
      if (!doc) throw notFound();
      const facts = { form: String(doc.title || doc.name).slice(0, 120), formFile: doc.name, docId: String(doc.id) };
      return { errand: errands.start({ goal: `Fill in and send my form “${facts.form}”`, facts }, { by: 'page' }), facts };
    }
  }
}

/** "Handle it" pressed: the planned errand (reused per source) and its plan, with the stops marked. */
export function handleBegin(app: AppContext, kind: HandleKind, ref: string): { errand: Errand; plan: HandleStep[] } {
  if (!isKind(kind)) throw new ErrandError(400, en('Unknown kind of thing to handle.'));
  const key = String(ref ?? '').slice(0, 120);
  const errands = errandsFor(app);
  const had = existing(app, kind, key);
  if (had) return { errand: had, plan: handleView(app, had.id).steps };
  const { errand, facts } = sourceErrand(app, kind, key);
  const mark = { handleKind: kind, handleRef: key };
  let e = errand;
  const plan = PLANS[kind];
  if (plan && e.status === 'planning') {
    const all = { ...e.facts, ...facts };
    const steps = plan.map((p) => stepOf({ ...p.d, text: trOwner(p.text, app.settings.get(), all) }, p.collect)).filter((s): s is Step => Boolean(s));
    e = errands.replan(e.id, steps, mark);
  } else e = errands.update(e.id, { facts: mark }, { by: 'person' });
  return { errand: e, plan: handleView(app, e.id).steps };
}

/** What the progress card shows. */
export function handleView(app: AppContext, id: number): HandleView {
  const e = errandsFor(app).get(id);
  if (!e) throw new ErrandError(404, en('Errand not found.'));
  const kind = isKind(e.facts.handleKind) ? e.facts.handleKind : null;
  const cur = e.steps.find((s) => s.status === 'waiting_you');
  const T = (s: string, p?: Record<string, unknown>) => trOwner(s, app.settings.get(), p);
  const first = (e.summary ?? '').split('\n')[0] ?? '';
  const why = e.status === 'stopped' && first && !first.startsWith(T(en('Done:'))) && !first.startsWith(T(en('Nothing was done yet.'))) ? first : '';
  const paid = e.spent ? T(en('You paid {amount}.'), { amount: Number.isInteger(e.spent) ? `$${e.spent}` : `$${e.spent.toFixed(2)}` }) : '';
  const outcome = e.status === 'done' || e.status === 'stopped' ? [e.status === 'done' ? T(en('All done.')) : why || T(en('You stopped it.')), paid].filter(Boolean).join(' ') : null;
  return {
    id: e.id,
    goal: e.goal,
    kind,
    status: e.status,
    paused: e.paused === true,
    steps: e.steps.map((s) => ({ text: s.text, kind: s.kind, stop: stopOf(s, kind), status: s.status, ...(s.result ? { result: s.result.slice(0, 300) } : {}) })),
    done: e.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: e.steps.length,
    stop: e.status === 'waiting_you' && cur ? (stopOf(cur, kind) ?? 'ok') : null,
    ask: e.status === 'waiting_you' ? (cur?.ask ?? null) : null,
    receipts: e.steps.filter((s) => s.status === 'done' && s.evidence?.line).map((s) => ({ step: s.text, line: s.evidence!.line!, verified: s.evidence!.verified })),
    summary: e.summary,
    outcome,
    conversationId: e.conversationId,
    deadline: e.deadline,
  };
}

// ---------------------------------------------------------------- running in the background

const work = new Set<Promise<unknown>>();
/** Steps on her own until she needs the person, is paused, waits on others or is over. */
function run(app: AppContext, id: number): void {
  const errands = errandsFor(app);
  const p = (async () => {
    for (let i = 0; i < ERRAND.maxSteps + 2; i++) {
      const e = errands.get(id);
      if (!e || e.paused || e.status !== 'working') return;
      const before = JSON.stringify(e.steps.map((s) => s.status));
      const after = await errands.advance(id);
      if (after.status === e.status && JSON.stringify(after.steps.map((s) => s.status)) === before) return;
    }
  })().catch((err: Error) => console.warn(`handle it ${id}: ${err.message}`));
  work.add(p);
  void p.finally(() => work.delete(p));
}
/** Tests and shutdown: wait for every background run. */
export async function handleSettled(): Promise<void> {
  while (work.size) await Promise.allSettled([...work]);
}

function must(app: AppContext, id: number): Errand {
  const e = errandsFor(app).get(id);
  if (!e) throw new ErrandError(404, en('Errand not found.'));
  if (!e.facts.handleKind) throw new ErrandError(409, en('This is not a Handle it errand.'));
  return e;
}

function note(app: AppContext, e: Errand, title: string, o: { undo?: boolean; sent?: boolean; step?: string } = {}): void {
  try {
    const params: Record<string, string> = { goal: e.goal.slice(0, 120), ...(o.step ? { step: o.step.slice(0, 120) } : {}) };
    timelineOf(app).record({
      tool: 'handle_it',
      kind: 'other',
      summary: title.replace(/\{(\w+)\}/g, (_m, k: string) => params[k] ?? ''),
      conversationId: e.conversationId,
      ...(o.undo ? { undo: { type: 'handle_it', id: e.id } } : { never: o.sent ? NEVER.sent : en('Handle it steps are undone by stopping it; what she did is listed here.') }),
      title,
      params,
    });
  } catch {
    /* the timeline is best effort */
  }
}

/** Start pressed on the plan: it runs until the first stop. */
export async function handleStart(app: AppContext, id: number): Promise<HandleView> {
  const e = must(app, id);
  const errands = errandsFor(app);
  if (e.status === 'planning') {
    const started = errands.confirm(id);
    note(app, started, en('Handle it started: {goal}'), { undo: true });
  }
  run(app, id);
  return handleView(app, id);
}

/** The person's OK at the stop she waits at (sign-in done, paid, send it, go ahead). */
export async function handleOk(app: AppContext, id: number, body: { amount?: number; note?: string; to?: string; choice?: string } = {}): Promise<HandleView> {
  must(app, id);
  await errandsFor(app).approve(id, body);
  run(app, id);
  return handleView(app, id);
}
export function handleSkip(app: AppContext, id: number): HandleView {
  must(app, id);
  errandsFor(app).skip(id);
  run(app, id);
  return handleView(app, id);
}
export function handlePause(app: AppContext, id: number): HandleView {
  must(app, id);
  const e = errandsFor(app).pause(id);
  note(app, e, en('Handle it paused: {goal}'));
  return handleView(app, id);
}
export function handleResume(app: AppContext, id: number): HandleView {
  must(app, id);
  const e = errandsFor(app).resume(id);
  note(app, e, en('Handle it resumed: {goal}'));
  run(app, id);
  return handleView(app, id);
}
export function handleStop(app: AppContext, id: number): HandleView {
  must(app, id);
  errandsFor(app).stop(id);
  return handleView(app, id);
}

// ---------------------------------------------------------------- hooks: timeline, bills, audit

/** A bill the person paid on the site themselves: marked paid (the same as Money → Mark paid). */
function markBillPaid(app: AppContext, ref: string): void {
  const s = moneyStore(app);
  const bill = s.bill(Number(ref));
  if (!bill || bill.done) return;
  const day = localDay(app.now(), app.settings.get().timeZone);
  const due = billStatus(bill, day).due ?? day;
  let next = s.setBill(bill.id, { paidFor: due, paidAt: app.now().toISOString() })!;
  if (bill.repeat === 'once') {
    s.setBill(bill.id, { done: true });
    if (bill.reminderId) app.planner?.cancelReminder(bill.reminderId);
    return;
  }
  if (bill.repeat === 'yearly') next = s.setBill(bill.id, { dueDate: addMonths(due, 12) })!;
  scheduleBill(app, s, next, null, due);
}

errandHooks.step = (app, e, s) => {
  if (!e.facts.handleKind) return;
  note(app, e, en('Handle it step done: {step}'), { step: s.text, sent: s.kind === 'message' });
  if (s.kind === 'message' && s.evidence?.kind === 'tool' && alwaysAllowOn(app)) noteAlwaysAllowed(app, 'mail_send', `Handle it: ${s.text}`);
  if (s.kind === 'purchase' && e.facts.handleKind === 'bill' && e.facts.handleRef) markBillPaid(app, e.facts.handleRef);
};
errandHooks.end = (app, e) => {
  if (!e.facts.handleKind) return;
  note(app, e, e.status === 'done' ? en('Handle it done: {goal}') : en('Handle it stopped: {goal}'));
};

registerRevert('handle_it', (u, app) => {
  const errands = errandsFor(app);
  const e = errands.get(Number(u.id));
  if (!e || e.status === 'done' || e.status === 'stopped') throw new TimelineError(409, en('It already finished.'));
  errands.stop(e.id, trOwner(en('You undid Handle it on the timeline.'), app.settings.get()));
  return en('Stopped it.');
});
