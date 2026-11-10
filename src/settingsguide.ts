// Phase 41: "Ask Sara" about her own settings. She answers from the same text the app shows: the
// ? tips (web/tips.json and every data-tip in web/index.html, with the label they sit on), the
// page summaries, the personality and relationship dials (traits.ts), the model jobs
// (modelpicks.ts) and the guide (web/help.html). Each answer carries a link that opens the right
// page in the app (/#view=settings:<page>), a tour (/#tour=<name>) or the guide (/help#<section>).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { everydayMatches } from '../web/everyday-words.js';
import { JOBS } from './modelpicks.ts';
import { QUIET_FOCUS, TRAITS } from './traits.ts';
import type { Tool } from './tools/types.ts';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');

export interface GuideEntry {
  /** What it is, e.g. "Jealousy (Settings → Her → Relationship)". */
  title: string;
  text: string;
  /** In-app link (/#view=…, /#tour=…) or the guide (/help#…). */
  link: string;
  /** The page or window it's on, for the link's words ("Open Relationship"). */
  place?: string;
  /** Words for matching (title words count double). */
  words: string[];
}

const STOP = new Set('a an and are as at be but by can do does for from how i if in is it its me my of on or she so that the their them then there they this to was what when where which who why will with you your yours her his him he use using should could would want get set make about into than more most some any not'.split(' '));
/** Lowercase word stems: plural and -ing/-ed endings dropped so "pictures" finds "picture". */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1') || w);
}

const strip = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<button[^>]*class="tip"[^>]*>\?<\/button>/g, '')
    .replace(/<(script|style|svg)[\s\S]*?<\/\1>/g, '')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const unq = (s: string): string => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

/** Windows (dialogs) that hold settings outside the Settings window, and how to open them. */
const DIALOG_VIEW: Record<string, { name: string; link: string }> = {
  team: { name: 'Team', link: '/#view=team' },
  planner: { name: 'Planner', link: '/#view=planner' },
  memory: { name: 'Memory', link: '/#view=memory' },
  'sara-dialog': { name: 'her page', link: '/#view=her' },
  'conv-settings': { name: 'the conversation settings (the button at the top of a chat)', link: '' },
  setup: { name: 'first-time setup', link: '' },
};

const TOURS: { name: string; title: string; about: string }[] = [
  { name: 'first', title: 'Tour: getting around', about: 'where everything is: chat, today, planner, memory, her page, team, settings, help' },
  { name: 'studio', title: 'Tour: shape her personality', about: 'personality studio starting points dials her life try it create your companion character' },
  { name: 'models', title: 'Tour: a model for each job', about: 'which model does what, models per job, recommended models, default model, subscriptions, providers' },
  { name: 'team', title: 'Tour: the team', about: 'team helpers bigger jobs plan build test review pull request github issue' },
];

/** Builds the guide from the app's own files (cached). */
let cache: GuideEntry[] | undefined;
export function guideEntries(webDir = WEB): GuideEntry[] {
  if (cache && webDir === WEB) return cache;
  const out: GuideEntry[] = [];
  const add = (title: string, text: string, link: string, extra = '', place?: string) => out.push({ title, text, link, place, words: [...words(title), ...words(title), ...words(`${text} ${extra}`)] });
  const html = readFileSync(join(webDir, 'index.html'), 'utf8');
  const tips = JSON.parse(readFileSync(join(webDir, 'tips.json'), 'utf8')) as { tips: Record<string, [string, string]>; pages: Record<string, [string, string]> };

  // Settings pages, their summaries, and every setting on them.
  const where = new Map<number, { page: string; title: string; name: string; group: string; end: number }>();
  for (const m of html.matchAll(/<section class="settings-page" data-page="([^"]+)" data-group="([^"]+)" data-title="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    const [, page, group, title, body] = m;
    const pageTitle = `${unq(title)} (Settings → ${unq(group)})`;
    where.set(m.index!, { page, title: pageTitle, name: unq(title), group, end: m.index! + m[0].length });
    const sum = tips.pages[page]?.[0] ?? '';
    // The summary and the page's own opening text (its steps, e.g. "message @BotFather").
    const intro = strip(body).slice(0, 420);
    add(pageTitle, sum ? `${sum} On the page: ${intro}` : intro, `/#view=settings:${page}`, strip(body).slice(420, 900), unq(title));
  }
  const pageAt = (i: number) => {
    for (const [start, p] of where) if (i >= start && i < p.end) return p;
    return undefined;
  };
  const dialogAt = (i: number) => {
    const open = html.lastIndexOf('<dialog id="', i);
    if (open < 0 || html.lastIndexOf('</dialog>', i) > open) return undefined;
    return /<dialog id="([\w-]+)"/.exec(html.slice(open))?.[1];
  };
  const placeOf = (i: number): { where: string; link: string; name: string } | undefined => {
    const p = pageAt(i);
    if (p) return { where: p.title, link: `/#view=settings:${p.page}`, name: p.name };
    const d = dialogAt(i);
    if (d && DIALOG_VIEW[d]) return { where: DIALOG_VIEW[d].name, link: DIALOG_VIEW[d].link, name: DIALOG_VIEW[d].name };
    return undefined;
  };
  /** The words of the label a control or a tip sits in (or the heading it follows). */
  const labelAt = (i: number): string => {
    const tidy = (h: string) => {
      // A comment cut by the slice: drop its tail (or its start).
      const end = h.indexOf('-->');
      if (end >= 0 && (h.indexOf('<!--') < 0 || h.indexOf('<!--') > end)) h = h.slice(end + 3);
      // A tag cut at the start of the slice: drop its tail.
      const gt = h.indexOf('>');
      if (gt >= 0 && (h.indexOf('<') < 0 || h.indexOf('<') > gt)) h = h.slice(gt + 1);
      return h.replace(/<!--[\s\S]*?(-->|$)/g, ' ').replace(/<(select|textarea)[\s\S]*?(<\/\1>|$)/g, ' ').replace(/<[^>]*$/, '');
    };
    const before = tidy(html.slice(Math.max(0, i - 600), i));
    const after = tidy(html.slice(i, i + 300));
    const ls = before.lastIndexOf('<label');
    const le = before.lastIndexOf('</label>');
    const end = after.indexOf('</label>');
    if (ls > le) return strip(before.slice(ls) + (end >= 0 ? after.slice(0, end + 8) : '')).slice(0, 80);
    const h = /<(h3|summary|strong)[^>]*>([^]*?)$/.exec(before);
    if (h) return strip(h[2]).slice(0, 80);
    return strip(tidy(before.slice(-160))).split(' ').slice(-6).join(' ');
  };
  // Tips written into the page.
  for (const m of html.matchAll(/<button type="button" class="tip" data-tip="([^"]+)"/g)) {
    const at = placeOf(m.index!);
    if (!at) continue;
    const label = labelAt(m.index!) || 'This setting';
    add(`${label} (${at.where})`, unq(m[1]), at.link, '', at.name);
  }
  // Tips from tips.json, at their control.
  for (const [id, [text, guide]] of Object.entries(tips.tips)) {
    const at0 = html.indexOf(`id="${id}"`);
    if (at0 < 0) continue;
    const i = html.lastIndexOf('<', at0); // the start of the control's tag
    const at = placeOf(i);
    const label = labelAt(i) || id;
    add(`${label} (${at?.where ?? 'the app'})`, text, at?.link || `/help#${guide}`, '', at?.link ? at.name : undefined);
  }
  // Dials: personality (Name and personality page) and relationship (Relationship page).
  for (const t of TRAITS) {
    const page = t.group === 'Together' ? 'her-relationship' : 'her-character';
    const pageName = t.group === 'Together' ? 'Relationship (Settings → Her)' : t.group === 'Work' ? 'At work, coding conversations only (Settings → Her → Name and personality)' : 'Personality studio (Settings → Her → Name and personality)';
    add(`${t.label} dial (${pageName})`, `${t.tip} The slider runs from "${t.low}" to "${t.high}"; the middle is balanced. Low: ${t.examples[0]} Middle: ${t.examples[1]} High: ${t.examples[2]}`, `/#view=settings:${page}`, t.id, t.group === 'Together' ? 'Relationship' : 'Name and personality');
  }
  // Phase 51: the "Quiet when I'm focused" switch, next to the work dials.
  add(`${QUIET_FOCUS.label} switch (At work, Settings → Her → Name and personality)`, QUIET_FOCUS.tip, '/#view=settings:her-character', 'quiet focused work mode', 'Name and personality');
  // Model jobs.
  for (const j of JOBS) add(`${j.label}: the model for this job (Settings → Models → Which model does what)`, j.tip, '/#view=settings:models-routes', `${j.id} model job`, 'Which model does what');
  // The guide, one entry per section.
  const help = readFileSync(join(webDir, 'help.html'), 'utf8');
  const parts = [...help.matchAll(/<h2 id="([\w-]+)">([^<]+)<\/h2>([\s\S]*?)(?=<h2 id=|<\/main>|$)/g)];
  for (const [, id, title, body] of parts) add(`${unq(title)} (the guide)`, strip(body).slice(0, 700), `/help#${id}`, strip(body).slice(700, 2000));
  // Tours.
  for (const t of TOURS) add(t.title, `A short guided tour of ${t.about}.`, `/#tour=${t.name}`, `${t.about} tour show me around walk me through`);
  // One entry per title and link (two fields in one row share a label): their texts join.
  const merged = new Map<string, GuideEntry>();
  for (const e of out) {
    const key = `${e.title}|${e.link}`;
    const m = merged.get(key);
    if (!m) merged.set(key, e);
    else if (!m.text.includes(e.text)) {
      m.text = `${m.text} ${e.text}`;
      m.words.push(...words(e.text));
    }
  }
  const list = [...merged.values()];
  if (webDir === WEB) cache = list;
  return list;
}

/** The best matches for a question: word overlap, rarer words weigh more. */
export function searchGuide(question: string, k = 5, entries = guideEntries()): GuideEntry[] {
  const q = [...new Set(words(question))];
  if (!q.length) return [];
  // 3.3.0 (ezplain): everyday words ("bigger text", "delete a chat", "how much does this cost") answer
  // with the right place first, from the same list as the Settings search (web/everyday-words.js).
  const plain: GuideEntry[] = everydayMatches(question).slice(0, 2).map((e) => ({ title: e.title, text: e.how, link: e.page ? `/#view=settings:${e.page}` : '', ...(e.page ? { place: e.title.replace(/ \(.*$/, '') } : {}), words: [] }));
  if (plain.length) return [...plain, ...rankGuide(q, question, k, entries).filter((h) => !plain.some((p) => p.link && p.link === h.link))].slice(0, k);
  return rankGuide(q, question, k, entries);
}

function rankGuide(q: string[], question: string, k: number, entries: GuideEntry[]): GuideEntry[] {
  // Adult mode isn't advertised: it only comes up when they ask about it.
  if (!/\b(adult|18|explicit|nsfw|sexual|spicy|intima)/i.test(question)) entries = entries.filter((e) => !/adult|18 or older/i.test(e.title) && !e.link.includes('you-adult'));
  const df = new Map<string, number>();
  for (const e of entries) for (const w of new Set(e.words)) df.set(w, (df.get(w) ?? 0) + 1);
  const n = entries.length;
  const scored = entries.map((e) => {
    const tf = new Map<string, number>();
    for (const w of e.words) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      s += Math.log(1 + n / (df.get(w) ?? 1)) * (1 + Math.log(f));
    }
    return { e, s: s / Math.sqrt(1 + e.words.length / 40) };
  });
  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.e);
}

/** The words on a link: "Open Relationship", "Start the tour", "Read the guide". */
function linkText(h: GuideEntry): string {
  if (h.link.startsWith('/#tour=')) return 'Start the tour';
  if (h.link.startsWith('/help')) return 'Read the guide';
  return h.place ? `Open ${h.place.replace(/^the /, '')}` : 'Open it';
}

export function formatGuide(hits: GuideEntry[]): string {
  if (!hits.length) return 'Nothing in the settings guide matches that. Answer from what you know, or point to the guide: [the guide](/help).';
  return [
    'From your settings guide (answer in your own words, briefly; include the most useful link as a markdown link so they can open it):',
    ...hits.map((h) => (h.link ? `- ${h.title}: ${h.text}\n  Link: [${linkText(h)}](${h.link})` : `- ${h.title}: ${h.text}`)),
  ].join('\n');
}

export function createSettingsGuideTool(): Tool {
  return {
    defaultPermission: 'auto',
    spec: {
      name: 'settings_guide',
      description:
        "Look up how this app (you, the companion app) works: what a setting or dial does and how to tune it, where to find something, which model to use for a job, how to set up voice, calls, phone, backups, the team, or a guided tour of the app for someone new. Use it whenever they ask about your settings or the app (e.g. 'what does jealousy do?', 'which model should I use for pictures?', 'how do I connect Telegram?', 'show me around'). Answers include markdown links that open the right page or a short tour: copy them exactly.",
      parameters: { type: 'object', properties: { question: { type: 'string', description: 'Their question, in their words.' } }, required: ['question'] },
    },
    summarize: (a) => `Settings guide: ${String(a.question ?? '').slice(0, 100)}`,
    async run(args) {
      return formatGuide(searchGuide(String(args.question ?? ''), 5));
    },
  };
}
