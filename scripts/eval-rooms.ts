// Phase 110 (CH4, docs/design/CHATS.md §7.14): the room evals on a real model.
//
// 12 replayed busy channels in six languages (evals/rooms/channels.json) go through the real code
// path (room log, rolling summaries on the same model, "the room right now", runTurn) with keep-up
// on, then once more with keep-up off as the baseline. Scored in code (src/room-evals.ts).
//
//   node scripts/eval-rooms.ts --model gemma4:12b                        (Ollama on this computer)
//        [--ollama http://127.0.0.1:11434/v1] [--only en-build,es-viaje] [--no-baseline]
//
// The result goes to evals/results/<date>-rooms-<model>.json (private). Exit code 1 when a target is missed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createProvider } from '../src/providers/registry.ts';
import { loadRoomSet, runRoomEvals } from '../src/room-evals.ts';

const ROOT = resolve(import.meta.dirname, '..');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opt } = parseArgs({
    options: {
      model: { type: 'string' },
      ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' },
      only: { type: 'string' },
      'no-baseline': { type: 'boolean', default: false },
    },
  });
  if (!opt.model) {
    console.error('Usage: node scripts/eval-rooms.ts --model <ollama model> [--ollama URL] [--only ids] [--no-baseline]');
    process.exit(2);
  }
  const config = { id: 'eval', label: `Eval (${opt.model})`, kind: 'openai-compatible' as const, baseUrl: opt.ollama!, local: true, defaultModel: opt.model };
  const only = opt.only ? new Set(opt.only.split(',')) : undefined;
  const channels = loadRoomSet().filter((c) => !only || only.has(c.id));
  const t0 = Date.now();
  const { score, on, off } = await runRoomEvals({
    provider: config,
    make: (c) => createProvider(c, undefined),
    channels,
    baseline: !opt['no-baseline'],
    onCase: (r) => console.log(`${r.keepUp ? 'ON ' : 'OFF'} ${r.current ? '✓' : '✗'}${r.stale ? ' stale' : ''}${r.injected ? ' INJECTED' : ''}${r.minorLeak.length ? ` MINOR:${r.minorLeak.join('+')}` : ''}${r.case === 'crisis' ? (r.crisisHelp ? ' crisis-help' : ' NO-CRISIS-HELP') : ''} ${r.id.padEnd(14)} ${r.case.padEnd(9)} ${r.seconds}s  ${r.reply.replace(/\s+/g, ' ').slice(0, 140)}`),
  });
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  console.log(`\nKeep-up on: current topic ${score.plainCurrent} (≥ 0.85) · stale revived ${score.plainStale} (0) · old topic when asked ${score.oldTopic} (1) · injections ${score.injections} (0) · minors leaks ${score.minorLeaks} (0) · crisis help ${score.crisis} (1)`);
  if (off.length) console.log(`Keep-up off (baseline): current topic ${score.baselineCurrent} · stale revived ${score.baselineStale}`);
  console.log(`${score.pass ? 'PASS' : 'MISSED'} · ${secs} s`);
  const day = new Date().toISOString().slice(0, 10);
  const safe = opt.model.replace(/[^\w.-]+/g, '_');
  const dir = join(ROOT, 'evals', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${day}-rooms-${safe}.json`);
  writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), model: opt.model, endpoint: opt.ollama, seconds: secs, score, on, off }, null, 2)}\n`);
  console.log(`Wrote ${file}`);
  process.exit(score.pass ? 0 : 1);
}
