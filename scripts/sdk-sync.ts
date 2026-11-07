// Copies the plugin SDK files that must be byte-equal everywhere (PL2d, docs/design/POLISH2.md C4):
//   sara-plugin.mjs  from examples/plugins/sara-plugin.mjs  (every example, first-party and store plugin)
//   http1.mjs        from plugins/whatsapp/http1.mjs         (the plugins that take webhooks)
//   pace.mjs         from plugins/whatsapp/pace.mjs          (the chat-app plugins that send; per-app limits inside)
//   sara-job.mjs     from src/plugins/sara-job.mjs           (plugins with permissions.run)
// `node scripts/sdk-sync.ts` writes the copies; `--check` only lists the ones that differ (exit 1).
// test/phase128d.test.ts runs the same comparison.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
export const SDK_SOURCES: Record<string, string> = {
  'sara-plugin.mjs': 'examples/plugins/sara-plugin.mjs',
  'http1.mjs': 'plugins/whatsapp/http1.mjs',
  'pace.mjs': 'plugins/whatsapp/pace.mjs',
  // H_EXEC: the job helper (channel op job.run) beside sara-plugin.mjs in plugins that run jobs.
  'sara-job.mjs': 'src/plugins/sara-job.mjs',
};
const SKIP = new Set(['node_modules', 'outputs', '.git']);

/** Every copy of the SDK files in the repository (outside node_modules, outputs and .git), as repo paths. */
export function sdkCopies(root = ROOT): Record<string, string[]> {
  const found: Record<string, string[]> = Object.fromEntries(Object.keys(SDK_SOURCES).map((n) => [n, []]));
  const walk = (dir: string): void => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(d.name)) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.name in found) found[d.name].push(relative(root, p).replaceAll('\\', '/'));
    }
  };
  walk(root);
  for (const n of Object.keys(found)) found[n].sort();
  return found;
}

export const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let off = 0;
  for (const [name, copies] of Object.entries(sdkCopies())) {
    const source = join(ROOT, SDK_SOURCES[name]);
    const want = sha256(source);
    for (const c of copies) {
      if (sha256(join(ROOT, c)) === want) continue;
      off++;
      if (check) console.log(`differs: ${c} (from ${SDK_SOURCES[name]})`);
      else {
        writeFileSync(join(ROOT, c), readFileSync(source));
        console.log(`copied: ${SDK_SOURCES[name]} → ${c}`);
      }
    }
    console.log(`${name}: ${copies.length} copies`);
  }
  if (check && off) process.exit(1);
}
