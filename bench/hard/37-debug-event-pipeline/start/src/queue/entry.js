// A queue entry: one accepted event and its delivery state.
//   seq         order of acceptance, unique and increasing for the life of a journal
//   attempts    failed attempts so far
//   dueAt       clock time from which it may be delivered (its acceptance time, or the retry time)

export function makeEntry({ seq, id, key, data, enqueuedAt, attempts = 0, dueAt = enqueuedAt }) {
  return { seq, id, key, data, enqueuedAt, attempts, dueAt };
}

export function describe(entry) {
  return entry.attempts > 0 ? `${entry.id}(#${entry.attempts + 1})` : entry.id;
}
