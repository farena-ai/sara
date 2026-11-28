import { DOUBLE_WIDTH, ZERO_WIDTH, inRanges } from './widthTable.js';

/** Display width of one code point: 0, 1 or 2 (R1). */
export function charWidth(cp) {
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  if (inRanges(cp, DOUBLE_WIDTH)) return 2;
  return 1;
}

/** Display width of a string (R3). */
export function textWidth(text) {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0));
  return width;
}
