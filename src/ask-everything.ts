// S5 "Ask your whole life" (docs/ASK_EVERYTHING.md): one question across the person's mail, files,
// chats, calendar, notes, lists and contacts. Federated: each source is asked with the search it
// already has (mail_search's providers, the library's word+meaning index, the chat store, the
// calendars of every account, the planner, household lists, people cards), the hits are ranked by
// how many of the question's words they hold, and a short answer is built from their best
// sentences, each line citing the hit it came from. No new index.
//
// Who sees what: everything runs on the asking person's own space (a household member's app has
// its own database, mailboxes and library), so nobody reads another person's data. Private chats,
// forgotten messages, other companions' and adult-channel chats never show; off the record nothing
// is searched; a child only gets the sources their tool allowlist (KID_TOOLS) already covers; in a
// private chat or Private local mode mail and calendars (which ask servers elsewhere) stay unread.
import type { AppContext } from './chat.ts';
import { KID_TOOLS } from './family.ts';
import { findFiles } from './find.ts';
import { messageText, type GmailPart } from './google.ts';
import { allEvents, calendarSources } from './mail/calendars.ts';
import { emptyTerms, type SearchTerms } from './mail/search.ts';
import { UNTRUSTED } from './mail/types.ts';
import { privateLocalOn } from './net-guard.ts';
import { turnSpaceSql, type SpaceSql } from './recall.ts';
import { ToolError, type Tool } from './tools/types.ts';

export const ASK_SOURCES = ['mail', 'files', 'chats', 'calendar', 'notes', 'lists', 'contacts'] as const;
export type AskSource = (typeof ASK_SOURCES)[number];

/** Where a hit opens, at the spot. */
export type AskOpen =
  | { kind: 'mail'; account: string; id: string }
  | { kind: 'library'; docId: number; page?: number }
  | { kind: 'file'; workspace: string; path: string }
  | { kind: 'chat'; conversationId: string; messageId?: number }
  | { kind: 'event'; account?: string; id: string; start: string; title: string; where?: string }
  | { kind: 'note'; id: number }
  | { kind: 'task'; id: number }
  | { kind: 'list'; board: string; card: string }
  | { kind: 'person'; id: number };

export interface AskHit {
  source: AskSource;
  title: string;
  /** The words from the source (a sentence or a short passage). */
  quote: string;
  /** Who/where: sender, "page 4", account, location. */
  where?: string;
  when?: string;
  open: AskOpen;
  score: number;
  /** Its citation number ([n]), 1-based across all groups. */
  cite?: number;
}
export interface AskGroup { source: AskSource; items: AskHit[]; error?: string }
export interface AskResult {
  query: string;
  words: string[];
  groups: AskGroup[];
  skipped: { source: AskSource; why: string }[];
  /** The cited answer: one hit per line (the app words it from the hit), best first. */
  answer: { cite: number; source: AskSource }[];
}
export interface AskOptions {
  sources?: readonly string[];
  signal?: AbortSignal;
  /** The conversation a tool call came from (its work/personal space and privacy apply). */
  conversationId?: string;
  /** Per source (default 5). */
  limit?: number;
}

// Words that carry no meaning in a question (six languages, short on purpose).
const STOP = new Set(
  (
    'a an the and or but of to in on at by for from with about into over is are was were be been being am do does did done have has had i me my mine we our you your he she it its they them their this that these those what when where which who whom whose why how there here any some all can could would should will shall may might must not no yes if then than so just also tell show find search ask know say said please let up out ' +
    'el la los las un una unos unas y o de del al en con por para que es son fue mi mis tu tus su sus lo le les se ' +
    'le la les un une des et ou de du au aux en dans sur pour par que qui est sont mon ma mes ton ta tes son sa ses ' +
    'der die das ein eine einen und oder von zu im in an auf mit für ist sind war mein meine dein deine sein seine ' +
    'o a os as um uma e ou de do da dos das em no na nos nas com por para que é meu minha seu sua ' +
    'il lo la gli le un una e o di del della in con per che è sono mio mia suo sua'
  ).split(/\s+/),
);

/** The words of a question that a search can use (max 8, in order, no duplicates). */
export function askWords(q: string): string[] {
  const out: string[] = [];
  for (const w of q.toLowerCase().split(/[^\p{L}\p{N}'@.-]+/u)) {
    const x = w.replace(/^[.'-]+|[.'-]+$/g, '');
    if (x.length < 2 || STOP.has(x) || out.includes(x)) continue;
    out.push(x);
    if (out.length >= 8) break;
  }
  return out;
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Share of the words in the text (0..1), with a small bonus for the longer (rarer) words. */
function scoreOf(text: string, words: string[]): number {
  if (!words.length) return 0;
  const t = fold(text);
  let hit = 0;
  let weight = 0;
  for (const w of words) {
    const len = Math.min(10, w.length);
    weight += len;
    if (t.includes(fold(w))) hit += len;
  }
  return hit / weight;
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** The sentence of a text that holds most of the words (clipped around the first one). */
export function bestQuote(text: string, words: string[], width = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const parts = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  let best = parts[0] ?? flat;
  let bs = -1;
  for (const p of parts) {
    const s = scoreOf(p, words);
    if (s > bs) [best, bs] = [p, s];
  }
  if (best.length <= width) return best;
  const at = Math.max(0, fold(best).indexOf(fold(words.find((w) => fold(best).includes(fold(w))) ?? '')) - 60);
  return `${at ? '…' : ''}${clip(best.slice(at), width)}`;
}

/** The tool each source rides on, for a child's allowlist. */
const SOURCE_TOOL: Record<AskSource, string> = { mail: 'mail_search', files: 'library', chats: 'recall', calendar: 'calendar_events', notes: 'note', lists: 'todo', contacts: 'person_lookup' };

type Ctx = { app: AppContext; words: string[]; q: string; limit: number; signal: AbortSignal; space?: SpaceSql; conversationId?: string };

function chats(c: Ctx): AskHit[] {
  const { app, words } = c;
  if (!words.length) return [];
  const like = words.map(() => 'instr(lower(m.content), ?) > 0').join(' OR ');
  const sp = c.space;
  const rows = app.store.db
    .prepare(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.private = 0 AND c.partner IS NULL AND c.channel NOT LIKE '%-nsfw' AND c.channel != 'a2a' AND m.role IN ('user','assistant')
       AND (m.meta IS NULL OR m.meta NOT LIKE '%"forgotten":true%') AND (${like})${sp ? ` AND ${sp.where}` : ''} ORDER BY m.id DESC LIMIT 300`,
    )
    .all(...words, ...(sp?.args ?? [])) as { id: number; conversation_id: string; role: string; content: string; created_at: string; title: string }[];
  return rows
    // The chat asking now, and the person's own bare questions, hold no answer.
    // Her earlier cited answers ([n]) would only cite this search back to itself.
    .filter((r) => r.conversation_id !== c.conversationId && !(r.role === 'user' && r.content.trim().length <= 200 && /\?\s*$/.test(r.content)) && !(r.role === 'assistant' && /\[\d+\]/.test(r.content)))
    .map((r): AskHit => ({ source: 'chats', title: r.title, quote: bestQuote(r.content.replace(/[*_`#>~]+/g, ''), words), where: r.role === 'user' ? 'you' : 'her', when: r.created_at, open: { kind: 'chat', conversationId: r.conversation_id, messageId: Number(r.id) }, score: scoreOf(r.content, words) }))
    .sort(rank)
    .slice(0, c.limit);
}

function notes(c: Ctx): AskHit[] {
  return (c.app.planner?.notes(undefined, 1000) ?? [])
    .map((n): AskHit => ({ source: 'notes', title: n.title, quote: bestQuote(n.body || n.title, c.words), when: n.updatedAt, open: { kind: 'note', id: n.id }, score: scoreOf(`${n.title}\n${n.body}`, c.words) }))
    .filter((h) => h.score > 0)
    .sort(rank)
    .slice(0, c.limit);
}

function lists(c: Ctx): AskHit[] {
  const { app, words } = c;
  const out: AskHit[] = (app.planner?.tasks({ status: 'all' }) ?? []).map((t) => ({
    source: 'lists' as const,
    title: t.title,
    quote: t.notes ? bestQuote(`${t.title}. ${t.notes}`, words) : t.title,
    where: [t.status === 'done' ? 'done' : 'to-do', t.project].filter(Boolean).join(' · '),
    when: t.dueAt ?? t.updatedAt,
    open: { kind: 'task' as const, id: t.id },
    score: scoreOf(`${t.title}\n${t.notes}\n${t.project ?? ''}`, words),
  }));
  // Household lists shared with this person (their own view: only lists they are a member of).
  const sb = app.sharedBoards;
  if (sb) {
    for (const b of sb.store.boardsFor(sb.person)) {
      for (const card of sb.store.view(sb.person, b.id)?.cards ?? []) {
        out.push({ source: 'lists', title: card.title, quote: card.notes ? bestQuote(`${card.title}. ${card.notes}`, words) : card.title, where: `${b.name}${card.status === 'done' ? ' · done' : ''}`, when: card.dueAt ?? card.createdAt, open: { kind: 'list', board: b.id, card: card.id }, score: scoreOf(`${card.title}\n${card.notes}`, words) });
      }
    }
  }
  return out.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
}

function contacts(c: Ctx): AskHit[] {
  return (c.app.people?.list({ status: 'active', limit: 2000 }) ?? [])
    .filter((p) => !p.private)
    .map((p): AskHit => {
      const blob = [p.name, p.fullName, ...(p.aliases ?? []), p.relation, p.notes].filter(Boolean).join('\n');
      return { source: 'contacts', title: p.fullName || p.name, quote: p.notes ? bestQuote(p.notes, c.words) : p.relation || p.name, where: p.relation || undefined, open: { kind: 'person', id: p.id }, score: scoreOf(blob, c.words) };
    })
    .filter((h) => h.score > 0)
    .sort(rank)
    .slice(0, c.limit);
}

async function files(c: Ctx): Promise<AskHit[]> {
  const { app, words } = c;
  const out: AskHit[] = [];
  if (app.library) {
    const { embedTarget } = await import('./embeddings.ts');
    const hits = (await app.library.find(c.q, { target: embedTarget(app), limit: c.limit * 2, timeoutMs: 4000 })).filter((h) => h.doc.keep && !h.doc.conversationId);
    for (const h of hits) {
      const name = h.doc.title && h.doc.title.length < 80 ? h.doc.title : h.doc.name;
      const page = h.passage.page ?? undefined;
      out.push({ source: 'files', title: name, quote: bestQuote(h.passage.text, words), where: [h.doc.name !== name ? h.doc.name : '', h.passage.place].filter(Boolean).join(' · ') || undefined, when: h.doc.addedAt, open: { kind: 'library', docId: h.doc.id, ...(page ? { page } : {}) }, score: Math.max(scoreOf(h.passage.text, words), h.by === 'meaning' ? 0.5 : 0) + 0.05 });
    }
  }
  // Workspace files are the owner's (the server's own folder): never a member's or a child's.
  if (!app.member) {
    for (const w of [words, words.length > 1 ? [longest(words)] : []]) {
      if (!w.length || out.some((h) => h.open.kind === 'file')) continue;
      for (const f of findFiles(app.rootDir ?? app.dataDir, w, c.limit)) out.push({ source: 'files', title: f.title, quote: f.snippet.replace(/^.*?line \d+: /, ''), where: /line \d+/.exec(f.snippet)?.[0], when: f.when, open: { kind: 'file', workspace: f.workspace ?? 'main', path: f.path ?? f.title }, score: scoreOf(`${f.title} ${f.snippet}`, words) });
    }
  }
  return out.sort(rank).slice(0, c.limit);
}

const longest = (words: string[]) => [...words].sort((a, b) => b.length - a.length)[0];

type Accts = NonNullable<AppContext['mailAccounts']>;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const header = (p: GmailPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
const nameOf = (from: string) => from.replace(/\s*<[^>]+>\s*$/, '').replace(/^"|"$/g, '').trim() || from;

async function mail(c: Ctx): Promise<AskHit[]> {
  const accts = c.app.mailAccounts as (Accts & Partial<Pick<Accts, 'combined' | 'googleOf'>>) | undefined;
  if (!accts) return [];
  const boxes = typeof accts.combined === 'function' ? accts.combined() : accts.list().filter((a) => !a.problem);
  const per = Math.max(3, Math.min(8, c.limit));
  // All the words first; nothing found: the longest word alone (questions carry extra words).
  const tries = [c.words, c.words.length > 1 ? [longest(c.words)] : []].filter((w) => w.length);
  const errors: string[] = [];
  const parts = await Promise.all(
    boxes.map(async (a): Promise<AskHit[]> => {
      try {
        for (const w of tries) {
          let found: { id: string; from: string; subject: string; date: string; text: string }[] = [];
          if (a.kind === 'google') {
            const g = accts.googleOf?.(a.id);
            if (!g) return [];
            const list = (await g.api(`${GMAIL}/messages?${new URLSearchParams({ q: w.join(' '), maxResults: String(per) })}`, { signal: c.signal })) as { messages?: { id: string }[] };
            const msgs = await Promise.all((list.messages ?? []).map((m) => g.api(`${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { signal: c.signal }) as Promise<{ id: string; snippet?: string; payload?: GmailPart }>));
            found = msgs.map((m) => ({ id: m.id, from: header(m.payload, 'From'), subject: header(m.payload, 'Subject'), date: header(m.payload, 'Date'), text: (m.snippet ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&') }));
          } else {
            const p = accts.provider(a.id);
            const terms: SearchTerms = { from: [], to: [], subject: [], words: w, notFrom: [], notWords: [] };
            if (emptyTerms(terms)) continue;
            const { ids } = await p.searchIds(terms, per, c.signal);
            if (!ids.length) continue;
            found = (await p.list(ids, c.signal)).map((m) => ({ id: m.id, from: m.from, subject: m.subject, date: m.date, text: m.text ?? m.snippet }));
          }
          if (!found.length) continue;
          const many = boxes.length > 1;
          return found.map((m) => ({ source: 'mail' as const, title: m.subject || '(no subject)', quote: bestQuote(m.text || m.subject, c.words), where: `${nameOf(m.from)}${many ? ` · ${a.address}` : ''}`, when: isNaN(Date.parse(m.date)) ? m.date : new Date(m.date).toISOString(), open: { kind: 'mail' as const, account: a.id, id: m.id }, score: scoreOf(`${m.subject}\n${m.text}`, c.words) }));
        }
        return [];
      } catch (err) {
        errors.push(`${a.address}: ${(err as Error).message.slice(0, 160)}`);
        return [];
      }
    }),
  );
  const hits = parts.flat().sort(rank).slice(0, c.limit);
  if (!hits.length && errors.length) throw new Error(errors.join('; '));
  return hits;
}

async function calendar(c: Ctx): Promise<AskHit[]> {
  const sources = calendarSources(c.app);
  if (!sources.length) return [];
  const now = c.app.now();
  const day = 86_400_000;
  // A year back and a year ahead; the longest word goes to the servers that search (Google), the
  // rest is ranked here.
  const { events } = await allEvents(sources, new Date(now.getTime() - 365 * day), new Date(now.getTime() + 365 * day), 250, c.signal, longest(c.words));
  return events
    .map((e): AskHit => {
      const blob = [e.title, e.location, ...(e.attendees ?? [])].filter(Boolean).join('\n');
      return { source: 'calendar', title: e.title, quote: e.title, where: [e.location, e.account].filter(Boolean).join(' · ') || undefined, when: e.start, open: { kind: 'event', ...(e.accountId ? { account: e.accountId } : {}), id: e.id, start: e.start, title: e.title, ...(e.location ? { where: e.location } : {}) }, score: scoreOf(blob, c.words) };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || Math.abs(Date.parse(a.when ?? '') - now.getTime()) - Math.abs(Date.parse(b.when ?? '') - now.getTime()))
    .slice(0, c.limit);
}

/** Best match first; the newer of two equal ones first. */
function rank(a: AskHit, b: AskHit): number {
  return b.score - a.score || String(b.when ?? '').localeCompare(String(a.when ?? ''));
}

const RUN: Record<AskSource, (c: Ctx) => AskHit[] | Promise<AskHit[]>> = { mail, files, chats, calendar, notes, lists, contacts };

/** Which sources this person may ask here, and why the others are skipped. */
export function askAllowed(app: AppContext, opts: { conversationId?: string } = {}): { allowed: AskSource[]; skipped: { source: AskSource; why: string }[] } {
  const skipped: { source: AskSource; why: string }[] = [];
  if (app.offRecord) return { allowed: [], skipped: ASK_SOURCES.map((source) => ({ source, why: 'Off the record, nothing is searched.' })) };
  const kid = app.member?.child?.();
  const conv = opts.conversationId ? app.store.getConversation(opts.conversationId) : undefined;
  const offServer = privateLocalOn() || Boolean(conv?.private);
  const allowed = ASK_SOURCES.filter((s) => {
    if (kid && !KID_TOOLS.has(SOURCE_TOOL[s])) return void skipped.push({ source: s, why: 'A parent decides what is searched here.' });
    if (offServer && (s === 'mail' || s === 'calendar')) return void skipped.push({ source: s, why: conv?.private ? 'Not in a private chat: mail and calendars are on other servers.' : 'Private local mode: mail and calendars are on other servers.' });
    return true;
  });
  return { allowed, skipped };
}

/** One question across every source this person may ask; grouped, cited, with a short answer. */
export async function askEverything(app: AppContext, q: string, opts: AskOptions = {}): Promise<AskResult> {
  const query = q.trim().slice(0, 300);
  const words = askWords(query);
  const { allowed, skipped } = askAllowed(app, opts);
  const want = opts.sources?.length ? allowed.filter((s) => opts.sources!.includes(s)) : allowed;
  const result: AskResult = { query, words, groups: [], skipped: opts.sources?.length ? skipped.filter((s) => opts.sources!.includes(s.source)) : skipped, answer: [] };
  if (!words.length || !want.length) return result;
  const ctx: Ctx = { app, words, q: query, limit: Math.max(1, Math.min(10, opts.limit ?? 5)), signal: opts.signal ?? new AbortController().signal, ...(opts.conversationId ? { space: turnSpaceSql(app, opts.conversationId), conversationId: opts.conversationId } : {}) };
  const settled = await Promise.allSettled(want.map(async (s) => RUN[s](ctx)));
  settled.forEach((r, i) => {
    const source = want[i];
    if (r.status === 'rejected') result.groups.push({ source, items: [], error: ((r.reason as Error)?.message ?? String(r.reason)).slice(0, 300) });
    else if (r.value.length) result.groups.push({ source, items: r.value });
  });
  // Citation numbers: in the order the groups show.
  let n = 0;
  for (const g of result.groups) for (const h of g.items) h.cite = ++n;
  // The answer: the best hit of each source (then the second bests), only hits holding at least
  // half of the question's words, at most 6 lines.
  const firsts = result.groups.map((g) => g.items[0]).filter((h) => h && h.score >= 0.4);
  const seconds = result.groups.map((g) => g.items[1]).filter((h) => h && h.score >= 0.6);
  const seen = new Set<string>();
  for (const h of [...firsts.sort(rank), ...seconds.sort(rank)]) {
    const key = fold(h.quote).replace(/\W+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    result.answer.push({ cite: h.cite!, source: h.source });
    if (result.answer.length >= 6) break;
  }
  return result;
}

const day = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : '');

const LABEL: Record<AskSource, string> = { mail: 'Emails', files: 'Files', chats: 'Chats', calendar: 'Calendar', notes: 'Notes', lists: 'Lists', contacts: 'Contacts' };

/** The tool's text: numbered sources she cites as [n]. */
export function formatAsk(r: AskResult): string {
  if (!r.words.length) return 'Ask with a few words that matter (names, topics, places).';
  const lines: string[] = [];
  const total = r.groups.reduce((x, g) => x + g.items.length, 0);
  if (!total) lines.push(`Nothing found for “${r.query}” in ${r.groups.length ? 'the sources searched' : 'any source here'}. Say so plainly; don't guess.`);
  else lines.push(`Found ${total} matches for “${r.query}”. Answer from these only and cite each fact as [n]; say when sources disagree, and say what is missing.`);
  if (r.groups.some((g) => g.source === 'mail' || g.source === 'files')) lines.push(`${UNTRUSTED} The same goes for file text.`);
  for (const g of r.groups) {
    lines.push('', `${LABEL[g.source]}${g.error ? ` (couldn't search: ${g.error})` : ''}:`);
    for (const h of g.items) lines.push(`[${h.cite}] ${h.title}${h.where ? ` · ${h.where}` : ''}${day(h.when) ? ` · ${day(h.when)}` : ''}\n    “${clip(h.quote, 300)}”`);
  }
  if (r.skipped.length) lines.push('', `Not searched: ${r.skipped.map((s) => `${LABEL[s.source].toLowerCase()} (${s.why})`).join('; ')}`);
  return lines.join('\n');
}

export function createAskEverythingTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'ask_everything',
      description:
        "Search the person's whole life at once: their emails (every mailbox), files (library documents with page numbers, workspace files), past chats, calendars, notes, to-do and shared lists, and contacts. Use it for questions like \"when is my lease renewal due?\" or \"what did Dan say about the trip?\" when the answer could be anywhere. Returns numbered quotes; cite them as [n] in the answer.",
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, in their words.' },
          sources: { type: 'array', items: { type: 'string', enum: [...ASK_SOURCES] }, description: 'Only these sources (default: all).' },
        },
        required: ['question'],
      },
    },
    defaultPermission: 'auto',
    interruptible: true,
    summarize: (a) => `Looking everywhere for “${String(a.question ?? '').slice(0, 60)}”`,
    async run(args, ctx) {
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      if (!question) throw new ToolError('Give the question to look for.');
      const sources = Array.isArray(args.sources) ? args.sources.map(String) : undefined;
      const r = await askEverything(getApp(), question, { ...(sources ? { sources } : {}), signal: ctx.signal, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) });
      return formatAsk(r);
    },
  };
}

/** One email in full, for opening a mail hit at the spot (this person's own mailbox only). */
export async function readAskMail(app: AppContext, account: string, id: string, signal?: AbortSignal): Promise<{ from: string; to: string; date: string; subject: string; text: string; account: string }> {
  if (app.offRecord) throw new ToolError('Off the record, nothing is searched.');
  if (!askAllowed(app).allowed.includes('mail')) throw new ToolError('Mail is not searched here.');
  const accts = app.mailAccounts as (Accts & Partial<Pick<Accts, 'googleOf'>>) | undefined;
  const a = accts?.list().find((x) => x.id === account);
  if (!accts || !a) throw new ToolError('No such mailbox.');
  if (!/^[\w.@+=:<>/-]{1,200}$/.test(id)) throw new ToolError('That is not an email id.');
  if (a.kind === 'google') {
    const g = accts.googleOf?.(a.id);
    if (!g) throw new ToolError('No such mailbox.');
    const m = (await g.api(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { signal })) as { payload?: GmailPart };
    const p = m.payload ?? {};
    return { from: header(p, 'From'), to: header(p, 'To'), date: header(p, 'Date'), subject: header(p, 'Subject'), text: messageText(p), account: a.address };
  }
  const m = await accts.provider(a.id).get(id, signal);
  return { from: m.from, to: m.to, date: m.date, subject: m.subject, text: m.text ?? m.snippet, account: a.address };
}
