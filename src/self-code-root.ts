// rootapply (docs/SELF_CODE.md "On a Linux server"): the file work of the root helper. deploy/lib-selfcode.sh
// runs this as root from the root-owned source checkout (/opt/<name>-src's twin, never patched), so the
// rules are root's own copy at the checkout's commit. It trusts nothing the service user wrote: the
// request and the patch are read as plain data, every rule is checked again here, and it never runs a
// command. Imports: Node's own modules and ./self-code-rules.ts only (both protected paths).
//
//   check   --instance N --request R --patch P --app A --src S   validate an owner-approved request
//   recheck --patch P --app A --src S                             the rules again (re-apply after an update)
//   apply   --patch P --app A --snap D                            snapshot the files, then apply
//   reverse --patch P --app A --snap D                            snapshot the files, then take it out
//   restore --snap D --app A                                      put the snapshot back
// Prints one JSON line ({ok, ...} or {ok:false, reason}); exit 0 when ok, 3 when refused.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { applyPatchTo, formatPatch, parsePatch, protectedReason, readOrNull, testWeakening, type FileChange, type FilePatch } from './self-code-rules.ts';

/** The folders the installer copies into /opt/<name> (deploy/install.sh); only these are applied. */
export const INSTALLED = ['src', 'web', 'persona', 'templates', 'skills', 'plugins'] as const;
export const installed = (path: string): boolean => (INSTALLED as readonly string[]).includes(path.split('/')[0]!);
export const MAX_PATCH = 1024 * 1024;

export interface RootRequest {
  v: 1;
  instance: string;
  id: number;
  kind: 'apply' | 'undo';
  approval: string;
  sha256?: string;
}
type Out = { ok: true; [k: string]: unknown } | { ok: false; reason: string };
const no = (reason: string): Out => ({ ok: false, reason });

/** The request as root accepts it, or why not (shape, this instance, an owner approval id). */
export function readRequest(text: string, instance: string): RootRequest | string {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return 'the request is not valid JSON';
  }
  if (!j || typeof j !== 'object' || j.v !== 1) return 'the request has an unknown format';
  if (j.instance !== instance) return `the request is for another Sara (${String(j.instance).slice(0, 40)}), not ${instance}`;
  if (!Number.isInteger(j.id) || (j.id as number) < 1 || (j.id as number) > 1e9) return 'the request has no valid change number';
  if (j.kind !== 'apply' && j.kind !== 'undo') return 'the request asks for something the helper does not do';
  if (typeof j.approval !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(j.approval)) return 'the request has no owner approval';
  if (j.kind === 'apply' && (typeof j.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(j.sha256))) return 'the request does not say which patch was approved';
  return { v: 1, instance, id: j.id as number, kind: j.kind, approval: j.approval, ...(j.kind === 'apply' ? { sha256: j.sha256 as string } : {}) };
}

/** No link anywhere on the way from `base` to `base/path` (root never writes through one). */
function plainPath(base: string, path: string): boolean {
  let at = base;
  for (const part of path.split('/')) {
    at = join(at, part);
    try {
      if (lstatSync(at).isSymbolicLink()) return false;
    } catch {
      return true; // not there yet: nothing below it can be a link
    }
  }
  return true;
}

/** Every rule on a patch: paths, protected list, fits the files, no test weakening, something to install. */
export function rules(patch: string, app: string, src: string): { files: FilePatch[]; changes: FileChange[] } | string {
  if (!patch.trim()) return 'the patch is empty';
  if (Buffer.byteLength(patch) > MAX_PATCH) return 'the patch is too large';
  let files: FilePatch[];
  try {
    files = parsePatch(patch);
  } catch (err) {
    return `the patch is not valid (${String((err as Error).message).slice(0, 120)})`;
  }
  if (!files.length) return 'the patch changes no file';
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) return `the patch changes ${f.path} twice`;
    seen.add(f.path);
    const what = protectedReason(f.path);
    if (what) return `it would change ${what} (${f.path}), which she may never change`;
    const base = installed(f.path) ? app : src;
    if (!plainPath(base, f.path)) return `${f.path} goes through a link`;
  }
  // The files as they are now: what is installed from /opt/<name>, the rest (tests) from the checkout.
  const changes: FileChange[] = [];
  for (const f of files) {
    const base = installed(f.path) ? app : src;
    const one = formatPatch([f]);
    const r = applyPatchTo(base, one, { dryRun: true });
    if (!r.ok) return `it no longer fits ${f.path}`;
    changes.push(...r.files);
  }
  const weak = testWeakening(changes);
  if (weak) return `it weakens her tests (${weak})`;
  const inst = files.filter((f) => installed(f.path));
  if (!inst.length) return 'the patch changes nothing that is installed on this server';
  return { files: inst, changes };
}

export function check(o: { instance: string; request: string; patch: string; app: string; src: string }): Out {
  const req = readRequest(o.request, o.instance);
  if (typeof req === 'string') return no(req);
  if (req.kind === 'undo') return { ok: true, id: req.id, kind: req.kind, approval: req.approval };
  const sha = createHash('sha256').update(o.patch).digest('hex');
  if (sha !== req.sha256) return no('the patch is not the one the owner approved');
  const r = rules(o.patch, o.app, o.src);
  if (typeof r === 'string') return no(r);
  return { ok: true, id: req.id, kind: req.kind, approval: req.approval, files: r.files.map((f) => f.path) };
}

function snapshot(app: string, snap: string, paths: string[]): void {
  rmSync(snap, { recursive: true, force: true });
  mkdirSync(join(snap, 'files'), { recursive: true });
  const files = paths.map((path) => {
    const live = join(app, path);
    const existed = existsSync(live);
    if (existed) {
      mkdirSync(dirname(join(snap, 'files', path)), { recursive: true });
      copyFileSync(live, join(snap, 'files', path));
    }
    return { path, existed };
  });
  writeFileSync(join(snap, 'manifest.json'), `${JSON.stringify({ files })}\n`);
}

export function restore(app: string, snap: string): Out {
  const m = JSON.parse(readFileSync(join(snap, 'manifest.json'), 'utf8')) as { files: { path: string; existed: boolean }[] };
  for (const f of m.files) {
    if (protectedReason(f.path) || !installed(f.path) || !plainPath(app, f.path)) continue;
    const live = join(app, f.path);
    if (f.existed) {
      mkdirSync(dirname(live), { recursive: true });
      copyFileSync(join(snap, 'files', f.path), live);
    } else rmSync(live, { force: true });
  }
  return { ok: true, files: m.files.map((f) => f.path) };
}

/** Applies (or takes out) only the installed part of the patch, after a snapshot of those files. */
export function applyInstalled(o: { patch: string; app: string; snap: string; reverse?: boolean }): Out {
  let files: FilePatch[];
  try {
    files = parsePatch(o.patch).filter((f) => installed(f.path) && !protectedReason(f.path));
  } catch {
    return no('the patch is not valid');
  }
  if (!files.length) return no('the patch changes nothing that is installed on this server');
  if (files.some((f) => !plainPath(o.app, f.path))) return no('a file goes through a link');
  const part = formatPatch(files);
  const dry = applyPatchTo(o.app, part, { dryRun: true, reverse: !!o.reverse });
  if (!dry.ok) return no(`it no longer fits ${dry.conflicts.join(', ')}`);
  snapshot(o.app, o.snap, files.map((f) => f.path));
  applyPatchTo(o.app, part, { reverse: !!o.reverse });
  return { ok: true, files: files.map((f) => f.path) };
}

function main(argv: string[]): Out {
  const cmd = argv[0];
  const arg = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    if (!v) throw new Error(`missing --${k}`);
    return v;
  };
  const real = (p: string) => realpathSync(p).split(sep).join('/');
  const text = (p: string, max: number) => {
    const t = readOrNull(p);
    if (t === null) throw new Error(`can't read ${p}`);
    if (Buffer.byteLength(t) > max) throw new Error(`${p} is too large`);
    return t;
  };
  switch (cmd) {
    case 'check':
      return check({ instance: arg('instance'), request: text(arg('request'), 4096), patch: text(arg('patch'), MAX_PATCH), app: real(arg('app')), src: real(arg('src')) });
    case 'recheck': {
      const r = rules(text(arg('patch'), MAX_PATCH), real(arg('app')), real(arg('src')));
      return typeof r === 'string' ? no(r) : { ok: true, files: r.files.map((f) => f.path) };
    }
    case 'apply':
    case 'reverse':
      return applyInstalled({ patch: text(arg('patch'), MAX_PATCH), app: real(arg('app')), snap: arg('snap'), reverse: cmd === 'reverse' });
    case 'restore':
      return restore(real(arg('app')), arg('snap'));
    default:
      return no('unknown command');
  }
}

if (process.argv[1] && /self-code-root\.ts$/.test(process.argv[1])) {
  let out: Out;
  try {
    out = main(process.argv.slice(2));
  } catch (err) {
    out = no(String((err as Error).message).slice(0, 300));
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exitCode = out.ok ? 0 : 3;
}
