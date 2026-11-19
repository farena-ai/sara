// W2.1: deploy/get-sara.sh is downloaded on its own, so it carries a copy of deploy/lib-preflight.sh
// (everything from "# ---- body") between its "# >>> lib-preflight.sh" / "# <<< lib-preflight.sh"
// markers. This copies the library in again; `--check` exits 1 when the copy is stale.
//   node scripts/sync-preflight.ts [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const libFile = join(ROOT, 'deploy', 'lib-preflight.sh');
const getFile = join(ROOT, 'deploy', 'get-sara.sh');

export function syncPreflight(lib: string, get: string): string {
  const body = lib.slice(lib.indexOf('# ---- body'));
  const a = get.indexOf('# >>> lib-preflight.sh');
  const b = get.indexOf('# <<< lib-preflight.sh');
  if (a < 0 || b < a) throw new Error('get-sara.sh has no lib-preflight.sh markers');
  const start = get.indexOf('\n', a) + 1;
  return get.slice(0, start) + body + get.slice(b);
}

if (import.meta.main) {
  const lib = readFileSync(libFile, 'utf8').replace(/\r\n/g, '\n');
  const get = readFileSync(getFile, 'utf8').replace(/\r\n/g, '\n');
  const next = syncPreflight(lib, get);
  if (process.argv.includes('--check')) {
    if (next !== get) {
      console.error('deploy/get-sara.sh carries an old copy of deploy/lib-preflight.sh: run node scripts/sync-preflight.ts');
      process.exit(1);
    }
    console.log('get-sara.sh preflight copy is current.');
  } else if (next !== get) {
    writeFileSync(getFile, next);
    console.log('Copied deploy/lib-preflight.sh into deploy/get-sara.sh.');
  } else console.log('Already current.');
}
