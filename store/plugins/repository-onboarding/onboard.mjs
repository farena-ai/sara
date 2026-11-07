// onboard.mjs: Repository Onboarding. Maps a staged repository (manifests, lockfiles, languages,
// folders, documentation, the documented prerequisites and build commands) without running
// anything, then reproduces the documented build only as asked: the exact command shown in a shell
// code block of the README's Build section, with every checkable documented prerequisite present,
// bound to a plan hash, as one owner-approved job in a disposable copy. Invented commands refuse.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runJob } from './sara-job.mjs';
import labels from './labels.json' with { type: 'json' };

const ROOT = 'projects';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_LIST = 100;
const SHELL_INFO = new Set(['sh', 'bash', 'shell', 'console', 'zsh']);
const SHELL_SYNTAX = /[;&|<>`$(){}*?!~\\]/;
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']);
const README = ['README.md', 'readme.md', 'Readme.md', 'README.markdown'];
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

/** Splits a command line into words (plain words and '…'/"…" quotes only); null when it isn't that simple. */
function wordsOf(line) {
  const words = [];
  const re = /\s*(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/gy;
  let m;
  let at = 0;
  while (at < line.length && (m = re.exec(line))) {
    words.push(m[1] ?? m[2] ?? m[3]);
    at = re.lastIndex;
    if (/^\s*$/.test(line.slice(at))) break;
  }
  return /^\s*$/.test(line.slice(at)) ? words : null;
}

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const sha = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const relPath = (p) => /^[\w@.-][\w@./-]*$/.test(p) && (p.includes('/') || p.includes('.')) && !p.split('/').includes('..');

function readJson(dir, f) {
  try {
    return JSON.parse(readFileSync(join(dir, ...f.split('/')), 'utf8'));
  } catch {
    return null;
  }
}

/** One documented prerequisite: a Node version, files that must exist, or something Sara can't check. */
function prerequisite(text, line, tree) {
  const node = /\bnode(?:\.js)?\s*(?:>=\s*)?v?(\d{1,2})\b/i.exec(text);
  if (node) {
    const have = Number(process.versions.node.split('.')[0]);
    const want = Number(node[1]);
    return { line, text, kind: 'node', status: have >= want ? 'met' : 'missing', detail: `Node ${want}+ (this Sara runs Node ${process.versions.node})` };
  }
  const paths = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(relPath);
  if (paths.length) {
    const missing = paths.filter((p) => !tree[p] && !Object.keys(tree).some((k) => k.startsWith(`${p.replace(/\/$/, '')}/`)));
    return { line, text, kind: 'file', status: missing.length ? 'missing' : 'met', detail: (missing.length ? missing : paths).join(', ') };
  }
  return { line, text, kind: 'other', status: 'unverified', detail: 'Sara cannot check this one; it is listed, not assumed.' };
}

/** README sections: documented prerequisites and the shell commands of its Build section. */
function readmeOf(dir, file, tree, scripts) {
  const prerequisites = [];
  const commands = [];
  const unsupported = [];
  let section = '';
  let fence = null;
  let shell = false;
  readFileSync(join(dir, file), 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const f = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(raw);
    if (f) {
      if (!fence) {
        fence = f[1][0];
        shell = SHELL_INFO.has(f[2].toLowerCase());
      } else if (f[1][0] === fence) fence = null;
      return;
    }
    if (fence) {
      if (!shell || !/\bbuild/i.test(section)) return;
      const cmd = raw.trim().replace(/^\$\s+/, '');
      if (!cmd || cmd.startsWith('#')) return;
      const words = SHELL_SYNTAX.test(cmd) ? null : wordsOf(cmd);
      if (!words || (words[0] !== 'node' && words[0] !== 'npm')) {
        unsupported.push({ file, line, command: cmd.slice(0, 300), reason: words ? 'program-not-runnable' : 'shell-syntax' });
        return;
      }
      const c = { file, line, section, command: cmd, program: words[0], args: words.slice(1) };
      if (c.program === 'npm') {
        const name = c.args[0] === 'test' ? 'test' : c.args[0] === 'run' ? c.args[1] : null;
        c.script = name && typeof scripts[name] === 'string' ? scripts[name] : null;
      }
      if (commands.length < MAX_LIST) commands.push(c);
      return;
    }
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      section = h[1].slice(0, 100);
      return;
    }
    const item = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (item && /^(prerequisites|requirements|before you (start|begin)|you need)\b/i.test(section) && prerequisites.length < MAX_LIST) prerequisites.push(prerequisite(item[1].trim().slice(0, 300), line, tree));
  });
  return { prerequisites, commands, unsupported };
}

function timeoutOf(args) {
  const t = args.timeoutS === undefined ? 120 : args.timeoutS;
  if (!Number.isInteger(t) || t < 5 || t > 300) fail('timeoutS must be a whole number from 5 to 300.');
  return t;
}
const jobOf = (project, c, timeoutS) => ({ program: c.program, args: c.args, from: `${ROOT}/${project}`, timeoutS, maxOutputKB: 64 });

export function mapOf(args, home = '.') {
  const project = String(args.project ?? '');
  if (!NAME.test(project)) fail('project must be a staged project name (lower-case letters, digits, hyphens).');
  const timeoutS = timeoutOf(args);
  const dir = join(home, ROOT, project);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) fail(`There is no staged project "${project}".`);
  const tree = treeOf(dir);
  const files = Object.keys(tree);
  const languages = {};
  for (const f of files) {
    const base = f.split('/').pop();
    const ext = base.includes('.') && !base.startsWith('.') ? base.slice(base.lastIndexOf('.')).toLowerCase() : '(none)';
    languages[ext] = (languages[ext] ?? 0) + 1;
  }
  const manifests = files.filter((f) => f.split('/').pop() === 'package.json').slice(0, 20).map((f) => {
    const p = readJson(dir, f) ?? {};
    const m = { file: f, name: typeof p.name === 'string' ? p.name : null, version: typeof p.version === 'string' ? p.version : null, type: typeof p.type === 'string' ? p.type : null, engines: p.engines && typeof p.engines === 'object' ? p.engines : null, scripts: p.scripts && typeof p.scripts === 'object' ? p.scripts : {}, dependencies: Object.keys(p.dependencies ?? {}).length, devDependencies: Object.keys(p.devDependencies ?? {}).length };
    for (const k of ['main', 'bin']) if (p[k] !== undefined) m[k] = p[k];
    return m;
  });
  const scripts = manifests.find((m) => m.file === 'package.json')?.scripts ?? {};
  const readme = README.find((f) => tree[f]);
  const doc = readme ? readmeOf(dir, readme, tree, scripts) : { prerequisites: [], commands: [], unsupported: [] };
  const commands = doc.commands.map((c) => ({ ...c, planSha: sha({ v: 1, project, tree, job: jobOf(project, c, timeoutS), at: [c.file, c.line] }), preview: [c.program, ...c.args].map(quote).join(' ') }));
  return {
    project, dir, tree, timeoutS, planSha: sha({ v: 1, project, tree }),
    files: files.length,
    languages: Object.fromEntries(Object.entries(languages).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, 50)),
    directories: [...new Set(files.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))].sort().slice(0, MAX_LIST),
    manifests,
    lockfiles: files.filter((f) => LOCKFILES.has(f.split('/').pop())).slice(0, MAX_LIST),
    docs: files.filter((f) => /\.(md|markdown)$/i.test(f)).slice(0, MAX_LIST),
    readme: readme ?? null,
    prerequisites: doc.prerequisites,
    build: { commands, unsupported: doc.unsupported },
  };
}

const tail = (s, n = 2000) => (String(s ?? '').length > n ? `…${String(s).slice(-n)}` : String(s ?? ''));

/** The build receipt from the job's result. */
export function receipt(c, res, prerequisites) {
  const base = { command: c.command, documentedAt: { file: c.file, line: c.line, section: c.section }, exitCode: res.exitCode ?? null, fence: res.fence ?? null, isolated: res.isolated === true, copyDeleted: res.deleted === true, prerequisites: prerequisites.map(({ line, kind, status, detail }) => ({ line, kind, status, detail })) };
  const refusal = res.error ?? (res.ok === false ? res.content : null);
  if (refusal) {
    const reason = String(refusal).slice(0, 300);
    return /needs an OS sandbox/.test(reason) ? { ...base, status: 'held', reason, note: 'npm runs lifecycle scripts as child processes; Sara runs it only inside bubblewrap (Linux). Held on this computer, not built or failed.' } : { ...base, status: 'not-run', reason };
  }
  if (res.cancelled) return { ...base, status: 'stopped' };
  const out = { ...base, ms: res.ms ?? null, stdout: tail(res.stdout), stderr: tail(res.stderr), stdoutSha256: sha(String(res.stdout ?? '')), stderrSha256: sha(String(res.stderr ?? '')), stdoutTruncated: res.stdoutTruncated === true, stderrTruncated: res.stderrTruncated === true, changed: res.changed ?? { added: [], changed: [], removed: [] } };
  if (res.timedOut) return { ...out, status: 'timeout' };
  return { ...out, status: res.exitCode === 0 ? 'built' : 'failed' };
}

const fmt = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));

export async function handle(args, lang = 'en', run = runJob, home = '.') {
  const l = L(lang);
  const op = args.operation;
  if (op !== 'map' && op !== 'build') fail('operation must be map or build.');
  const m = mapOf(args, home);
  if (op === 'map') {
    const { dir: _d, tree: _t, timeoutS: _s, ...pub } = m;
    const r = { status: 'mapped', ...pub, build: { commands: m.build.commands.map(({ args: _a, ...c }) => c), unsupported: m.build.unsupported }, note: 'Nothing ran. Build accepts only a command shown in the README Build section, with its planSha.' };
    const missing = m.prerequisites.filter((p) => p.status === 'missing').length;
    const lines = [l.mapped, fmt(l.summary, { files: m.files, manifests: m.manifests.length, lockfiles: m.lockfiles.length }), fmt(l.prereqs, { n: m.prerequisites.length, missing }), fmt(l.commands, { n: m.build.commands.length })];
    return { content: JSON.stringify(r), card: { title: l.title, lines: lines.map((x) => x.slice(0, 200)) } };
  }
  const command = String(args.command ?? '');
  const c = m.build.commands.find((x) => x.command === command);
  if (!c) fail('That is not a documented build command: build runs only a command shown exactly in a shell code block of the README Build section (node or npm, no shell syntax). Nothing ran.');
  if (c.program === 'npm' && !c.script) fail(`Refused: the documented npm script "${String(c.args[1] ?? c.args[0]).slice(0, 40)}" is not in package.json. Nothing ran.`);
  const missing = m.prerequisites.filter((p) => p.status === 'missing');
  if (missing.length) fail(`Refused: missing documented prerequisite: ${missing.map((p) => p.detail).join('; ').slice(0, 300)}. Nothing ran.`);
  if (args.planSha !== c.planSha) fail('The plan changed (files or arguments) or the planSha is wrong. Map again.');
  let res;
  try {
    res = await run(jobOf(m.project, c, m.timeoutS));
  } catch (err) {
    res = { ok: false, content: `Sara refused the job: ${String(err.message ?? err).slice(0, 300)}` };
  }
  const r = receipt(c, res, m.prerequisites);
  const lines = [l[r.status] ?? r.status, `${c.file}:${c.line}  ${c.command}`];
  if (r.exitCode !== null) lines.push(fmt(l.exit, { code: r.exitCode }));
  if (r.changed?.added?.length) lines.push(fmt(l.added, { n: r.changed.added.length }));
  if (r.reason) lines.push(r.reason);
  return { content: JSON.stringify(r), card: { title: l.title, lines: lines.map((x) => String(x).slice(0, 200)) } };
}
