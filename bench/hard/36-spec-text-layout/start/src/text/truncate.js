import { fail } from '../util/errors.js';

/** One line of at most `width` columns. */
export function truncateText(text, width, ellipsis = '…') {
  return fail('overflow "truncate" is not implemented yet');
}

/** Keeps at most `maxLines` lines. */
export function limitLines(lines, maxLines, width, ellipsis = '…') {
  return fail('maxLines is not implemented yet');
}
