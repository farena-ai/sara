// M1: Sara's plain search words (the Gmail subset the model already writes) read once into terms,
// then turned into what each provider understands: Microsoft Graph ($filter / $search KQL) and IMAP
// SEARCH. Words a provider can't do are refused with a plain sentence, never silently dropped.
// Pure (no I/O). Dates are the owner's time zone, like Gmail's (gmail-dates.ts).
import { gmailDates, midnightIn, ymdIn } from '../gmail-dates.ts';

export interface SearchTerms {
  from: string[];
  to: string[];
  subject: string[];
  words: string[];
  notFrom: string[];
  notWords: string[];
  unread?: boolean;
  flagged?: boolean;
  attachment?: boolean;
  important?: boolean;
  /** inbox, sent, trash, spam, archive, drafts, or a folder name. */
  folder?: string;
  /** A label / category / keyword. */
  label?: string;
  notLabel?: string;
  /** Epoch ms: received before (exclusive) / at or after (inclusive). */
  before?: number;
  after?: number;
  larger?: number;
  /** What the words were read as, for the card ("up to the end of Oct 1, 2026"). */
  dates?: string;
}

export class SearchWordsError extends Error {}

const FOLDERS: Record<string, string> = { inbox: 'inbox', sent: 'sent', trash: 'trash', bin: 'trash', deleted: 'trash', spam: 'spam', junk: 'spam', archive: 'archive', drafts: 'drafts', draft: 'drafts' };

/** Splits words, keeping "quoted phrases" and key:"quoted values" whole. */
export function tokens(q: string): string[] {
  const out: string[] = [];
  const re = /(-?[\w.]+:)?"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[3] ?? `${m[1] ?? ''}"${m[2]}"`);
  return out;
}
const unq = (s: string) => s.replace(/^"|"$/g, '');

const SIZE = (v: string) => {
  const m = /^(\d+(?:\.\d+)?)([kmg]?)b?$/i.exec(v);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g']);
};
const AGO = (v: string, now: Date) => {
  const m = /^(\d+)([dmy])$/i.exec(v);
  if (!m) return undefined;
  const d = new Date(now);
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'd') d.setTime(d.getTime() - n * 86_400_000);
  else if (u === 'm') d.setMonth(d.getMonth() - n);
  else d.setFullYear(d.getFullYear() - n);
  return d.getTime();
};
const DAY = (v: string, tz: string | undefined) => {
  if (/^\d{9,11}$/.test(v)) return Number(v) * 1000;
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(v);
  return m ? midnightIn({ y: +m[1], m: +m[2], d: +m[3] }, tz) * 1000 : undefined;
};

/** Reads search words (and plain date words) into terms. Unknown `key:` words are refused. */
export function parseSearch(query: string, opts: { dates?: string; tz?: string; now?: Date } = {}): SearchTerms {
  const now = opts.now ?? new Date();
  const t: SearchTerms = { from: [], to: [], subject: [], words: [], notFrom: [], notWords: [] };
  const later = (cur: number | undefined, v: number) => (cur === undefined ? v : Math.max(cur, v));
  const sooner = (cur: number | undefined, v: number) => (cur === undefined ? v : Math.min(cur, v));
  let q = query.trim();
  if (/[{}()]|\s(OR|AND)\s/.test(q)) throw new SearchWordsError('Groups and OR searches only work in Gmail. Split it into simpler searches (one sender at a time).');
  if (opts.dates?.trim()) {
    const d = gmailDates(opts.dates, opts.tz, now);
    if (!d) throw new SearchWordsError(`I couldn't read the dates "${opts.dates}".`);
    q = `${q} ${d.exact}`;
    t.dates = d.meaning;
  }
  for (const raw of tokens(q)) {
    const neg = raw.startsWith('-');
    const tok = neg ? raw.slice(1) : raw;
    const m = /^([a-z_]+):(.+)$/i.exec(tok);
    if (!m) {
      (neg ? t.notWords : t.words).push(unq(tok));
      continue;
    }
    const key = m[1].toLowerCase();
    const v = unq(m[2]);
    const lv = v.toLowerCase();
    if (key === 'from') (neg ? t.notFrom : t.from).push(v);
    else if (key === 'to' && !neg) t.to.push(v);
    else if (key === 'subject' && !neg) t.subject.push(v);
    else if (key === 'is' && (lv === 'unread' || lv === 'read')) t.unread = neg ? lv === 'read' : lv === 'unread';
    else if (key === 'is' && (lv === 'starred' || lv === 'flagged')) t.flagged = !neg;
    else if (key === 'is' && lv === 'important') t.important = !neg;
    else if (key === 'has' && lv === 'attachment') t.attachment = !neg;
    else if (key === 'in' && !neg) t.folder = FOLDERS[lv] ?? (lv === 'anywhere' ? undefined : v);
    else if ((key === 'label' || key === 'category') && FOLDERS[lv] && !neg) t.folder = FOLDERS[lv];
    else if (key === 'label' || key === 'category') {
      if (key === 'category' && /^(promotions|social|updates|forums|primary)$/.test(lv)) throw new SearchWordsError(`category:${lv} is a Gmail tab; this mailbox doesn't have it. Search by sender instead (from:…).`);
      if (neg) t.notLabel = v;
      else t.label = v;
    } else if ((key === 'before' || key === 'older') && !neg) {
      const d = DAY(v, opts.tz);
      if (d === undefined) throw new SearchWordsError(`"${tok}" isn't a date (use before:YYYY/MM/DD).`);
      t.before = sooner(t.before, d);
    } else if ((key === 'after' || key === 'newer') && !neg) {
      const d = DAY(v, opts.tz);
      if (d === undefined) throw new SearchWordsError(`"${tok}" isn't a date (use after:YYYY/MM/DD).`);
      t.after = later(t.after, d);
    } else if (key === 'older_than' && !neg) {
      const d = AGO(v, now);
      if (d === undefined) throw new SearchWordsError(`"${tok}" isn't a length of time (like older_than:6m).`);
      t.before = sooner(t.before, d);
    } else if (key === 'newer_than' && !neg) {
      const d = AGO(v, now);
      if (d === undefined) throw new SearchWordsError(`"${tok}" isn't a length of time (like newer_than:7d).`);
      t.after = later(t.after, d);
    } else if ((key === 'larger' || key === 'size') && !neg && SIZE(v)) t.larger = SIZE(v);
    else throw new SearchWordsError(`"${raw}" only works in Gmail. This mailbox understands from:, to:, subject:, is:unread, is:read, is:starred, has:attachment, in:inbox/sent/trash/spam/archive, label:, before:, after:, older_than:, newer_than:, larger: and plain words.`);
  }
  return t;
}

/** True when nothing narrows the search (organizing "everything" needs at least one word). */
export const emptyTerms = (t: SearchTerms): boolean =>
  !t.from.length && !t.to.length && !t.subject.length && !t.words.length && !t.notFrom.length && !t.notWords.length && t.unread === undefined && t.flagged === undefined && t.attachment === undefined && t.important === undefined && !t.folder && !t.label && !t.notLabel && t.before === undefined && t.after === undefined && t.larger === undefined;

// ---------- Microsoft Graph ----------

export interface GraphQuery {
  /** A well-known folder (inbox, archive, deleteditems, junkemail, sentitems, drafts) or a folder name to look up. */
  folder?: { wellKnown?: string; name?: string };
  filter?: string;
  search?: string;
  /** What $search can't combine with: checked on each message here. */
  client: (m: { receivedDateTime?: string; isRead?: boolean; flag?: { flagStatus?: string }; hasAttachments?: boolean; importance?: string; categories?: string[]; from?: { emailAddress?: { address?: string } } }) => boolean;
}

const WELL_KNOWN: Record<string, string> = { inbox: 'inbox', sent: 'sentitems', trash: 'deleteditems', spam: 'junkemail', archive: 'archive', drafts: 'drafts' };
const odataStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
const kqlStr = (s: string) => `"${s.replace(/["\\]/g, ' ').trim()}"`;

/**
 * Graph can't use $filter and $search in one call. With from/to/subject/words it is a $search
 * (KQL) and the rest is checked on each result; otherwise everything is one $filter.
 */
export function toGraph(t: SearchTerms): GraphQuery {
  if (t.larger !== undefined) throw new SearchWordsError('larger: only works in Gmail and IMAP mailboxes. Search by sender or date instead.');
  const folder = t.folder ? (WELL_KNOWN[t.folder] ? { wellKnown: WELL_KNOWN[t.folder] } : { name: t.folder }) : undefined;
  const kql: string[] = [
    ...t.from.map((v) => `from:${kqlStr(v)}`),
    ...t.to.map((v) => `to:${kqlStr(v)}`),
    ...t.subject.map((v) => `subject:${kqlStr(v)}`),
    ...t.words.map(kqlStr),
    ...t.notFrom.map((v) => `NOT from:${kqlStr(v)}`),
    ...t.notWords.map((v) => `NOT ${kqlStr(v)}`),
  ];
  const f: string[] = [];
  if (t.after !== undefined) f.push(`receivedDateTime ge ${new Date(t.after).toISOString()}`);
  if (t.before !== undefined) f.push(`receivedDateTime lt ${new Date(t.before).toISOString()}`);
  if (t.unread !== undefined) f.push(`isRead eq ${t.unread ? 'false' : 'true'}`);
  if (t.flagged !== undefined) f.push(t.flagged ? "flag/flagStatus eq 'flagged'" : "flag/flagStatus ne 'flagged'");
  if (t.attachment !== undefined) f.push(`hasAttachments eq ${t.attachment}`);
  if (t.important !== undefined) f.push(t.important ? "importance eq 'high'" : "importance ne 'high'");
  if (t.label) f.push(`categories/any(c:c eq ${odataStr(t.label)})`);
  if (t.notLabel) f.push(`not(categories/any(c:c eq ${odataStr(t.notLabel)}))`);
  const client: GraphQuery['client'] = (m) => {
    const at = Date.parse(m.receivedDateTime ?? '');
    if (t.after !== undefined && !(at >= t.after)) return false;
    if (t.before !== undefined && !(at < t.before)) return false;
    if (t.unread !== undefined && Boolean(!m.isRead) !== t.unread) return false;
    if (t.flagged !== undefined && (m.flag?.flagStatus === 'flagged') !== t.flagged) return false;
    if (t.attachment !== undefined && Boolean(m.hasAttachments) !== t.attachment) return false;
    if (t.important !== undefined && (m.importance === 'high') !== t.important) return false;
    const cats = (m.categories ?? []).map((c) => c.toLowerCase());
    if (t.label && !cats.includes(t.label.toLowerCase())) return false;
    if (t.notLabel && cats.includes(t.notLabel.toLowerCase())) return false;
    const from = (m.from?.emailAddress?.address ?? '').toLowerCase();
    if (t.notFrom.some((x) => from.includes(x.toLowerCase()))) return false;
    return true;
  };
  if (kql.length) return { ...(folder ? { folder } : {}), search: `"${kql.join(' ').replace(/"/g, '\\"')}"`, client };
  return { ...(folder ? { folder } : {}), ...(f.length ? { filter: f.join(' and ') } : {}), client };
}

// ---------- IMAP ----------

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** RFC 3501 date (the server compares dates only, in its own reading of the day). */
export const imapDate = (ms: number, tz: string | undefined): string => {
  const d = ymdIn(new Date(ms), tz);
  return `${d.d}-${MON[d.m - 1]}-${d.y}`;
};

/** An IMAP search string: an astring (quoted) or a non-synchronizing literal for 8-bit text. */
export function imapString(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`;
  const bytes = Buffer.from(s, 'utf8');
  // Sent as latin1 by the client: the UTF-8 bytes go through unchanged.
  return `{${bytes.length}+}\r\n${bytes.toString('latin1')}`;
}

/** UID SEARCH criteria (without "UID SEARCH") and the folder role or name to search in. */
export function toImap(t: SearchTerms, tz: string | undefined, keywords: boolean): { folder?: string; criteria: string; utf8: boolean } {
  if (t.important !== undefined) throw new SearchWordsError('is:important only works in Gmail and Outlook. Use is:starred, a sender or a date instead.');
  if ((t.label || t.notLabel) && !keywords) throw new SearchWordsError("This mail server has no labels. Use a folder instead (in:\"Folder name\").");
  const c: string[] = [];
  for (const v of t.from) c.push(`FROM ${imapString(v)}`);
  for (const v of t.to) c.push(`TO ${imapString(v)}`);
  for (const v of t.subject) c.push(`SUBJECT ${imapString(v)}`);
  for (const v of t.words) c.push(`TEXT ${imapString(v)}`);
  for (const v of t.notFrom) c.push(`NOT FROM ${imapString(v)}`);
  for (const v of t.notWords) c.push(`NOT TEXT ${imapString(v)}`);
  if (t.unread !== undefined) c.push(t.unread ? 'UNSEEN' : 'SEEN');
  if (t.flagged !== undefined) c.push(t.flagged ? 'FLAGGED' : 'UNFLAGGED');
  if (t.label) c.push(`KEYWORD ${keyword(t.label)}`);
  if (t.notLabel) c.push(`UNKEYWORD ${keyword(t.notLabel)}`);
  if (t.after !== undefined) c.push(`SINCE ${imapDate(t.after, tz)}`);
  if (t.before !== undefined) c.push(`BEFORE ${imapDate(t.before, tz)}`);
  if (t.larger !== undefined) c.push(`LARGER ${t.larger}`);
  // has:attachment has no IMAP word: a multipart/mixed header is a close stand-in.
  if (t.attachment) c.push('HEADER Content-Type "multipart/mixed"');
  if (t.attachment === false) c.push('NOT HEADER Content-Type "multipart/mixed"');
  const criteria = c.join(' ') || 'ALL';
  return { ...(t.folder ? { folder: t.folder } : {}), criteria, utf8: /[^\x00-\x7f]/.test(criteria) };
}

/** An IMAP keyword (atom) for a label name: letters, digits and _ only. */
export const keyword = (name: string): string => name.trim().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Sara';
