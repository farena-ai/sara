// Quarantine entries (docs/STORE.md, "Quarantine"): { reason, record, step }, written canonically, one per
// line, to quarantine/<collection>.ndjson, after the entries already there.

export function entry(step, reason, record) {
  return { reason, record, step };
}

/** A step's result builder: kept records and quarantine entries per collection. */
export class StepResult {
  constructor(step) {
    this.step = step;
    this.collections = {};
    this.quarantine = {};
  }

  keep(collection, records) {
    this.collections[collection] = records;
  }

  reject(collection, reason, record) {
    (this.quarantine[collection] ??= []).push(entry(this.step, reason, record));
  }
}

/**
 * Splits a collection's lines into records and quarantines the lines that are not JSON objects (the entry's
 * record is then the line's text). Returns the records in file order.
 */
export function objectsOf(lines = [], collection, result) {
  const out = [];
  for (const line of lines) {
    if ('raw' in line) result.reject(collection, 'not a JSON object', line.raw);
    else out.push(line.record);
  }
  return out;
}
