// E6 (docs/BUSINESS_TOOLS.md): meeting notes (pasted, or a document in the Library) to action items
// with owners and dates. Meeting rooms and recordings already get their notes and action items in
// src/meetings.ts (EC19); this covers notes typed or shared as text. Code finds the plain patterns
// ("Action: …", "- [ ] …", "Dana will send the deck by Friday", "@sam to book the room"); the model
// may add items it reads, each kept only with a quote that is really in the notes. Planner to-dos
// are made only when asked (create_tasks), each once.
import { parseWhen } from '../planner.ts';

export interface ActionItemOut {
  task: string;
  owner: string;
  due: string;
  quote: string;
  dueAt?: string | null;
}

const DUE = /\b(?:by|before|due|until|no later than)\s+((?:the\s+)?(?:end of (?:the )?(?:day|week|month)|eod|eow|tomorrow|today|tonight|next (?:week|month|monday|tuesday|wednesday|thursday|friday)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2}))/i;
const VERB = /^(?:@?([A-Z][\p{L}'-]+(?: [A-Z][\p{L}'-]+)?|@[\w.-]+|I|We|You))\s+(?:will|to|should|needs to|need to|is going to|are going to|agreed to|has to|must|'ll)\s+(.+)$/u;
const PREFIX = /^(?:[-*•]\s*)?(?:\[ \]\s*|action(?: item)?s?\s*[:\-–]\s*|todo\s*[:\-–]\s*|ai\s*[:\-–]\s*|next steps?\s*[:\-–]\s*|follow[- ]up\s*[:\-–]\s*)/i;
const NOT_PEOPLE = new Set(['The', 'This', 'That', 'It', 'There', 'Then', 'If', 'When', 'Everyone', 'Nobody', 'Someone', 'Notes', 'Meeting', 'Agenda']);

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();

/** The plain patterns, line by line (each with its exact line as the quote). */
export function findActionItems(text: string): ActionItemOut[] {
  const out: ActionItemOut[] = [];
  for (const raw of text.split(/\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 400) continue;
    const prefixed = PREFIX.test(line);
    const body = line.replace(PREFIX, '').replace(/^[-*•]\s*/, '').trim();
    // "Owner: task" after a prefix, e.g. "Action: Dana — send the deck by Friday".
    let owner = '';
    let task = body;
    const v = VERB.exec(body);
    if (v && !NOT_PEOPLE.has(v[1])) {
      owner = v[1].replace(/^@/, '');
      task = v[2];
    } else {
      const named = /^@?([A-Z][\p{L}'-]+(?: [A-Z][\p{L}'-]+)?|@[\w.-]+)\s*[:—–-]\s+(.+)$/u.exec(body);
      const tagged = /(?:^|\s)@([\w.-]+)/.exec(body);
      if (named && prefixed && !NOT_PEOPLE.has(named[1])) {
        owner = named[1].replace(/^@/, '');
        task = named[2];
      } else if (tagged) owner = tagged[1];
      else if (!prefixed) continue;
    }
    if (/^(I|We)$/.test(owner)) owner = owner === 'I' ? 'me' : 'us';
    if (owner === 'You') owner = 'you';
    const d = DUE.exec(task);
    const due = d ? clean(d[1]) : '';
    const t = clean(d ? task.slice(0, d.index) + task.slice(d.index + d[0].length) : task);
    if (t.length < 3) continue;
    out.push({ task: t.replace(/^\w/, (c) => c.toUpperCase()), owner, due, quote: line });
  }
  return out.slice(0, 60);
}

/** A due phrase as a time (5 PM local on a date-only day), relative to the meeting day. */
export function dueAtOf(due: string, now: Date, timeZone?: string): string | null {
  if (!due) return null;
  const today = now.toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const pad = (n: number) => String(n).padStart(2, '0');
  const md = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/i.exec(due.trim());
  const num = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(due.trim());
  let day: string | undefined;
  if (md) day = `${md[3] ?? year}-${pad(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(md[1].toLowerCase()) + 1)}-${pad(Number(md[2]))}`;
  else if (num) day = `${num[3] ? (Number(num[3]) < 100 ? 2000 + Number(num[3]) : Number(num[3])) : year}-${pad(Number(num[1]))}-${pad(Number(num[2]))}`;
  else if (/^next week$/i.test(due.trim())) day = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  // A day without a year that has already gone by this year means next year.
  if (day && (md || num) && !(md?.[3] || num?.[3]) && day < today) day = `${year + 1}${day.slice(4)}`;
  const phrase = (day ?? due)
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/^(?:eod|end of (?:the )?day)$/, 'today 5pm')
    .replace(/^(?:eow|end of (?:the )?week)$/, 'friday')
    .replace(/(\d)(st|nd|rd|th)\b/, '$1');
  return parseWhen(phrase, now, timeZone, { dateOnlyHour: 17 })?.toISOString() ?? null;
}
