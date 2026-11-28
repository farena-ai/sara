// T59 (coding correctness): the review of her change, with tools. Measured with the repository benchmark
// (2026-11-27): the review without tools (src/spec-review.ts) flagged only about 4 of 20 failed turns,
// because it sees only what she read and edited this turn, not the rest of the code and not what the
// code really does. This reviewer gets the same material plus a few read-only tools and a small step
// limit:
//   - list_dir, read_file, search: the workspace as it is now (never written to);
//   - run_tests: the test command she already ran this turn, again, in a throwaway copy of the
//     workspace (src/sandbox-run.ts), so nothing it starts can change her files; at most twice;
//   - no other command, no web, no edits.
// Its answer is the same ISSUE / OK lines as the review without tools (parseSpecReview), so what
// happens next is unchanged: she gets the gaps for one more step, or with "the reviewer finishes" on
// the Review model takes the turn over (T57). Off unless precise.checks.reviewTools is on.
import type { AppContext, ModelChoice } from './chat.ts';
import { preciseSettings } from './diagnostics.ts';
import type { ChatMessage, ToolCall, ToolSpec } from './providers/types.ts';
import { runInSandbox, type SandboxGate } from './sandbox-run.ts';
import { listDir, readFileTool, searchTool } from './tools/builtin.ts';
import type { SandboxInfo } from './tools/sandbox.ts';
import type { Tool } from './tools/types.ts';
import { SPEC_REVIEW_PROMPT } from './spec-review.ts';
import { usageScope } from './usage.ts';

export const TOOL_REVIEW = { steps: 8, testRuns: 2, ms: 300_000, stepMs: 120_000, toolChars: 12_000, maxTokens: 12_000, testMs: 180_000 };

/** A function, not a constant: spec-review.ts and this file import each other. */
export const toolReviewPrompt = (): string => `${SPEC_REVIEW_PROMPT}

You also have read-only tools: list_dir, read_file and search look at the project as it is now${'{tests}'}. Use them to check what the material does not show: the rest of the code the change depends on, callers of what was changed, other places the same rule applies, the project's own documents. You cannot change any file. You have a few steps only: look at what matters most, then answer. A passing test run does not prove the change is right; a suspected gap counts only when the code shows it. When you are done, reply with the ISSUE lines or OK as described above, and nothing else.`;

const TEST_TOOL: ToolSpec = {
  name: 'run_tests',
  description: 'Run the project\'s tests again (the same command the developer ran), in a throwaway copy of the project. Returns the output and exit code. Takes no arguments.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

const READ_TOOLS: Tool[] = [listDir, readFileTool, searchTool];

export interface ToolReviewResult {
  /** The reviewer's last words (ISSUE lines or OK), empty when it wrote nothing. */
  text: string;
  steps: number;
  testRuns: number;
  /** Tokens in and out, as the provider reported them (estimated when it did not). */
  tokens: number;
}

/**
 * The tests again in a throwaway copy of the workspace (the sandbox gate's isolation, no network,
 * the copy deleted at once). Undefined when the app has no sandbox gate: then the reviewer only reads.
 */
export function testsInCopy(gate: SandboxGate | undefined, base: SandboxInfo, workspaceDir: string): ((command: string, signal: AbortSignal) => Promise<string>) | undefined {
  if (!gate) return undefined;
  return async (command, signal) => {
    const r = await runInSandbox(workspaceDir, command, { cacheDir: gate.cacheDir, base, isolation: gate.isolation(), network: false, timeoutMs: TOOL_REVIEW.testMs, signal, keep: false, maxBytes: gate.settings().maxMB * 1048576 });
    if (!r.run) return `The tests could not be run in a copy: ${r.notRun ?? 'no result'}`;
    const status = r.run.timedOut ? 'timed out' : `exit code ${r.run.exitCode ?? 'none'}`;
    return `$ ${command}\n[${status}, ${(r.run.ms / 1000).toFixed(1)}s, in a copy]\n${r.run.output.trimEnd() || '(no output)'}`;
  };
}

const clipOut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[cut]` : s);

/**
 * The reviewer's loop. `runTests` is offered only when given (the turn ran a test command and the
 * app can run it in a copy). Never throws for a tool's own error: the reviewer reads it as a result.
 */
export async function runToolReview(o: {
  choice: ModelChoice;
  material: string;
  workspaceDir: string;
  sandbox: SandboxInfo;
  testCommand?: string;
  runTests?: (signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
  limits?: Partial<typeof TOOL_REVIEW>;
  purpose?: string;
  conversationId?: string;
}): Promise<ToolReviewResult> {
  const L = { ...TOOL_REVIEW, ...o.limits };
  const all = AbortSignal.any([AbortSignal.timeout(L.ms), ...(o.signal ? [o.signal] : [])]);
  const specs: ToolSpec[] = [...READ_TOOLS.map((t) => t.spec), ...(o.runTests ? [TEST_TOOL] : [])];
  const system = toolReviewPrompt().replace('{tests}', o.runTests ? `, and run_tests runs the developer's test command (${o.testCommand ?? 'the tests'}) again` : '');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: o.material },
  ];
  let steps = 0;
  let testRuns = 0;
  let tokens = 0;
  let text = '';
  const sc: { purpose: string; conversationId?: string; tokens?: number; reported?: number } = { purpose: o.purpose ?? 'spec-review', ...(o.conversationId ? { conversationId: o.conversationId } : {}) };
  await usageScope.run(sc, async () => {
    for (; steps < L.steps; steps++) {
      if (all.aborted) break;
      // The last step has no tools: the reviewer must answer.
      const last = steps === L.steps - 1;
      if (last) messages.push({ role: 'user', content: '[Note from the app: no steps left. Answer now with the ISSUE lines or OK.]' });
      let out = '';
      const calls: ToolCall[] = [];
      const inChars = messages.reduce((n, m) => n + m.content.length, 0);
      try {
        const signal = AbortSignal.any([all, AbortSignal.timeout(L.stepMs)]);
        for await (const ev of o.choice.provider.stream({ model: o.choice.model, messages, ...(last ? {} : { tools: specs }), temperature: 0, maxTokens: L.maxTokens, reasoning: 'low', signal })) {
          if (ev.type === 'text') out += ev.text;
          else if (ev.type === 'tool_call') calls.push(ev.call);
          if (out.length > L.maxTokens * 12) break;
        }
      } catch {
        // A failed step ends the review with what it has (nothing, most often).
        break;
      }
      tokens += Math.ceil(inChars / 4) + Math.ceil(out.length / 4);
      if (!calls.length) {
        text = out.trim();
        if (process.env.SARA_REVIEW_TRACE === '1') console.log(`    review answer after ${steps + 1} step(s), ${testRuns} test run(s): ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
        steps++;
        break;
      }
      messages.push({ role: 'assistant', content: out, toolCalls: calls });
      // The benchmark's --trace shows the reviewer's own steps (SARA_REVIEW_TRACE=1); the app never sets it.
      if (process.env.SARA_REVIEW_TRACE === '1') for (const c of calls) console.log(`    review ${steps + 1}. ${c.name} ${JSON.stringify(c.arguments).slice(0, 120)}`);
      for (const c of calls) {
        let result: string;
        if (c.name === 'run_tests' && o.runTests) {
          if (testRuns >= L.testRuns) result = `run_tests may run ${L.testRuns} times per review; it already ran ${testRuns} times.`;
          else {
            testRuns++;
            try {
              result = await o.runTests(AbortSignal.any([all, AbortSignal.timeout(L.testMs)]));
            } catch (err) {
              result = `The tests could not be run: ${(err as Error).message}`;
            }
          }
        } else {
          const tool = READ_TOOLS.find((t) => t.spec.name === c.name);
          if (!tool) result = `There is no tool named ${c.name}. You have: ${specs.map((s) => s.name).join(', ')}.`;
          else {
            try {
              // No conversationId: what the reviewer reads never counts as read by her (src/tools/edit-guard.ts).
              result = await tool.run(c.arguments, { workspaceDir: o.workspaceDir, signal: all, sandbox: o.sandbox });
            } catch (err) {
              result = `Error: ${(err as Error).message}`;
            }
          }
        }
        messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: clipOut(result, L.toolChars) });
      }
    }
  });
  if (sc.reported) tokens = sc.tokens ?? tokens;
  return { text, steps, testRuns, tokens };
}

/**
 * T60 (owner, 2026-11-27): the strong review is on by default, measured on the repository benchmark
 * (projects + hard, gemma4 coding: alone 6 of 24; deepseek reviewing with tools and taking over 14 of 24).
 * It acts only when a Review model is set (Settings → Which model does what → Reviewing code): reviewing
 * with the coder itself made results worse (4 of 24), and with no Review model nothing changes.
 */
export function strongReviewSet(app: AppContext): boolean {
  if (!preciseSettings(app).checks.strongReview) return false;
  const r = (app.settings.get() as { routes?: Record<string, { model?: string } | undefined> }).routes?.review;
  return Boolean(r?.model);
}
