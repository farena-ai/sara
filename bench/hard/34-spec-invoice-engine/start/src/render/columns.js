// Simple column layout for the text rendering.

export function padRight(s, w) {
  return s + ' '.repeat(Math.max(0, w - s.length));
}

export function padLeft(s, w) {
  return ' '.repeat(Math.max(0, w - s.length)) + s;
}

/** Lays rows out in columns two spaces apart; trailing spaces are removed. */
export function columns(rows, pads) {
  const widths = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, String(c).length)));
  return rows.map((r) => r.map((c, i) => (pads[i] ?? padRight)(String(c), widths[i])).join('  ').trimEnd());
}
