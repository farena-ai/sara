// N3 (docs/INBOX_HELPER.md): the inbox helper's reader over the connected mailboxes (read only).
// Gmail through its API (format=full: text, HTML for JSON-LD, attachment names), Outlook and IMAP
// through the M1 providers (src/mail). Only inbox messages newer than the cursor, at most `max`.
import type { AppContext } from '../chat.ts';
import type { SearchTerms } from '../mail/search.ts';
import type { InboxMail } from './classify.ts';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
type GPart = { mimeType?: string; filename?: string; headers?: { name: string; value: string }[]; body?: { data?: string; attachmentId?: string; size?: number }; parts?: GPart[] };
const gh = (p: GPart | undefined, n: string) => p?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? '';
const b64 = (s: string | undefined) => (s ? Buffer.from(s, 'base64url').toString('utf8') : '');
const walk = (p: GPart | undefined, out: GPart[] = []): GPart[] => {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
};

const googleOf = (app: AppContext, id: string) => (id === 'google' ? app.google : undefined) ?? app.mailAccounts?.googleOf?.(id);

function accountOf(app: AppContext, address: string) {
  const a = app.mailAccounts?.list().find((x) => x.address.toLowerCase() === address.toLowerCase());
  if (!a) throw new Error('That mailbox is not connected any more.');
  if (a.problem) throw new Error(a.problem);
  return a;
}

export async function readNewMail(app: AppContext, o: { account: string; since: Date; seen: ReadonlySet<string>; max: number; signal: AbortSignal }): Promise<InboxMail[]> {
  const a = accountOf(app, o.account);
  const out: InboxMail[] = [];
  if (a.kind === 'google') {
    // MULTIMAIL: each Google account through its own sign-in.
    const g = googleOf(app, a.id);
    if (!g) return out;
    const q = `in:inbox after:${Math.floor(o.since.getTime() / 1000)} -from:me`;
    const list = (await g.api(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(o.max) })}`, { signal: o.signal })) as { messages?: { id: string }[] };
    for (const { id } of list.messages ?? []) {
      if (o.seen.has(id)) continue;
      const m = (await g.api(`${GMAIL}/messages/${id}?format=full`, { signal: o.signal })) as { id: string; internalDate?: string; snippet?: string; payload?: GPart };
      const parts = walk(m.payload);
      const plain = parts.find((p) => p.mimeType === 'text/plain' && !p.filename);
      const html = parts.find((p) => p.mimeType === 'text/html' && !p.filename);
      out.push({ account: a.address, id: m.id, from: gh(m.payload, 'From'), subject: gh(m.payload, 'Subject'), date: new Date(Number(m.internalDate ?? 0) || Date.parse(gh(m.payload, 'Date')) || 0).toISOString(), text: b64(plain?.body?.data).slice(0, 60_000), html: b64(html?.body?.data).slice(0, 300_000), attachments: parts.filter((p) => p.filename && p.body?.attachmentId).map((p) => p.filename!) });
    }
    return out;
  }
  const p = app.mailAccounts!.provider(a.id);
  const terms: SearchTerms = { from: [], to: [], subject: [], words: [], notFrom: [], notWords: [], folder: 'inbox', after: o.since.getTime() };
  const { ids } = await p.searchIds(terms, o.max, o.signal);
  for (const id of ids) {
    if (o.seen.has(id)) continue;
    const m = p.withHtml ? await p.withHtml(id, o.signal) : await p.get(id, o.signal);
    if (m.headers.sent || m.from.toLowerCase().includes(a.address.toLowerCase())) continue;
    out.push({ account: a.address, id: m.id, from: m.from, subject: m.subject, date: m.date, text: (m.text ?? '').slice(0, 60_000), ...(m.html ? { html: m.html } : {}), ...(m.attachments?.length ? { attachments: m.attachments } : {}) });
  }
  return out;
}

export async function readAttachment(app: AppContext, account: string, mailId: string, name: string, signal: AbortSignal): Promise<{ name: string; mime: string; data: Buffer } | undefined> {
  const a = accountOf(app, account);
  if (a.kind === 'google') {
    const g = googleOf(app, a.id);
    if (!g) return undefined;
    const m = (await g.api(`${GMAIL}/messages/${mailId}?format=full`, { signal })) as { payload?: GPart };
    const part = walk(m.payload).find((p) => p.filename === name && p.body?.attachmentId);
    if (!part) return undefined;
    const got = (await g.api(`${GMAIL}/messages/${mailId}/attachments/${part.body!.attachmentId}`, { signal })) as { data?: string };
    return got.data ? { name, mime: part.mimeType ?? 'application/octet-stream', data: Buffer.from(got.data, 'base64url') } : undefined;
  }
  const p = app.mailAccounts!.provider(a.id);
  return p.attachment ? p.attachment(mailId, name, signal) : undefined;
}
