// EC25 (docs/ops/EC2527_DESIGN.md): the trust report. For one run, one project or a week, what Sara
// said against what actually ran: the reply sentences the receipts check flagged (src/receipts.ts,
// kept in messages.meta.unverified), every tool call with its outcome and approval, failed tools,
// policy and loop-guard refusals, sandbox tries, the sources her web tools and research runs read,
// cost, and the audit rows of the window. Read-only over records that already exist; never message
// text other than the flagged sentence, never audit content.
import type { DatabaseSync } from 'node:sqlite';
import type { AuditRow } from './audit-trail.ts';
import type { RunStore, RunView, StepView, ToolStep } from './runs.ts';

export type TrustScope = { kind: 'run'; id: number } | { kind: 'project'; id: number } | { kind: 'week'; from: string; to: string };
export interface TrustSource { db: DatabaseSync; runs: RunStore }

/** Rows kept per list (the rest is counted in `more`). */
export const TRUST_CAP = 200;
export const TRUST_RUN_CAP = 500;

export interface TrustClaim { run: number; kind: string; problem: string; sentence: string; at: string }
export interface TrustTool { name: string; ok: number; error: number; denied: number }
export interface TrustCall { run: number; name: string; summary: string; output: string; at: string }
export interface TrustRefusal extends TrustCall { why: 'policy' | 'loop' | 'declined' }
export interface TrustSandbox { run: number; name: string; summary: string; isolation: string; choice: string; at: string }
export interface TrustSourceRow { url: string; title: string; status: string; from: 'tool' | 'research'; run: number }
export interface TrustAudit { seq: number; at: string; action: string; who: string; role: string; channel: string; outcome: string; target?: string }
export interface TrustReport {
  scope: TrustScope;
  title: string;
  from: string | null;
  to: string | null;
  summary: { runs: number; steps: number; modelCalls: number; toolCalls: number; failedTools: number; tokensIn: number; tokensOut: number; usd: number; unpricedCalls: number; ms: number; errors: number };
  runs: { id: number; kind: string; title: string; status: string; startedAt: string; usd: number }[];
  claims: TrustClaim[];
  tools: TrustTool[];
  approvals: { auto: number; allowed: number; denied: number; refused: number };
  failed: TrustCall[];
  refusals: TrustRefusal[];
  sandbox: TrustSandbox[];
  sources: TrustSourceRow[];
  searches: string[];
  audit: TrustAudit[];
  auditRefused: number;
  more: Record<'runs' | 'claims' | 'failed' | 'refusals' | 'sandbox' | 'sources' | 'searches' | 'audit', number>;
}

type Row = Record<string, unknown>;
const clip = (v: unknown, n: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const WEB_URL = /^(web_fetch|browser_open|browser_navigate|read_url|fetch_url)$/;

function runsInScope(src: TrustSource, scope: TrustScope): RunView[] {
  const ids = (sql: string, ...p: (string | number)[]): number[] => (src.db.prepare(sql).all(...p) as Row[]).map((r) => Number(r.id));
  const list = scope.kind === 'run' ? [scope.id] : scope.kind === 'project' ? ids('SELECT r.id FROM runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.project_id = ? ORDER BY r.id DESC LIMIT ?', scope.id, TRUST_RUN_CAP + 1) : ids('SELECT id FROM runs WHERE started_at >= ? AND started_at < ? ORDER BY id DESC LIMIT ?', scope.from, scope.to, TRUST_RUN_CAP + 1);
  return list.map((id) => src.runs.get(id)).filter((r): r is RunView => Boolean(r));
}

/** Builds the report. Throws "No run …" / "No project …" for a scope that names nothing. */
export function trustReport(sources: readonly TrustSource[], scope: TrustScope, auditRows: readonly AuditRow[]): TrustReport {
  const more = { runs: 0, claims: 0, failed: 0, refusals: 0, sandbox: 0, sources: 0, searches: 0, audit: 0 };
  const push = <T>(list: T[], key: keyof typeof more, v: T) => (list.length < TRUST_CAP ? list.push(v) : more[key]++);
  const r: TrustReport = { scope, title: '', from: null, to: null, summary: { runs: 0, steps: 0, modelCalls: 0, toolCalls: 0, failedTools: 0, tokensIn: 0, tokensOut: 0, usd: 0, unpricedCalls: 0, ms: 0, errors: 0 }, runs: [], claims: [], tools: [], approvals: { auto: 0, allowed: 0, denied: 0, refused: 0 }, failed: [], refusals: [], sandbox: [], sources: [], searches: [], audit: [], auditRefused: 0, more };
  const tools = new Map<string, TrustTool>();
  const seenUrl = new Set<string>();
  const seenSearch = new Set<string>();
  let projectName: string | undefined;
  let found = 0;
  for (const src of sources) {
    if (scope.kind === 'project' && projectName === undefined) {
      const p = src.db.prepare('SELECT name FROM projects WHERE id = ?').get(scope.id) as Row | undefined;
      if (p) projectName = String(p.name);
    }
    const all = runsInScope(src, scope);
    if (all.length > TRUST_RUN_CAP) more.runs += all.length - TRUST_RUN_CAP;
    for (const run of all.slice(0, TRUST_RUN_CAP)) {
      found++;
      const s = r.summary;
      s.runs++;
      s.tokensIn += run.tokensIn;
      s.tokensOut += run.tokensOut;
      s.usd += run.usd;
      s.ms += run.ms;
      if (run.status === 'error') s.errors++;
      push(r.runs, 'runs', { id: run.id, kind: run.kind, title: clip(run.title, 120), status: run.status, startedAt: run.startedAt, usd: run.usd });
      const steps: StepView[] = src.runs.steps(run.id);
      s.steps += steps.length;
      const replies = new Set<number>([run.replyMessageId ?? 0, ...steps.map((x) => x.replyMessageId ?? 0)].filter(Boolean));
      for (const id of replies) {
        const m = src.db.prepare('SELECT meta, created_at FROM messages WHERE id = ?').get(id) as Row | undefined;
        let meta: { unverified?: { kind?: string; problem?: string; sentence?: string }[] } = {};
        try {
          meta = m?.meta ? JSON.parse(String(m.meta)) : {};
        } catch {
          meta = {};
        }
        for (const c of Array.isArray(meta.unverified) ? meta.unverified : []) push(r.claims, 'claims', { run: run.id, kind: clip(c.kind, 30), problem: clip(c.problem, 20), sentence: clip(c.sentence, 300), at: String(m?.created_at ?? run.startedAt) });
      }
      for (const st of steps) {
        s.modelCalls += st.calls.length;
        s.unpricedCalls += st.calls.filter((c) => c.usd === null).length;
        for (const t of st.tools as ToolStep[]) {
          s.toolCalls++;
          const row = tools.get(t.name) ?? { name: t.name, ok: 0, error: 0, denied: 0 };
          row[t.status === 'ok' ? 'ok' : t.status === 'error' ? 'error' : 'denied']++;
          tools.set(t.name, row);
          if (t.approval) r.approvals[t.approval]++;
          const call = { run: run.id, name: t.name, summary: clip(t.summary, 160), output: clip(t.output, 300), at: st.at };
          if (t.status === 'error') {
            s.failedTools++;
            push(r.failed, 'failed', call);
          }
          if (t.guard) push(r.refusals, 'refusals', { ...call, why: t.guard.kind === 'loop' ? 'loop' : 'declined' });
          else if (t.approval === 'refused') push(r.refusals, 'refusals', { ...call, why: 'policy' });
          const sb = t.sandbox as { isolation?: unknown; choice?: unknown } | undefined;
          if (sb && typeof sb === 'object') push(r.sandbox, 'sandbox', { run: run.id, name: t.name, summary: call.summary, isolation: clip(sb.isolation, 40) || '—', choice: clip(sb.choice, 40) || '—', at: st.at });
          const url = typeof t.args?.url === 'string' ? t.args.url : undefined;
          if (url && WEB_URL.test(t.name) && /^https?:\/\//i.test(url) && !seenUrl.has(url)) {
            seenUrl.add(url);
            push(r.sources, 'sources', { url: clip(url, 500), title: '', status: t.status === 'ok' ? 'read' : 'failed', from: 'tool', run: run.id });
          }
          const q = t.name === 'web_search' && typeof t.args?.query === 'string' ? clip(t.args.query, 200) : '';
          if (q && !seenSearch.has(q)) {
            seenSearch.add(q);
            push(r.searches, 'searches', q);
          }
        }
      }
    }
    // EC6 research runs are not tied to a chat, so they belong to a week only.
    if (scope.kind === 'week') {
      try {
        for (const x of src.db.prepare("SELECT s.url, s.title, s.status, s.run_id FROM research_sources s JOIN research_runs r ON r.id = s.run_id WHERE r.created_at >= ? AND r.created_at < ? AND s.status IN ('read', 'failed') ORDER BY s.id").all(scope.from, scope.to) as Row[]) {
          const url = String(x.url);
          if (seenUrl.has(url)) continue;
          seenUrl.add(url);
          push(r.sources, 'sources', { url: clip(url, 500), title: clip(x.title, 160), status: String(x.status), from: 'research', run: Number(x.run_id) });
        }
      } catch {
        /* no research tables in this space yet */
      }
    }
  }
  r.summary.usd = Math.round(r.summary.usd * 1e6) / 1e6;
  r.tools = [...tools.values()].sort((a, b) => b.ok + b.error + b.denied - (a.ok + a.error + a.denied) || a.name.localeCompare(b.name));
  if (scope.kind === 'run') {
    if (!found) throw new Error(`No run ${scope.id} here.`);
    const run = r.runs[0]!;
    r.title = `Run ${run.id}: ${run.title || run.kind}`;
    r.from = run.startedAt;
  } else if (scope.kind === 'project') {
    if (projectName === undefined) throw new Error(`No project ${scope.id} here.`);
    r.title = `Project: ${projectName}`;
  } else {
    r.title = `Week from ${scope.from.slice(0, 10)}`;
    r.from = scope.from;
    r.to = scope.to;
  }
  // The audit rows of the window (the run's own day range for one run; none for a project, whose
  // work has no window). Names and outcomes only.
  const winFrom = scope.kind === 'week' ? Date.parse(scope.from) : scope.kind === 'run' && r.runs[0] ? Date.parse(r.runs[0].startedAt) - 60_000 : NaN;
  const winTo = scope.kind === 'week' ? Date.parse(scope.to) : scope.kind === 'run' && r.runs[0] ? Date.parse(r.runs[0].startedAt) + Math.max(r.summary.ms, 0) + 10 * 60_000 : NaN;
  if (!Number.isNaN(winFrom)) {
    const rows = [...auditRows].filter((a) => {
      const at = Date.parse(a.at);
      return at >= winFrom && at < winTo;
    }).sort((a, b) => b.seq - a.seq);
    for (const a of rows) {
      if (a.outcome === 'refused') r.auditRefused++;
      push(r.audit, 'audit', { seq: a.seq, at: a.at, action: a.action, who: a.who, role: a.role, channel: a.channel, outcome: a.outcome, ...(a.target ? { target: a.target } : {}) });
    }
  }
  return r;
}

const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const moreLine = (n: number): string => (n ? `\n_…and ${n} more._\n` : '');

/** The report as one Markdown document (the PDF and Word downloads are made from it). */
export function trustMarkdown(r: TrustReport, generated = new Date().toISOString()): string {
  const s = r.summary;
  const out: string[] = [`# Trust report: ${r.title}`, '', `Made ${generated.slice(0, 16).replace('T', ' ')} UTC${r.from ? ` · from ${r.from.slice(0, 10)}` : ''}${r.to ? ` to ${r.to.slice(0, 10)}` : ''}. What Sara said, set against what her records show actually ran.`, ''];
  out.push('## Summary', '', `- Runs: ${s.runs} (${s.errors} ended with an error), steps: ${s.steps}, model calls: ${s.modelCalls}`, `- Tool calls: ${s.toolCalls}, failed: ${s.failedTools}`, `- Tokens: ${s.tokensIn} in, ${s.tokensOut} out · estimated cost $${s.usd.toFixed(2)}${s.unpricedCalls ? ` (${s.unpricedCalls} calls with no price)` : ''}`, `- Claims flagged by the receipts check: ${r.claims.length + r.more.claims}`, '');
  out.push('## Claims checked', '', r.claims.length ? 'Sentences in her replies that no tool receipt backed (missing) or that a receipt contradicted.' : 'No reply sentence was flagged: every claim the receipts check looks for was backed by a tool receipt.', '');
  for (const c of r.claims) out.push(`- Run ${c.run} · ${c.kind} · **${c.problem}**: "${c.sentence}"`);
  out.push(moreLine(r.more.claims), '## Tool calls', '');
  if (r.tools.length) out.push('| Tool | ok | error | denied |', '|---|---|---|---|', ...r.tools.map((t) => `| ${cell(t.name)} | ${t.ok} | ${t.error} | ${t.denied} |`));
  else out.push('No tool calls.');
  out.push('', '## Failed tools', '');
  for (const f of r.failed) out.push(`- Run ${f.run} · ${f.name}: ${f.summary} — ${f.output}`);
  if (!r.failed.length) out.push('None.');
  out.push(moreLine(r.more.failed), '## Approvals', '', `- Ran without asking: ${r.approvals.auto}`, `- Allowed by a person: ${r.approvals.allowed}`, `- Denied by a person: ${r.approvals.denied}`, `- Refused (never, not available, or the policy): ${r.approvals.refused}`, '');
  out.push('## Policy refusals', '');
  for (const f of r.refusals) out.push(`- Run ${f.run} · ${f.name} (${f.why === 'policy' ? 'policy or never-allowed' : f.why === 'loop' ? 'loop guard' : 'declined before'}): ${f.summary}`);
  if (!r.refusals.length) out.push('None.');
  out.push(moreLine(r.more.refusals), `Audit rows refused in this window: ${r.auditRefused}.`, '', '## Sandbox', '');
  for (const x of r.sandbox) out.push(`- Run ${x.run} · ${x.name}: ${x.isolation}, ${x.choice}`);
  if (!r.sandbox.length) out.push('No sandbox tries.');
  out.push(moreLine(r.more.sandbox), '## Sources cited', '');
  for (const x of r.sources) out.push(`- ${x.status === 'read' ? 'Read' : 'Failed'}: ${x.url}${x.title ? ` (${x.title})` : ''}${x.from === 'research' ? ` · research run ${x.run}` : ` · run ${x.run}`}`);
  for (const q of r.searches) out.push(`- Searched: ${q}`);
  if (!r.sources.length && !r.searches.length) out.push('No web sources.');
  out.push(moreLine(r.more.sources + r.more.searches), '## Audit trail', '');
  if (r.audit.length) out.push('| # | When | What | Who | Where | Outcome |', '|---|---|---|---|---|---|', ...r.audit.map((a) => `| ${a.seq} | ${a.at.slice(0, 16).replace('T', ' ')} | ${cell(a.action)}${a.target ? ` ${cell(a.target)}` : ''} | ${cell(a.who)} | ${cell(a.channel)} | ${a.outcome} |`));
  else out.push(r.scope.kind === 'project' ? 'A project has no time window: see a week or a run for audit rows.' : 'No audit rows in this window.');
  out.push(moreLine(r.more.audit), '## Runs', '');
  for (const x of r.runs) out.push(`- Run ${x.id} · ${x.kind} · ${x.status} · ${x.startedAt.slice(0, 16).replace('T', ' ')} · ${cell(x.title)}`);
  if (!r.runs.length) out.push('No runs.');
  out.push(moreLine(r.more.runs));
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
