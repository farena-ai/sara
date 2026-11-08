// PRQ: is a catalog program on this computer? Pure over an injected environment, so every OS is
// testable on every OS. Looks on PATH first, then in the catalog's known install folders (a program
// installed a minute ago is found without restarting Sara: Windows does not refresh a running
// process's PATH).
import { posix, win32 } from 'node:path';
import type { Os, Program, ProgramId } from './catalog.ts';

export interface DetectEnv {
  platform: Os;
  pathVar: string;
  /** ProgramFiles, ProgramFiles(x86), LOCALAPPDATA, USERPROFILE, HOME. */
  vars: Record<string, string | undefined>;
  exists: (file: string) => boolean;
  list: (dir: string) => string[];
  /** The program's own version output (stdout+stderr), or undefined. */
  version?: (file: string, args: string[]) => string | undefined;
}

export interface Detection {
  id: ProgramId;
  found: boolean;
  path?: string;
  dir?: string;
  /** Found through PATH (false: in a known folder Sara's PATH doesn't have yet). */
  onPath?: boolean;
  version?: string;
  /** Older than the catalog's minimum (e.g. Node < 22). */
  old?: boolean;
}

const EXTS: Record<Os, string[]> = { win32: ['.exe', '.cmd', '.bat', ''], darwin: [''], linux: [''] };

/** Compares dotted versions numerically: -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

function expand(raw: string, vars: DetectEnv['vars']): string | undefined {
  let missing = false;
  const out = raw.replace(/\{([A-Za-z()0-9]+)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (!v) missing = true;
    return v ?? '';
  });
  return missing ? undefined : out;
}

/** Known places, with at most one `*` folder segment matched against what is there. */
function candidates(raw: string, env: DetectEnv): string[] {
  const p = expand(raw, env.vars);
  if (!p) return [];
  const path = env.platform === 'win32' ? win32 : posix;
  const parts = p.split(env.platform === 'win32' ? /[\\/]/ : /\//);
  const star = parts.indexOf('*');
  if (star < 0) return [p];
  const parent = parts.slice(0, star).join(path.sep) || path.sep;
  const rest = parts.slice(star + 1);
  let names: string[] = [];
  try {
    names = env.list(parent).sort().reverse();
  } catch {
    return [];
  }
  return names.map((n) => path.join(parent, n, ...rest));
}

export function detect(p: Program, env: DetectEnv): Detection {
  const path = env.platform === 'win32' ? win32 : posix;
  const sep = env.platform === 'win32' ? ';' : ':';
  const has = (dir: string, cmd: string): string | undefined => EXTS[env.platform].map((e) => path.join(dir, cmd + e)).find((f) => env.exists(f));
  let hit: { path: string; dir: string; onPath: boolean } | undefined;
  for (const dir of env.pathVar.split(sep).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    for (const cmd of p.detect.commands) {
      const f = has(dir, cmd);
      if (f && (p.detect.with ?? []).every((w) => has(dir, w))) {
        hit = { path: f, dir, onPath: true };
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    for (const raw of p.detect.paths[env.platform] ?? []) {
      const f = candidates(raw, env).find((c) => env.exists(c));
      if (!f) continue;
      const dir = path.dirname(f);
      if ((p.detect.with ?? []).every((w) => has(dir, w))) {
        hit = { path: f, dir, onPath: false };
        break;
      }
    }
  }
  if (!hit) return { id: p.id, found: false };
  const out: Detection = { id: p.id, found: true, ...hit };
  const v = p.detect.version;
  if (v && env.version) {
    const m = v.re.exec(env.version(hit.path, v.args) ?? '');
    if (m) {
      out.version = m[1];
      if (v.min && compareVersions(m[1], v.min) < 0) out.old = true;
    }
  }
  return out;
}
