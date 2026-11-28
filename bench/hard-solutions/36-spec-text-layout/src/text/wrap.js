import { clusters } from './clusters.js';
import { normalizeText, words } from './normalize.js';
import { textWidth } from './width.js';

/** Wraps text into lines of width at most `width` (R7 to R11). */
export function wrapText(text, width) {
  const lines = [];
  for (const paragraph of normalizeText(text).split('\n')) {
    const list = words(paragraph);
    if (list.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    let open = false;
    for (const word of list) {
      const w = textWidth(word);
      if (w <= width) {
        if (!open) {
          line = word;
          lineWidth = w;
          open = true;
        } else if (lineWidth + 1 + w <= width) {
          line += ' ' + word;
          lineWidth += 1 + w;
        } else {
          lines.push(line);
          line = word;
          lineWidth = w;
        }
        continue;
      }
      if (open) lines.push(line);
      let piece = '';
      let pieceWidth = 0;
      for (let c of clusters(word)) {
        let cw = textWidth(c);
        if (cw > width) {
          c = '?';
          cw = 1;
        }
        if (pieceWidth + cw > width) {
          lines.push(piece);
          piece = '';
          pieceWidth = 0;
        }
        piece += c;
        pieceWidth += cw;
      }
      line = piece;
      lineWidth = pieceWidth;
      open = true;
    }
    lines.push(line);
  }
  return lines;
}
