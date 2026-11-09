// V4b (docs/ops/V4_DESIGN.md → Live run timeline): the pure part of the timeline. Given a turn's
// steps (web/steps.js) and the evidence the chat stream and the stored messages carry, it says how far
// the run is and which steps were really verified. No DOM, no words (web/run-timeline.js draws it),
// so tests replay recorded step streams through it.
//
// A step counts as verified only when something checked it:
//   - sandbox: the command ran in an isolated throwaway copy first and exited 0 (Phase 80 record), or
//   - checks:  a file she wrote or edited is in a "clean" checks chip (Phase 120: the project's checker
//              ran over her edits and left nothing).
// Every other finished step is plainly "done". The trust report and receipts stay where they are.

export const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
const FINISHED = new Set(['ok', 'error', 'denied']);
const LIVE = new Set(['running', 'waiting']);

const normPath = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');

/** True when a sandbox try really checked the command (isolated copy, it ran, exit 0, no timeout). */
export function sandboxVerified(rec) {
  return Boolean(rec && rec.ran === true && rec.isolated === true && rec.exitCode === 0 && !rec.timedOut && rec.decision !== 'cancelled');
}

/** True when a clean checks chip covers the file this step wrote. */
export function checksVerified(step, chip) {
  if (!chip || chip.state !== 'clean' || !WRITE_TOOLS.has(step?.name) || step?.status !== 'ok') return false;
  const path = normPath(step.args?.path);
  if (!path) return false;
  return (Array.isArray(chip.files) ? chip.files : []).some((f) => {
    const n = normPath(f);
    return Boolean(n) && (n === path || n.endsWith(`/${path}`) || path.endsWith(`/${n}`));
  });
}

/** What verified one step ({ by: 'sandbox' | 'checks', … }), or null: a plain done. */
export function verification(step, evidence = {}) {
  if (!step || step.kind !== 'tool' || step.status !== 'ok') return null;
  const rec = step.id && evidence.sandbox instanceof Map ? evidence.sandbox.get(step.id) : undefined;
  if (sandboxVerified(rec)) return { by: 'sandbox', label: String(rec.label ?? '') };
  if (checksVerified(step, evidence.checks)) return { by: 'checks', checker: String(evidence.checks.checker ?? '') };
  return null;
}

/**
 * The run at a glance: how many steps, which one is active, whether it waits for an OK, how many
 * failed or were verified. `progress` is 0..1 once finished and null while live (the bar then shows
 * that work is going on, never a made-up share of an unknown plan).
 */
export function timelineModel(steps = [], evidence = {}) {
  const list = steps.filter((s) => s && s.kind !== 'run');
  const active = list.findIndex((s) => LIVE.has(s.status));
  const live = active >= 0;
  const done = list.filter((s) => FINISHED.has(s.status)).length;
  const marks = list.map((s) => verification(s, evidence));
  return {
    total: list.length,
    done,
    live,
    active,
    waiting: list.some((s) => s.status === 'waiting'),
    errors: list.filter((s) => s.status === 'error').length,
    denied: list.filter((s) => s.status === 'denied').length,
    // 3.0.3: approvals nobody answered in time (the card opens for them, like a failure).
    timedOut: list.filter((s) => s.status === 'denied' && s.timedOut).length,
    verified: marks.filter(Boolean).length,
    marks,
    progress: live ? null : list.length ? 1 : 0,
    sandboxTries: evidence.sandbox instanceof Map ? evidence.sandbox.size : 0,
  };
}

/** The footer's numbers from a run record (GET /api/runs/:id), or null when there is none. */
export function runTotals(run) {
  if (!run || typeof run !== 'object') return null;
  const tokens = (Number(run.tokensIn) || 0) + (Number(run.tokensOut) || 0);
  const usd = Number(run.usd) || 0;
  return { tokens, usd, incomplete: (Number(run.unpriced) || 0) + (Number(run.unreported) || 0) > 0 };
}
