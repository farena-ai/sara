import { alignText } from '../text/align.js';
import { truncateText } from '../text/truncate.js';
import { trimTrailingSpaces } from '../util/strings.js';

/** R36: the two title lines for a table whose lines are `lineWidth` wide. */
export function titleLines(title, lineWidth, ellipsis) {
  if (title === undefined) return [];
  const text = truncateText(title, lineWidth, ellipsis);
  return [trimTrailingSpaces(alignText(text, lineWidth, 'center')), ''];
}
