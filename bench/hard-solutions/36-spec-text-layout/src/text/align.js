import { textWidth } from './width.js';
import { spaces } from '../util/strings.js';

/** Pads one line to exactly `width` columns (R25). */
export function alignText(line, width, align = 'left') {
  const gap = Math.max(0, width - textWidth(line));
  if (align === 'right') return spaces(gap) + line;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return spaces(left) + line + spaces(gap - left);
  }
  return line + spaces(gap);
}
