// Read-only views of a journal folder, for the CLI (`relay journal …`, `relay totals`).
import { silent } from '../util/log.js';
import { formatCents, parseAmount } from '../util/money.js';
import { replay } from './recovery.js';
import { SegmentStore } from './segment-store.js';

export function readJournal(dir) {
  const store = new SegmentStore(dir, Number.MAX_SAFE_INTEGER, silent);
  const segments = store.list().map((name) => {
    const { records, torn } = store.read(name);
    return { name, records, torn };
  });
  const state = replay(segments.flatMap((s) => s.records));
  return { segments, state };
}

/** Sums the amounts of the delivered events per account: { account: "12.50" }, sorted by account. */
export function journalTotals(dir) {
  const { segments } = readJournal(dir);
  const records = segments.flatMap((s) => s.records);
  const accepted = new Map();
  for (const r of records) if (r.t === 'enq') accepted.set(r.seq, r);
  const cents = new Map();
  for (const r of records) {
    if (r.t !== 'done') continue;
    const enq = accepted.get(r.seq);
    if (!enq) continue;
    const account = enq.data?.account ?? enq.key;
    const amount = parseAmount(enq.data?.amount);
    if (amount === null) continue;
    cents.set(account, (cents.get(account) ?? 0) + amount);
  }
  const out = {};
  for (const account of [...cents.keys()].sort()) out[account] = formatCents(cents.get(account));
  return out;
}
