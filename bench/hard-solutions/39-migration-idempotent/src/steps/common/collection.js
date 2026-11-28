// The common shape of a step over one collection: quarantine lines that are not objects, then records that
// fail the step's checks, then duplicate ids; keep the rest in file order.
import { objectsOf } from '../../migrate/quarantine.js';
import { dedupeById, hasId } from './ids.js';

/** convert(record) -> { record } | { reason }. Returns the kept { record, original } pairs. */
export function migrateCollection(lines, collection, convert, result) {
  const passed = [];
  for (const record of objectsOf(lines, collection, result)) {
    const out = hasId(record) ? convert(record) : { reason: 'missing id' };
    if (out.reason) result.reject(collection, out.reason, record);
    else passed.push({ record: out.record, original: record });
  }
  const { kept, duplicates } = dedupeById(passed);
  for (const d of duplicates) result.reject(collection, 'duplicate id', d.original);
  return kept;
}
