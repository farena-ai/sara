// migrate <command> <store> [options]; run(argv, io) -> exit code (docs/CLI.md).
import { resolve } from 'node:path';
import { LATEST } from '../migrate/registry.js';
import { migrate } from '../migrate/runner.js';
import { status } from '../migrate/status.js';
import { UsageError } from '../util/errors.js';

const USAGE = `usage: migrate run <store> [--to N]
       migrate status <store>
`;

function parse(argv) {
  const positionals = [];
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--to' || arg.startsWith('--to=')) {
      const raw = arg === '--to' ? argv[++i] : arg.slice(5);
      if (!/^\d+$/.test(raw ?? '')) throw new UsageError('--to needs a schema number');
      values.to = Number(raw);
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, values };
}

const COMMANDS = {
  run({ dir, values, io }) {
    const result = migrate(dir, { to: values.to ?? LATEST });
    if (result.steps.length === 0) io.stdout(`already at schema ${result.to}, nothing to do\n`);
    for (const step of result.steps) io.stdout(`${step} done\n`);
    if (result.steps.length > 0) io.stdout(`store is at schema ${result.to}\n`);
    return 0;
  },
  status({ dir, io }) {
    const s = status(dir);
    io.stdout(`schema ${s.schema}${s.interrupted ? ', interrupted run (run again to finish)' : ''}\n`);
    for (const [name, n] of Object.entries(s.counts)) io.stdout(`  ${name}: ${n} records\n`);
    return 0;
  },
};

export function run(argv, io) {
  try {
    const [command, ...rest] = argv;
    if (!command || command === '--help' || command === 'help') {
      io.stdout(USAGE);
      return 0;
    }
    const handler = COMMANDS[command];
    if (!handler) throw new UsageError(`unknown command "${command}"`);
    const { positionals, values } = parse(rest);
    if (positionals.length !== 1) throw new UsageError(USAGE.trimEnd());
    return handler({ dir: resolve(io.cwd, positionals[0]), values, io });
  } catch (err) {
    io.stderr(`error: ${err.message}\n`);
    return err.exitCode ?? 1;
  }
}
