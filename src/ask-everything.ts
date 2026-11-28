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
//
// U3.19: also meetings (S2 transcripts and notes, cited with the time in the recording), trips (S6
// bookings), documents (S7 templates, drafts and their clause checklists), research reports (S1) and
// goals (S3); contacts also cover the S4 promises and last contact. Each keeps its feature's rules:
// meetings and research are the owner's only (a member's space has none), trips, goals and documents
// are each space's own, a child skips them all, anything made in a private, adult or other-person
// chat stays out (as those chats do), and a private People card shows only in a private chat.
import type { AppContext } from './chat.ts';
import { KID_TOOLS } from './family.ts';
import { findFiles } from './find.ts';
import { clauseChecklist, DOC_TYPE_LABEL, guessDocType } from './documents/clauses.ts';
import { FORMAT_LABEL, madeDocs } from './documents/make.ts';
import { docTemplates } from './documents/templates.ts';
import { messageText, type GmailPart } from './google.ts';
import { allEvents, calendarSources } from './mail/calendars.ts';
import { emptyTerms, type SearchTerms } from './mail/search.ts';
import { UNTRUSTED } from './mail/types.ts';
import { moneyStore } from './money/store.ts';
import { privateLocalOn } from './net-guard.ts';
import { healthFor, HealthLog } from './health-log.ts';
import { healthMessage } from './health-terms.ts';
import { turnSpaceSql, type SpaceSql } from './recall.ts';
import { ToolError, type Tool } from './tools/types.ts';
import { workspacesBase } from './tools/workspace.ts';

export const ASK_SOURCES = ['mail', 'files', 'chats', 'calendar', 'notes', 'lists', 'contacts', 'meetings', 'trips', 'documents', 'research', 'goals', 'money', 'health'] as const;
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
  | { kind: 'person'; id: number }
  /** U3.19: a meeting, at a transcript line (its number and seconds into the recording) or its notes. */
  | { kind: 'meeting'; id: number; line?: number; t?: number }
  | { kind: 'trip'; id: number; booking?: number }
  | { kind: 'research'; id: number }
  | { kind: 'goal'; id: number }
  | { kind: 'money'; tx: number }
  /** U4.22: the person's own Health log (only from a private chat with "include health" on). */
  | { kind: 'health' };

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
const SOURCE_TOOL: Record<AskSource, string> = { mail: 'mail_search', files: 'library', chats: 'recall', calendar: 'calendar_events', notes: 'note', lists: 'todo', contacts: 'person_lookup', meetings: 'meeting_notes', trips: 'trips', documents: 'doc_from_template', research: 'research_start', goals: 'goal_plan', money: 'budget_summary', health: 'health_read'};

type Ctx = { app: AppContext; words: string[]; q: string; limit: number; signal: AbortSignal; space?: SpaceSql; conversationId?: string };

/** A chat row that logged or answered health (its own mark, or the person's message before it). */
function healthRow(app: AppContext, r: { id: number; conversation_id: string; role: string }): boolean {
  const get = (sql: string, ...a: (string | number)[]) => app.store.db.prepare(sql).get(...a) as { role: string; meta: string | null } | undefined;
  const meta = (row: { meta: string | null } | undefined) => {
    try {
      return row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const own = get('SELECT role, meta FROM messages WHERE id = ?', r.id);
  if (own && healthMessage({ role: own.role, meta: meta(own) })) return true;
  if (r.role === 'user') return false;
  const asked = get("SELECT role, meta FROM messages WHERE conversation_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1", r.conversation_id, r.id);
  return Boolean(asked && healthMessage({ role: asked.role, meta: meta(asked) }));
}

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
    // U4.22: a health log exchange never shows (the message that logged, and her reply to it).
    .filter((r) => !healthRow(app, r))
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
  // U3.19: a private card (learned in a private chat, or marked) only when asking in a private chat.
  const inPrivate = Boolean(c.conversationId && c.app.store.getConversation(c.conversationId)?.private);
  const ties = c.app.peopleTies;
  const people = (c.app.people?.list({ status: 'active', limit: 2000 }) ?? []).filter((p) => inPrivate || !p.private);
  const byId = new Map(people.map((p) => [p.id, p]));
  const hits = people.map((p): AskHit => {
    const blob = [p.name, p.fullName, ...(p.aliases ?? []), p.relation, p.notes].filter(Boolean).join('\n');
    const last = ties?.lastContact(p.id);
    return { source: 'contacts', title: p.fullName || p.name, quote: p.notes ? bestQuote(p.notes, c.words) : p.relation || p.name, where: [p.relation, last ? `last contact ${last.slice(0, 10)}` : ''].filter(Boolean).join(' · ') || undefined, open: { kind: 'person', id: p.id }, score: scoreOf(blob, c.words) };
  });
  // S4 promises on the cards (what was promised to or by them), open ones and ones waiting for an OK.
  for (const pr of ties?.promises({ status: 'active' }) ?? []) {
    const p = byId.get(pr.personId);
    if (!p) continue;
    hits.push({ source: 'contacts', title: p.fullName || p.name, quote: pr.text, where: ['promise', pr.due ? `due ${pr.due}` : ''].filter(Boolean).join(' · '), when: pr.createdAt, open: { kind: 'person', id: p.id }, score: scoreOf(`${p.name}\n${p.fullName ?? ''}\n${pr.text}`, c.words) });
  }
  return hits.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
}

/** A chat whose things stay out of Ask (as its messages do): private, adult, someone else's, A2A. */
function hiddenChat(c: Ctx, id: string | null | undefined): boolean {
  if (!id || id === c.conversationId) return false;
  const conv = c.app.store.getConversation(id);
  return Boolean(conv && (conv.private || conv.partner || conv.channel.endsWith('-nsfw') || conv.channel === 'a2a'));
}

/** Seconds into a recording as 12:05 or 1:02:05. */
export function clockOf(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** S2 meetings: what was said (cited with the speaker and the time) and the written notes. */
function meetings(c: Ctx): AskHit[] {
  const { app, words } = c;
  if (!app.meetings || !words.length) return [];
  const db = app.store.db;
  const titles = new Map((db.prepare('SELECT id, title, notes, created_at FROM meetings ORDER BY id DESC LIMIT 500').all() as { id: number; title: string; notes: string | null; created_at: string }[]).map((m) => [Number(m.id), m]));
  const like = words.map(() => 'instr(lower(text), ?) > 0').join(' OR ');
  const rows = db.prepare(`SELECT meeting_id, n, speaker, text, t FROM meeting_lines WHERE kind = 'said' AND (${like}) ORDER BY meeting_id DESC, n LIMIT 400`).all(...words) as { meeting_id: number; n: number; speaker: string; text: string; t: number | null }[];
  const out: AskHit[] = [];
  for (const r of rows) {
    const m = titles.get(Number(r.meeting_id));
    if (!m) continue;
    const t = r.t === null || r.t === undefined ? undefined : Math.round(Number(r.t) * 10) / 10;
    out.push({ source: 'meetings', title: m.title, quote: bestQuote(r.text, words), where: [r.speaker, t === undefined ? '' : clockOf(t)].filter(Boolean).join(' · '), when: m.created_at, open: { kind: 'meeting', id: Number(r.meeting_id), line: Number(r.n), ...(t === undefined ? {} : { t }) }, score: scoreOf(`${m.title}\n${r.speaker}\n${r.text}`, words) });
  }
  for (const m of titles.values()) {
    if (!m.notes) continue;
    let n: { summary?: string; decisions?: string[]; actions?: { task: string; owner?: string }[]; questions?: string[] };
    try {
      n = JSON.parse(m.notes) as typeof n;
    } catch {
      continue;
    }
    const parts = [n.summary ?? '', ...(n.decisions ?? []), ...(n.actions ?? []).map((a) => `${a.task}${a.owner ? ` (${a.owner})` : ''}`), ...(n.questions ?? [])].filter(Boolean).map((x) => x.replace(/[.!?]?\s*$/, '.'));
    const text = parts.join(' ');
    // The notes rank just under a transcript line that says the same.
    out.push({ source: 'meetings', title: m.title, quote: bestQuote(text, words), where: 'notes', when: m.created_at, open: { kind: 'meeting', id: Number(m.id) }, score: scoreOf(`${m.title}\n${text}`, words) * 0.95 });
  }
  return out.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
}

/** S6 trips: each booking on a trip's timeline. */
function trips(c: Ctx): AskHit[] {
  const tr = c.app.travel;
  if (!tr) return [];
  const out: AskHit[] = [];
  for (const t of tr.trips({ all: true })) {
    for (const b of t.bookings) {
      const blob = [t.title, b.title, b.number, b.airline, b.confirmation, b.from, b.to, b.place, b.kind].filter(Boolean).join('\n');
      const quote = [b.title, b.when, b.confirmation ? `confirmation ${b.confirmation}` : ''].filter(Boolean).join(' · ');
      out.push({ source: 'trips', title: t.title, quote: quote.includes(b.number ?? '') ? quote : `${b.number} · ${quote}`, where: [b.kind, t.dates].filter(Boolean).join(' · '), when: b.startsAt, open: { kind: 'trip', id: t.id, booking: b.id }, score: scoreOf(blob, c.words) });
    }
  }
  return out.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
}

/** S7 documents: templates (with what they fill in), drafts she made, and their clause checklists. */
function documents(c: Ctx): AskHit[] {
  const { app, words } = c;
  const lib = app.library;
  if (!lib) return [];
  const out: AskHit[] = [];
  for (const tpl of docTemplates(app).list()) {
    const d = lib.get(tpl.libraryId);
    if (!d || hiddenChat(c, d.conversationId)) continue;
    const fills = tpl.placeholders.filter((p) => p.kind !== 'signature').map((p) => p.label);
    const label = DOC_TYPE_LABEL[tpl.type] ?? tpl.type;
    out.push({ source: 'documents', title: d.name, quote: fills.length ? `Fills in: ${fills.slice(0, 12).join(', ')}` : `${label} template`, where: `${label} template`, when: tpl.createdAt, open: { kind: 'library', docId: d.id }, score: scoreOf(`${d.name}\n${label} template\n${fills.join('\n')}`, words) });
  }
  for (const m of madeDocs(app).recent(200)) {
    if (!m.libraryId || hiddenChat(c, m.conversationId) || !lib.get(m.libraryId)) continue;
    const content = String(m.spec?.content ?? '').replace(/[*_`#>~]+/g, '');
    out.push({ source: 'documents', title: m.title, quote: bestQuote(content || m.title, words), where: `${FORMAT_LABEL[m.format] ?? m.format} · draft${m.version > 1 ? ` v${m.version}` : ''}`, when: m.createdAt, open: { kind: 'library', docId: m.libraryId }, score: scoreOf(`${m.title}\n${content}`, words) });
    // Its clause checklist (the same check doc_checklist runs), one line per clause the question names.
    if (!content) continue;
    const type = guessDocType(m.title, content);
    for (const it of clauseChecklist(content, type).items) {
      const s = scoreOf(`${m.title}\n${it.label}`, words);
      if (!words.some((w) => fold(it.label).includes(fold(w)))) continue;
      out.push({ source: 'documents', title: m.title, quote: `${it.label}: ${it.status === 'missing' ? 'missing' : it.quote ? `“${clip(it.quote, 160)}”` : it.status}`, where: `clause checklist · ${DOC_TYPE_LABEL[type]}`, when: m.createdAt, open: { kind: 'library', docId: m.libraryId }, score: s + 0.01 });
    }
  }
  return out.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
}

/** S1 research reports (the owner's). */
function research(c: Ctx): AskHit[] {
  const out: AskHit[] = [];
  for (const r of c.app.research?.list() ?? []) {
    if (!r.report || hiddenChat(c, r.conversationId)) continue;
    const read = r.sources.filter((s) => s.status === 'read').length;
    out.push({ source: 'research', title: r.question, quote: bestQuote(r.report.replace(/[*_`#>~]+/g, '').replace(/\s*\[\d{1,3}\]/g, ''), c.words), where: `report${read ? ` · ${read} sources` : ''}`, when: r.updatedAt, open: { kind: 'research', id: r.id }, score: scoreOf(`${r.question}\n${r.report}`, c.words) });
  }
  return out.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
}

/**
 * U4.20 money: the person's own transactions (this space's store, so members stay apart), by
 * merchant words or an amount ("42.10", "$6.75"). Local data only.
 */
function money(c: Ctx): AskHit[] {
  const s = moneyStore(c.app);
  const amounts = new Set([...c.q.matchAll(/\$?(\d{1,7}[.,]\d{2})\b/g)].map((m) => Math.round(Number(m[1].replace(',', '.')) * 100)));
  const words = c.words.filter((w) => !/^\d/.test(w));
  const out: AskHit[] = [];
  for (const t of s.transactions()) {
    const amt = Math.abs(t.amountCents);
    const byAmount = amounts.has(amt);
    const score = byAmount ? 1 : words.length ? scoreOf(`${t.description}\n${t.merchant}\n${t.category}`, words) : 0;
    if (score <= 0) continue;
    const money = `${t.amountCents < 0 ? '-' : ''}$${(amt / 100).toFixed(2)}`;
    out.push({ source: 'money', title: t.merchant || t.description, quote: `${t.date} · ${t.description} · ${money}`, where: [t.account, t.category].filter(Boolean).join(' · '), when: t.date, open: { kind: 'money', tx: t.id }, score });
  }
  return out.sort(rank).slice(0, c.limit);
}

/** S3 goals: the goal and its steps. */
function goals(c: Ctx): AskHit[] {
  const out: AskHit[] = [];
  for (const g of c.app.longGoals?.list() ?? []) {
    if (hiddenChat(c, g.conversationId)) continue;
    const steps = g.milestones.map((m) => `${m.text}${m.due ? ` (by ${m.due})` : ''}${m.status === 'done' ? ' (done)' : ''}`);
    const best = steps.map((s) => [s, scoreOf(s, c.words)] as const).sort((a, b) => b[1] - a[1])[0];
    const done = g.milestones.filter((m) => m.status === 'done').length;
    out.push({ source: 'goals', title: g.title, quote: best && best[1] > 0 ? best[0] : g.title, where: [g.status, g.due ? `due ${g.due}` : '', `${done} of ${g.milestones.length} steps done`].filter(Boolean).join(' · '), when: g.updatedAt, open: { kind: 'goal', id: g.id }, score: scoreOf(`${g.title}\n${steps.join('\n')}`, c.words) });
  }
  return out.filter((h) => h.score > 0).sort(rank).slice(0, c.limit);
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
      for (const f of findFiles(workspacesBase(app), w, c.limit)) out.push({ source: 'files', title: f.title, quote: f.snippet.replace(/^.*?line \d+: /, ''), where: /line \d+/.exec(f.snippet)?.[0], when: f.when, open: { kind: 'file', workspace: f.workspace ?? 'main', path: f.path ?? f.title }, score: scoreOf(`${f.title} ${f.snippet}`, words) });
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

/** U4.22: the person's Health log (askAllowed lets it in only from a private chat with "include health" on). */
function health(c: Ctx): AskHit[] {
  return healthFor(c.app)
    .search(c.words)
    .map((h): AskHit => ({ source: 'health', title: h.title, quote: h.quote, when: h.when, open: { kind: 'health' }, score: scoreOf(`${h.title}\n${h.quote}`, c.words) }))
    .filter((h) => h.score > 0)
    .sort(rank)
    .slice(0, c.limit);
}

const RUN: Record<AskSource, (c: Ctx) => AskHit[] | Promise<AskHit[]>> = { mail, files, chats, calendar, notes, lists, contacts, meetings, trips, documents, research, goals, money, health };

/** Which sources this person may ask here, and why the others are skipped. */
export function askAllowed(app: AppContext, opts: { conversationId?: string } = {}): { allowed: AskSource[]; skipped: { source: AskSource; why: string }[] } {
  const skipped: { source: AskSource; why: string }[] = [];
  if (app.offRecord) return { allowed: [], skipped: ASK_SOURCES.map((source) => ({ source, why: 'Off the record, nothing is searched.' })) };
  const kid = app.member?.child?.();
  const conv = opts.conversationId ? app.store.getConversation(opts.conversationId) : undefined;
  const offServer = privateLocalOn() || Boolean(conv?.private);
  const allowed = ASK_SOURCES.filter((s) => {
    // U4.22: health only from a private chat with "include health" on (never named otherwise).
    if (s === 'health') return Boolean(conv?.private) && !kid && HealthLog.exists(app) && healthFor(app).settings().includeInAsk;
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

const LABEL: Record<AskSource, string> = { mail: 'Emails', files: 'Files', chats: 'Chats', calendar: 'Calendar', notes: 'Notes', lists: 'Lists', contacts: 'Contacts', meetings: 'Meetings', trips: 'Trips', documents: 'Documents', research: 'Research', goals: 'Goals', money: 'Money', health: 'Health'};

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

// C14: the person's words that ask for more than their documents (six languages, whole words).
const WORD = (alts: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts})(?![\\p{L}\\p{N}])`, 'iu');
const MAIL_CUE = WORD('e-?mails?|mails?|inbox|mailbox|correos?|bandeja de entrada|courriels?|bo[iî]te mail|posteingang|postfach|correio|caixa de entrada|posta|casella');
const ALL_CUE = WORD('everything|everywhere|todas partes|todos lados|partout|überall|em todo o lado|em todo lugar|dappertutto|ovunque');

/** What the person asked to have searched besides their documents: 'all', 'mail', or nothing. */
export function beyondDocsCue(text: string): 'all' | 'mail' | undefined {
  return ALL_CUE.test(text) ? 'all' : MAIL_CUE.test(text) ? 'mail' : undefined;
}

/**
 * C14: a `library` ask in a turn where the person said "check everything" or named their mail. Some
 * models pick `library` for those anyway, so the rest is searched here with ask_everything's own
 * rules (askAllowed: off the record, a child, a private chat, Private local mode). Nothing is added
 * where ask_everything would not run on its own: the owner's own chats only, with the tool set to
 * run without asking; mail only when mail_search also runs without asking. Returns the text to
 * add to the library answer, or undefined.
 */
export async function askBeyondDocuments(app: AppContext, o: { query: string; conversationId?: string; signal?: AbortSignal }): Promise<string | undefined> {
  const conv = o.conversationId ? app.store.getConversation(o.conversationId) : undefined;
  if (!conv || conv.partner || /-work(-nsfw)?$/.test(conv.channel) || conv.channel.startsWith('group') || ['api', 'mcp', 'home-assistant', 'alexa', 'a2a', 'webhook'].includes(conv.channel)) return undefined;
  if (app.readTogether?.get(conv.id)?.source === 'feed') return undefined;
  const said = app.store.db.prepare("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(conv.id) as { content: string } | undefined;
  const cue = beyondDocsCue(`${said?.content ?? ''}\n${o.query}`);
  if (!cue) return undefined;
  const over = app.settings.get().toolPermissions;
  const perm = (name: string) => (app.tools.get(name) ? app.tools.permission(name, over) : undefined);
  if (perm('ask_everything') !== 'auto') return undefined;
  const mailOk = (perm('mail_search') ?? 'auto') === 'auto';
  // Files are the library's own answer above; the rest is what ask_everything would search.
  const sources = (cue === 'mail' ? ['mail'] : ASK_SOURCES.filter((s) => s !== 'files')).filter((s) => s !== 'mail' || mailOk);
  const notMail = mailOk ? '' : 'Their email was not searched from here (searching mail asks first): use mail_search for that.';
  if (!sources.length) return notMail || undefined;
  const r = await askEverything(app, o.query, { sources, conversationId: conv.id, ...(o.signal ? { signal: o.signal } : {}) });
  if (!r.words.length) return notMail || undefined;
  return [`They asked to look ${cue === 'mail' ? 'in their mail' : 'everywhere'} too, so this was also searched (use it together with the document quotes above):`, formatAsk(r), notMail].filter(Boolean).join('\n');
}

export function createAskEverythingTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: 'ask_everything',
      description:
        "Search the person's whole life at once: their emails (every mailbox), files (library documents with page numbers, workspace files), past chats, calendars, notes, to-do and shared lists, contacts (card notes, promises, last contact), meetings (what was said, with the time, and the notes), trips (bookings), documents (templates, drafts, clause checklists), research reports, goals and money (bank and card transactions by merchant or amount). Use it for questions like \"when is my lease renewal due?\" or \"what did Dan say about the trip?\" when the answer could be anywhere. Returns numbered quotes; cite them as [n] in the answer.",
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
