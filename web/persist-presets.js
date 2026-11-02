// Phase 128 PL2c (docs/design/POLISH2.md N17, Q4): the Keep going presets in words. The numbers come
// from the server (GET /api/persist → presets: Careful, Normal = today's defaults, Long jobs); this
// file only says them and tells which preset a set of numbers is. No DOM work at import time, so the
// words can be checked in Node.
import { t } from './naming.js';

export const PRESETS = ['careful', 'normal', 'long'];
export const PRESET_ICON = { careful: 'shield', normal: 'gauge', long: 'job', custom: 'sliders' };
export const presetName = (id) => ({ careful: t('Careful'), normal: t('Normal'), long: t('Long jobs'), custom: t('Custom') })[id] ?? id;

const n = (v) => Number(v || 0).toLocaleString();
/** 30 → "30 minutes", 60 → "an hour", 240 → "4 hours". */
export function timeWords(min) {
  if (min === 60) return t('an hour');
  if (min > 60 && min % 60 === 0) return t('{n} hours', { n: min / 60 });
  return t('{n} minutes', { n: min });
}
const dollars = (usd) => (usd ? t('at most ${usd}', { usd: String(usd) }) : t('no dollar cap'));

/** The two summary lines of a preset: a goal, and the repeats. */
export function presetSummary(p) {
  const g = p.goals;
  const l = p.loops;
  return {
    goal: t('A goal stops after {rounds} rounds or {time}: up to {tokens} tokens, {dollars}.', { rounds: g.rounds, time: timeWords(g.minutes), tokens: n(g.tokens), dollars: dollars(g.usd) }),
    repeats: t('Repeats: every {every} min at the most, {active} at once, up to {tokens} tokens a day, {dollars}.', { every: l.minEvery, active: l.maxActive, tokens: n(l.dailyTokens), dollars: dollars(l.dailyUsd) }),
  };
}

const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${pre}${k}.`) : [[`${pre}${k}`, Number(v)]]));
/** Which preset these numbers are (settings or the Fine-tune fields), or 'custom'. Extra keys (on, quiet, reviewer) are ignored. */
export function whichPreset(presets, numbers) {
  const mine = new Map(flat(numbers));
  for (const id of PRESETS) {
    const p = presets?.[id];
    if (p && flat(p).every(([k, v]) => mine.get(k) === v)) return id;
  }
  return 'custom';
}
