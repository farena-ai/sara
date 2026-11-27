// T55 (coding correctness): "done" needs the tests to have run after the last change.
//
// The claim check only caught the words "tests pass", and any shell command backed them. Measured on
// the owner's models with the repository benchmark (2026-11-27): a model finishes with files changed
// after its last test run, or with no test run at all, and says it is done. So, in a coding
// conversation, when her reply would end the turn and
//   - she changed files this turn, and
//   - the project has tests (a test command found in its files, or she ran tests earlier this turn), and
//   - no test run came after her last change (or the last one failed and her reply does not say so),
// the app gives her one more step with a plain note: run the tests now and report the real result.
// At most DONE_GATE.nudges a turn; never when the owner said not to run the tests, in a goal or loop
// round (those have their own check), or when she has no shell.
import type { Receipt } from './receipts.ts';

export const DONE_GATE = { nudges: 2 };

/** A shell command that runs a test suite. */
export const TEST_RUN = /\b(jest|vitest|pytest|unittest|mocha|go test|cargo test|npm t\b|npm (run )?test|pnpm (run )?test|yarn (run )?test|bun test|node --test|make (check|test)|npm run check|phpunit|rspec|dotnet test|gradle\w* test|mvn test)\b/i;
const FILE_CHANGE = new Set(['write_file', 'edit_file']);
const NO_TESTS = /\b(?:do not|don'?t|no need to|without|skip(?:ping)?)\b[^.!?\n]{0,30}\b(?:tests?|testing|run(?:ning)? (?:it|them|anything))\b/i;
const SAYS_FAILING = /\b(fail(?:s|ed|ing|ure)?|still (?:red|broken|failing)|not (?:yet )?(?:passing|working|fixed|done)|doesn[’']?t pass|do(?:es)? not pass|could ?n[o’']t|unable to|error(?:s)? (?:remain|left)|broken)\b/i;

const exitOf = (output: string): number | null => {
  const m = output.match(/^\[exit code (\d+)/);
  return m ? Number(m[1]) : null;
};

export interface DoneGateInput {
  receipts: Receipt[];
  reply: string;
  /** The project's own test command, when its files name one (src/projectknow.ts scanProject). */
  testCommand?: string;
  ownerText: string;
  ownerName: string;
  canStep: boolean;
  goalOrLoop: boolean;
  hasShell: boolean;
}

export type DoneGateWhy = 'not-run' | 'stale' | 'failed';

/** What is wrong with ending the turn here, if anything (pure; the nudge count is the caller's). */
export function doneGateWhy(o: Pick<DoneGateInput, 'receipts' | 'reply' | 'testCommand' | 'ownerText'>): { why: DoneGateWhy; command?: string } | undefined {
  if (NO_TESTS.test(o.ownerText)) return undefined;
  const lastChange = o.receipts.findLastIndex((r) => FILE_CHANGE.has(r.name) && r.status === 'ok');
  if (lastChange < 0) return undefined;
  const tests = o.receipts.map((r, i) => ({ r, i })).filter((x) => x.r.name === 'shell' && TEST_RUN.test(String(x.r.args.command ?? '')));
  const last = tests.at(-1);
  const command = o.testCommand ?? (last ? String(last.r.args.command) : undefined);
  if (!command) return undefined;
  if (!last) return { why: 'not-run', command };
  if (last.i < lastChange) return { why: 'stale', command };
  if (last.r.status !== 'denied' && exitOf(last.r.output) !== 0 && !SAYS_FAILING.test(o.reply)) return { why: 'failed', command };
  return undefined;
}

export class DoneGate {
  nudges = 0;

  /** The note for one more step, or undefined when the turn may end. */
  note(o: DoneGateInput): string | undefined {
    if (this.nudges >= DONE_GATE.nudges || !o.canStep || o.goalOrLoop || !o.hasShell) return undefined;
    const g = doneGateWhy(o);
    if (!g) return undefined;
    this.nudges++;
    const head = `[Note from the app, not from ${o.ownerName}: `;
    if (g.why === 'failed') return `${head}your last test run failed, and your reply does not say so. Fix what fails and run the tests again, or say plainly which tests still fail and why. Do not call the work done while they fail.]`;
    const what = g.why === 'stale' ? 'you changed files after your last test run, so that run says nothing about the code as it is now' : 'you changed files and have not run the tests';
    return `${head}${what}. Run them now (${g.command}), read the result, and then answer: if they pass, say so with the real numbers; if something fails, fix it or say plainly what still fails.]`;
  }
}
