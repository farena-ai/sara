// Phase 81 (harness track M6, docs/design/HARNESS_TRACK.md §3 M6, §7 #2 #5): the security pass.
//
// After a coding turn that changed files (the TurnHooks `afterReply` seam with `final`), a pass
// runs in the background with its own small budget, as its own run (kind 'security'):
//   1. the deterministic checks (src/security/rules.ts) over the changed files: no model;
//   2. the dependency check of changed manifests/lockfiles against OSV.dev, only when the owner
//      switched advisories on, never in private conversations or private local mode;
//   3. the Reviewing model (a new model job, falls back to Coding) reads the diff with the
//      deterministic findings as context and may add findings only with a verbatim quote, which
//      code checks (the "no theater" rule): an invented quote is dropped.
// Findings go into the one findings table (src/security/findings.ts) and onto the turn's reply
// (`meta.security`), and the page is told (`findings` event).
//
// Install-time check: a shell command that installs a pinned package version
// (npm/pnpm/yarn/pip/poetry/cargo/go/gem) is looked up first; a known-vulnerable version stops
// with a "Known vulnerability" approval card. Going on is an explicit override, recorded.
//
// Settings → Coding → Coding projects → Security pass: After coding turns (default) / Only when
// I ask / Off; the second look by the Reviewing model; live advisories (off by default, the
// package list shown before switching on); the pass's token budget. Never in everyday chats.
import { readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AppContext, ChatEvent, TurnHooks } from '../chat.ts';
import { resolveChain } from '../chat.ts';
import { isCloudModelName } from '../model-names.ts';
import { privateLocalOn } from '../net-guard.ts';
import type { ChatMessage, Provider } from '../providers/types.ts';
import { filesNamed, RunRecorder } from '../runs.ts';
import type { Conversation } from '../store.ts';
import { advisoryLine, worst, type AdvisoryCard, type OsvClient, type Verdict } from './advisories.ts';
export type { AdvisoryCard } from './advisories.ts';
export { declinedInstallOutput } from './advisories.ts';
import { installTargets, isInstallCommand, isManifest, pkgKey, readManifest, uniquePkgs, type FoundPkg, type Pkg } from './deps.ts';
import { readWorkspaceText, SEVERITY_RANK, validateQuotes, type Finding, type FindingSeverity, type FindingStore, type NewFinding } from './findings.ts';
import { changedLines, dirtyFiles, fileSig, git, repoState, reviewDiff } from './git.ts';
import { checkable, checkFile, RULES } from './rules.ts';

export type SecurityMode = 'off' | 'after' | 'ask';
export const SECURITY_MODES: readonly SecurityMode[] = ['after', 'ask', 'off'];
export const REVIEW_BUDGET_CHOICES = [10_000, 30_000, 100_000] as const;

export interface SecuritySettings {
  /** After coding turns (default) / Only when I ask / Off. */
  mode: SecurityMode;
  /** The Reviewing model's second look (falls back to the Coding model). */
  reviewer: boolean;
  /** Live advisories from OSV.dev (§7 #2: off until the owner switches it on). */
  advisories: boolean;
  /** Tokens the pass (reviewer) and each fix may spend. */
  budgetTokens: (typeof REVIEW_BUDGET_CHOICES)[number];
  /** Run the project's tests in a sandbox copy after a fix. */
  runTests: boolean;
}
export const DEFAULT_SECURITY: SecuritySettings = { mode: 'after', reviewer: true, advisories: false, budgetTokens: 30_000, runTests: true };

export function securitySettings(s: { securityPass?: Partial<SecuritySettings> } | undefined): SecuritySettings {
  const r = s?.securityPass ?? {};
  return {
    mode: SECURITY_MODES.includes(r.mode as SecurityMode) ? (r.mode as SecurityMode) : DEFAULT_SECURITY.mode,
    reviewer: typeof r.reviewer === 'boolean' ? r.reviewer : DEFAULT_SECURITY.reviewer,
    advisories: r.advisories === true,
    budgetTokens: REVIEW_BUDGET_CHOICES.includes(Number(r.budgetTokens) as (typeof REVIEW_BUDGET_CHOICES)[number]) ? (Number(r.budgetTokens) as SecuritySettings['budgetTokens']) : DEFAULT_SECURITY.budgetTokens,
    runTests: typeof r.runTests === 'boolean' ? r.runTests : DEFAULT_SECURITY.runTests,
  };
}

export function mergeSecurity(cur: SecuritySettings, body: Record<string, unknown>): SecuritySettings {
  return securitySettings({
    securityPass: {
      ...cur,
      ...(SECURITY_MODES.includes(body.mode as SecurityMode) ? { mode: body.mode as SecurityMode } : {}),
      ...(typeof body.reviewer === 'boolean' ? { reviewer: body.reviewer } : {}),
      ...(typeof body.advisories === 'boolean' ? { advisories: body.advisories } : {}),
      ...(REVIEW_BUDGET_CHOICES.includes(Number(body.budgetTokens) as SecuritySettings['budgetTokens']) ? { budgetTokens: Number(body.budgetTokens) as SecuritySettings['budgetTokens'] } : {}),
      ...(typeof body.runTests === 'boolean' ? { runTests: body.runTests } : {}),
    },
  });
}

/** The pass's own time limit (the background work never runs on forever). */
const PASS_MS = 180_000;
const MAX_FILES = 200;

export interface PassInput {
  conversationId?: string | null;
  workspace: string;
  wsDir: string;
  files: string[];
  reason: 'turn' | 'ask';
  private: boolean;
  /** Lines changed since the last commit (for "new" routes). */
  changed?: Map<string, Set<number>>;
  /** The reply that ends the turn: it gets `meta.security`. */
  replyMessageId?: number;
  signal?: AbortSignal;
}

export interface PassSummary {
  at: string;
  reason: 'turn' | 'ask';
  runId: number | null;
  files: number;
  /** Open findings from this pass (new and already known). */
  ids: number[];
  newIds: number[];
  counts: Record<FindingSeverity, number>;
  dropped: number;
  reviewer: { ran: boolean; model?: string; added: number; dropped: number; note?: string };
  advisories: { checked: number; vulnerable: number; note?: 'off' | 'private' | 'offline' | 'no manifests' | 'error' };
  ms: number;
  tokens: number;
  error?: string;
}

/** One model answer, through the job's chain (backups take over on failure). */
export async function askModel(chain: { provider: Provider; model: string }[], messages: ChatMessage[], maxTokens: number, signal: AbortSignal): Promise<{ text: string; model: string }> {
  let lastErr: unknown;
  for (const { provider, model } of chain) {
    let out = '';
    try {
      for await (const ev of provider.stream({ model, messages, temperature: 0.1, maxTokens, reasoning: 'none', signal })) {
        if (ev.type === 'text') out += ev.text;
        if (out.length > maxTokens * 8) break;
      }
      return { text: out, model: `${provider.config.label} · ${model}` };
    } catch (err) {
      if (out) return { text: out, model: `${provider.config.label} · ${model}` };
      lastErr = err;
      if (signal.aborted) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('No model answered.');
}

/** The first JSON object (or array) in a model's answer (fenced or not). */
export function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const cand of [fenced, text].filter((x): x is string => Boolean(x))) {
    const a = cand.indexOf('{');
    const b = cand.lastIndexOf('}');
    const c = cand.indexOf('[');
    const d = cand.lastIndexOf(']');
    const tries: string[] = [];
    if (a >= 0 && b > a) tries.push(cand.slice(a, b + 1));
    if (c >= 0 && d > c) tries.push(cand.slice(c, d + 1));
    for (const t of tries) {
      try {
        return JSON.parse(t);
      } catch {
        // Small models often put real line breaks / tabs inside JSON strings (code in "find" and
        // "replace"): escape them and try once more.
        try {
          return JSON.parse(escapeRawControls(t));
        } catch {
          /* next */
        }
      }
    }
  }
  return undefined;
}

/**
 * Every top-level JSON object in a text, in order (string-aware brace matching; each object parsed on
 * its own, with raw line breaks escaped). For answers that list several objects where one was asked.
 */
export function jsonObjectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = 0; i < text.length && out.length < 50; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"' && depth > 0) inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        const t = text.slice(start, i + 1);
        for (const cand of [t, escapeRawControls(t)]) {
          try {
            const v = JSON.parse(cand) as unknown;
            if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
            break;
          } catch {
            /* next */
          }
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Escapes raw newlines, carriage returns and tabs that appear inside JSON string literals. */
export function escapeRawControls(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') {
        out += ch + (s[i + 1] ?? '');
        i++;
        continue;
      }
      if (ch === '"') inStr = false;
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

const REVIEW_SYSTEM = `You review a code change for SECURITY problems only (not style). You never write exploits, attack payloads or test inputs; you only point at lines and say how to fix them.
Answer with JSON only: {"findings":[{"file":"path/as/in/the/diff","line":12,"quote":"text copied exactly from that line","rule":"short-id","severity":"high|medium|low","title":"what is wrong, in plain words","advice":"how to fix it"}]}
Rules:
- The quote MUST be copied character for character from ONE line of the new code. A finding whose quote is not in the file is thrown away.
- Only files in the diff. Only real problems you can point at. Do not repeat the findings already listed.
- If nothing else is wrong, answer {"findings":[]}.`;

export class SecurityPass {
  readonly findings: FindingStore;
  readonly osv: OsvClient;
  readonly #app: AppContext;
  /** The last pass started (tests and evals await it). */
  last?: Promise<PassSummary | undefined>;
  /** One pass per workspace at a time; a second one waits for the first. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(app: AppContext, findings: FindingStore, osv: OsvClient) {
    this.#app = app;
    this.findings = findings;
    this.osv = osv;
  }

  settings(): SecuritySettings {
    return securitySettings(this.#app.settings.get());
  }

  /**
   * The hooks for one coding turn: note which files the turn changed (her file tools, applied
   * sandbox tries, and for commands that ran for real the git status compared with the start),
   * and when the final reply is saved, start the pass in the background (mode After coding turns).
   */
  turnHooks(conv: Conversation, wsDir: string, opts: { group?: boolean; external?: boolean; rec?: RunRecorder } = {}): TurnHooks | undefined {
    if (conv.mode !== 'coding' || conv.partner || opts.group || opts.external) return undefined;
    const s = this.settings();
    // Phase 82: the threat model after coding turns rides on the same seam and the same file list.
    const threats = this.#app.threats;
    const threatsOn = () => Boolean(threats && threats.settings().mode !== 'off');
    if (s.mode === 'off' && !threatsOn()) return undefined;
    const named = new Set<string>();
    let shellRan = false;
    let started = false;
    let before: Map<string, string> | undefined;
    const repo = repoState(wsDir);
    if (repo.repo) {
      try {
        before = new Map(dirtyFiles(wsDir).slice(0, 500).map((f) => [f, fileSig(wsDir, f)]));
      } catch {
        before = undefined;
      }
    }
    const rel = (p: string) => {
      const r = isAbsolute(p) ? relative(wsDir, p) : p;
      return r.split(sep).join('/').replace(/^\.\//, '');
    };
    return {
      afterTool: (c) => {
        if (c.status !== 'ok') return;
        for (const f of filesNamed(c.call.name, c.args)) named.add(rel(f));
        const sb = c.sandbox;
        if (sb?.applied) for (const f of sb.applied.written) named.add(f);
        if ((c.call.name === 'shell' && (!sb || sb.decision === 'ran')) || /^git_|^starter_create$/.test(c.call.name)) shellRan = true;
      },
      afterReply: (c) => {
        if (!c.final || started) return;
        started = true;
        const secAfter = this.settings().mode === 'after';
        if (!secAfter && !threatsOn()) return;
        const files = new Set([...named].filter((f) => f && !f.startsWith('..')));
        if (repo.repo && (shellRan || named.size)) {
          for (const f of dirtyFiles(wsDir).slice(0, 1000)) if (!before || before.get(f) !== fileSig(wsDir, f)) files.add(f);
        }
        const list = [...files].filter((f) => (checkable(f) || isManifest(f)) && readWorkspaceText(wsDir, f) !== undefined).slice(0, MAX_FILES);
        if (!list.length) return;
        const pass = secAfter ? this.start({ conversationId: conv.id, workspace: conv.workspace, wsDir, files: list, reason: 'turn', private: conv.private, replyMessageId: c.messageId, ...(repo.commit ? { changed: changedLines(wsDir, list) } : {}) }) : undefined;
        // The threat pass waits for the security pass (one model call at a time, findings in order).
        if (threats && threatsOn()) threats.start({ conversationId: conv.id, workspace: conv.workspace, wsDir, changed: list.filter(checkable), reason: 'turn', private: conv.private, replyMessageId: c.messageId }, pass);
      },
    };
  }

  /** Starts a pass in the background (queued behind a running one for the same workspace). */
  start(input: PassInput): Promise<PassSummary | undefined> {
    const prev = this.#running.get(input.wsDir) ?? Promise.resolve();
    const p = prev.then(() => this.run(input)).catch((err: Error) => {
      console.warn(`security pass: ${err.message}`);
      return undefined;
    });
    this.#running.set(input.wsDir, p);
    void p.finally(() => {
      if (this.#running.get(input.wsDir) === p) this.#running.delete(input.wsDir);
    });
    this.last = p;
    return p;
  }

  /** The files a "Check now" looks at: the uncommitted ones, or (none) every code file up to 200. */
  filesToCheck(wsDir: string): string[] {
    const repo = repoState(wsDir);
    let files = repo.repo ? dirtyFiles(wsDir) : [];
    if (!files.length && repo.repo) {
      // Nothing uncommitted: the tracked files.
      files = gitTracked(wsDir);
    }
    if (!files.length) files = walkFiles(wsDir);
    return files.filter((f) => checkable(f) || isManifest(f)).slice(0, MAX_FILES);
  }

  /** The packages the advisory check would send for these workspaces (shown before switching it on). */
  previewPackages(dirs: { name: string; dir: string }[]): { workspace: string; file: string; ecosystem: string; name: string; version: string }[] {
    const out: { workspace: string; file: string; ecosystem: string; name: string; version: string }[] = [];
    for (const w of dirs) {
      for (const f of walkFiles(w.dir, 3).filter(isManifest)) {
        const text = readWorkspaceText(w.dir, f);
        if (text === undefined) continue;
        for (const p of uniquePkgs(readManifest(f, text))) out.push({ workspace: w.name, file: f, ecosystem: p.ecosystem, name: p.name, version: p.version });
        if (out.length >= 2000) return out;
      }
    }
    return out;
  }

  /** One pass (awaitable; `start` runs it in the background). */
  async run(input: PassInput): Promise<PassSummary> {
    const t0 = Date.now();
    const app = this.#app;
    const s = this.settings();
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(PASS_MS)]) : AbortSignal.timeout(PASS_MS);
    const conv = input.conversationId ? app.store.getConversation(input.conversationId) : undefined;
    const rec = app.runs && conv ? new RunRecorder(app.runs, { kind: 'security', conversationId: conv.id, title: input.reason === 'ask' ? 'Security check' : 'Security pass' }) : RunRecorder.none();
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    const summary: PassSummary = { at: new Date().toISOString(), reason: input.reason, runId: rec.on ? rec.id : null, files: input.files.length, ids: [], newIds: [], counts: { block: 0, high: 0, medium: 0, low: 0, info: 0 }, dropped: 0, reviewer: { ran: false, added: 0, dropped: 0 }, advisories: { checked: 0, vulnerable: 0 }, ms: 0, tokens: 0 };
    let status: 'ok' | 'error' = 'ok';
    try {
      // 1. The deterministic checks (code only).
      rec.startStep({ label: 'Code checks' });
      const code: NewFinding[] = [];
      for (const f of input.files) {
        if (!checkable(f)) continue;
        const text = read(f);
        if (text === undefined) continue;
        code.push(...checkFile(f, text, input.changed?.has(f) ? { changed: input.changed.get(f)! } : {}));
      }
      // 2. Dependencies (only when switched on; never private; offline = cache only).
      const deps: NewFinding[] = [];
      const manifests = input.files.filter(isManifest);
      if (!manifests.length) summary.advisories.note = 'no manifests';
      else if (!s.advisories) summary.advisories.note = 'off';
      else if (input.private) summary.advisories.note = 'private';
      else {
        const found: FoundPkg[] = [];
        for (const f of manifests) {
          const text = read(f);
          if (text !== undefined) found.push(...readManifest(f, text));
        }
        const pkgs = uniquePkgs(found);
        const verdicts = await this.osv.check(pkgs, signal);
        summary.advisories.checked = pkgs.length;
        if (pkgs.some((p) => verdicts.get(pkgKey(p))?.reason === 'offline' && verdicts.get(pkgKey(p))?.status === 'unknown') || (privateLocalOn() && pkgs.length)) summary.advisories.note = 'offline';
        else if (pkgs.some((p) => verdicts.get(pkgKey(p))?.reason === 'error')) summary.advisories.note = 'error';
        for (const p of pkgs) {
          const v = verdicts.get(pkgKey(p));
          if (v?.status !== 'vulnerable') continue;
          summary.advisories.vulnerable++;
          deps.push(advisoryFinding(p, v, { file: p.file, line: p.line, quote: p.quote }));
        }
      }
      // 3. The Reviewing model (its own small budget; quotes checked by code).
      const model: NewFinding[] = [];
      const codeFiles = input.files.filter(checkable);
      if (s.reviewer && codeFiles.length && conv && !signal.aborted) {
        try {
          const r = await this.#review(conv, input, codeFiles, code, rec, s.budgetTokens, signal);
          model.push(...r.findings);
          summary.reviewer = { ran: r.ran, added: 0, dropped: 0, ...(r.model ? { model: r.model } : {}), ...(r.note ? { note: r.note } : {}) };
        } catch (err) {
          summary.reviewer = { ran: false, added: 0, dropped: 0, note: `error: ${(err as Error).message.slice(0, 160)}` };
        }
      } else if (!s.reviewer) summary.reviewer.note = 'off';
      // The "no theater" rule for every finding with a file.
      const all = [...code, ...deps, ...model];
      const { kept, dropped } = validateQuotes(all, read);
      summary.dropped = dropped.length;
      summary.reviewer.dropped = dropped.filter((d) => d.finding.origin === 'model').length;
      // A model finding on a line code already flagged adds nothing.
      const codeAt = new Set(kept.filter((f) => f.origin !== 'model').map((f) => `${f.file}:${f.line}`));
      const final = kept.filter((f) => f.origin !== 'model' || !codeAt.has(`${f.file}:${f.line}`));
      summary.reviewer.added = final.filter((f) => f.origin === 'model').length;
      const before = new Set(this.findings.list({ workspace: input.workspace, status: 'all', limit: 2000 }).map((f) => f.id));
      const rows = this.findings.add(final, { conversationId: conv?.id ?? null, workspace: input.workspace, runId: rec.on ? rec.id : null });
      const open = rows.filter((r) => r.status === 'open');
      summary.ids = [...new Set(open.map((r) => r.id))];
      summary.newIds = [...new Set(rows.filter((r) => !before.has(r.id)).map((r) => r.id))];
      for (const r of open) summary.counts[r.severity]++;
    } catch (err) {
      status = 'error';
      summary.error = (err as Error).message.slice(0, 300);
    } finally {
      summary.tokens = rec.on ? rec.totals().tokens : summary.tokens;
      summary.ms = Date.now() - t0;
      rec.close(status);
    }
    if (input.replyMessageId) {
      try {
        app.store.updateMessageMeta(input.replyMessageId, { security: summary });
      } catch {
        /* the conversation may be gone */
      }
    }
    app.events?.publish({ type: 'findings', conversationId: conv?.id ?? null, workspace: input.workspace, summary });
    return summary;
  }

  async #review(conv: Conversation, input: PassInput, files: string[], code: NewFinding[], rec: RunRecorder, budget: number, signal: AbortSignal): Promise<{ ran: boolean; findings: NewFinding[]; model?: string; note?: string }> {
    const read = (f: string) => readWorkspaceText(input.wsDir, f);
    // The diff is cut to what the budget leaves room for (an answer of up to ~1,500 tokens).
    const cap = Math.max(0, Math.min(30_000, Math.floor((budget - (rec.on ? rec.totals().tokens : 0) - 1500 - REVIEW_SYSTEM.length / 3.5 - 400) * 3.5)));
    if (cap < 500) return { ran: false, findings: [], note: 'budget' };
    const whole = files.map((f) => `+++ b/${f} (new file)\n${(read(f) ?? '').split(/\r?\n/).map((l) => `+${l}`).join('\n')}`).join('\n');
    const diff = repoState(input.wsDir).commit ? reviewDiff(input.wsDir, files, read, cap) : whole.length > cap ? `${whole.slice(0, cap)}\n[… diff cut at ${cap} characters]` : whole;
    if (!diff.trim()) return { ran: false, findings: [], note: 'empty diff' };
    let chain = resolveChain(this.#app, conv, 'review');
    // A private conversation's review stays on this hardware (resolveChain already enforces the
    // private route; this also drops any backup that isn't local).
    if (conv.private) chain = chain.filter((c) => c.provider.config.local && !isCloudModelName(c.model));
    if (!chain.length) return { ran: false, findings: [], note: 'no model' };
    if (rec.on) chain = chain.map((c) => ({ ...c, provider: rec.wrap(c.provider, 'security review') }));
    const listed = code.map((f) => `- ${f.file}:${f.line} [${f.rule}] ${f.title}: ${f.quote}`).join('\n') || '(none)';
    const user = `Already found by the code checks (do not repeat):\n${listed}\n\nThe change (unified diff; lines starting with + are new):\n${diff}`;
    // Its own small budget: the prompt plus the answer must fit.
    const promptTokens = Math.ceil((REVIEW_SYSTEM.length + user.length) / 3.5);
    const room = budget - (rec.on ? rec.totals().tokens : 0) - promptTokens;
    if (room < 300) return { ran: false, findings: [], note: 'budget' };
    rec.startStep({ label: 'Review' });
    const { text, model } = await askModel(chain, [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: user }], Math.min(2000, room), signal);
    const j = jsonIn(text) as { findings?: unknown[] } | unknown[] | undefined;
    const raw = Array.isArray(j) ? j : Array.isArray((j as { findings?: unknown[] })?.findings) ? (j as { findings: unknown[] }).findings : [];
    const allowed = new Set(files);
    const out: NewFinding[] = [];
    for (const x of raw.slice(0, 30)) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const file = String(o.file ?? '').replace(/^\.?\/*/, '').replace(/^b\//, '');
      if (!allowed.has(file)) continue;
      const sev = String(o.severity ?? 'medium').toLowerCase();
      const severity: FindingSeverity = sev === 'high' || sev === 'critical' ? 'high' : sev === 'low' ? 'low' : 'medium';
      const slug = String(o.rule ?? 'issue').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'issue';
      const title = String(o.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!title) continue;
      out.push({ source: 'security', origin: 'model', severity, rule: `review:${slug}`, title, advice: String(o.advice ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), file, line: Number(o.line) > 0 ? Math.floor(Number(o.line)) : null, quote: String(o.quote ?? '').trim().slice(0, 300), meta: { model } });
    }
    return { ran: true, findings: out, model };
  }

  // ---- install-time check ------------------------------------------------------------------------

  /**
   * Before an install command runs (the beforeTool seam): the pinned versions it names are looked
   * up. A known-vulnerable one stops with the "Known vulnerability" card; offline says "not checked:
   * offline" and goes on. Off, private conversations and private local mode: nothing is sent.
   */
  async installCheck(command: string, conv: Conversation, signal?: AbortSignal): Promise<{ card?: AdvisoryCard; events: ChatEvent[]; verdicts: Map<string, Verdict>; targets: Pkg[] } | undefined> {
    if (!isInstallCommand(command)) return undefined;
    const s = this.settings();
    const targets = installTargets(command);
    if (!targets.length || !s.advisories || conv.private) return undefined;
    const verdicts = await this.osv.check(targets, signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000));
    const bad = targets.filter((p) => verdicts.get(pkgKey(p))?.status === 'vulnerable');
    const offline = targets.filter((p) => verdicts.get(pkgKey(p))?.status === 'unknown');
    const events: ChatEvent[] = [];
    if (offline.length) events.push({ type: 'advisory', id: '', state: 'offline', packages: offline.map((p) => `${p.name} ${p.version}`) });
    if (!bad.length) return { events, verdicts, targets };
    const card: AdvisoryCard = {
      command: command.slice(0, 1000),
      packages: bad.map((p) => {
        const v = verdicts.get(pkgKey(p))!;
        return { ecosystem: p.ecosystem, name: p.name, version: p.version, severity: worst(v), vulns: v.vulns.slice(0, 8).map((x) => ({ id: x.id, summary: x.summary, severity: x.severity, ...(x.fixed ? { fixed: x.fixed } : {}), url: x.url })) };
      }),
    };
    return { card, events, verdicts, targets };
  }

  /** The owner's answer on a "Known vulnerability" card, kept as findings (per decision). */
  recordInstall(card: AdvisoryCard, answer: 'override' | 'deny', scope: { conversationId: string; workspace: string; runId?: number | null; step?: number | null }): Finding[] {
    return this.findings.add(
      card.packages.map((p) => ({
        ...advisoryFinding(p, { status: 'vulnerable', vulns: p.vulns.map((v) => ({ ...v, aliases: [] })), checkedAt: new Date().toISOString() }, { file: null, line: null, quote: card.command }),
        status: answer === 'override' ? ('accepted' as const) : ('dismissed' as const),
        reason: answer === 'override' ? 'Installed anyway (your override on the approval card)' : 'Not installed (you said no on the approval card)',
        meta: { ecosystem: p.ecosystem, name: p.name, version: p.version, vulns: p.vulns, install: true, answer },
      })),
      scope,
    );
  }
}

/** A finding for a vulnerable package (title and advice in plain words; ids and fixed version in meta). */
export function advisoryFinding(p: Pkg, v: Verdict, where: { file: string | null; line: number | null; quote: string }): NewFinding {
  const fixed = v.vulns.map((x) => x.fixed).find(Boolean);
  const sev = worst(v);
  return {
    source: 'advisory',
    origin: 'code',
    severity: SEVERITY_RANK[sev] >= SEVERITY_RANK.high ? 'high' : sev,
    rule: 'known-vulnerability',
    title: `${p.name} ${p.version} has known vulnerabilities`,
    advice: `${advisoryLine(p, v)}. ${fixed ? `Upgrade to ${fixed} or later` : 'Upgrade to a version without these advisories or use another package'}, then install again so the lockfile changes.`,
    file: where.file,
    line: where.line,
    quote: where.quote,
    meta: { ecosystem: p.ecosystem, name: p.name, version: p.version, ...(fixed ? { fixed } : {}), vulns: v.vulns.slice(0, 10).map((x) => ({ id: x.id, summary: x.summary, severity: x.severity, ...(x.fixed ? { fixed: x.fixed } : {}), url: x.url })) },
  };
}

// ---- small file listings (no git) ----------------------------------------------------------------

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.cache', 'coverage']);

/** Files of a folder (forward slashes), dependency and build folders left out. */
export function walkFiles(root: string, maxDepth = 8, cap = 3000): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) out.push(r);
    }
  };
  walk(root, '', 0);
  return out;
}

function gitTracked(ws: string): string[] {
  const r = git(ws, ['ls-files', '-z']);
  return r.status === 0 ? r.out.split('\0').filter(Boolean) : [];
}

export { RULES };
