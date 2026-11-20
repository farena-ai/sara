// P2 (docs/design/P2STOCKS.md): the Stocks tile's pure helpers, no imports (tests load this file
// in Node). Charts are drawn here as SVG paths from the server's points: no chart library, no
// outside chart service; colors come from theme variables in web/today.css.

/**
 * Geometry for a price line: `line` and `area` path data, the scale and a `y(price)` mapper.
 * points: [[t, price], ...] oldest first; levels: prices that must be visible (alert lines,
 * the previous close).
 */
export function chartGeom(points, { w = 300, h = 80, pad = 4, levels = [] } = {}) {
  const pts = (points ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return { line: '', area: '', min: 0, max: 0, y: () => h / 2, x: () => 0 };
  const vals = [...pts.map((p) => p[1]), ...levels.filter((v) => Number.isFinite(v))];
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const t0 = pts[0][0];
  const t1 = pts.at(-1)[0];
  const span = t1 - t0 || 1;
  // Even spacing by index for intraday/weekly ranges keeps nights and weekends from leaving gaps.
  const x = (i) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * w);
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const f = (n) => (Math.round(n * 10) / 10).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${f(x(i))},${f(y(p[1]))}`).join('');
  const area = `${line}L${f(x(pts.length - 1))},${h}L${f(x(0))},${h}Z`;
  return { line, area, min, max, y, x, t0, t1, span };
}

const fmt2 = (n) => Math.abs(n).toFixed(2);
/** The day's change as words that don't rely on color: an arrow, a sign and the numbers. */
export function changeParts(change, pct) {
  if (!Number.isFinite(change) && !Number.isFinite(pct)) return { dir: 'flat', arrow: '', text: '' };
  const v = Number.isFinite(change) ? change : pct;
  const dir = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const sign = dir === 'up' ? '+' : dir === 'down' ? '−' : '';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■';
  const parts = [];
  if (Number.isFinite(change)) parts.push(`${sign}${fmt2(change)}`);
  if (Number.isFinite(pct)) parts.push(Number.isFinite(change) ? `(${sign}${fmt2(pct)}%)` : `${sign}${fmt2(pct)}%`);
  return { dir, arrow, text: parts.join(' ') };
}

/** How long the tile waits before asking again: a minute while the market is open, 15 when closed, longer after errors (at most 30 min). */
export function pollEveryMs(open, failures = 0) {
  const base = open ? 60_000 : 15 * 60_000;
  if (!failures) return base;
  return Math.min(30 * 60_000, Math.max(base, 60_000 * 2 ** Math.min(failures, 5)));
}

/** A price as text: two decimals, four under 1 (crypto, pennies). */
export function priceText(v, lang) {
  if (!Number.isFinite(v)) return '—';
  const d = Math.abs(v) < 1 ? 4 : 2;
  return v.toLocaleString(lang || undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
