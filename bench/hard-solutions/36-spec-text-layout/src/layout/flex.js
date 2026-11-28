/** R21: shares of `room` for columns with the given weights (largest remainder, leftmost first). */
export function shares(room, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const r = Math.max(room, 0);
  const out = weights.map((k) => Math.floor((r * k) / total));
  let left = r - out.reduce((a, b) => a + b, 0);
  const order = weights
    .map((k, i) => ({ i, rem: (r * k) % total }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/** R22: widths for the flex columns (indexes into `columns`) sharing `room`. */
export function resolveFlex(columns, indexes, room) {
  const result = new Map();
  let open = [...indexes];
  let left = room;
  while (open.length > 0) {
    const got = shares(left, open.map((i) => columns[i].flex));
    const over = open.filter((i, n) => columns[i].max !== undefined && got[n] > columns[i].max);
    if (over.length > 0) {
      for (const i of over) {
        result.set(i, columns[i].max);
        left -= columns[i].max;
      }
      open = open.filter((i) => !over.includes(i));
      continue;
    }
    const under = open.filter((i, n) => got[n] < columns[i].min);
    if (under.length > 0) {
      for (const i of under) {
        result.set(i, columns[i].min);
        left -= columns[i].min;
      }
      open = open.filter((i) => !under.includes(i));
      continue;
    }
    open.forEach((i, n) => result.set(i, got[n]));
    break;
  }
  return result;
}
