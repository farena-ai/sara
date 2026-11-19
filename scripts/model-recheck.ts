// W2.4: the monthly re-check by hand (src/model-recheck.ts) against Ollama on THIS computer.
//   node scripts/model-recheck.ts            # print the results
//   node scripts/model-recheck.ts --publish  # also write docs/results/model-recheck.json + the results page
// Only listed free models that are installed locally are asked; cloud models never are; nothing is pulled.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_OLLAMA, detectOllama } from '../src/local-models.ts';
import { ModelRecheck } from '../src/model-recheck.ts';
import { writePage, type RecheckSummary } from './bench-compare.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { values: opt } = parseArgs({ options: { publish: { type: 'boolean', default: false }, ollama: { type: 'string', default: DEFAULT_OLLAMA } } });
const dir = mkdtempSync(join(tmpdir(), 'sara-recheck-'));
try {
  const started = new Date();
  const rc = new ModelRecheck({ dataDir: dir, root: () => opt.ollama!, fetch, now: () => new Date(), ollama: () => detectOllama(opt.ollama!, fetch), lastActivity: () => 0 });
  const { results } = await rc.run();
  for (const r of results) console.log(`${r.passed === r.of ? 'PASS' : 'MISS'} ${r.model.padEnd(28)} ${r.job.padEnd(10)} ${r.passed}/${r.of} ${(r.ms / 1000).toFixed(1)} s${r.failed.length ? ` (missed: ${r.failed.join(', ')})` : ''}`);
  if (!results.length) console.log('No listed free model is installed in Ollama here.');
  if (opt.publish) {
    const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
    // One row per model and job (the same build listed under two ids is shown once).
    const seen = new Set<string>();
    const rows = results.filter((r) => !seen.has(`${r.model}|${r.job}`) && seen.add(`${r.model}|${r.job}`));
    const out: RecheckSummary = { kind: 'model-recheck', started: started.toISOString(), version, command: 'node scripts/model-recheck.ts --publish', results: rows };
    writeFileSync(join(ROOT, 'docs', 'results', 'model-recheck.json'), `${JSON.stringify(out, null, 2)}\n`);
    console.log(`Wrote docs/results/model-recheck.json and ${writePage()}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
