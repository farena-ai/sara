// relay journal ls | pending --journal <dir>
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJournal } from '../../journal/inspect.js';
import { UsageError } from '../args.js';

export const options = { journal: { type: 'string' }, json: { type: 'flag' } };

export function run({ values, positionals, io }) {
  const [what] = positionals;
  if (!values.journal) throw new UsageError('relay journal needs --journal <dir>');
  const dir = resolve(io.cwd, values.journal);
  if (!existsSync(dir)) throw new UsageError(`no journal at ${values.journal}`);
  const { segments, state } = readJournal(dir);
  if (what === 'ls') {
    if (values.json) io.stdout(`${JSON.stringify(segments.map((s) => ({ name: s.name, records: s.records.length, torn: s.torn })))}\n`);
    else for (const s of segments) io.stdout(`${s.name.padEnd(18)} ${String(s.records.length).padStart(5)} records${s.torn ? ' (torn last line)' : ''}\n`);
    return 0;
  }
  if (what === 'pending') {
    const rows = state.pending.map((e) => ({ seq: e.seq, id: e.id, key: e.key, attempts: e.attempts, dueAt: e.dueAt }));
    if (values.json) io.stdout(`${JSON.stringify(rows)}\n`);
    else for (const r of rows) io.stdout(`${String(r.seq).padStart(6)}  ${r.id}  ${r.key}  attempts=${r.attempts}  due=${r.dueAt}\n`);
    return 0;
  }
  throw new UsageError('usage: relay journal ls|pending --journal <dir>');
}
