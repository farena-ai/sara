// Phase 82 (harness track M7, docs/design/HARNESS_TRACK.md §3 M7): the threat-model pass.
//
// After the security pass of a coding turn that changed files (the same `afterReply` seam, the same
// changed-files list), in the background, as its own run (kind 'security', "Threat model"):
//   1. the code map of the project's reachable surface and the deterministic threat rules
//      (src/security/threat-graph.ts): entry points, sinks, a bounded walk entry -> sink; only
//      threats whose path touches a file this turn changed are reported after a turn;
//   2. the Reviewing model (falls back to Coding) gets the graph summary and the diff and may add
//      threats ONLY on an entry point the code listed, with a verbatim quote of the sink line and a
//      named path; code checks both quotes ("no theater"): anything else is dropped;
//   3. the threats go into the one findings table (source 'threat') with entry, sink, path,
//      category and severity, and a threat model summary per project is written into the data
//      folder (<data>/threat-models/<project>.md and .json: surfaces, trust boundaries, open
//      threats, what changed this turn), shown in Findings → Threat model.
// The SECOND PASS ("Fix these", src/security/fix.ts FixBranches.startBatch) is only ever started by
// the owner: the Coding model fixes only those threats on one local branch, the threat rule is the
// re-check, the project's tests run in an M5 sandbox copy, one diff with Apply / Keep / Discard.
// Settings → Coding → Coding projects → Threat model after coding turns: Off / Report only /
// Report and offer the fix pass (default). Never in everyday chats.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../chat.ts';
import { resolveChain } from '../chat.ts';
import { isCloudModelName } from '../model-names.ts';
import { RunRecorder } from '../runs.ts';
import type { Conversation } from '../store.ts';
import { readWorkspaceText, validateQuotes, type Finding, type FindingSeverity, type FindingStore, type NewFinding } from './findings.ts';
import { repoState, reviewDiff } from './git.ts';
import { askModel, jsonIn, securitySettings, walkFiles } from './pass.ts';
import { analyze, pathLine, THREAT_KINDS, THREAT_RULES, type Analysis, type Entry, type Hit, type Step, type ThreatKind } from './threat-graph.ts';

export type ThreatMode = 'off' | 'report' | 'offer';
export const THREAT_MODES: readonly ThreatMode[] = ['offer', 'report', 'off'];
export interface ThreatSettings {
  /** Off / Report only / Report and offer the fix pass (default). */
  mode: ThreatMode;
}
export const DEFAULT_THREATS: ThreatSettings = { mode: 'offer' };

export function threatSettings(s: { threatModel?: Partial<ThreatSettings> } | undefined): ThreatSettings {
  const m = s?.threatModel?.mode;
  return { mode: THREAT_MODES.includes(m as ThreatMode) ? (m as ThreatMode) : DEFAULT_THREATS.mode };
}
export function mergeThreats(cur: ThreatSettings, body: Record<string, unknown>): ThreatSettings {
  return threatSettings({ threatModel: { ...cur, ...(THREAT_MODES.includes(body.mode as ThreatMode) ? { mode: body.mode as ThreatMode } : {}) } });
}

const PASS_MS = 180_000;

export interface ThreatInput {
  conversationId?: string | null;
  workspace: string;
  wsDir: string;
  /** The files this turn changed (after a turn); every threat reported touches one of them. */
  changed: string[];
  reason: 'turn' | 'ask';
  private: boolean;
  replyMessageId?: number;
  signal?: AbortSignal;
}

export interface ThreatSummary {
  at: string;
  workspace: string;
  reason: 'turn' | 'ask';
  mode: ThreatMode;
  runId: number | null;
  files: number;
  changed: number;
  entries: number;
  /** Open threats from this pass (new and already known) and the new ones. */
  ids: number[];
  newIds: number[];
  counts: Record<FindingSeverity, number>;
  dropped: number;
  reviewer: { ran: boolean; model?: string; added: number; dropped: number; note?: string };
  ms: number;
  tokens: number;
  error?: string;
}

/** The threat model summary of a project (written per pass; Findings → Threat model). */
export interface ThreatModel {
  workspace: string;
  at: string;
  files: number;
  truncated: boolean;
  entries: { id: string; kind: Entry['kind']; label: string; file: string; line: number; authed: boolean; upload: boolean }[];
  boundaries: { id: string; count: number }[];
  sinks: { kind: string; file: string; line: number; guarded: boolean }[];
  open: { id: number; rule: string; kind: string; severity: FindingSeverity; category: string; title: string; entry: string; sink: string; path: string; origin: string }[];
  changed: { files: string[]; ids: number[]; newIds: number[]; reason: 'turn' | 'ask'; runId: number | null };
  envReads: number;
}

// ---- hits → findings, and the "no theater" check of both ends --------------------------------------

interface ThreatMeta {
  kind: ThreatKind;
  category: string;
  entry: { id?: string; file: string; line: number; quote: string; label: string; kind: string };
  sink: { file: string; line: number; quote: string };
  path: Step[];
  hops: number;
  [k: string]: unknown;
}

export function hitFinding(h: Hit): NewFinding {
  const r = THREAT_RULES[h.kind];
  return {
    source: 'threat',
    origin: 'code',
    severity: h.entry.kind === 'cli' ? 'low' : r.severity,
    rule: `threat:${h.kind}`,
    title: r.title,
    advice: r.advice,
    file: h.sink.file,
    line: h.sink.line,
    quote: h.sink.quote,
    meta: { kind: h.kind, category: r.category, entry: { id: h.entry.id, file: h.entry.file, line: h.entry.line, quote: h.entry.quote, label: h.entry.label, kind: h.entry.kind }, sink: { file: h.sink.file, line: h.sink.line, quote: h.sink.quote }, path: h.path, hops: h.hops } satisfies ThreatMeta,
  };
}

/**
 * Threat findings keep the "no theater" rule at BOTH ends: the sink quote (validateQuotes, the
 * finding's own file and line) and the entry point's quote must be real text in their files, and
 * the path must name at least the entry and the sink. Anything else is dropped.
 */
export function validateThreats<T extends NewFinding>(list: T[], read: (file: string) => string | undefined): { kept: T[]; dropped: { finding: T; why: string }[] } {
  const { kept: sinkOk, dropped } = validateQuotes(list, read);
  const kept: T[] = [];
  for (const f of sinkOk) {
    const m = f.meta as Partial<ThreatMeta> | undefined;
    if (f.source !== 'threat') {
      kept.push(f);
      continue;
    }
    if (!f.file || !m?.entry?.file || !m.entry.quote || !Array.isArray(m.path) || m.path.length < 2) {
      dropped.push({ finding: f, why: 'no path from an entry point' });
      continue;
    }
    const v = validateQuotes([{ source: 'threat', severity: 'info', rule: 'entry', title: 'entry', advice: '', file: m.entry.file, line: m.entry.line, quote: m.entry.quote }], read);
    if (!v.kept.length) {
      dropped.push({ finding: f, why: `entry ${v.dropped[0]?.why ?? 'not found'}` });
      continue;
    }
    const entry = { ...m.entry, line: v.kept[0].line!, quote: v.kept[0].quote! };
    const path = m.path.map((s, i) => (i === 0 ? { ...s, line: entry.line } : i === m.path!.length - 1 ? { ...s, line: f.line! } : s));
    kept.push({ ...f, meta: { ...m, entry, sink: { file: f.file, line: f.line!, quote: f.quote! }, path } });
  }
  return { kept, dropped };
}

/** How many of a threat finding's problems are still there in a folder (the fix pass's re-check). */
export function recheckThreat(f: Pick<Finding, 'rule' | 'file' | 'quote' | 'meta' | 'origin'>, dir: string, analysis?: Analysis): { line: number; quote: string }[] {
  const m = f.meta as Partial<ThreatMeta>;
  if (f.origin === 'model' || !f.rule.startsWith('threat:') || !THREAT_KINDS.includes(f.rule.slice(7) as ThreatKind)) {
    // A reviewer's threat: the quoted sink line itself is the proof (gone = fixed).
    const text = f.file ? readWorkspaceText(dir, f.file) : undefined;
    if (!text || !f.quote) return [];
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((l) => l.includes(f.quote!));
    return at >= 0 ? [{ line: at + 1, quote: f.quote }] : [];
  }
  const a = analysis ?? analyzeDir(dir);
  const kind = f.rule.slice(7);
  return a.hits.filter((h) => h.kind === kind && h.sink.file === f.file && (!m?.entry?.file || h.entry.file === m.entry.file) && (!m?.entry?.label || h.entry.label === m.entry.label)).map((h) => ({ line: h.sink.line, quote: h.sink.quote }));
}

/** The analysis of a folder on disk (only through the workspace reader: no links, nothing outside). */
export function analyzeDir(dir: string): Analysis {
  return analyze(walkFiles(dir, 10, 3000), (rel) => readWorkspaceText(dir, rel));
}

// ---- the summary -------------------------------------------------------------------------------------

const BOUNDARY_OF: Record<string, string> = { shell: 'shell', sql: 'database', path: 'files', ssrf: 'outbound', deserialize: 'deserialize', html: 'html-out', redirect: 'html-out', eval: 'shell' };

export function threatModelOf(workspace: string, a: Analysis, open: Finding[], changed: ThreatModel['changed']): ThreatModel {
  const boundaries = new Map<string, number>();
  const bump = (id: string, n = 1) => boundaries.set(id, (boundaries.get(id) ?? 0) + n);
  for (const e of a.entries) bump(e.kind === 'http' || e.kind === 'upload' ? 'network-in' : e.kind === 'message' ? 'messages-in' : 'local-in');
  if (a.envReads.length) bump('local-in', 0);
  for (const [k, n] of Object.entries(a.sinkCounts)) if (n && BOUNDARY_OF[k]) bump(BOUNDARY_OF[k], n);
  return {
    workspace,
    at: new Date().toISOString(),
    files: a.files,
    truncated: a.truncated,
    entries: a.entries.slice(0, 300).map((e) => ({ id: e.id, kind: e.kind, label: e.label, file: e.file, line: e.line, authed: e.authed, upload: e.upload })),
    boundaries: [...boundaries].map(([id, count]) => ({ id, count })),
    sinks: a.sinks.slice(0, 300),
    open: open.slice(0, 200).map((f) => {
      const m = f.meta as Partial<ThreatMeta>;
      return { id: f.id, rule: f.rule, kind: String(m.kind ?? f.rule.replace(/^threat:(review-)?/, '')), severity: f.severity, category: String(m.category ?? ''), title: f.title, entry: m.entry ? `${m.entry.label} (${m.entry.file}:${m.entry.line})` : '', sink: `${f.file}:${f.line}`, path: Array.isArray(m.path) ? pathLine(m.path) : '', origin: f.origin };
    }),
    changed,
    envReads: a.envReads.length,
  };
}

const BOUNDARY_WORDS: Record<string, string> = { 'network-in': 'Network → your server (HTTP routes, uploads)', 'messages-in': 'Messages from clients (WebSocket, workers)', 'local-in': 'Command line and environment', outbound: 'Your server → other servers', database: 'Your server → database', files: 'Your server → files', shell: 'Your server → commands and code', deserialize: 'Loading serialized data', 'html-out': 'Your server → browsers (HTML, redirects)' };

export function threatMarkdown(m: ThreatModel): string {
  const L: string[] = [`# Threat model: ${m.workspace}`, '', `Written by Sara's threat pass on ${m.at} from ${m.files} code files${m.truncated ? ' (the first 400)' : ''}. Every threat below quotes real lines; nothing here was run.`, ''];
  L.push('## Surfaces (entry points)', '');
  if (!m.entries.length) L.push('No entry points found.');
  for (const e of m.entries) L.push(`- ${e.label} · \`${e.file}:${e.line}\`${e.kind === 'http' || e.kind === 'upload' ? (e.authed ? ' · signed in' : ' · no sign-in check seen') : ''}${e.upload ? ' · file upload' : ''}`);
  if (m.envReads) L.push(`- Environment variables read in ${m.envReads} places (set by whoever runs the app; no threats from these).`);
  L.push('', '## Trust boundaries', '');
  for (const b of m.boundaries) L.push(`- ${BOUNDARY_WORDS[b.id] ?? b.id}: ${b.count}`);
  L.push('', '## Open threats', '');
  if (!m.open.length) L.push('None open.');
  for (const o of m.open) L.push(`- **#${o.id} ${o.title}** (${o.severity}, ${o.category}${o.origin === 'model' ? ', found by the Reviewing model' : ''})`, `  - Path: ${o.path || `${o.entry} → ${o.sink}`}`);
  L.push('', '## What changed this turn', '');
  L.push(m.changed.files.length ? `Files: ${m.changed.files.map((f) => `\`${f}\``).join(', ')}` : 'A check you started (the whole project).');
  L.push(`New threats: ${m.changed.newIds.length ? m.changed.newIds.map((i) => `#${i}`).join(', ') : 'none'}; open from this pass: ${m.changed.ids.length}.`, '');
  return L.join('\n');
}

const safeName = (ws: string) => ws.replace(/[^\w.-]/g, '_').slice(0, 120);

// ---- the reviewer ------------------------------------------------------------------------------------

const THREAT_REVIEW_SYSTEM = `You review the attack surface of a code change. You never write exploits, attack payloads or test inputs; you only point at lines and say how to fix them.
You get the entry points the code found (E1, E2, …), the threats the code already found, and the diff.
Add a threat ONLY when outside input from one of the listed entry points reaches a dangerous line without a check. Answer with JSON only:
{"threats":[{"entry":"E1","sink":{"file":"path/as/in/the/project","line":12,"quote":"text copied exactly from that line"},"path":["E1 handler","helper()","the sink"],"kind":"shell|sql|path|ssrf|deserialize|html|redirect|eval|secret|auth|ratelimit|other","severity":"high|medium|low","title":"what is wrong, in plain words","advice":"how to fix it"}]}
Rules:
- "entry" must be one of the listed ids. "quote" MUST be copied character for character from ONE line. "path" names each step from the entry to the sink.
- A threat without a real quote or without a path is thrown away. Do not repeat the threats already listed.
- If nothing else is wrong, answer {"threats":[]}.`;

export class ThreatPass {
  readonly findings: FindingStore;
  readonly #app: AppContext;
  last?: Promise<ThreatSummary | undefined>;
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(app: AppContext, findings: FindingStore) {
    this.#app = app;
    this.findings = findings;
  }

  settings(): ThreatSettings {
    return threatSettings(this.#app.settings.get());
  }

  /** The folder the summaries are written to (each space's own data folder). */
  dir(): string {
    return join(this.#app.dataDir, 'threat-models');
  }

  /** The last summary written for a project (undefined before the first pass). */
  model(workspace: string): { model: ThreatModel; markdown: string } | undefined {
    try {
      const model = JSON.parse(readFileSync(join(this.dir(), `${safeName(workspace)}.json`), 'utf8')) as ThreatModel;
      const markdown = readFileSync(join(this.dir(), `${safeName(workspace)}.md`), 'utf8');
      return { model, markdown };
    } catch {
      return undefined;
    }
  }

  /** Starts a pass in the background (after `after`, the turn's security pass, and any running one). */
  start(input: ThreatInput, after?: Promise<unknown>): Promise<ThreatSummary | undefined> {
    const prev = Promise.all([this.#running.get(input.wsDir), after].map((p) => (p ?? Promise.resolve()).catch(() => undefined)));
    const p = prev.then(() => this.run(input)).catch((err: Error) => {
      console.warn(`threat pass: ${err.message}`);
      return undefined;
    });
    this.#running.set(input.wsDir, p);
    void p.finally(() => {
      if (this.#running.get(input.wsDir) === p) this.#running.delete(input.wsDir);
    });
    this.last = p;
    return p;
  }

  async run(input: ThreatInput): Promise<ThreatSummary> {
    const t0 = Date.now();
    const app = this.#app;
    const sec = securitySettings(app.settings.get());
    const mode = this.settings().mode;
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(PASS_MS)]) : AbortSignal.timeout(PASS_MS);
    const conv = input.conversationId ? app.store.getConversation(input.conversationId) : undefined;
    const rec = app.runs && conv ? new RunRecorder(app.runs, { kind: 'security', conversationId: conv.id, title: 'Threat model' }) : RunRecorder.none();
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const summary: ThreatSummary = { at: new Date().toISOString(), workspace: input.workspace, reason: input.reason, mode, runId: rec.on ? rec.id : null, files: 0, changed: input.changed.length, entries: 0, ids: [], newIds: [], counts: { block: 0, high: 0, medium: 0, low: 0, info: 0 }, dropped: 0, reviewer: { ran: false, added: 0, dropped: 0 }, ms: 0, tokens: 0 };
    let status: 'ok' | 'error' = 'ok';
    let analysis: Analysis | undefined;
    try {
      rec.startStep({ label: 'Map the attack surface' });
      analysis = analyze(walkFiles(input.wsDir, 10, 3000), read);
      summary.files = analysis.files;
      summary.entries = analysis.entries.length;
      const changed = new Set(input.changed);
      const touches = (h: Hit) => input.reason === 'ask' || h.path.some((s) => changed.has(s.file)) || changed.has(h.entry.file);
      const code = analysis.hits.filter(touches).map(hitFinding);
      // The Reviewing model: graph summary + diff; additions only on listed entries, quotes checked.
      const model: NewFinding[] = [];
      if (sec.reviewer && conv && analysis.entries.length && !signal.aborted) {
        try {
          const r = await this.#review(conv, input, analysis, code, rec, sec.budgetTokens, signal);
          model.push(...r.findings);
          summary.reviewer = { ran: r.ran, added: 0, dropped: 0, ...(r.model ? { model: r.model } : {}), ...(r.note ? { note: r.note } : {}) };
        } catch (err) {
          summary.reviewer = { ran: false, added: 0, dropped: 0, note: `error: ${(err as Error).message.slice(0, 160)}` };
        }
      } else if (!sec.reviewer) summary.reviewer.note = 'off';
      const { kept, dropped } = validateThreats([...code, ...model], read);
      summary.dropped = dropped.length;
      summary.reviewer.dropped = dropped.filter((d) => d.finding.origin === 'model').length;
      const codeAt = new Set(kept.filter((f) => f.origin !== 'model').map((f) => `${f.file}:${f.line}`));
      const final = kept.filter((f) => f.origin !== 'model' || !codeAt.has(`${f.file}:${f.line}`));
      summary.reviewer.added = final.filter((f) => f.origin === 'model').length;
      const before = new Set(this.findings.list({ workspace: input.workspace, source: 'threat', status: 'all', limit: 2000 }).map((f) => f.id));
      const rows = this.findings.add(final, { conversationId: conv?.id ?? null, workspace: input.workspace, runId: rec.on ? rec.id : null });
      // Two paths to the same sink line are one finding (one fingerprint): count each row once.
      const open = [...new Map(rows.filter((r) => r.status === 'open').map((r) => [r.id, r])).values()];
      summary.ids = open.map((r) => r.id);
      summary.newIds = [...new Set(rows.filter((r) => !before.has(r.id)).map((r) => r.id))];
      for (const r of open) summary.counts[r.severity]++;
    } catch (err) {
      status = 'error';
      summary.error = (err as Error).message.slice(0, 300);
    } finally {
      summary.tokens = rec.on ? rec.totals().tokens : 0;
      summary.ms = Date.now() - t0;
      rec.close(status);
    }
    if (analysis) {
      try {
        const m = threatModelOf(input.workspace, analysis, this.findings.list({ workspace: input.workspace, source: 'threat', status: 'open' }), { files: input.reason === 'turn' ? input.changed.slice(0, 200) : [], ids: summary.ids, newIds: summary.newIds, reason: input.reason, runId: summary.runId });
        mkdirSync(this.dir(), { recursive: true });
        const base = join(this.dir(), safeName(input.workspace));
        writeFileSync(`${base}.json.tmp`, JSON.stringify(m));
        renameSync(`${base}.json.tmp`, `${base}.json`);
        writeFileSync(`${base}.md`, threatMarkdown(m));
      } catch (err) {
        console.warn(`threat model summary: ${(err as Error).message}`);
      }
    }
    if (input.replyMessageId) {
      try {
        app.store.updateMessageMeta(input.replyMessageId, { threats: summary });
      } catch {
        /* the conversation may be gone */
      }
    }
    app.events?.publish({ type: 'findings', conversationId: conv?.id ?? null, workspace: input.workspace, summary: { ...summary, kind: 'threats' } as never });
    return summary;
  }

  async #review(conv: Conversation, input: ThreatInput, a: Analysis, code: NewFinding[], rec: RunRecorder, budget: number, signal: AbortSignal): Promise<{ ran: boolean; findings: NewFinding[]; model?: string; note?: string }> {
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const files = input.changed.filter((f) => read(f) !== undefined).slice(0, 200);
    const graph = [
      'Entry points (found by code):',
      ...a.entries.slice(0, 80).map((e) => `- ${e.id} ${e.label} at ${e.file}:${e.line}${e.kind === 'http' || e.kind === 'upload' ? (e.authed ? ' (signed in)' : ' (no sign-in check seen)') : ''}: ${e.quote}`),
      '',
      'Sinks the code reached from them:',
      ...a.sinks.slice(0, 80).map((s) => `- ${s.kind} at ${s.file}:${s.line}${s.guarded ? ' (guarded)' : ''}`),
      '',
      'Threats already found (do not repeat):',
      ...(code.length ? code.slice(0, 60).map((f) => `- ${f.rule} ${pathLine(((f.meta as ThreatMeta).path) ?? [])}`) : ['(none)']),
    ].join('\n');
    const fixed = Math.ceil((THREAT_REVIEW_SYSTEM.length + graph.length) / 3.5) + 400;
    const cap = Math.max(0, Math.min(30_000, Math.floor((budget - (rec.on ? rec.totals().tokens : 0) - 1500 - fixed) * 3.5)));
    if (cap < 500) return { ran: false, findings: [], note: 'budget' };
    if (!files.length && input.reason === 'turn') return { ran: false, findings: [], note: 'empty diff' };
    const diff = files.length ? (repoState(input.wsDir).commit ? reviewDiff(input.wsDir, files, read, cap) : files.map((f) => `+++ b/${f} (new file)\n${(read(f) ?? '').split(/\r?\n/).map((l) => `+${l}`).join('\n')}`).join('\n').slice(0, cap)) : '';
    if (input.reason === 'turn' && !diff.trim()) return { ran: false, findings: [], note: 'empty diff' };
    let chain = resolveChain(this.#app, conv, 'review');
    if (conv.private) chain = chain.filter((c) => c.provider.config.local && !isCloudModelName(c.model));
    if (!chain.length) return { ran: false, findings: [], note: 'no model' };
    if (rec.on) chain = chain.map((c) => ({ ...c, provider: rec.wrap(c.provider, 'threat review') }));
    const user = `${graph}\n\nThe change (unified diff; lines starting with + are new):\n${diff || '(a check of the whole project: no diff)'}`;
    const promptTokens = Math.ceil((THREAT_REVIEW_SYSTEM.length + user.length) / 3.5);
    const room = budget - (rec.on ? rec.totals().tokens : 0) - promptTokens;
    if (room < 300) return { ran: false, findings: [], note: 'budget' };
    rec.startStep({ label: 'Review the threats' });
    const { text, model } = await askModel(chain, [{ role: 'system', content: THREAT_REVIEW_SYSTEM }, { role: 'user', content: user }], Math.min(2000, room), signal);
    const j = jsonIn(text) as { threats?: unknown[] } | unknown[] | undefined;
    const raw = Array.isArray(j) ? j : Array.isArray((j as { threats?: unknown[] })?.threats) ? (j as { threats: unknown[] }).threats : [];
    const byId = new Map(a.entries.map((e) => [e.id, e]));
    const out: NewFinding[] = [];
    for (const x of raw.slice(0, 20)) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      // Entry-point listing is code: the model may only name one of the listed entries.
      const e = byId.get(String(o.entry ?? '').trim());
      if (!e) continue;
      const s = (o.sink ?? {}) as Record<string, unknown>;
      const file = String(s.file ?? '').replace(/^\.?\/*/, '').replace(/^b\//, '');
      const quote = String(s.quote ?? '').trim().slice(0, 300);
      const named = Array.isArray(o.path) ? o.path.map((p) => String(p).replace(/\s+/g, ' ').trim().slice(0, 120)).filter(Boolean).slice(0, 8) : [];
      if (!file || !quote || !named.length) continue;
      const k = String(o.kind ?? 'other').toLowerCase();
      const kind = (THREAT_KINDS as readonly string[]).includes(k) ? (k as ThreatKind) : undefined;
      const sev = String(o.severity ?? 'medium').toLowerCase();
      const severity: FindingSeverity = sev === 'high' || sev === 'critical' ? 'high' : sev === 'low' ? 'low' : 'medium';
      const title = String(o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!title) continue;
      const line = Number(s.line) > 0 ? Math.floor(Number(s.line)) : 1;
      const path: Step[] = [{ file: e.file, line: e.line, label: e.label }, ...named.slice(1, -1).map((label) => ({ file, line, label })), { file, line, label: named.at(-1) ?? 'sink' }];
      out.push({ source: 'threat', origin: 'model', severity, rule: `threat:review-${kind ?? 'other'}`, title, advice: String(o.advice ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), file, line, quote, meta: { kind: kind ?? 'other', category: kind ? THREAT_RULES[kind].category : 'Tampering', entry: { id: e.id, file: e.file, line: e.line, quote: e.quote, label: e.label, kind: e.kind }, sink: { file, line, quote }, path, hops: path.length - 1, named, model } });
    }
    return { ran: true, findings: out, model };
  }
}
