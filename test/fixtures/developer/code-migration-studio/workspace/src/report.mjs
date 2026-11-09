import { add } from '../lib/math.mjs';

export function total(xs) {
  return xs.reduce((acc, x) => add(acc, x), 0);
}
export const helpers = { add };
