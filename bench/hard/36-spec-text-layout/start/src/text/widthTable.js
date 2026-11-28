// The width table of docs/LAYOUT.md, Appendix A. Ranges are inclusive at both ends and sorted.

/** Code points of width 0 (combining marks). */
export const ZERO_WIDTH = [
  [0x0300, 0x036f],
  [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
];

/** Code points of width 2. */
export const DOUBLE_WIDTH = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
];

/** True when cp lies in one of the ranges (binary search; the ranges are sorted and disjoint). */
export function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = ranges[mid];
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
}
