import { fail } from '../util/errors.js';
import { sum } from '../util/strings.js';

/** R23: narrows columns until the widths fit in `budget`. Changes `widths` in place. */
export function shrinkToFit(columns, widths, budget) {
  let total = sum(widths);
  while (total > budget) {
    let pick = -1;
    for (let i = 0; i < widths.length; i++) {
      if (columns[i].kind === 'fixed' || widths[i] <= columns[i].min) continue;
      if (pick < 0 || widths[i] >= widths[pick]) pick = i;
    }
    if (pick < 0) fail('the table does not fit in the width');
    widths[pick]--;
    total--;
  }
  return widths;
}
