import { textWidth } from './width.js';
import { fail } from '../util/errors.js';
import { spaces } from '../util/strings.js';

/** Pads one line to exactly `width` columns. */
export function alignText(line, width, align = 'left') {
  const gap = Math.max(0, width - textWidth(line));
  if (align === 'left') return line + spaces(gap);
  if (align === 'right') return spaces(gap) + line;
  return fail(`align "${align}" is not implemented yet`);
}
