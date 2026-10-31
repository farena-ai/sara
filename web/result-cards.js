// Phase 75 (stage 1): result cards in the chat, drawn from the structured `card` the server builds
// from a tool's real result (src/cards.ts): never from her reply text. Weather, to-dos, reminders,
// notes, calendar events, files changed, test runs and background tasks, smart-home actions,
// pictures and web searches. Every value goes in as text (no HTML), links only to http(s).
import { t } from './naming.js';
import { icon } from './icons.js';
import { kindFromSky, sparkline, weatherArt } from './viz.js';
import { gmailResult } from './gmail-view.js';
import { pluginResultCard } from './plugins.js';
import { checkupCard, checkupChangeCard } from './checkup-view.js';

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  return e;
};

/** A card's frame: a line icon (web/icons.js) or a picture (the weather art) beside its title. */
function shell(kind, iconName, title, tone = '') {
  const card = el('div', `rcard rcard-${kind}${tone ? ` ${tone}` : ''}`);
  card.setAttribute('role', 'group');
  const head = el('div', 'rcard-head');
  const ic = el('span', 'rcard-icon');
  ic.setAttribute('aria-hidden', 'true');
  const svg = typeof iconName === 'string' ? icon(iconName) : null;
  if (svg) ic.append(svg);
  if (svg) head.append(ic);
  head.append(el('span', 'rcard-title', title));
  card.append(head);
  card.setAttribute('aria-label', title);
  return card;
}

const plannerLink = () => {
  const a = el('a', 'rcard-link', t('Open the Planner'));
  a.href = '/#view=planner';
  return a;
};

const REPEAT = () => ({ daily: t('every day'), weekdays: t('on weekdays'), weekly: t('every week'), monthly: t('every month') });

// wttr.in's one-line formats give only a symbol for the sky: say it in words too.
const SKY = () => [[/☀|🌞/u, t('Sunny')], [/🌤|⛅|🌥/u, t('Partly cloudy')], [/⛈|🌩/u, t('Thunderstorms')], [/🌦|🌧|☔/u, t('Rain')], [/🌨|❄|☃/u, t('Snow')], [/🌫/u, t('Fog')], [/☁/u, t('Cloudy')]];
const skyWords = (icon) => SKY().find(([re]) => re.test(icon ?? ''))?.[1] ?? '';

// 2.8: the sky as a small illustration (wttr.in's symbol or its words → a weather kind → web/viz.js),
// by day unless wttr.in drew a moon: the picture follows the data, never the clock.
function weather(c) {
  const card = shell('weather', 'weather', c.place || t('Weather'));
  const main = el('div', 'rc-weather-main');
  const kind = kindFromSky(c.icon, c.condition);
  const art = weatherArt(kind, !/🌙|🌑|🌕/u.test(c.icon ?? ''));
  main.append(art, el('span', 'rc-temp', c.temp ?? ''), el('span', 'rc-cond', c.condition || skyWords(c.icon)));
  card.append(main);
  const chips = el('div', 'rc-chips');
  if (c.feels) chips.append(el('span', 'rc-chip', t('Feels like {temp}', { temp: c.feels })));
  if (c.wind) chips.append(el('span', 'rc-chip', t('Wind {wind}', { wind: c.wind })));
  if (c.humidity) chips.append(el('span', 'rc-chip', t('Humidity {humidity}', { humidity: c.humidity })));
  if (chips.childElementCount) card.append(chips);
  if (Array.isArray(c.days) && c.days.length) {
    const days = el('div', 'rc-days');
    for (const d of c.days.slice(0, 3)) {
      const day = el('div', 'rc-day');
      let label = d.date;
      try {
        label = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
      } catch {
        /* keep the date */
      }
      day.append(el('span', 'rc-day-name', label), el('span', 'rc-day-range', [d.max, d.min].filter(Boolean).join(' / ')));
      days.append(day);
    }
    card.append(days);
    // The highs of the next days as a tiny line (only real numbers from the result).
    const spark = sparkline(c.days.slice(0, 3).map((d) => Number.parseFloat(String(d.max ?? '').replace(/[^\d.-]/g, ''))), { w: 120, h: 22, cls: 'rc-spark' });
    if (spark) card.append(spark);
  }
  card.append(el('p', 'rc-source', t('From wttr.in')));
  return card;
}

function task(c) {
  const title = { added: t('To-do added'), done: t('To-do done'), reopened: t('To-do reopened'), updated: t('To-do changed'), deleted: t('To-do deleted') }[c.action] ?? t('To-do');
  const card = shell('task', c.action === 'done' ? 'check' : 'todo', title, c.action === 'done' ? 'ok' : '');
  const line = el('p', `rc-main${c.action === 'done' || c.action === 'deleted' ? ' struck' : ''}`, c.title);
  card.append(line);
  const meta = [c.due ? t('Due {when}', { when: c.due }) : '', c.project ? t('Project: {name}', { name: c.project }) : '', c.priority === 'high' ? t('High priority') : ''].filter(Boolean);
  if (meta.length) card.append(el('p', 'rc-meta', meta.join(' · ')));
  if (c.action !== 'deleted') card.append(plannerLink());
  return card;
}

function reminder(c) {
  const card = shell('reminder', c.call ? 'phone' : 'reminder', c.action === 'cancelled' ? t('Reminder cancelled') : t('Reminder set'));
  card.append(el('p', `rc-main${c.action === 'cancelled' ? ' struck' : ''}`, c.text));
  const when = c.place ? (c.when === 'leave' ? t('When you leave {place}', { place: c.place }) : t('When you get to {place}', { place: c.place })) : c.when ?? '';
  const meta = [when, c.repeat ? REPEAT()[c.repeat] ?? c.repeat : '', c.call ? t('She will call you') : ''].filter(Boolean);
  if (meta.length && c.action !== 'cancelled') card.append(el('p', 'rc-meta', meta.join(' · ')));
  if (c.action !== 'cancelled') card.append(plannerLink());
  return card;
}

function note(c) {
  const card = shell('note', 'note', c.action === 'deleted' ? t('Note deleted') : t('Note saved'));
  card.append(el('p', `rc-main${c.action === 'deleted' ? ' struck' : ''}`, c.title));
  if (c.project) card.append(el('p', 'rc-meta', t('Project: {name}', { name: c.project })));
  if (c.action !== 'deleted') card.append(plannerLink());
  return card;
}

function calendar(c) {
  const card = shell('calendar', 'calendar', c.action === 'added' ? t('Added to your calendar') : t('Your calendar'));
  if (!c.events?.length) {
    card.append(el('p', 'rc-meta', t('Nothing on the calendar then.')));
    return card;
  }
  const ul = el('ul', 'rc-list');
  for (const e of c.events.slice(0, 8)) {
    const li = el('li', 'rc-event');
    li.append(el('span', 'rc-when', e.when), el('span', 'rc-what', e.title));
    if (e.location) li.append(el('span', 'rc-where', e.location));
    ul.append(li);
  }
  card.append(ul);
  return card;
}

/** Every file she wrote or edited in one reply, as one card ("Files changed: 3"). */
function files(list) {
  const unique = [...new Map(list.map((c) => [c.path, c])).values()];
  const card = shell('files', 'files', t('Files changed: {n}', { n: unique.length }));
  const ul = el('ul', 'rc-list rc-files');
  for (const f of unique.slice(0, 12)) {
    const li = el('li', 'rc-file');
    li.append(el('code', 'rc-path', f.path), el('span', `rc-tag ${f.action}`, f.action === 'edited' ? t('edited') : t('written')));
    ul.append(li);
  }
  if (unique.length > 12) ul.append(el('li', 'rc-meta', t('+{n} more', { n: unique.length - 12 })));
  card.append(ul);
  return card;
}

function test(c) {
  const ok = c.ok && !c.failed;
  const card = shell('test', ok ? 'flask' : 'warn', ok ? t('Tests passed') : t('Tests failed'), ok ? 'ok' : 'bad');
  const nums = el('div', 'rc-chips');
  if (c.passed !== undefined) nums.append(el('span', 'rc-chip ok', t('Passed: {n}', { n: c.passed })));
  if (c.failed) nums.append(el('span', 'rc-chip bad', t('Failed: {n}', { n: c.failed })));
  if (c.skipped) nums.append(el('span', 'rc-chip', t('Skipped: {n}', { n: c.skipped })));
  if (c.exitCode !== null && c.exitCode !== 0) nums.append(el('span', 'rc-chip', t('Exit code {code}', { code: c.exitCode })));
  if (nums.childElementCount) card.append(nums);
  card.append(el('code', 'rc-cmd', c.command));
  return card;
}

function job(c) {
  const done = c.status === 'ok';
  const failed = c.status === 'error' || (c.exitCode !== undefined && c.exitCode !== 0);
  const title = c.status === 'running' ? t('Background task running') : done ? t('Background task finished') : failed ? t('Background task failed') : t('Background task: {status}', { status: c.status });
  const card = shell('job', 'job', title, done ? 'ok' : failed ? 'bad' : '');
  card.append(el('p', 'rc-main', `#${c.id} · ${c.label}`));
  return card;
}

function home(c) {
  const card = shell('home', 'home', t('Smart home'));
  card.append(el('p', 'rc-main', c.name || c.entity));
  if (c.state) card.append(el('p', 'rc-meta', t('Now: {state}', { state: c.state })));
  return card;
}

function photo(c) {
  const card = shell('photo', 'photo', c.caption ? t('New picture') : t('Picture sent'));
  if (c.caption) card.append(el('p', 'rc-meta', c.caption));
  return card;
}

function search(c) {
  const card = shell('search', 'search', t('Web search: {query}', { query: c.query }));
  const ul = el('ul', 'rc-list rc-sources');
  for (const r of c.results ?? []) {
    if (!/^https?:\/\//i.test(r.url)) continue;
    const li = el('li', 'rc-source-row');
    const a = el('a', 'rc-source-link', r.title || r.host);
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a, el('span', 'rc-host', r.host));
    ul.append(li);
  }
  card.append(ul);
  return card;
}

/** Phase 87: a page in the Sara browser on the owner's computer, with the step's small picture. */
function computer(c) {
  const title = c.action === 'look' ? t('Looked at a page on your computer') : c.action === 'navigate' ? t('Moved in the Sara browser') : t('Opened in the Sara browser');
  const card = shell('computer', 'monitor', title, c.problems ? 'bad' : '');
  card.append(el('p', 'rc-main', c.title || c.url));
  if (/^https?:\/\//i.test(c.url ?? '')) card.append(el('p', 'rc-url', c.url));
  if (c.computer) card.append(el('p', 'rc-meta', t('On {computer}', { computer: c.computer })));
  if (c.problems) card.append(el('p', 'rc-meta', t('Problems: {what}', { what: c.problems })));
  if (/^[0-9a-f]{64}$/.test(c.thumb ?? '')) {
    const img = el('img', 'rc-thumb');
    img.alt = t('Small picture of the page');
    img.loading = 'lazy';
    img.src = `/api/computer/thumb/${c.thumb}`;
    card.append(img);
  }
  return card;
}

/** Phase 87: no computer connected yet: how to let her use one (web-only users). */
function handsInstall(c) {
  const card = shell('hands-install', 'monitor', t('Let Sara use your computer'));
  card.append(el('p', 'rc-meta', t('Install the Sara app for Windows or Mac and switch on "Let Sara use this computer" in it. Phones can watch and stop her, but can\u2019t be driven.')));
  card.append(el('p', 'rc-meta', t('On a Linux desktop, run Sara hands in a visible terminal with Chrome or Chromium installed.')));
  card.append(el('code', 'rc-meta', 'sara hands --server https://sara.example.com'));
  if (/^https:\/\//i.test(c.url ?? '')) {
    const a = el('a', 'button-link', t('Download the Sara app'));
    a.href = c.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    card.append(a);
  }
  return card;
}

const DRAW = { weather, task, reminder, note, calendar, test, job, home, photo, search, gmail: gmailResult, computer, 'hands-install': handsInstall, checkup: checkupCard, 'checkup-change': checkupChangeCard, plugin: (c) => pluginResultCard(c) };

/** One element per card; the file cards of a reply become one "Files changed" card. */
export function renderCards(cards) {
  const out = [];
  const fileCards = cards.filter((c) => c?.kind === 'file');
  for (const c of cards) {
    if (!c || typeof c !== 'object') continue;
    if (c.kind === 'file') {
      if (c === fileCards[0]) out.push(files(fileCards));
      continue;
    }
    const draw = DRAW[c.kind];
    if (draw) out.push(draw(c));
  }
  return out;
}

/** A single card (live, as each result arrives). Files are drawn one by one until the reply is redrawn. */
export const renderCard = (c) => renderCards([c])[0] ?? null;
