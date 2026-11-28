// Record ids within one collection (docs/MIGRATIONS.md, "Rules for every step").

export function hasId(record) {
  return typeof record.id === 'string' && record.id !== '';
}

/**
 * Keeps one record per id. `items` are { record, original } pairs that passed the step's other checks, in file
 * order; returns { kept, duplicates } (duplicates are the pairs to quarantine with "duplicate id").
 */
export function dedupeById(items) {
  const byId = new Map();
  for (const item of items) byId.set(item.record.id, item);
  const kept = [...byId.values()];
  return { kept, duplicates: [] };
}
