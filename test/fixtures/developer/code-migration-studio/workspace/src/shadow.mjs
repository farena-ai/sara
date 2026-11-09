import { add } from '../lib/math.mjs';

export function product() {
  const add = (a, b) => a * b; // shadows the import: must stay
  return add(2, 3);
}
export const five = add(2, 3);
