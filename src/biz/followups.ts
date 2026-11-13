// E6 (docs/BUSINESS_TOOLS.md): "who do I owe a reply". From the person's connected mailboxes (Gmail
// through the Google sign-in, Outlook and IMAP through src/mail), the conversations whose last
// message is someone else's, addressed to them (not just copied), not a newsletter, no-reply sender
// or automated message, waiting longer than N days. Ranked by code: a question, written to them
// alone, unread, a back-and-forth, then age. The filter is a pure function so it is tested on
// fixture threads; the gathering only reads (drafting a reply goes through mail_draft / gmail_draft,
// which ask first; nothing is ever sent from here).
import type { AppContext } from '../chat.ts';
import { addressOf, type MailMessage } from '../mail/types.ts';

export interface ThreadTip {
  account: string;
  threadId: string;
  /** The last message's id (reply_to for mail_draft / gmail_draft). */
  latestId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  count: number;
  /** The last message is the person's own (already answered). */
  fromMe: boolean;
  headers: Record<string, string>;
  /** Gmail's category (promotions, social, updates, forums), when known. */
  category?: string;
}

export interface FollowUp extends ThreadTip {
  ageDays: number;
  score: number;
  why: string[];
}

const AUTOMATED_FROM = /\b(?:no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|newsletter|news|digest|alerts?|bounce|automated|auto-confirm|receipts?|billing|marketing|updates?)@/i;
const AUTOMATED_SUBJECT = /\b(?:receipt|your order|order confirmation|shipped|delivery|verification code|verify your|password reset|sign-?in|security alert|invoice #?\d+ (?:is )?(?:paid|available)|unsubscribe|newsletter|webinar|out of office|automatic reply|auto-?reply)\b/i;

/** Is this from a real person writing to them (not a list, bulk mail or a machine)? */
export function looksAutomated(t: Pick<ThreadTip, 'from' | 'subject' | 'headers' | 'category'>): boolean {
  const h = t.headers;
  if (h['list-unsubscribe'] || h['list-id']) return true;
  if (/bulk|list|junk/i.test(h.precedence ?? '')) return true;
  if (/auto-/i.test(h['auto-submitted'] ?? '')) return true;
  if (t.category && /promotions|social|updates|forums/i.test(t.category)) return true;
  if (AUTOMATED_FROM.test(t.from)) return true;
  return AUTOMATED_SUBJECT.test(t.subject);
}

const listHas = (list: string, me: string[]) => {
  const l = list.toLowerCase();
  return me.some((m) => m && l.includes(m));
};

/** The ranked list: waiting at least `minDays`, newest look-back first by score. Pure (tests use fixtures). */
export function rankFollowUps(threads: ThreadTip[], me: string[], now: Date, minDays = 2): FollowUp[] {
  const mine = me.map((m) => m.toLowerCase().trim()).filter(Boolean);
  const out: FollowUp[] = [];
  for (const t of threads) {
    if (t.fromMe || mine.includes(addressOf(t.from))) continue;
    if (looksAutomated(t)) continue;
    // Addressed to them: in To (being only copied doesn't count as owing a reply).
    if (mine.length && !listHas(t.to, mine)) continue;
    const ageDays = Math.floor((now.getTime() - Date.parse(t.date)) / 86_400_000);
    if (!Number.isFinite(ageDays) || ageDays < minDays) continue;
    const why: string[] = [];
    let score = 0;
    if (/\?/.test(t.snippet) || /\?\s*$/.test(t.subject)) {
      score += 3;
      why.push('asks a question');
    }
    const toCount = t.to.split(',').filter((x) => x.includes('@')).length + t.cc.split(',').filter((x) => x.includes('@')).length;
    if (toCount <= 1) {
      score += 2;
      why.push('written to you alone');
    }
    if (t.unread) {
      score += 1;
      why.push('unread');
    }
    if (t.count > 1) {
      score += 1;
      why.push(`${t.count} messages`);
    }
    // Waiting longer weighs more, up to two weeks; very old threads drift down.
    score += ageDays <= 14 ? ageDays * 0.25 : Math.max(0, 3.5 - (ageDays - 14) * 0.1);
    out.push({ ...t, ageDays, score: Math.round(score * 100) / 100, why });
  }
  return out.sort((a, b) => b.score - a.score || Date.parse(a.date) - Date.parse(b.date));
}

const fromMessage = (account: string, m: MailMessage, count: number, me: string): ThreadTip => ({
  account,
  threadId: m.threadId,
  latestId: m.id,
  from: m.from,
  to: m.to,
  cc: m.cc ?? '',
  subject: m.subject,
  date: m.date,
  snippet: m.snippet,
  unread: m.unread,
  count,
  fromMe: addressOf(m.from) === me || Boolean(m.headers.sent),
  headers: m.headers,
  ...(m.focused === false ? { category: 'other' } : {}),
});

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
type GPart = { headers?: { name: string; value: string }[] };
type GMsg = { id: string; threadId: string; snippet?: string; labelIds?: string[]; payload?: GPart };
const gh = (p: GPart | undefined, n: string) => p?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? '';

/** Every connected mailbox's recent inbox conversations (read only). Errors per mailbox are reported, not thrown. */
export async function gatherThreads(app: AppContext, lookbackDays: number, signal?: AbortSignal): Promise<{ threads: ThreadTip[]; me: string[]; mailboxes: string[]; problems: string[] }> {
  const accounts = app.mailAccounts;
  const threads: ThreadTip[] = [];
  const me: string[] = [];
  const mailboxes: string[] = [];
  const problems: string[] = [];
  for (const a of accounts?.list() ?? []) {
    if (a.problem) {
      problems.push(`${a.address}: ${a.problem}`);
      continue;
    }
    me.push(a.address.toLowerCase());
    mailboxes.push(a.address);
    try {
      if (a.kind === 'google') {
        if (!app.google) continue;
        const q = `in:inbox newer_than:${lookbackDays}d -from:me`;
        const list = (await app.google.api(`${GMAIL}/threads?${new URLSearchParams({ q, maxResults: '40' })}`, { signal })) as { threads?: { id: string }[] };
        const H = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted'];
        const full = await Promise.all((list.threads ?? []).map((t) => app.google!.api(`${GMAIL}/threads/${t.id}?format=metadata&${H.map((h) => `metadataHeaders=${h}`).join('&')}`, { signal }) as Promise<{ id: string; messages?: GMsg[] }>));
        for (const t of full) {
          const last = t.messages?.at(-1);
          if (!last) continue;
          const p = last.payload;
          const cat = last.labelIds?.find((l) => /^CATEGORY_(PROMOTIONS|SOCIAL|UPDATES|FORUMS)$/.test(l));
          threads.push({
            account: a.address,
            threadId: t.id,
            latestId: last.id,
            from: gh(p, 'From'),
            to: gh(p, 'To'),
            cc: gh(p, 'Cc'),
            subject: gh(p, 'Subject'),
            date: new Date(gh(p, 'Date') || 0).toISOString(),
            snippet: last.snippet ?? '',
            unread: Boolean(last.labelIds?.includes('UNREAD')),
            count: t.messages?.length ?? 1,
            fromMe: Boolean(last.labelIds?.includes('SENT')),
            headers: { 'list-unsubscribe': gh(p, 'List-Unsubscribe'), 'list-id': gh(p, 'List-Id'), precedence: gh(p, 'Precedence'), 'auto-submitted': gh(p, 'Auto-Submitted') },
            ...(cat ? { category: cat.slice(9).toLowerCase() } : {}),
          });
        }
      } else {
        for (const g of await accounts!.provider(a.id).recentInbox(lookbackDays, 60, signal)) threads.push(fromMessage(a.address, g.latest, g.count, a.address.toLowerCase()));
      }
    } catch (err) {
      problems.push(`${a.address}: ${(err as Error).message}`);
    }
  }
  return { threads, me, mailboxes, problems };
}
