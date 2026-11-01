// Phase 114 (PL1a): the personality dial rows. Each row shows the dial's name, the word for the
// band it is in (and the number), a sample line of how she'd sound there, five soft ticks with the
// middle band shaded ("her usual self": it adds nothing to her prompt), and the end words right
// under the track. The sample line is written copy from the server's dial definitions (traits.ts
// `steps`), swapped as the slider moves: no model call. Try it is where the model answers.
import { locale, t } from './naming.js';

/** The band of a value: 0 (0-1), 1 (2-3), 2 (4-6, the middle), 3 (7-8), 4 (9-10). Same as traits.ts band(). */
export const bandOf = (v) => (v <= 1 ? 0 : v <= 3 ? 1 : v <= 6 ? 2 : v <= 8 ? 3 : 4);
/** Where each band starts (the ticks). */
export const BAND_START = [0, 2, 4, 7, 9];

/** The step at a value in the app's language: { word, meaning, say }. {you} and {name} are filled in. */
export function stepAt(d, v, vars = {}) {
  const s = d.steps?.[bandOf(v)];
  if (!s) return null;
  return { word: t(s.word), meaning: t(s.meaning), say: t(s.say, vars) };
}

/** A position in end words ("Openly warm", "Leaning: keeps it light", "Very shy"); '' in the middle. */
export function endWord(d, v) {
  const b = bandOf(v);
  if (b === 2) return '';
  const end = b < 2 ? d.low : d.high;
  const oneWord = !/\s/.test(end) && !/^very /i.test(end);
  const strong = b === 0 || b === 4;
  const word = t(end).toLocaleLowerCase(locale());
  if (oneWord) return strong ? t('Very {word}', { word }) : t('A bit {word}', { word });
  return strong ? t(end) : t('Leaning: {word}', { word });
}

/** "Your Sara so far": the dials that are off the middle, in end words, in the order they're shown. */
export function soFar(defs, traits) {
  return defs.map((d) => endWord(d, traits?.[d.id] ?? 5)).filter(Boolean);
}

/** The text of the "Your Sara so far" strip. */
export function soFarText(defs, traits) {
  const words = soFar(defs, traits);
  return words.length ? words.join(' · ') : t('Her usual self on every dial');
}

const make = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/**
 * One dial row. `get()` reads the value (5 when unset), `set(v)` stores it; `vars` fills {you} and
 * {name}; `onPlans` opens Planner → Her plans (the Starts conversations row links there).
 */
export function dialRow(d, { get, set, vars = () => ({}), onChange, onPlans } = {}) {
  const row = make('div', 'dial');
  row.dataset.dialRow = d.id;
  const head = make('div', 'dial-head');
  const label = make('span', 'dial-label', t(d.label));
  const tip = make('button', 'tip', '?');
  tip.type = 'button';
  tip.dataset.tip = t(d.tip);
  const word = make('span', 'dial-word', '');
  const num = make('span', 'dial-num muted small', '');
  head.append(label, tip, word, num);
  const say = make('p', 'dial-say', '');
  say.setAttribute('aria-live', 'polite');
  const when = make('p', 'dial-when muted small', '');
  const track = make('div', 'dial-track');
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '10';
  range.step = '1';
  range.dataset.dial = d.id;
  range.setAttribute('aria-label', t(d.label));
  const ticks = make('div', 'dial-ticks');
  ticks.setAttribute('aria-hidden', 'true');
  const zone = make('span', 'dial-zone');
  zone.title = t('Her usual self');
  ticks.append(zone, ...BAND_START.map((b) => make('span', `dial-tick at-${b}`)));
  track.append(ticks, range);
  const ends = make('div', 'dial-ends');
  ends.append(make('span', '', t(d.low)), make('span', '', t(d.high)));
  row.append(head, say, when, track, ends);
  if (d.note) row.append(make('p', 'dial-note muted small', t(d.note)));
  if (d.id === 'initiative') {
    const extra = make('p', 'dial-note muted small', `${t('Shared with her plans · quiet hours apply')} `);
    if (onPlans) {
      const go = make('button', 'linkish small', t('Her plans'));
      go.type = 'button';
      go.addEventListener('click', onPlans);
      extra.append(go);
    }
    row.append(extra);
  }
  let shown = -1;
  const paint = (v) => {
    const s = stepAt(d, v, vars()) ?? { word: '', meaning: '', say: '' };
    const b = bandOf(v);
    word.textContent = s.word;
    num.textContent = String(v);
    row.dataset.band = String(b);
    range.setAttribute('aria-valuetext', `${v} · ${s.word}`);
    when.textContent = `${s.word}: ${s.meaning} · ${t(d.when)}`;
    range.title = when.textContent;
    if (say.textContent !== s.say) {
      say.textContent = s.say;
      // A short cross-fade when the band changes (none with reduced motion: see style.css).
      if (shown !== -1 && shown !== b) {
        say.classList.remove('swap');
        void say.offsetWidth;
        say.classList.add('swap');
      }
    }
    shown = b;
  };
  row.show = () => {
    const v = Number(get() ?? 5);
    range.value = String(v);
    paint(v);
  };
  range.addEventListener('input', () => {
    const v = Number(range.value);
    set(v);
    paint(v);
    onChange?.(d.id, v);
  });
  return row;
}

/**
 * Rows for the given dials (all when `ids` is empty), in groups with their plain names when
 * `grouped`. `target()` is the draft persona the values go to.
 */
export function dialRows(box, defs, ids, target, onChange, { grouped = false, vars, onPlans } = {}) {
  const list = defs.filter((d) => !ids || ids.includes(d.id));
  const groups = !ids || grouped ? [...new Set(list.map((d) => d.group))] : [null];
  box.replaceChildren();
  for (const g of groups) {
    const wrap = make('div', 'dial-group');
    if (g) wrap.append(make('p', 'dial-group-name', t(list.find((d) => d.group === g)?.groupTitle ?? g)));
    for (const d of list.filter((x) => !g || x.group === g)) {
      wrap.append(
        dialRow(d, {
          get: () => target().traits?.[d.id] ?? 5,
          set: (v) => {
            const p = target();
            p.traits = { ...p.traits, [d.id]: v };
          },
          vars,
          onChange,
          onPlans,
        }),
      );
    }
    box.append(wrap);
  }
}

/** Shows every row of a box again from the draft (after Undo, an archetype, a reload). */
export const refreshDials = (box) => box.querySelectorAll('.dial').forEach((r) => r.show?.());
