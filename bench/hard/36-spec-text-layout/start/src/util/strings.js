/** n spaces (none for n <= 0). */
export function spaces(n) {
  return n > 0 ? ' '.repeat(n) : '';
}

/** Removes trailing U+0020 spaces only (not tabs, not U+00A0). */
export function trimTrailingSpaces(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x20) end--;
  return s.slice(0, end);
}

export function sum(values) {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function isInteger(v, min = 1) {
  return Number.isInteger(v) && v >= min;
}
