// 3.1.1 move-in on the same computer: Sara looks (read-only) in the standard places an old agent keeps
// its home (%LOCALAPPDATA%\hermes, ~/.hermes, $HERMES_HOME, ~/.openclaw, ~/.openclaw-*, $OPENCLAW_STATE_DIR)
// and counts what would come over (memories, skills she learned, past chats), so the Move in page can
// say "Found Hermes Agent on this computer: 10 memories, 17 skills, 107 past chats → Bring her over".
// Only names, counts and the agent's own small files are read; nothing is written. The paths never come
// from the browser: the page sends back the key of a found agent, never a path.
// Also: the one-paste scripts for another computer (go.sh / go.ps1), which download the collector from
// this Sara, pack the old agent and send it straight here with a one-time move-in code.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { splitHermesEntries } from './text.ts';

export const NODE_COLLECTOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'sara-movein.mjs');

export interface LocalAgent {
  key: string;
  kind: 'hermes' | 'openclaw';
  agentId: string;
  /** Where it lives, with ~ for the home folder (shown on the page). */
  where: string;
  name: string;
  counts: { memories: number; skills: number; chats: number };
}
/** The server-side half of a found agent (the path the collector is pointed at). */
export interface LocalTarget extends LocalAgent {
  root: string;
}

interface Candidate {
  kind: 'hermes' | 'openclaw' | 'custom';
  agentId: string;
  roots: [string, string, string][];
}
type CollectorModule = { findCandidates: (opts: Record<string, unknown>) => Candidate[] };

const BUNDLED_AUTHOR = /\b(hermes agent|nous research|nousresearch|openclaw)\b/i;
const HELPER_SOURCE = /^(subagent|delegate|delegation|worker)$/i;
const CONTINUES = /compress|compact|context|summar|rollover|continu/i;

let cache: { at: number; list: LocalTarget[] } | undefined;

const safe = <T>(f: () => T, d: T): T => {
  try {
    return f();
  } catch {
    return d;
  }
};

/** SKILL.md folders under a skills folder (dot folders and links skipped, at most `cap` entries looked at). */
function countSkills(dir: string, cap = 4000): number {
  let n = 0;
  let seen = 0;
  const todo = [dir];
  while (todo.length && seen < cap) {
    const d = todo.pop()!;
    for (const e of safe(() => readdirSync(d, { withFileTypes: true }), [])) {
      if (++seen > cap) break;
      if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) todo.push(p);
      else if (e.name === 'SKILL.md') {
        const head = safe(() => readFileSync(p, 'utf8').slice(0, 4096), '');
        const author = /^\s*author:\s*(.+)$/m.exec(head)?.[1] ?? '';
        if (!BUNDLED_AUTHOR.test(author)) n++;
      }
    }
  }
  return n;
}

/** Past chats in a Hermes state.db: her chats with you (helpers left out, compression chains as one). */
function countHermesChats(db: string): number {
  if (!existsSync(db)) return 0;
  const conn = safe(() => new DatabaseSync(db, { readOnly: true }), undefined);
  if (!conn) return 0;
  try {
    const cols = new Set((conn.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('id')) return 0;
    const pick = (c: string) => (cols.has(c) ? c : 'NULL');
    const rows = conn.prepare(`SELECT id, ${pick('source')} AS source, ${pick('parent_session_id')} AS parent, ${pick('started_at')} AS started, ${pick('ended_at')} AS ended, ${pick('end_reason')} AS reason, ${pick('message_count')} AS msgs FROM sessions`).all() as { id: string; source: string | null; parent: string | null; started: number | null; ended: number | null; reason: string | null; msgs: number | null }[];
    const by = new Map(rows.map((r) => [String(r.id), r]));
    let n = 0;
    for (const r of rows) {
      if (HELPER_SOURCE.test(String(r.source ?? '')) || r.msgs === 0) continue;
      const p = r.parent ? by.get(String(r.parent)) : undefined;
      const joins = p && (!p.reason || CONTINUES.test(String(p.reason))) && Number(r.started ?? 0) >= Number(p.ended ?? 0) - 60;
      if (!joins) n++;
    }
    return n;
  } catch {
    return 0;
  } finally {
    conn.close();
  }
}

function hermesCounts(home: string): LocalAgent['counts'] {
  let memories = 0;
  for (const f of ['MEMORY.md', 'USER.md']) memories += safe(() => splitHermesEntries(readFileSync(join(home, 'memories', f), 'utf8')).length, 0);
  return { memories, skills: countSkills(join(home, 'skills')), chats: countHermesChats(join(home, 'state.db')) };
}

function openclawCounts(state: string, ws: string | undefined, agentId: string): LocalAgent['counts'] {
  let memories = 0;
  if (ws) {
    for (const f of ['MEMORY.md', 'memory.md', 'USER.md']) memories += safe(() => (readFileSync(join(ws, f), 'utf8').match(/^\s*[-*] /gm) ?? []).length, 0);
    memories += safe(() => readdirSync(join(ws, 'memory')).filter((x) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(x)).length, 0);
  }
  const skills = countSkills(join(state, 'skills')) + (ws ? countSkills(join(ws, 'skills')) : 0);
  const chats = safe(() => readdirSync(join(state, 'agents', agentId, 'sessions')).filter((x) => x.endsWith('.jsonl')).length, 0);
  return { memories, skills, chats };
}

function displayName(kind: string, root: string, ws: string | undefined): string {
  const files = kind === 'hermes' ? [join(root, 'SOUL.md')] : ws ? [join(ws, 'IDENTITY.md'), join(ws, 'SOUL.md')] : [];
  for (const f of files) {
    const text = safe(() => readFileSync(f, 'utf8').slice(0, 64 * 1024), '');
    const m = /^\s*[-*]?\s*\**name\**\s*[:\uff1a]\s*\**([^\n*]{1,40})/im.exec(text);
    if (m) return m[1].trim();
  }
  return '';
}

const tilde = (p: string, home: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

/** Old agents on this computer (cached 20 s). `env`/`home` are for tests. */
export async function findLocalAgents(opts: { fresh?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<LocalTarget[]> {
  if (!opts.fresh && cache && Date.now() - cache.at < 20_000) return cache.list;
  const mod = (await import(NODE_COLLECTOR_PATH.startsWith('/') ? `file://${NODE_COLLECTOR_PATH}` : `file:///${NODE_COLLECTOR_PATH.replace(/\\/g, '/')}`)) as CollectorModule;
  const env = opts.env ?? process.env;
  const home = (process.platform === 'win32' ? env.USERPROFILE : env.HOME) || '';
  const saved = { ...process.env };
  let cands: Candidate[] = [];
  try {
    if (opts.env) Object.assign(process.env, opts.env);
    cands = mod.findCandidates({});
  } finally {
    if (opts.env) {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }
  const list: LocalTarget[] = [];
  for (const c of cands) {
    if (c.kind !== 'hermes' && c.kind !== 'openclaw') continue;
    const root = c.roots[0][2];
    const ws = c.roots.find((r) => r[1] === 'openclaw-workspace')?.[2];
    if (!safe(() => statSync(root).isDirectory(), false)) continue;
    const counts = c.kind === 'hermes' ? hermesCounts(root) : openclawCounts(root, ws, c.agentId);
    const key = `${c.kind}:${c.agentId}:${root}`;
    list.push({ key: Buffer.from(key).toString('base64url'), kind: c.kind, agentId: c.agentId, where: tilde(root, home), name: displayName(c.kind, root, ws), counts, root });
  }
  cache = { at: Date.now(), list };
  return list;
}

/** What the page may see of a found agent (no full path). */
export const publicAgent = ({ root: _r, ...a }: LocalTarget): LocalAgent => a;

/** The collector's arguments for a found agent (packs held categories too: Sara holds them until you say yes). */
export function collectArgs(a: LocalTarget, out: string): string[] {
  return ['--no-warnings', NODE_COLLECTOR_PATH, 'collect', '--yes', '--progress', 'json', '--out', out, '--include-category', 'medical', '--include-category', 'intimate', a.kind === 'hermes' ? '--hermes-home' : '--openclaw-state', a.root, '--agent', a.agentId];
}

// ---------------------------------------------------------------------------------------------
// Another computer: one line to paste (it fetches a small script from this Sara)
// ---------------------------------------------------------------------------------------------
export type System = 'windows' | 'mac' | 'linux';
const dashed = (code: string) => code.trim().toLowerCase().replace(/[^a-z]+/g, '-');

/** The one line for the old computer: the code rides along (valid 30 minutes, good for one upload). */
export function oneLine(origin: string, code: string, system: System): string {
  if (system === 'windows') return `irm "${origin}/movein/go.ps1?c=${dashed(code)}" | iex`;
  return `curl -fsSL "${origin}/movein/go.sh" | sh -s -- ${dashed(code)}`;
}

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** The shell script behind the Mac/Linux line: Python 3 if it works here, else Node, else what to install. */
export function goSh(origin: string): string {
  return `#!/bin/sh
# Sara move-in: finds your old agent (Hermes Agent or OpenClaw) on this computer, packs a copy of what
# Sara can bring over and sends it to your Sara. It only reads; nothing on this computer is changed.
set -e
SARA=${sq(origin)}
CODE=$(printf '%s' "$1" | tr '-' ' ')
if [ -z "$CODE" ]; then echo "The move-in code is missing: copy the whole line from Sara's Move in page again."; exit 2; fi
D=$(mktemp -d 2>/dev/null || mktemp -d -t sara-movein)
trap 'rm -rf "$D"' EXIT INT TERM
ARGS="collect --yes --include-category medical --include-category intimate --out $D --send-to $SARA"
if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' >/dev/null 2>&1; then
  curl -fsSL "$SARA/movein/sara-movein.py" -o "$D/sara-movein.py"
  python3 "$D/sara-movein.py" $ARGS --code "$CODE"
elif node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  curl -fsSL "$SARA/movein/sara-movein.mjs" -o "$D/sara-movein.mjs"
  node --no-warnings "$D/sara-movein.mjs" $ARGS --code "$CODE"
else
  echo "This computer has neither Python 3 nor Node 18+, so the move-in can't run here."
  echo "Install one of them (python.org or nodejs.org), then paste the same line again."
  exit 1
fi
`;
}

/** The PowerShell script behind the Windows line (runs in memory: no execution-policy change needed). */
export function goPs1(origin: string, code: string): string {
  const words = code.replace(/[^a-z-]+/gi, '').replace(/-/g, ' ').trim();
  return `# Sara move-in: finds your old agent (Hermes Agent or OpenClaw) on this computer, packs a copy of what
# Sara can bring over and sends it to your Sara. It only reads; nothing on this computer is changed.
$ErrorActionPreference = 'Stop'
$sara = ${psq(origin)}
$code = ${psq(words)}
if (-not $code) { Write-Host "The move-in code is missing: copy the whole line from Sara's Move in page again."; return }
$d = Join-Path $env:TEMP ('sara-movein-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $d | Out-Null
try {
  $py = $null
  foreach ($c in @('py', 'python', 'python3')) {
    if (Get-Command $c -ErrorAction SilentlyContinue) {
      & $c -c "import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)" 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $py = $c; break }
    }
  }
  $collect = @('collect', '--yes', '--include-category', 'medical', '--include-category', 'intimate', '--out', $d, '--send-to', $sara, '--code', $code)
  if ($py) {
    Invoke-WebRequest -UseBasicParsing "$sara/movein/sara-movein.py" -OutFile (Join-Path $d 'sara-movein.py')
    & $py (Join-Path $d 'sara-movein.py') @collect
  } elseif (Get-Command node -ErrorAction SilentlyContinue) {
    Invoke-WebRequest -UseBasicParsing "$sara/movein/sara-movein.mjs" -OutFile (Join-Path $d 'sara-movein.mjs')
    & node --no-warnings (Join-Path $d 'sara-movein.mjs') @collect
  } else {
    Write-Host "This computer has neither Python nor Node, so the move-in can't run here."
    Write-Host "Install one of them (python.org or nodejs.org), then paste the same line again."
  }
} finally {
  Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue
}
`;
}
