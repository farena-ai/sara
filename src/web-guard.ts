// 3.1.2 (docs/RESEARCH.md "Why chats stopped failing"): guard rails for reading the web in a chat.
// Seen in real chats: the model guessed page addresses (site.com/class-warrior-guide, /warrior-guide,
// /warrior …), got dozens of 404 pages back as text, hit Cloudflare "Just a moment..." walls and
// kept going until the context had to be compacted twice. Here:
// - a page that doesn't exist (404/410) comes back as one short line: search for it instead;
// - after 3 not-found pages on one site in a reply, more guessed addresses there are refused (an
//   address a search result or a fetched page linked to still works);
// - bot walls (Cloudflare challenges, captchas) are recognised and reported as "this site blocks
//   automated readers": never retried, never worked around;
// - after 8 pages in one reply the result says to start a research run (research_start), which runs
//   in the background with its own budget, and the chat offers "Turn this into a research run".
// No network here: pure checks plus a per-reply tally (WebTurn).

export const WEB_TURN = {
  /** From this many web_fetch calls in one reply on, each result suggests a research run. */
  nudgeAfter: 8,
  /** Not-found pages on one site before guessed addresses there are refused. */
  notFoundPerSite: 3,
  /** A hard stop for one reply: more pages than this go to a research run. */
  maxFetches: 24,
} as const;

const STRONG = [
  /<title>\s*just a moment\.{0,3}\s*<\/title>/i,
  /\bjust a moment\.\.\.?\s*(?:enable javascript|checking)/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /\bcf[-_]chl[-_]|\/cdn-cgi\/challenge-platform\/|cf-browser-verification|cf_clearance/i,
  /checking (?:if the site connection is secure|your browser before accessing)/i,
  /enable javascript and cookies to continue/i,
  /\b(?:px-captcha|perimeterx|datadome|captcha-delivery\.com|hcaptcha\.com\/1\/api|google\.com\/recaptcha|challenges\.cloudflare\.com)\b/i,
  /\bverify (?:that )?you are (?:a )?human\b/i,
  /\bare you a robot\??/i,
  /\bddos protection by\b/i,
  /\baccess denied\b[\s\S]{0,200}\b(?:bot|automated|reference #)/i,
];
const WEAK = /\bcaptcha\b|\bsecurity check\b|\bunusual traffic\b|\bblocked\b/i;

/**
 * A bot wall: a challenge page instead of the page (Cloudflare "Just a moment...", "Attention
 * Required!", captchas, DataDome/PerimeterX). `status` 0 = unknown (shell or browser output).
 */
export function isBotWall(input: { status?: number; text?: string; title?: string; headers?: { cfMitigated?: string | null; server?: string | null } }): boolean {
  const status = input.status ?? 0;
  const title = (input.title ?? '').trim();
  const text = (input.text ?? '').slice(0, 20_000);
  if (/^challenge$/i.test(input.headers?.cfMitigated ?? '')) return true;
  if (/^(just a moment\.{0,3}|attention required!?(\s*\|\s*cloudflare)?|security check|access denied|are you a robot\??)$/i.test(title)) return true;
  const hay = `${title}\n${text}`;
  if (STRONG.some((re) => re.test(hay))) return true;
  // A short page on a refusal status that talks about captchas or blocking is a wall too.
  if ((status === 403 || status === 429 || status === 503) && text.length < 4000 && WEAK.test(hay)) return true;
  return false;
}

/** The same check for text from a shell command or a browser tool (no status): strong signs only. */
export function looksLikeBotWall(output: string): boolean {
  const hay = output.slice(0, 40_000);
  return STRONG.some((re) => re.test(hay));
}

export const BOT_WALL_LINE = 'This site blocks automated readers (a bot check such as Cloudflare or a captcha), so its page can’t be read. Don’t retry it or try to get around the check: use other sources, or the snippet a web_search result already gave you.';

const hostOf = (u: URL) => u.hostname.replace(/^www\./, '').toLowerCase();

export function notFoundLine(url: URL, status: number): string {
  return `Not found (HTTP ${status}): ${url.href} doesn’t exist. Don’t guess page addresses: search for the page instead (web_search "site:${hostOf(url)} <what you are looking for>") and fetch an address from the results.`;
}

export function refusedLine(url: URL): string {
  return `Not fetched: ${WEB_TURN.notFoundPerSite} guessed addresses on ${hostOf(url)} were not found in this reply, so more guesses there are refused. Search for the page instead (web_search "site:${hostOf(url)} <what you are looking for>") and fetch an address from the results.`;
}

export function nudgeLine(n: number, canResearch: boolean): string {
  return canResearch
    ? `[You have read ${n} pages in this reply. Work this deep belongs in a research run: call research_start with the question (it plans searches, reads the pages search finds in the background with its own budget, skips sites that block readers and writes a cited report) instead of reading more pages here, or answer from what you have.]`
    : `[You have read ${n} pages in this reply. Answer from what you have now, or tell the owner what is still missing; don't keep reading page after page.]`;
}

export function capLine(): string {
  return `Not fetched: this reply already read ${WEB_TURN.maxFetches} pages. Start a research run (research_start) for the rest, or answer from what you have.`;
}

const norm = (u: string): string | null => {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href;
  } catch {
    return null;
  }
};

/** One reply's tally of web reading (created per turn; passed to web_fetch and web_search). */
export class WebTurn {
  fetches = 0;
  /** The reply passed WEB_TURN.nudgeAfter pages (the chat shows "Turn this into a research run" once). */
  offerDue = false;
  offered = false;
  readonly notFound = new Map<string, number>();
  readonly blocked = new Set<string>();
  /** Addresses a search result or a fetched page gave (never refused as guesses). */
  readonly known = new Set<string>();
  readonly canResearch: boolean;

  constructor(o: { canResearch?: boolean } = {}) {
    this.canResearch = o.canResearch === true;
  }

  noteFound(urls: Iterable<string>): void {
    for (const u of urls) {
      const k = norm(u);
      if (k && this.known.size < 5000) this.known.add(k);
    }
  }

  /** Why this fetch is refused before it runs, or null. Counts the call. */
  before(url: URL): string | null {
    const host = hostOf(url);
    const k = norm(url.href);
    if (this.fetches >= WEB_TURN.maxFetches) return capLine();
    if (this.blocked.has(host)) return BOT_WALL_LINE;
    if ((this.notFound.get(host) ?? 0) >= WEB_TURN.notFoundPerSite && !(k && this.known.has(k))) {
      this.fetches++;
      return refusedLine(url);
    }
    this.fetches++;
    return null;
  }

  notFoundOn(url: URL): void {
    const host = hostOf(url);
    this.notFound.set(host, (this.notFound.get(host) ?? 0) + 1);
  }

  blockedOn(url: URL): void {
    this.blocked.add(hostOf(url));
  }

  /** The line added to this fetch's result once the reply has read many pages ('' before that). */
  nudge(): string {
    if (this.fetches <= WEB_TURN.nudgeAfter) return '';
    if (!this.offered) this.offerDue = true;
    return `\n\n${nudgeLine(this.fetches, this.canResearch)}`;
  }

  /** True once, when the chat should offer "Turn this into a research run". */
  takeOffer(): boolean {
    if (!this.offerDue || this.offered || !this.canResearch) return false;
    this.offered = true;
    this.offerDue = false;
    return true;
  }
}
