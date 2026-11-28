import { charWidth } from './width.js';

/** Splits text into clusters (R2): a base code point and the width-0 code points after it. */
export function clusters(text) {
  const out = [];
  for (const ch of text) {
    if (charWidth(ch.codePointAt(0)) === 0 && out.length > 0) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}
