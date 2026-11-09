// 3.0.3 (owner): Your story's look-back range. Default: the past year (today minus one year to today),
// so "Write our year" covers a year even on a new install (it used to start on the first day you talked,
// which is today at first). A range the person picked is kept on this device (sara.storyRange).
export const STORY_RANGE_KEY = 'sara.storyRange';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** One year before a YYYY-MM-DD day (29 February → 28 February). */
export function yearBefore(day) {
  const [y, m, d] = day.split('-').map(Number);
  const back = new Date(Date.UTC(y - 1, m - 1, d));
  if (back.getUTCMonth() !== m - 1) back.setUTCDate(0);
  return back.toISOString().slice(0, 10);
}
/** The range to show: a saved, valid choice, else the past year. */
export function storyRange(today, saved) {
  if (saved && DAY.test(saved.from ?? '') && DAY.test(saved.to ?? '') && saved.from <= saved.to) return { from: saved.from, to: saved.to };
  return { from: yearBefore(today), to: today };
}
