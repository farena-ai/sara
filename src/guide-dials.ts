// The dial tables of the guide (web/help.html, between <!-- dials:start --> and <!-- dials:end -->),
// built from the definitions in traits.ts. scripts/gen-guide.ts writes them; a test checks the
// guide matches, so it never drifts from the app.
import { GROUP_TITLES, HUMOURS, NEVER_CONTROLLING, QUIET_FOCUS, type TraitDef, TRAITS } from './traits.ts';
import { ARCHETYPES } from './studio.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Phase 114: the plain group names; the relationship and work groups say where they live.
const GROUPS: [TraitDef['group'], string][] = [
  ['Heart', GROUP_TITLES.Heart],
  ['Fun', GROUP_TITLES.Fun],
  ['Edge', GROUP_TITLES.Edge],
  ['Talk', GROUP_TITLES.Talk],
  ['Together', 'You two (Settings → Relationship)'],
  ['Work', 'While you code (coding conversations only)'],
];
/** The bands of a dial, as the column heads (0-1, 2-3, 4-6, 7-8, 9-10). */
export const BAND_HEADS = ['0–1', '2–3', '4–6', '7–8', '9–10'];
export const DIALS_INTRO = 'Every dial has five steps. The middle one (4–6) is her usual self: it adds nothing to her prompt. Each step shows its word and how she would sound; the app shows the same line under the dial as you move it.';

export const DIALS_START = '<!-- dials:start -->';
export const DIALS_END = '<!-- dials:end -->';

/** The first cell of a dial's row: its name, its ends (and the old ones), the moment her lines answer. */
export function dialCell(t: TraitDef): string {
  const was = t.was ? `<br><span class="muted small">Also called: ${esc(t.was[0])} ↔ ${esc(t.was[1])}</span>` : '';
  return `<b>${esc(t.label)}</b><br><span class="muted small">${esc(t.low)} ↔ ${esc(t.high)}</span>${was}<br><span class="muted small">${esc(t.when)}</span>`;
}
/** One band's cell: the step word and her line. */
export const stepCell = (s: TraitDef['steps'][number]): string => `<b>${esc(s.word)}</b><br>${esc(s.say)}`;

export function dialTablesHtml(): string {
  let h = `<p>${esc(DIALS_INTRO)}</p>\n`;
  for (const [g, title] of GROUPS) {
    h += `<h3>${esc(title)}</h3>\n<table class="guide-dials">\n<tr><th>Dial</th>${BAND_HEADS.map((b) => `<th>${b}</th>`).join('')}</tr>\n`;
    for (const t of TRAITS.filter((x) => x.group === g)) {
      h += `<tr id="dial-${t.id}"><td>${dialCell(t)}</td>${t.steps.map((s) => `<td>${stepCell(s)}</td>`).join('')}</tr>\n`;
    }
    h += '</table>\n';
    if (g === 'Together') h += `<p class="muted small">${esc(NEVER_CONTROLLING)}</p>\n`;
    if (g === 'Work') h += `<p id="dial-${QUIET_FOCUS.id}"><b>${esc(QUIET_FOCUS.label)}</b> (a switch): ${esc(QUIET_FOCUS.tip)}</p>\n`;
  }
  h += `<p><b>Humour styles:</b> ${Object.values(HUMOURS).map((x) => esc(x.label)).join(', ')}.</p>\n`;
  h += `<p><b>Starting points:</b> ${ARCHETYPES.map((a) => `${a.emoji} ${esc(a.label)} (${esc(a.blurb.replace(/\.$/, ''))})`).join('; ')}.</p>\n`;
  return h;
}

/** The guide with its dial tables replaced (or the same text when they already match). */
export function withDialTables(html: string): string {
  const a = html.indexOf(DIALS_START);
  const b = html.indexOf(DIALS_END);
  if (a < 0 || b < a) throw new Error('help.html has no dials markers');
  return `${html.slice(0, a + DIALS_START.length)}\n${dialTablesHtml()}${html.slice(b)}`;
}
