// docs.mjs: Documentation Doctor. Checks the local links of a staged project's Markdown (files and
// heading anchors, without fetching anything) and lists the commands its documentation shows in
// shell code blocks. Running one is a separate, explicit step: the exact documented command, bound
// to a plan hash of the staged files, as one owner-approved job in a disposable copy. Text in the
// documentation (comments, inline code, prose) is never turned into a command.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { runJob } from './sara-job.mjs';
import labels from './labels.json' with { type: 'json' };

const ROOT = 'projects';
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DOCS = 200;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_LIST = 200;
const SHELL_INFO = new Set(['sh', 'bash', 'shell', 'console', 'zsh']);
const SHELL_SYNTAX = /[;&|<>`$(){}*?!~\\]/;
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

function projectDir(args, home) {
  const project = String(args.project ?? '');
  if (!NAME.test(project)) fail('project must be a staged project name (lower-case letters, digits, hyphens).');
  const dir = join(home, ROOT, project);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) fail(`There is no staged project "${project}".`);
  return { project, dir };
}

/** GitHub-style heading anchors of one Markdown text. */
function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = h[1].toLowerCase().replace(/[`*_~[\]()]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    out.add(k ? `${base}-${k}` : base);
  }
  return out;
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

/** Links, anchors and shell code blocks of the staged Markdown files. */
export function scan(dir, tree) {
  const docs = Object.keys(tree).filter((f) => /\.(md|markdown)$/i.test(f));
  if (docs.length > MAX_DOCS) fail(`At most ${MAX_DOCS} Markdown files.`);
  const texts = new Map();
  for (const f of docs) {
    const buf = readFileSync(join(dir, ...f.split('/')));
    if (buf.length > MAX_DOC_BYTES) fail(`${f} is larger than 512 KB.`);
    texts.set(f, buf.toString('utf8'));
  }
  const anchors = new Map([...texts].map(([f, t]) => [f, anchorsOf(t)]));
  const links = { ok: 0, broken: [], external: [] };
  const commands = [];
  const unsupported = [];
  for (const [file, text] of texts) {
    let fence = null;
    let shell = false;
    text.split(/\r?\n/).forEach((raw, i) => {
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
        if (!shell) return;
        const cmd = raw.trim().replace(/^\$\s+/, '');
        if (!cmd || cmd.startsWith('#')) return;
        const words = SHELL_SYNTAX.test(cmd) ? null : wordsOf(cmd);
        if (!words) unsupported.push({ file, line, command: cmd.slice(0, 300), reason: 'shell-syntax' });
        else if (words[0] !== 'node' && words[0] !== 'npm') unsupported.push({ file, line, command: cmd.slice(0, 300), reason: 'program-not-runnable' });
        else if (commands.length < MAX_LIST) commands.push({ file, line, command: cmd, program: words[0], args: words.slice(1) });
        return;
      }
      // Links outside code: drop inline code spans and HTML comments first.
      const prose = raw.replace(/`[^`]*`/g, '').replace(/<!--.*?-->/g, '');
      for (const m of prose.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
          if (links.external.length < MAX_LIST) links.external.push({ file, line, target });
          continue;
        }
        const [path, anchor] = target.split('#');
        const to = path ? posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(path))) : file;
        let problem = null;
        if (to.startsWith('..') || to.startsWith('/')) problem = 'outside-project';
        else if (!tree[to] && !Object.keys(tree).some((k) => k.startsWith(`${to}/`))) problem = 'missing-file';
        else if (anchor !== undefined && anchor !== '' && texts.has(to) && !anchors.get(to).has(decodeURIComponent(anchor).toLowerCase())) problem = 'missing-anchor';
        if (problem) {
          if (links.broken.length < MAX_LIST) links.broken.push({ file, line, target, problem });
        } else links.ok++;
      }
    });
  }
  return { docs: docs.length, links, commands, unsupported };
}

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const shaOf = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const jobOf = (project, c, timeoutS) => ({ program: c.program, args: c.args, from: `${ROOT}/${project}`, timeoutS, maxOutputKB: 64 });

function timeoutOf(args) {
  const t = args.timeoutS === undefined ? 60 : args.timeoutS;
  if (!Number.isInteger(t) || t < 5 || t > 300) fail('timeoutS must be a whole number from 5 to 300.');
  return t;
}

export function checkOf(args, home = '.') {
  const { project, dir } = projectDir(args, home);
  const timeoutS = timeoutOf(args);
  const tree = treeOf(dir);
  const s = scan(dir, tree);
  const planSha = shaOf({ v: 1, project, tree });
  const commands = s.commands.map((c) => ({ ...c, planSha: shaOf({ v: 1, project, tree, job: jobOf(project, c, timeoutS), at: [c.file, c.line] }), preview: [c.program, ...c.args].map(quote).join(' ') }));
  return { project, dir, tree, timeoutS, planSha, ...s, commands };
}

const tail = (s, n = 2000) => (String(s ?? '').length > n ? `…${String(s).slice(-n)}` : String(s ?? ''));

/** Reads a documented command's job result. */
export function outcome(c, res) {
  const base = { command: c.command, documentedAt: { file: c.file, line: c.line }, exitCode: res.exitCode ?? null, fence: res.fence ?? null, isolated: res.isolated === true, copyDeleted: res.deleted === true };
  const refusal = res.error ?? (res.ok === false ? res.content : null);
  if (refusal) {
    const reason = String(refusal).slice(0, 300);
    if (/needs an OS sandbox/.test(reason)) return { ...base, status: 'held', reason, note: 'npm runs lifecycle scripts as child processes; Sara runs it only inside bubblewrap (Linux). Held on this computer, not passed or failed.' };
    return { ...base, status: 'not-run', reason };
  }
  if (res.cancelled) return { ...base, status: 'stopped' };
  const out = { ...base, stdout: tail(res.stdout), stderr: tail(res.stderr), stdoutTruncated: res.stdoutTruncated === true, stderrTruncated: res.stderrTruncated === true, changed: res.changed ?? { added: [], changed: [], removed: [] }, ms: res.ms ?? null };
  if (res.timedOut) return { ...out, status: 'timeout' };
  return { ...out, status: res.exitCode === 0 ? 'passed' : 'failed' };
}

function fmt(s, v) {
  return s.replace(/\{(\w+)\}/g, (_, k) => String(v[k]));
}

export async function handle(args, lang = 'en', run = runJob, home = '.') {
  const l = L(lang);
  const op = args.operation;
  if (op !== 'check' && op !== 'run') fail('operation must be check or run.');
  const c = checkOf(args, home);
  if (op === 'check') {
    const r = { status: 'checked', project: c.project, planSha: c.planSha, docs: c.docs, links: c.links, commands: c.commands.map(({ args: _a, ...x }) => x), unsupported: c.unsupported, note: 'Nothing ran. External links are listed, not fetched. Run one documented command explicitly with its planSha.' };
    const lines = [l.checked, fmt(l.links, { broken: c.links.broken.length, ok: c.links.ok }), ...c.links.broken.slice(0, 3).map((b) => `${b.file}:${b.line}  ${b.target}  (${l[b.problem] ?? b.problem})`), fmt(l.commands, { n: c.commands.length })];
    return { content: JSON.stringify(r), card: { title: l.title, lines: lines.map((x) => x.slice(0, 200)) } };
  }
  const command = String(args.command ?? '');
  const doc = c.commands.find((x) => x.command === command);
  if (!doc) fail('That is not a runnable documented command: run accepts only a command shown exactly in a shell code block of the staged documentation (node or npm, no shell syntax).');
  if (args.planSha !== doc.planSha) fail('The plan changed (files or arguments) or the planSha is wrong. Check again.');
  let res;
  try {
    res = await run(jobOf(c.project, doc, c.timeoutS));
  } catch (err) {
    res = { ok: false, content: `Sara refused the job: ${String(err.message ?? err).slice(0, 300)}` };
  }
  const r = outcome(doc, res);
  const lines = [l[r.status] ?? r.status, `${doc.file}:${doc.line}  ${doc.command}`];
  if (r.exitCode !== null) lines.push(fmt(l.exit, { code: r.exitCode }));
  if (r.reason) lines.push(r.reason);
  return { content: JSON.stringify(r), card: { title: l.title, lines: lines.map((x) => String(x).slice(0, 200)) } };
}
