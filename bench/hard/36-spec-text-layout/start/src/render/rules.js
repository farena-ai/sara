import { trimTrailingSpaces } from '../util/strings.js';

/** A rule line of the "ascii" style made of `ch` (R32). Spans are ignored. */
export function ruleLine(style, widths, ch) {
  const pad = style.padLeft + style.padRight;
  return style.corner + widths.map((w) => ch.repeat(w + pad)).join(style.corner) + style.corner;
}

/** The header underline of the "none" style (R33). */
export function underline(style, widths) {
  return trimTrailingSpaces(widths.map((w) => '-'.repeat(w)).join(style.separator));
}
