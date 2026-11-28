// Turns what a sink returned into the events it accepted and the ones to try again.
// A sink returns nothing (all accepted) or { rejected: [ids], reason }; see docs/SINKS.md.

export class SinkResultError extends Error {}

export function splitOutcome(items, result) {
  if (result === undefined || result === null) return { accepted: items.slice(), retry: [] };
  if (typeof result !== 'object' || (result.rejected !== undefined && !Array.isArray(result.rejected))) {
    throw new SinkResultError('a sink must return nothing or { rejected: [ids] }');
  }
  const rejected = new Set(result.rejected ?? []);
  for (const id of rejected) {
    if (!items.some((e) => e.id === id)) throw new SinkResultError(`the sink rejected "${id}", which is not in the batch`);
  }
  const accepted = items.slice();
  const retry = [];
  for (let i = 0; i < accepted.length; i++) {
    if (rejected.has(accepted[i].id)) {
      retry.push(accepted[i]);
      accepted.splice(i, 1);
    }
  }
  return { accepted, retry };
}
