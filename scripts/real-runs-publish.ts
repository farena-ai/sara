// ROADMAP_W W0.1: the sanitized summary of one real-model run (scripts/eval-real.ts results.json) for
// docs/results/real-runs-<date>-<label>.json and the benchmark page. Scores, features, timings, token counts
// and the NAMES of failed checks only: never a prompt, reply, tool output, check detail, judge reason or path.
// Pure (no side effects on import): eval-real.ts and bench-compare.ts both use it.

export interface RealRun { task: string; feature: string; pass: boolean; judge: number | null; seconds: number; failed: string[] }
export interface RealSummary {
  kind: 'real-runs';
  label: string;
  version: string;
  model: string;
  judge: string;
  started: string;
  passed: number;
  of: number;
  judgeAvg: number | null;
  minutes: number;
  tokensIn: number;
  tokensOut: number;
  command: string;
  runs: RealRun[];
}

type Results = {
  version: string; model: string; judge: string; started: string;
  tasks: Record<string, { id: string; feature: string; status: string; ms: number; tokens: { input: number; output: number }; judge?: { score: number }; checks: { name: string; ok: boolean }[] }>;
};

/** order: the suite's task ids (only those present are kept, in that order); default every task in the file. */
export function realSummary(r: Results, label: string, order?: string[]): RealSummary {
  const ids = (order ?? Object.keys(r.tasks)).filter((id) => r.tasks[id]);
  const ts = ids.map((id) => r.tasks[id]!);
  const judged = ts.map((t) => t.judge?.score ?? 0).filter((s) => s > 0);
  return {
    kind: 'real-runs',
    label: String(label).replace(/[^a-z0-9-]/gi, '').slice(0, 40) || 'run',
    version: String(r.version ?? ''),
    model: String(r.model ?? ''),
    judge: String(r.judge ?? ''),
    started: String(r.started ?? ''),
    passed: ts.filter((t) => t.status === 'pass').length,
    of: ts.length,
    judgeAvg: judged.length ? Math.round((judged.reduce((a, b) => a + b, 0) / judged.length) * 100) / 100 : null,
    minutes: Math.round(ts.reduce((s, t) => s + (t.ms || 0), 0) / 6000) / 10,
    tokensIn: ts.reduce((s, t) => s + (t.tokens?.input || 0), 0),
    tokensOut: ts.reduce((s, t) => s + (t.tokens?.output || 0), 0),
    command: `node scripts/eval-real.ts --model ${r.model} --judge ${r.judge}`,
    runs: ts.map((t) => ({
      task: t.id,
      feature: t.feature,
      pass: t.status === 'pass',
      judge: t.judge?.score ? t.judge.score : null,
      seconds: Math.round((t.ms || 0) / 1000),
      failed: t.status === 'pass' ? [] : t.status === 'error' ? ['error'] : t.checks.filter((c) => !c.ok && c.name !== 'notes').map((c) => c.name),
    })),
  };
}
