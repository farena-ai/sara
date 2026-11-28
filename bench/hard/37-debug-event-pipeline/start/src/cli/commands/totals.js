// relay totals --journal <dir>: the amounts of the delivered events, per account, from the journal alone.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { journalTotals } from '../../journal/inspect.js';
import { UsageError } from '../args.js';

export const options = { journal: { type: 'string' }, json: { type: 'flag' } };

export function run({ values, io }) {
  if (!values.journal) throw new UsageError('relay totals needs --journal <dir>');
  const dir = resolve(io.cwd, values.journal);
  if (!existsSync(dir)) throw new UsageError(`no journal at ${values.journal}`);
  const totals = journalTotals(dir);
  if (values.json) io.stdout(`${JSON.stringify(totals)}\n`);
  else for (const [account, amount] of Object.entries(totals)) io.stdout(`  ${account.padEnd(12)} ${amount.padStart(12)}\n`);
  return 0;
}
