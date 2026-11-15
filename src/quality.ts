// N1 (docs/design/NEXT.md, docs/QUALITY.md): "How she did" this week, for the owner, from what is
// already kept here: the runs table (turns, their time and tool steps), the turn-error notices
// (with their error class) and the fallback notices. Counts and chat links only; nothing leaves
// this computer (the support desk has no field for it, so it isn't sent).
import type { DatabaseSync } from 'node:sqlite';
import { en } from './i18n.ts';

/** A turn slower than this (start to end) counts as slow. */
export const SLOW_TURN_MS = 60_000;

export interface QualityReason {
  /** The error class (SlowModelError, EmptyReply, Error, ...). */
  errorClass: string;
  count: number;
  /** Up to three chats where it happened (newest first). */
  chats: { id: string; title: string }[];
}

export interface QualityReport {
  from: string;
  to: string;
  days: number;
  turns: number;
  failed: number;
  slow: number;
  empty: number;
  fallbacks: number;
  refused: number;
  stale: number;
  unverified: number;
  reasons: QualityReason[];
  /** English tips (the app translates them), most useful first. */
  tips: string[];
}

const one = <T>(db: DatabaseSync, sql: string, ...p: (string | number)[]): T | undefined => {
  try {
    return db.prepare(sql).get(...p) as T | undefined;
  } catch {
    return undefined;
  }
};
const all = <T>(db: DatabaseSync, sql: string, ...p: (string | number)[]): T[] => {
  try {
    return db.prepare(sql).all(...p) as T[];
  } catch {
    return [];
  }
};

const STALE = /fresh viewId|look(?:ed)? again|use pc_look|not there now|several controls now|Look at the desktop first/i;

/** The week's report (the last `days` days up to `now`). */
export function qualityReport(db: DatabaseSync, now: Date, days = 7): QualityReport {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const to = now.toISOString();
  const turns = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM runs WHERE kind = 'turn' AND started_at >= ? AND started_at <= ?", since, to)?.n ?? 0;
  const failedRuns = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM runs WHERE kind = 'turn' AND status = 'error' AND started_at >= ? AND started_at <= ?", since, to)?.n ?? 0;
  const slow = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM runs WHERE kind = 'turn' AND started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL AND (julianday(ended_at) - julianday(started_at)) * 86400000.0 > ?", since, to, SLOW_TURN_MS)?.n ?? 0;
  // Turn errors as the chat shows them (one notice per failed turn, with its class).
  const errs = all<{ conversation_id: string; title: string | null; cls: string | null; created_at: string }>(
    db,
    "SELECT m.conversation_id, c.title, json_extract(m.meta, '$.errorClass') AS cls, m.created_at FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'notice' AND m.content LIKE 'turnerror:%' AND m.created_at >= ? AND m.created_at <= ? ORDER BY m.id DESC",
    since,
    to,
  );
  const fallbacks = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM messages WHERE role = 'notice' AND content LIKE 'fallback:%' AND created_at >= ? AND created_at <= ?", since, to)?.n ?? 0;
  const byClass = new Map<string, QualityReason>();
  for (const e of errs) {
    const cls = e.cls || 'TurnError';
    const r = byClass.get(cls) ?? { errorClass: cls, count: 0, chats: [] };
    r.count++;
    if (r.chats.length < 3 && !r.chats.some((c) => c.id === e.conversation_id)) r.chats.push({ id: e.conversation_id, title: (e.title ?? '').slice(0, 80) });
    byClass.set(cls, r);
  }
  const reasons = [...byClass.values()].sort((a, b) => b.count - a.count || a.errorClass.localeCompare(b.errorClass)).slice(0, 5);
  const empty = byClass.get('EmptyReply')?.count ?? 0;
  // Tool steps: refused and stale desktop actions, changes that could not be verified.
  let refused = 0;
  let stale = 0;
  let unverified = 0;
  for (const row of all<{ tool_calls: string }>(db, "SELECT s.tool_calls FROM run_steps s JOIN runs r ON r.id = s.run_id WHERE r.started_at >= ? AND r.started_at <= ? AND s.tool_calls IS NOT NULL", since, to)) {
    let steps: { name?: string; status?: string; approval?: string; output?: string }[];
    try {
      steps = JSON.parse(row.tool_calls);
    } catch {
      continue;
    }
    if (!Array.isArray(steps)) continue;
    for (const s of steps) {
      const out = String(s.output ?? '');
      if (/^Could not verify:/m.test(out)) unverified++;
      if (!/^pc_/.test(String(s.name ?? ''))) continue;
      if (s.status === 'denied' || ['refused', 'denied', 'timeout'].includes(String(s.approval))) refused++;
      else if (s.status === 'error' && STALE.test(out)) stale++;
    }
  }
  const failed = Math.max(failedRuns, errs.length);
  const rep: QualityReport = { from: since, to, days, turns, failed, slow, empty, fallbacks, refused, stale, unverified, reasons, tips: [] };
  rep.tips = qualityTips(rep);
  return rep;
}

/** Plain tips for what the counts show (English; the app translates them). */
export function qualityTips(r: Pick<QualityReport, 'failed' | 'slow' | 'empty' | 'fallbacks' | 'refused' | 'stale' | 'unverified' | 'reasons'>): string[] {
  const tips: string[] = [];
  const slowModel = r.reasons.some((x) => x.errorClass === 'SlowModelError');
  if (r.slow > 0 || slowModel || r.fallbacks > 2) tips.push(en('Some replies were slow. Auto (Settings → Models & usage) picks a faster model per job and hands over when one is slow.'));
  if (r.empty > 0) tips.push(en('A model returned empty replies. Pick another for that job, or use Auto so the next model answers.'));
  if (r.failed > 0 && !slowModel && r.empty === 0) tips.push(en('Open a failed chat to see what went wrong; Fix it on the error often has the answer.'));
  if (r.refused > 0) tips.push(en('Desktop actions were refused or not approved in time. Check Computer use in the Sara app on that computer.'));
  if (r.stale > 0) tips.push(en('Some desktop actions found the window had changed. Leave the window still while she works on it.'));
  if (r.unverified > 0) tips.push(en('Some changes could not be checked afterwards. Open those chats and confirm the result.'));
  if (!tips.length) tips.push(en('Nothing to fix this week.'));
  return tips;
}

/** The counts only (no chat names or ids): for the weekly review card. */
export function qualityCounts(r: QualityReport): Pick<QualityReport, 'turns' | 'failed' | 'slow' | 'empty' | 'fallbacks' | 'refused' | 'stale' | 'unverified'> {
  return { turns: r.turns, failed: r.failed, slow: r.slow, empty: r.empty, fallbacks: r.fallbacks, refused: r.refused, stale: r.stale, unverified: r.unverified };
}
