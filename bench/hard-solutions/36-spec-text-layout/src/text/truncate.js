import { clusters } from './clusters.js';
import { flatten } from './normalize.js';
import { textWidth } from './width.js';
import { trimTrailingSpaces } from '../util/strings.js';

/** The longest run of whole clusters from the start of `text` whose width is at most `room`. */
function prefix(text, room) {
  let out = '';
  let width = 0;
  for (const c of clusters(text)) {
    const cw = textWidth(c);
    if (width + cw > room) break;
    out += c;
    width += cw;
  }
  return out;
}

/** `line` shortened to end with the ellipsis inside `width` (R13, R14). */
export function shorten(line, width, ellipsis) {
  const ew = textWidth(ellipsis);
  if (ew >= width) return prefix(ellipsis, width);
  return trimTrailingSpaces(prefix(line, width - ew)) + ellipsis;
}

/** One line of at most `width` columns (R12 to R14). */
export function truncateText(text, width, ellipsis = '…') {
  const flat = flatten(text);
  if (textWidth(flat) <= width) return flat;
  return shorten(flat, width, ellipsis);
}

/** R15: keep `maxLines` lines and mark the last one. */
export function limitLines(lines, maxLines, width, ellipsis = '…') {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = textWidth(last) + textWidth(ellipsis) <= width ? last + ellipsis : shorten(last, width, ellipsis);
  return kept;
}
