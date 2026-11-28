import { normalizeText, words } from './normalize.js';
import { textWidth } from './width.js';

/** Wraps text into lines of width at most `width`. */
export function wrapText(text, width) {
  const lines = [];
  for (const paragraph of normalizeText(text).split('\n')) {
    let line = '';
    for (const word of words(paragraph)) {
      if (line === '') line = word;
      else if (textWidth(line) + 1 + textWidth(word) <= width) line += ' ' + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}
