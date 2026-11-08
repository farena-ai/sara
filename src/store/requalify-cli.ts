// EC27: the body of `sara addons requalify` (see scripts/addons-requalify.ts for the usage).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldRuns, type QualifyRun } from './qualified.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OS_NAME: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'Mac' };

export function requalify(args: string[]): string[] {
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const from = args.flatMap((a, i) => (a === '--from' && args[i + 1] ? [resolve(args[i + 1]!)] : []));
  const indexPath = opt('--index');
  if (!from.length || !indexPath) throw new Error('Use --from <qualify-addons-native.json> (once per computer) and --index <the signed index.json the run used>.');
  const out = resolve(opt('--out') ?? join(ROOT, 'store', 'qualified.json'));
  const sara = opt('--sara') ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const at = opt('--at') ?? new Date().toISOString().slice(0, 10);
  const index = JSON.parse(readFileSync(resolve(indexPath), 'utf8'));
  const versions = Object.fromEntries((index.items ?? []).map((i: { id: string; latest: string }) => [i.id, i.latest]));
  const runs: QualifyRun[] = from.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  const after = foldRuns(doc.items ?? {}, runs, { at, sara, versions });
  const lines: string[] = [];
  for (const id of [...new Set(runs.map((r) => r.id))].sort()) {
    const r = after[id];
    if (!r) lines.push(`${id}: not qualified (held, not listed, or nothing passed)`);
    else if (r.at === at && r.sara === sara) lines.push(`${id} ${r.version}: ${Object.entries(r.os).map(([o, v]) => `${OS_NAME[o] ?? o} ${v}`).join(', ')}`);
  }
  writeFileSync(out, `${JSON.stringify({ ...doc, items: after }, null, 1)}\n`);
  lines.push(`Wrote ${out}. Publish it with the next Store list (sara-hub scripts/store-publish.ts).`);
  return lines;
}
