// Phase 109 (CH3, docs/design/CHATS.md §6.7): the title evals on a real model.
//
// 40 invented sessions in six languages (evals/titles/sessions.json: 20 plain, 10 that change topic
// halfway, 5 partner/room chats, 5 sensitive) are named through the real code path (src/titles.ts:
// trigger, cheap call, output checks) and scored in code (src/title-evals.ts).
//
//   node scripts/eval-titles.ts --model gemma4:12b                       (Ollama on this computer)
//        [--ollama http://127.0.0.1:11434/v1] [--route local|quick] [--only en-garden,es-paella]
//
// --route says which of the owner's choices this run stands for (This computer / Quick helpers);
// a quick route on a cloud model is run the same way with --ollama pointing at it. The result goes
// to evals/results/<date>-titles-<route>-<model>.json (private; the owner picks the default from it).
// Exit code 1 when a target is missed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createProvider } from '../src/providers/registry.ts';
import { loadTitleSet, runTitleEvals } from '../src/title-evals.ts';

const ROOT = resolve(import.meta.dirname, '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({
    options: {
      model: { type: 'string' },
      ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' },
      route: { type: 'string', default: 'local' },
      only: { type: 'string' },
    },
  });
  if (!opt.model) {
    console.error('Usage: node scripts/eval-titles.ts --model <ollama model> [--ollama URL] [--route local|quick]');
    process.exit(2);
  }
  const route = opt.route === 'quick' ? 'quick' : 'local';
  const config = { id: 'eval', label: `Eval (${opt.model})`, kind: 'openai-compatible' as const, baseUrl: opt.ollama!, local: true, defaultModel: opt.model };
  const set = loadTitleSet();
  const only = opt.only ? new Set(opt.only.split(',')) : undefined;
  const sessions = only ? set.sessions.filter((s) => only.has(s.id)) : set.sessions;
  const t0 = Date.now();
  const { score, results } = await runTitleEvals({
    provider: config,
    make: (c) => createProvider(c, undefined),
    sessions,
    owner: set.owner,
    onSession: (r) => console.log(`${r.topic ? '✓' : '✗'} ${r.id.padEnd(22)} ${r.first}${r.second !== undefined ? `  →  ${r.second}${r.changed ? '' : ' (no new title)'}` : ''}${r.sensitiveShown ? `  [shows ${r.sensitiveShown}]` : ''}${r.personNamed ? `  [names ${r.personNamed}]` : ''}${r.wrongLanguage ? `  [in ${r.wrongLanguage}]` : ''}${r.skipped ? `  (${r.skipped.join(', ')})` : ''}`),
  });
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`\nTopic ${score.topic} (≥ 0.85) · new title after a change ${score.change} (≥ 0.8; on topic ${score.changeMatched}; code check saw it ${score.codeCheck}) · sensitive ${score.sensitive} (1) · people ${score.people} (1) · language ${score.language} (≥ 0.95) · ${score.pass ? 'PASS' : 'MISSED'} · ${secs} s`);
  const day = new Date().toISOString().slice(0, 10);
  const safe = opt.model.replace(/[^\w.-]+/g, '_');
  const dir = join(ROOT, 'evals', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}-titles-${route}-${safe}.json`);
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), model: opt.model, route, endpoint: opt.ollama, seconds: secs, score, results }, null, 2)}\n`);
  console.log(`Wrote ${file}`);
  process.exit(score.pass ? 0 : 1);
}
