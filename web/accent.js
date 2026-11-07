// V1 (docs/ops/V1_DESIGN.md → Accent): a custom accent colour that stays readable in every palette.
// customAccent('#hex') works out, per mode, a fill (≥ 3:1 on every page surface, and carrying its own
// text at 4.5:1), a text shade nudged in OKLCH lightness until it reaches 4.5:1 on every surface, and the
// text colour on the fill (black or white). app.js stores the result in sara.accentCustom and
// web/theme-boot.js copies the three strings before the first paint.

/** surface-0/1/2 of every palette (web/theme.css, kept equal by test/v1-theme.test.ts). */
export const PAGE_SURFACES = {
  dark: ['#0f1012', '#16171a', '#1d1e22', '#0a0e17', '#0f1420', '#151b29', '#111417', '#171b1f', '#1e2328', '#2e3440', '#333a47', '#3b4252', '#002b36', '#073642', '#0b3d4a', '#161513', '#1c1b18', '#23221e', '#14110f', '#1b1714', '#221d19', '#000000', '#0a0a0a', '#141414', '#0f0d17', '#17141f', '#1e1a29'],
  light: ['#f7f7f8', '#ffffff', '#f0f0f2', '#f4f7fb', '#eaf0f7', '#f6f8f8', '#edf1f1', '#eceff4', '#f5f7fa', '#e5e9f0', '#fdf6e3', '#fffbef', '#f5efdc', '#faf9f6', '#f3f1ec', '#fbf7f1', '#f4eee5', '#f2f2f2', '#faf7f5', '#f4eef1'],
};

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
export const parseHex = (h) => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(h ?? '').trim());
  if (!m) return null;
  const v = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
};
const toHex = (rgb) => '#' + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0')).join('');
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** sRGB hex → OKLCH [L, C, h]. */
export function toOklch(hex) {
  const [r, g, b] = parseHex(hex).map(toLin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}
/** OKLCH → sRGB hex; the chroma shrinks until the colour fits in sRGB. */
export function fromOklch([L, C, h]) {
  for (let c = C; c >= 0; c -= 0.005) {
    const A = c * Math.cos(h), B = c * Math.sin(h);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
    const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return toHex(rgb.map(toGam));
  }
  return toHex([L, L, L].map((v) => toGam(Math.min(1, Math.max(0, v)))));
}
/** Moves `hex` lighter (dark mode) or darker (light mode) in OKLCH until `ok(hex)` holds. */
function nudge(hex, dark, ok) {
  const [L, C, h] = toOklch(hex);
  for (let i = 0; i <= 100; i++) {
    const v = fromOklch([Math.min(1, Math.max(0, L + (dark ? i : -i) * 0.01)), C, h]);
    if (ok(v)) return v;
  }
  return dark ? '#ffffff' : '#000000';
}
const BLACK = '#0b0b0c';
const onFor = (fill) => (contrast('#ffffff', fill) >= contrast(BLACK, fill) ? '#ffffff' : BLACK);

/** One mode's three colours for a picked colour, or null for a value that isn't a colour. */
export function accentFor(hex, mode, surfaces = PAGE_SURFACES[mode]) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const base = toHex(rgb);
  const dark = mode === 'dark';
  const fillOk = (v) => surfaces.every((s) => contrast(v, s) >= 3) && contrast(onFor(v), v) >= 4.5;
  const fill = fillOk(base) ? base : nudge(base, dark, fillOk);
  const text = nudge(base, dark, (v) => surfaces.every((s) => contrast(v, s) >= 4.5));
  return { fill, text, on: onFor(fill) };
}
/** Both modes, as stored in sara.accentCustom ({ hex, dark, light }). */
export function customAccent(hex) {
  const dark = accentFor(hex, 'dark');
  const light = accentFor(hex, 'light');
  return dark && light ? { hex: toHex(parseHex(hex)), dark, light } : null;
}
