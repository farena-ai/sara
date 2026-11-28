// Calendar dates as "YYYY-MM-DD" strings, counted in whole days on the UTC calendar (SPEC rule 21).
import { fail } from '../errors.js';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y, m) {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** The day number (days since 1970-01-01) of a date string; INVALID_DATE if it is not a real date. */
export function dayNumber(s, field = 'date') {
  const m = typeof s === 'string' ? DATE.exec(s) : null;
  if (!m) fail('INVALID_DATE', `${field} must be YYYY-MM-DD, got ${JSON.stringify(s)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) fail('INVALID_DATE', `${field} is not a calendar date: ${s}`);
  return Date.UTC(y, mo - 1, d) / DAY_MS;
}

/** The number of days from `start` to `end`, both included. */
export function daysInclusive(start, end) {
  return dayNumber(end) - dayNumber(start) + 1;
}
