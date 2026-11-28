const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

export function daysInMonth(year, month) {
  return [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** True for a 'YYYY-MM-DD' string naming a real day. */
export function isDay(text) {
  if (typeof text !== 'string') return false;
  const m = DAY.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** True for a 'YYYY-MM' string with a month from 01 to 12. */
export function isMonth(text) {
  if (typeof text !== 'string') return false;
  const m = MONTH.exec(text);
  return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** The first day of a 'YYYY-MM' month and the first day of the month after it. */
export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const next = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  return { first: `${month}-01`, nextFirst: `${next}-01` };
}

/** The 'YYYY-MM' month of a 'YYYY-MM-DD' day. */
export const monthOf = (day) => day.slice(0, 7);
