// X0 (docs/security/X0_REVIEW.md): one place that says when other people's words are in play and
// what that changes. "Outside words" are text a tool brought in that the person did not write: a web
// page, search results, an email, an MCP server's answer, a page in a browser she drives. A model
// may be talked into obeying them (prompt injection), so while they are in play:
//   1. Always allow everything stops skipping cards (src/chat.ts), on the server AND on the
//      person's computer (pc_run and desktop actions no longer carry the no-card key);
//   2. a tool that sends an address out (web_fetch, the testing browser) asks first unless that
//      exact address was already seen: in the person's own words, a search result, a page or an
//      email. An address the model put together itself could carry private text away. Once the
//      person says yes for a site, more addresses on that site run for the rest of the reply.
// The hold lasts for the rest of the turn and for the next TAINT_CARRY_TURNS messages from the
// person in that chat, so "when they next reply, run X" on a page does not work either.
// Pure functions: no I/O.

/** Tools whose answer is other people's words. */
const OUTSIDE_WORDS_TOOLS = new Set([
  'web_fetch', 'web_search',
  'mail_read', 'mail_thread', 'mail_search', 'mail_needs_answer',
  'gmail_read', 'gmail_thread', 'gmail_search', 'gmail_needs_answer',
  'inbox_suggestions',
  'browser_open', 'browser_read', 'browser_check',
]);
/** Browser tools on the person's computer that bring page text back. */
const PC_BROWSER_READS = /^pc_browser_(open|navigate|read|look|logs|request|tabs|click|scroll)$/;

export const outsideWordsTool = (name: string): boolean => OUTSIDE_WORDS_TOOLS.has(name) || name.startsWith('mcp_') || PC_BROWSER_READS.test(name) || name === 'pc_my_tabs';

/** How many of the person's own messages the hold outlives the turn that read the outside words. */
export const TAINT_CARRY_TURNS = 2;

interface StoredLike {
  role: string;
  content?: string;
  meta?: { name?: unknown; status?: unknown } | null;
}

/**
 * True when an outside-words tool answered within the last TAINT_CARRY_TURNS messages from the
 * person (the conversation as stored before the new message is added).
 */
export function carriedTaint(messages: readonly StoredLike[], turns: number = TAINT_CARRY_TURNS): boolean {
  let users = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      if (++users >= turns) return false;
      continue;
    }
    if (m.role === 'tool' && (m.meta?.status ?? 'ok') === 'ok' && outsideWordsTool(String(m.meta?.name ?? ''))) return true;
  }
  return false;
}

/** Tools that send an address out, and the argument that holds it. */
// The browser on the person's computer is not here: it has its own rule and card there (an unknown
// site asks once per task), which the hold above brings back.
const OUTBOUND_URL_ARG: Record<string, string> = {
  web_fetch: 'url',
  browser_open: 'url',
};

/** The web address this call would send out, if it is one of the outbound tools. */
export function outboundUrl(name: string, args: Record<string, unknown> | undefined): string | undefined {
  const key = OUTBOUND_URL_ARG[name];
  if (!key || !args) return undefined;
  const v = args[key];
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v.trim())) return undefined;
  return v.trim();
}

const variants = (url: string): string[] => {
  const out = new Set<string>([url]);
  try {
    const u = new URL(url);
    u.hash = '';
    out.add(u.href);
    if (u.pathname === '/' && !u.search) out.add(u.origin);
    out.add(u.href.replace(/\/$/, ''));
  } catch {
    /* not an address: only the literal text counts */
  }
  return [...out].filter((v) => v.length >= 8);
};

/** True when the needle stands in the text as a whole address (not the start of a longer one). */
const standsIn = (text: string, needle: string, bare = false): boolean => {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const prev = at > 0 ? text[at - 1]! : ' ';
    const next = text[at + needle.length];
    const endOk = next === undefined || /[\s"'<>)\]}|\\^`,;]/.test(next) || (/[.!?:/]/.test(next) && !/[\w/%=&?#-]/.test(text[at + needle.length + 1] ?? ''));
    if (endOk && !(bare && /[\w.-]/.test(prev))) return true;
  }
  return false;
};

/**
 * Whether this exact address was already seen: in a set of known addresses (search results, links on
 * fetched pages) or written out in one of the texts (the person's messages, earlier tool answers).
 * A bare site address (no path, no query) counts when its site name was seen ("open example.com").
 */
export function urlSeen(url: string, known: { has(u: string): boolean } | undefined, texts: Iterable<string | undefined>): boolean {
  let bareHost: string | undefined;
  try {
    const u = new URL(url);
    if ((u.pathname === '/' || u.pathname === '') && !u.search && !u.username) bareHost = u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return false;
  }
  // This computer itself (her own job's page, a local tool): nothing leaves.
  if (isLoopbackUrl(url)) return true;
  const vs = variants(url);
  if (known && vs.some((v) => known.has(v))) return true;
  for (const t of texts) {
    if (!t) continue;
    if (vs.some((v) => standsIn(t, v))) return true;
    if (bareHost && standsIn(t.toLowerCase(), bareHost, true)) return true;
  }
  return false;
}

/** The site of an address, for "asked once per site in this reply" ('' when it is not an address). */
export function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isLoopbackUrl(url: string): boolean {
  const h = hostOfUrl(url);
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '[::1]' || h === '::1';
}

/** The line added to the card when an unseen address would go out. */
export function unseenAddressLine(url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the text */
  }
  return `This address (${host}) was not in anything you wrote or she read, and other people's words are in this chat. Open it?`;
}
