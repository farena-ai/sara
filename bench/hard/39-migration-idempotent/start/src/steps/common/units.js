// Unit conversions used by the steps.

export const GRAMS_PER_POUND = 453.59237;

/** Whole grams for a weight in pounds (a number ≥ 0), rounded with Math.round; null when not a weight. */
export function poundsToGrams(lb) {
  if (typeof lb !== 'number' || !Number.isFinite(lb) || lb < 0) return null;
  return Math.round(lb * GRAMS_PER_POUND);
}
