// R8 (docs/FAMILY.md): school mail for the inbox helper (N3). A school, district, PTA or teacher sender
// (or a school newsletter) is read line by line for the dates parents need: early release, no school,
// picture day, field trips, events, and permission slips with their due date. Each becomes a `school`
// finding (one suggestion card each); accepting adds it to the person's "School" list with a
// reminder, and a permission slip becomes a task with the attached form kept in the Library.
// Rules only, no model, no network; email text is data and never followed.
import { findDate, htmlText, senderDomain, senderName, type Finding, type InboxMail } from './classify.ts';

export type SchoolType = 'early_release' | 'no_school' | 'picture_day' | 'field_trip' | 'permission_slip' | 'event';

const SCHOOL_LABEL = /^(?:[a-z0-9]+-)*(?:[a-z0-9]*(?:schools?|district|academy|elementary)|[a-z]{2,12}(?:isd|usd|cisd)|pta|pto|k12)(?:-[a-z0-9]+)*$/;
const SCHOOL_SERVICE = /(^|\.)(parentsquare|schoolmessenger|classdojo|bloomz|konstella)\.(com|net|org)$/;
const schoolDomain = (d: string) => SCHOOL_SERVICE.test(d) || d.split('.').slice(0, -1).some((l) => SCHOOL_LABEL.test(l));
const SCHOOL_NAME = /\b(school|elementary|middle|high school|academy|district|isd|pta|pto|principal|teacher|classroom|mrs?\.|ms\.|room \d+|grade)\b/i;
const SCHOOL_SUBJECT = /\b(newsletter|weekly update|week ahead|class news|classroom news|school news|from the principal|reminders?|upcoming|calendar|field trip|picture day|permission slip|early release|no school)\b/i;

const TYPES: [SchoolType, RegExp, string][] = [
  ['permission_slip', /\b(permission slip|permission form|consent form|signed form)s?\b/i, 'Permission slip'],
  ['early_release', /\b(early (release|dismissal)|half[- ]day|minimum day|dismiss(ed|al) at \d)/i, 'Early release'],
  ['no_school', /\b(no school|school (is )?closed|no classes|teacher (work|in-?service|planning) day|professional development day|student holiday|winter break|spring break|thanksgiving break)\b/i, 'No school'],
  ['picture_day', /\b(picture day|photo day|school (pictures|photos)|retake day)\b/i, 'Picture day'],
  ['field_trip', /\b(field trip)s?\b/i, 'Field trip'],
  ['event', /\b(concert|book fair|conferences?|open house|science fair|spirit day|pajama day|class party|performance|assembly|fun run|back to school night|curriculum night|bake sale)\b/i, ''],
];

/** True when the mail comes from a school (or is a school newsletter). */
export function isSchoolMail(m: Pick<InboxMail, 'from' | 'subject'>, text: string): boolean {
  const domain = senderDomain(m.from);
  if (schoolDomain(domain) || (/\.edu$/.test(domain) && /\b(k-?12|elementary|middle|high)\b/i.test(text))) return true;
  return SCHOOL_NAME.test(senderName(m.from)) && (SCHOOL_SUBJECT.test(m.subject) || TYPES.some(([, re]) => re.test(text)));
}

/** A date on one line: the usual formats, or a bare "11/20" (this year, or next if it passed). */
function lineDate(line: string, now: Date): { day: string; time?: string } | undefined {
  const d = findDate(line, now);
  if (d) return d;
  const m = /\b(\d{1,2})\/(\d{1,2})\b(?!\/)/.exec(line);
  if (!m) return undefined;
  const mo = Number(m[1]);
  const day = Number(m[2]);
  if (!(mo >= 1 && mo <= 12 && day >= 1 && day <= 31)) return undefined;
  let y = now.getUTCFullYear();
  if (Date.UTC(y, mo - 1, day) < now.getTime() - 31 * 86_400_000) y++;
  return { day: `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
}

const clip = (s: string, n: number): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** The school dates in one mail (at most 8), or none when it isn't school mail. */
export function schoolFindings(m: InboxMail, now: Date): Finding[] {
  const text = m.text?.trim() ? m.text : htmlText(m.html ?? '');
  if (!isSchoolMail(m, `${m.subject}\n${text}`)) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  const domain = senderDomain(m.from);
  const lines = `${m.subject}\n${text}`.split(/\n|(?<=[.!?])\s+(?=[A-Z*•-])/).map((l) => l.replace(/^[\s*•\-–]+/, '').trim()).filter((l) => l.length > 3).slice(0, 400);
  for (const line of lines) {
    const hit = TYPES.find(([, re]) => re.test(line));
    if (!hit) continue;
    const [type, , label] = hit;
    const when = lineDate(line, now);
    if (!when) continue;
    // The title: the kind, with its own short detail ("Field trip to the Science Museum",
    // "Permission slip for the field trip", "Book fair"); the date and time are shown on their own.
    const detail = (re: RegExp) => clip(re.exec(line)?.[1] ?? '', 50).replace(/[.!;:,]+$/, '');
    const TRIP_TO = /field trips? (to (?:the )?[^,.;!(]{3,45}?)(?=\s+(?:on|this|next)\b|[,.;!(]|$)/i;
    const SLIP_FOR = /(?:permission slips?|consent forms?|permission forms?) (for (?:the )?[^,.;!(]{3,45}?)(?=\s+(?:are|is)\b|\s+due\b|[,.;!(]|$)/i;
    const more = type === 'field_trip' ? detail(TRIP_TO) : type === 'permission_slip' ? detail(SLIP_FOR) : '';
    const title = type === 'event' ? (TYPES.find(([t]) => t === 'event')![1].exec(line)?.[0] ?? 'School event').replace(/^./, (c) => c.toUpperCase()) : more ? `${label} ${more}` : label;
    const due = type === 'permission_slip' ? when.day : undefined;
    const ref = `${domain}|${type}|${when.day}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ kind: 'school', source: 'rules', ref, school: type, title, start: when.time ? `${when.day}T${when.time}` : when.day, ...(due ? { due } : {}) });
    if (out.length >= 8) break;
  }
  return out;
}
