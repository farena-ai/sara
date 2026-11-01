// Phase 114 (PL1d, docs/design/POLISH.md §6): the "How do I…?" index. Every question of the app's
// "How do I…?" blocks lives once, in web/howto.json; this file turns it into
//   - the guide's index (web/help.html, between <!-- howto:start --> and <!-- howto:end -->), and
//   - the docs site page docs/HOW_DO_I.md.
// scripts/gen-guide.ts writes both; test/phase114d.test.ts checks they match, so neither drifts.
// The guide's copy is translated in the browser by web/help-i18n.js with the keys the app already has
// (page titles from index.html, the questions and steps from howto.json), so it needs no new lines.

export interface HowtoQ {
  id: string;
  q: string;
  steps: string[];
  show?: string;
  start?: string;
}
export type HowtoData = Record<string, HowtoQ[]>;
/** A Settings page's title and group, read from index.html (data-page / data-title / data-group). */
export interface PageTitle {
  title: string;
  group: string;
}

export const HOWTO_START = '<!-- howto:start -->';
export const HOWTO_END = '<!-- howto:end -->';

/** The views (and the chat) in the order the sidebar shows them, with their names in the app. */
export const VIEW_TITLES: Record<string, string> = {
  chat: 'Chat',
  today: 'Today',
  planner: 'Planner',
  memory: 'Memory',
  library: 'Library',
  scrapbook: 'Scrapbook',
  moments: 'Our moments',
  story: 'Your story',
  team: 'Team',
  findings: 'Findings',
  evals: 'Evals',
};
export const VIEWS_HEADING = 'Chat and the main views';
/** Settings groups in the order of the Settings menu. */
export const GROUP_ORDER = ['Her', 'You', 'Models', 'Abilities', 'Connections', 'Data & health', 'Household'];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Settings page titles and groups from index.html. */
export function pageTitles(indexHtml: string): Record<string, PageTitle> {
  const out: Record<string, PageTitle> = {};
  for (const m of indexHtml.matchAll(/<section\b[^>]*\bdata-page="([\w-]+)"[^>]*>/g)) {
    const title = /data-title="([^"]*)"/.exec(m[0])?.[1];
    const group = /data-group="([^"]*)"/.exec(m[0])?.[1];
    if (title && group) out[m[1]] = { title: title.replace(/&amp;/g, '&'), group: group.replace(/&amp;/g, '&') };
  }
  return out;
}

export interface HowtoSection {
  heading: string;
  pages: { id: string; title: string; questions: HowtoQ[] }[];
}

/** The index in reading order: the views first, then Settings group by group. Pages keep howto.json's order. */
export function howtoSections(data: HowtoData, titles: Record<string, PageTitle>): HowtoSection[] {
  const views: HowtoSection = { heading: VIEWS_HEADING, pages: [] };
  for (const id of Object.keys(VIEW_TITLES)) if (data[id]?.length) views.pages.push({ id, title: VIEW_TITLES[id], questions: data[id] });
  const groups = new Map<string, HowtoSection>(GROUP_ORDER.map((g) => [g, { heading: g, pages: [] }]));
  for (const [id, questions] of Object.entries(data)) {
    if (id in VIEW_TITLES || !questions.length) continue;
    const t = titles[id];
    if (!t) throw new Error(`howto.json: "${id}" is neither a view nor a Settings page in index.html`);
    if (!groups.has(t.group)) groups.set(t.group, { heading: t.group, pages: [] });
    groups.get(t.group)!.pages.push({ id, title: t.title, questions });
  }
  return [views, ...groups.values()].filter((s) => s.pages.length);
}

/** Every question id, as the guide anchors them (`howto-<page>-<question>`). */
export const howtoAnchor = (page: string, q?: string) => `howto-${page}${q ? `-${q}` : ''}`;

/** The guide's index: an h3 per group, an h4 per page, each question a folded <details> with its steps. */
export function howtoIndexHtml(data: HowtoData, titles: Record<string, PageTitle>): string {
  let h = '';
  for (const s of howtoSections(data, titles)) {
    h += `<h3>${esc(s.heading)}</h3>\n`;
    for (const p of s.pages) {
      h += `<h4 id="${howtoAnchor(p.id)}">${esc(p.title)}</h4>\n`;
      for (const q of p.questions) {
        h += `<details class="howto-q" id="${howtoAnchor(p.id, q.id)}"><summary>${esc(q.q)}</summary><ol>${q.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></details>\n`;
      }
    }
  }
  return h;
}

/** The guide with its index replaced (or the same text when it already matches). */
export function withHowtoIndex(html: string, data: HowtoData, titles: Record<string, PageTitle>): string {
  const a = html.indexOf(HOWTO_START);
  const b = html.indexOf(HOWTO_END);
  if (a < 0 || b < a) throw new Error('help.html has no howto markers');
  return `${html.slice(0, a + HOWTO_START.length)}\n${howtoIndexHtml(data, titles)}${html.slice(b)}`;
}

/** docs/HOW_DO_I.md: the same index as a page of the docs site (and readable on GitHub). */
export function howtoIndexMd(data: HowtoData, titles: Record<string, PageTitle>): string {
  const sections = howtoSections(data, titles);
  const count = sections.reduce((n, s) => n + s.pages.reduce((m, p) => m + p.questions.length, 0), 0);
  let md = '# How do I…?\n\n';
  md += `<!-- Generated from web/howto.json by node scripts/gen-guide.ts. Edit howto.json, not this file. -->\n\n`;
  md += `Every page of the app has a **How do I…?** box at the top with short, step-by-step answers. These are all ${count} of\n`;
  md += 'them in one place. In the app, open the box and press **Show me** to see the control it talks about. New here? Start with\n';
  md += '[Start here](START_HERE.md); writing code with her? [For coders](FOR_CODERS.md).\n\n';
  for (const s of sections) {
    md += `## ${s.heading === VIEWS_HEADING ? s.heading : `Settings → ${s.heading}`}\n\n`;
    for (const p of s.pages) {
      md += `### ${p.title}\n\n`;
      for (const q of p.questions) {
        md += `**${q.q}**\n\n${q.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n`;
      }
    }
  }
  return md;
}
