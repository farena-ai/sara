// EC27 (docs/ops/EC2527_DESIGN.md): `sara addons requalify` for owners (no CI). Folds the results of
// scripts/qualify-addons-native.mjs runs (one JSON file per computer) into store/qualified.json, the
// source of the Store's signed qualified sidecar. The versions come from the signed index the runs
// used (<SARA_DATA>/store/index.json of the throwaway Sara).
//   node scripts/addons-requalify.ts --from windows.json [--from linux.json] --index <index.json>
//        [--sara 2.84.0] [--at 2026-11-08] [--out store/qualified.json]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requalify } from '../src/store/requalify-cli.ts';

export { requalify };
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    for (const l of requalify(process.argv.slice(2))) console.log(l);
  } catch (err) {
    console.error(`requalify: ${(err as Error).message}`);
    process.exit(1);
  }
}
