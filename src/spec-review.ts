// T56 (coding correctness): a second look at her change against what was asked, before a coding turn
// ends. Measured with the repository benchmark on the owner's models (2026-11-27): a model ran the
// project's tests after its last edit, saw them pass and stopped, and the hidden tests still failed,
// because the fix did not do what the README or SPEC asks (a rounding rule, a quoting rule). Its own
// tests cannot catch what it misread. So once a turn, when she changed files and is about to finish:
//   - the Review model (Settings → Which model does what → Reviewing code; else the coding model) gets
//     the request, the documents she read this turn (README, SPEC, notes), her edits and her last test
//     output, and no tools;
//   - it lists requirements the change does not meet, each with the words of the request or document
//     it comes from, or says OK;
//   - anything it lists goes back to her for one more step: check each against the code, fix what is
//     real, say which she disagrees with and why.
// It only adds a step. It never edits, never blocks the reply for long (one call, a time limit) and
// is skipped in private conversations unless the review model is on the owner's own hardware.
import type { AppContext, ModelChoice } from './chat.ts';
import { cheapCall, isLocalModel, ledgerOf } from './cheap.ts';
import { runToolReview } from './review-tools.ts';
import type { SandboxInfo } from './tools/sandbox.ts';
import type { Receipt } from './receipts.ts';
import type { Conversation } from './store.ts';

export const SPEC_REVIEW = { maxDocs: 4, docChars: 6_000, editChars: 24_000, testChars: 3_000, requestChars: 4_000, fileChars: 12_000, filesChars: 36_000, maxIssues: 6, maxTokens: 12_000, ms: 150_000, dailyRuns: 200 };

export interface SpecIssue {
  /** The words of the request or a document the issue rests on. */
  from: string;
  /** What the change does not do, or does wrong. */
  what: string;
}

export const SPEC_REVIEW_PROMPT = `You review a code change against what was asked. You are given: the request, the documents the developer read (README, SPEC and the like), the edits made, the edited files as they are now, and the last test output. The developer's own tests may pass and the change may still be wrong, because tests only cover what their author thought of.

Find requirements that the change does NOT meet. Read every rule in the request and the documents: exact formats, rounding, ordering, edge cases (empty input, zero, negative numbers, duplicates, quoting, whitespace, case), error behaviour, and things that must stay unchanged. For each rule, check the edited code does exactly that.

Reply with one line per real problem, at most 6, most important first:
ISSUE: "<the words of the request or document that state the rule>" | <what the code does instead, or does not do>

If you find none, reply with exactly:
OK

Only report what you can point to in the text you were given. No style remarks, no praise, no suggestions beyond the requirements, nothing about tests you would like to see.`;

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[cut]` : s);
const DOC = /\.(md|markdown|txt|rst|adoc)$|(^|[\\/])(README|SPEC|CHANGELOG|NOTES|TODO|REQUIREMENTS)[^\\/]*$/i;

/** The reviewer's material, from this turn's receipts only (nothing is read from disk here). */
export function reviewMaterial(request: string, receipts: Receipt[], readNow?: (path: string) => string | undefined): { text: string; edits: number } | undefined {
  const ok = receipts.filter((r) => r.status === 'ok');
  const edits = ok.filter((r) => r.name === 'edit_file' || r.name === 'write_file');
  if (!edits.length) return undefined;
  const docs = new Map<string, string>();
  for (const r of ok) {
    const p = String(r.args.path ?? '');
    if (r.name === 'read_file' && DOC.test(p)) docs.set(p, cut(r.output, SPEC_REVIEW.docChars));
  }
  const docText = [...docs].slice(-SPEC_REVIEW.maxDocs).map(([p, t]) => `--- ${p}\n${t}`).join('\n\n');
  let editText = '';
  for (const r of edits) {
    const p = String(r.args.path ?? '');
    editText += r.name === 'write_file' ? `--- ${p} (whole file written)\n${String(r.args.content ?? '')}\n\n` : `--- ${p} (replaced)\n- ${String(r.args.old_string ?? '').split('\n').join('\n- ')}\n+ ${String(r.args.new_string ?? '').split('\n').join('\n+ ')}\n\n`;
  }
  // The edited files as they are now: an edit alone does not show what the rest of the function does.
  let filesText = '';
  if (readNow) {
    for (const p of [...new Set(edits.map((r) => String(r.args.path ?? '')))]) {
      const now = readNow(p);
      if (now === undefined || filesText.length > SPEC_REVIEW.filesChars) continue;
      filesText += `--- ${p}\n${cut(now, SPEC_REVIEW.fileChars)}\n\n`;
    }
  }
  const tests = lastTestRun(receipts);
  const text = [
    `## The request\n${cut(request.trim(), SPEC_REVIEW.requestChars)}`,
    docText ? `## Documents the developer read\n${docText}` : '## Documents the developer read\n(none this turn)',
    `## The edits\n${cut(editText.trim(), SPEC_REVIEW.editChars)}`,
    ...(filesText ? [`## The edited files as they are now\n${filesText.trim()}`] : []),
    tests ? `## Last test output (${String(tests.args.command)})\n${cut(tests.output, SPEC_REVIEW.testChars)}` : '## Last test output\n(no tests were run)',
  ].join('\n\n');
  return { text, edits: edits.length };
}

const TEST_RE = /\b(test|pytest|unittest|jest|vitest|mocha|check)\b/i;

/** T59: the last test command she ran this turn (one that ran), if any. */
export function lastTestRun(receipts: Receipt[]): Receipt | undefined {
  return receipts.findLast((r) => r.status === 'ok' && r.name === 'shell' && TEST_RE.test(String(r.args.command ?? '')));
}

/** Reads the reviewer's lines. Anything that is not an ISSUE line with both parts is dropped. */
export function parseSpecReview(out: string): SpecIssue[] {
  const issues: SpecIssue[] = [];
  for (const raw of out.split('\n')) {
    const m = /^\s*(?:[-*\d.)\s]*)ISSUE:\s*(.+?)\s*\|\s*(.+?)\s*$/i.exec(raw);
    if (!m) continue;
    const from = m[1]!.replace(/^["'“”`]+|["'“”`]+$/g, '').trim();
    const what = m[2]!.trim();
    if (from.length < 3 || what.length < 8) continue;
    issues.push({ from: from.slice(0, 300), what: what.slice(0, 400) });
    if (issues.length >= SPEC_REVIEW.maxIssues) break;
  }
  return issues;
}

export function specReviewNote(issues: SpecIssue[], reviewer: string, ownerName: string): string {
  const lines = issues.map((i, n) => `${n + 1}. The request or its documents say: "${i.from}". The reviewer says: ${i.what}`).join('\n');
  return `[Note from the app, not from ${ownerName}: before you finish, ${reviewer} read your change against the request and found ${issues.length === 1 ? 'one possible gap' : `${issues.length} possible gaps`}:\n${lines}\nA reviewer can be wrong. For each one: open the code and the document, decide whether it is real, fix what is real (and run the tests again), and say in your answer which ones you did not change and why. Do not just agree.]`;
}

/** T57: the note for the Review model when it takes the turn over: the gaps are its own findings to check and fix. */
export function takeOverNote(issues: SpecIssue[], ownerName: string): string {
  const lines = issues.map((i, n) => `${n + 1}. The request or its documents say: "${i.from}". Found: ${i.what}`).join('\n');
  return `[Note from the app, not from ${ownerName}: another model wrote the change above and said it was finished. A review of it against the request found ${issues.length === 1 ? 'one possible gap' : `${issues.length} possible gaps`}:\n${lines}\nYou take over from here. Read the code and the documents yourself, check each point (a review can be wrong), fix what is real, look for anything else the request asks that is not done, run the tests, and then answer with what you changed and what you left as it was.]`;
}

export class SpecReview {
  /** One review a turn: her follow-up step is not reviewed again. */
  done = false;
  /** T59: how the last review with tools went (steps, test runs). */
  lastTools?: { steps: number; testRuns: number };

  async run(
    app: AppContext,
    conv: Conversation,
    o: {
      request: string;
      receipts: Receipt[];
      ownerName: string;
      route: ModelChoice[];
      canStep: boolean;
      goalOrLoop: boolean;
      readNow?: (path: string) => string | undefined;
      call?: (system: string, user: string) => Promise<string>;
      /** T59: the reviewer gets read-only tools on this workspace (and the tests again, in a copy, when runTests is given). */
      tools?: { workspaceDir: string; sandbox: SandboxInfo; runTests?: (command: string, signal: AbortSignal) => Promise<string>; signal?: AbortSignal };
    },
  ): Promise<{ note: string; issues: SpecIssue[]; reviewer: string } | undefined> {
    if (this.done || !o.canStep || o.goalOrLoop) return undefined;
    const material = reviewMaterial(o.request, o.receipts, o.readNow);
    if (!material) return undefined;
    // A private conversation never leaves the owner's hardware, not even for a review.
    const route = conv.private ? o.route.filter((c) => isLocalModel(c.provider.config, c.model)) : o.route;
    if (!route.length && !o.call) return undefined;
    this.done = true;
    let out = '';
    let reviewer = 'a second model';
    try {
      if (o.call) out = await o.call(SPEC_REVIEW_PROMPT, material.text);
      else if (o.tools) {
        const ledger = ledgerOf(app);
        if (!ledger.fits('spec-review', { runs: SPEC_REVIEW.dailyRuns }, { tokens: 0 })) return undefined;
        ledger.add('spec-review', { runs: 1 });
        const test = lastTestRun(o.receipts);
        const command = test ? String(test.args.command ?? '') : '';
        const t = o.tools;
        const runTests = command && t.runTests ? (signal: AbortSignal) => t.runTests!(command, signal) : undefined;
        // The same model twice: one that thought until its limit and wrote nothing gets a second try.
        for (const choice of [route[0]!, route[0]!]) {
          const r = await runToolReview({ choice, material: material.text, workspaceDir: t.workspaceDir, sandbox: t.sandbox, ...(runTests ? { runTests, testCommand: command } : {}), ...(t.signal ? { signal: t.signal } : {}), ...(conv.id ? { conversationId: conv.id } : {}) });
          try {
            ledger.add('spec-review', { tokens: r.tokens });
          } catch {
            /* the store closed meanwhile */
          }
          this.lastTools = { steps: r.steps, testRuns: r.testRuns };
          out = r.text;
          reviewer = choice.model;
          if (out) break;
        }
        if (!out) return undefined;
      } else {
        const r = await cheapCall(app, {
          source: 'spec-review',
          purpose: 'spec-review',
          conv,
          model: 'quick',
          // The same model twice: one that thought until its limit and wrote nothing gets a second try.
          route: [route[0]!, route[0]!, ...route.slice(1, 2)],
          reasoning: 'low',
          messages: [
            { role: 'system', content: SPEC_REVIEW_PROMPT },
            { role: 'user', content: material.text },
          ],
          maxTokens: SPEC_REVIEW.maxTokens,
          temperature: 0,
          cap: { runs: SPEC_REVIEW.dailyRuns },
          timeoutMs: SPEC_REVIEW.ms,
        });
        if (!r.ok) return undefined;
        out = r.text;
        reviewer = `${r.model}`;
      }
    } catch {
      return undefined;
    }
    const issues = parseSpecReview(out);
    if (!issues.length) return undefined;
    return { note: specReviewNote(issues, reviewer, o.ownerName), issues, reviewer };
  }
}
