import { fail } from '../util/errors.js';

/**
 * Border styles (docs/LAYOUT.md R32, R33). `left`/`right` are the outer borders, `separator` sits
 * between two cells, `padLeft`/`padRight` are spaces inside each cell, `corner` joins rule lines.
 */
export const STYLES = {
  ascii: { name: 'ascii', left: '|', right: '|', separator: '|', padLeft: 1, padRight: 1, corner: '+', rule: '-', headerRule: '=' },
  none: { name: 'none', left: '', right: '', separator: '  ', padLeft: 0, padRight: 0, corner: null, rule: null, headerRule: null },
};

export function getStyle(name = 'ascii') {
  const style = STYLES[name];
  if (!style) fail(`unknown style "${name}"`);
  return style;
}

/** What a line holds besides the column contents, for n columns (R17). */
export function overhead(style, n) {
  return style.left.length + style.right.length + n * (style.padLeft + style.padRight) + (n - 1) * style.separator.length;
}

/** What lies between two neighbouring cells on a line (padding, separator, padding). */
export function boundaryWidth(style) {
  return style.padRight + style.separator.length + style.padLeft;
}

export function hasRules(style) {
  return style.corner !== null;
}
