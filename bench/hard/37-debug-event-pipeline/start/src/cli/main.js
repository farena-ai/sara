// Entry point: run(argv, io) → exit code. io = { stdout(text), stderr(text), cwd }.
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError } from '../config.js';
import { JournalError } from '../journal/codec.js';
import { parseArgs, UsageError } from './args.js';
import * as journal from './commands/journal.js';
import * as runCommand from './commands/run.js';
import * as totals from './commands/totals.js';

const COMMANDS = { run: runCommand, journal, totals };
const GLOBAL = { log: { type: 'string' }, help: { type: 'flag' } };

const USAGE = `usage: relay <command> [options]

  relay run <events.ndjson> [--journal DIR] [--sink ledger|memory] [--batch N] [--max-attempts N]
            [--segment-size N] [--tick MS] [--rate N] [--start MS] [--lock ACCOUNT:UNTIL]...
            [--stop-after TICKS] [--json]
  relay journal ls|pending --journal DIR [--json]
  relay totals --journal DIR [--json]

  --log FILE   append the run log to FILE (any command)
`;

export function run(argv, io) {
  const [name, ...rest] = argv;
  try {
    if (!name || name === '--help' || name === 'help') {
      io.stdout(USAGE);
      return 0;
    }
    const command = COMMANDS[name];
    if (!command) throw new UsageError(`unknown command "${name}"`);
    const { values, positionals } = parseArgs(rest, { ...GLOBAL, ...command.options });
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const logFile = values.log ? resolve(io.cwd, values.log) : null;
    const logWrite = logFile ? (line) => appendFileSync(logFile, line) : null;
    return command.run({ values, positionals, io, logWrite });
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof ConfigError || err instanceof JournalError) {
      io.stderr(`error: ${err.message}\n`);
      return 3;
    }
    io.stderr(`error: ${err.stack ?? err.message}\n`);
    return 1;
  }
}
