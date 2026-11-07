// gates.mjs: Release Readiness. Reads a versioned gate profile of a staged project (each gate a
// reviewed node/npm command and the requirement it proves), binds it and the staged files to a plan
// hash, then runs every gate as its own owner-approved job in a disposable copy and collects the
// real exit codes and output hashes. Ready only when every gate actually passed; a failing gate
// blocks; a held, declined or stopped gate leaves it incomplete. Nothing publishes, signs, uploads
// or reaches CI: such gates refuse before anything runs.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJob } from './sara-job.mjs';
import labels from './labels.json' with { type: 'json' };

const ROOT = 'projects';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_GATES = 10;
const FORBIDDEN = /\b(publish|publishing|sign|signer|signing|upload|deploy|push|ci)\b/i;
const L = (lang) => labels[lang] ?? labels.en;
const fail = (msg) => {
  throw new Error(msg);
};

/** Every regular file of the staged project with its hash (links refuse; .git and dependency folders are skipped). */
export function treeOf(dir) {
  const files = {};
  let n = 0;
  let bytes = 0;
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) fail(`The staged project contains a link (${r}); stage plain files only.`);
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (st.isDirectory()) walk(p, r);
      else if (st.isFile()) {
        if (++n > MAX_FILES || (bytes += st.size) > MAX_BYTES) fail('The staged project is too large (2,000 files / 20 MB).');
        files[r] = createHash('sha256').update(readFileSync(p)).digest('hex');
      }
    }
  };
  walk(dir, '');
  return files;
}

function relOk(p) {
  return typeof p === 'string' && p.length <= 200 && !/[\0\r\n\\:*?"<>|]/.test(p) && !p.startsWith('/') && p.split('/').every((s) => s && s !== '.' && s !== '..' && !/[ .]$/.test(s));
}

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const noPublish = (what) => fail(`Release Readiness runs local gates only: ${what} looks like a publish, sign, upload, deploy or CI step, so the profile is refused and nothing runs.`);

/** The checked gate profile: [{ id, requirement, program, args }]. */
export function profileOf(dir, name, tree) {
  if (!tree[name]) fail(`The project has no gate profile ${name}.`);
  const buf = readFileSync(join(dir, ...name.split('/')));
  if (buf.length > 64 * 1024) fail('The gate profile is larger than 64 KB.');
  let p;
  try {
    p = JSON.parse(buf.toString('utf8'));
  } catch {
    fail('The gate profile is not valid JSON.');
  }
  if (!p || p.version !== 1 || !Array.isArray(p.gates) || !p.gates.length || p.gates.length > MAX_GATES) fail(`The gate profile needs "version": 1 and 1–${MAX_GATES} gates.`);
  let scripts = null;
  const seen = new Set();
  return p.gates.map((g) => {
    if (!g || typeof g !== 'object' || Array.isArray(g)) fail('Every gate must be an object.');
    for (const k of Object.keys(g)) if (!['id', 'requirement', 'program', 'args'].includes(k)) fail(`Unknown gate field "${String(k).slice(0, 40)}".`);
    const id = String(g.id ?? '');
    if (!NAME.test(id) || seen.has(id)) fail('Every gate needs a unique id (lower-case letters, digits, hyphens).');
    seen.add(id);
    const requirement = String(g.requirement ?? '');
    if (!requirement || requirement.length > 200 || /[\0\r\n]/.test(requirement)) fail(`Gate ${id} needs a one-line requirement (up to 200 characters).`);
    if (g.program !== 'node' && g.program !== 'npm') fail(`Gate ${id}: program must be node or npm.`);
    if (!Array.isArray(g.args) || g.args.length > 32 || g.args.some((a) => typeof a !== 'string' || a.length > 300 || /[\0\r\n]/.test(a))) fail(`Gate ${id}: args must be up to 32 one-line strings.`);
    if (FORBIDDEN.test(id) || g.args.some((a) => FORBIDDEN.test(a))) noPublish(`gate ${id}`);
    if (g.program === 'npm') {
      const script = g.args[0] === 'test' ? 'test' : g.args[0] === 'run' ? g.args[1] : null;
      if (!script) fail(`Gate ${id}: npm may only run "test" or "run <script>".`);
      if (scripts === null) {
        try {
          scripts = tree['package.json'] ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {} : {};
        } catch {
          scripts = {};
        }
      }
      if (typeof scripts[script] !== 'string') fail(`Gate ${id}: package.json has no "${String(script).slice(0, 40)}" script.`);
      if (FORBIDDEN.test(scripts[script])) noPublish(`the "${script}" script of gate ${id}`);
    }
    return { id, requirement, program: g.program, args: [...g.args] };
  });
}

export function planOf(args, home = '.') {
  const project = String(args.project ?? '');
  if (!NAME.test(project)) fail('project must be a staged project name (lower-case letters, digits, hyphens).');
  const profile = args.profile === undefined ? 'release-gates.json' : String(args.profile);
  if (!relOk(profile) || !profile.endsWith('.json')) fail('profile must be a relative path to a .json gate profile in the project.');
  const timeoutS = args.timeoutS === undefined ? 120 : args.timeoutS;
  if (!Number.isInteger(timeoutS) || timeoutS < 5 || timeoutS > 300) fail('timeoutS must be a whole number from 5 to 300.');
  const dir = join(home, ROOT, project);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) fail(`There is no staged project "${project}".`);
  const tree = treeOf(dir);
  const gates = profileOf(dir, profile, tree).map((g) => ({ ...g, command: [g.program, ...g.args].map(quote).join(' '), job: { program: g.program, args: g.args, from: `${ROOT}/${project}`, timeoutS, maxOutputKB: 64 } }));
  const planSha = sha({ v: 1, project, profile, gates: gates.map((g) => ({ id: g.id, requirement: g.requirement, job: g.job })), tree });
  return { project, profile, profileSha256: tree[profile], tree, gates, planSha };
}

const tail = (s, n = 800) => (String(s ?? '').length > n ? `…${String(s).slice(-n)}` : String(s ?? ''));

/** One gate's evidence from its job result. */
export function gateResult(g, res) {
  const base = { id: g.id, requirement: g.requirement, command: g.command, exitCode: res.exitCode ?? null, fence: res.fence ?? null, isolated: res.isolated === true, copyDeleted: res.deleted === true };
  const refusal = res.error ?? (res.ok === false ? res.content : null);
  if (refusal) {
    const reason = String(refusal).slice(0, 300);
    return /needs an OS sandbox/.test(reason) ? { ...base, status: 'held', reason, note: 'npm runs only inside bubblewrap (Linux); held on this computer, not passed.' } : { ...base, status: 'not-run', reason };
  }
  if (res.cancelled) return { ...base, status: 'stopped' };
  const ev = { ...base, ms: res.ms ?? null, stdoutSha256: sha(String(res.stdout ?? '')), stderrSha256: sha(String(res.stderr ?? '')), stdoutTruncated: res.stdoutTruncated === true, stderrTruncated: res.stderrTruncated === true, stdoutTail: tail(res.stdout), stderrTail: tail(res.stderr), changed: res.changed ?? { added: [], changed: [], removed: [] } };
  if (res.timedOut) return { ...ev, status: 'timeout' };
  return { ...ev, status: res.exitCode === 0 ? 'passed' : 'failed' };
}

export function verdictOf(gates) {
  const blockedBy = gates.filter((g) => g.status === 'failed' || g.status === 'timeout').map((g) => ({ id: g.id, requirement: g.requirement, status: g.status, exitCode: g.exitCode }));
  const verdict = blockedBy.length ? 'blocked' : gates.every((g) => g.status === 'passed') ? 'ready' : 'incomplete';
  return { verdict, blockedBy, incomplete: gates.filter((g) => !['passed', 'failed', 'timeout'].includes(g.status)).map((g) => g.id) };
}

const fmt = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));

export async function handle(args, lang = 'en', run = runJob, home = '.') {
  const l = L(lang);
  const op = args.operation;
  if (op !== 'plan' && op !== 'run') fail('operation must be plan or run.');
  const plan = planOf(args, home);
  if (op === 'plan') {
    const r = { status: 'planned', project: plan.project, profile: plan.profile, profileSha256: plan.profileSha256, planSha: plan.planSha, files: Object.keys(plan.tree).length, gates: plan.gates.map(({ id, requirement, command }) => ({ id, requirement, command })), note: 'Nothing ran. Run asks you to approve one job per gate.' };
    return { content: JSON.stringify(r), card: { title: l.title, lines: [l.planned, ...plan.gates.map((g) => `${g.id}: ${g.command}`)].map((x) => x.slice(0, 200)) } };
  }
  if (args.planSha !== plan.planSha) fail('The plan changed (files, profile or arguments) or the planSha is wrong. Plan again.');
  const gates = [];
  for (const g of plan.gates) {
    let res;
    try {
      res = await run(g.job);
    } catch (err) {
      res = { ok: false, content: `Sara refused the job: ${String(err.message ?? err).slice(0, 300)}` };
    }
    gates.push(gateResult(g, res));
  }
  const v = verdictOf(gates);
  const r = { ...v, project: plan.project, profile: plan.profile, profileSha256: plan.profileSha256, planSha: plan.planSha, gates, note: 'Local gates only; nothing was published, signed or uploaded.' };
  const lines = [l[v.verdict], ...gates.map((g) => `${g.id}: ${l[g.status] ?? g.status}${g.exitCode === null ? '' : ` (${fmt(l.exit, { code: g.exitCode })})`}`)];
  return { content: JSON.stringify(r), card: { title: l.title, lines: lines.map((x) => String(x).slice(0, 200)) } };
}
