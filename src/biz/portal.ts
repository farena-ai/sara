// U4.29 (docs/BUSINESS_PACK.md): the client portal link. A read-only, expiring page with ONE
// client's invoices and quotes (not drafts or void ones) and the files picked for them, built on
// EC11's share links (src/share.ts): only the token's hash is stored, the page is a frozen copy made
// when the link is made, served by `/s/<token>` without script, never indexed, revocable at once.
// No client accounts and no payments: the page shows how to pay, as written in Business details.
import type { AppContext } from '../chat.ts';
import { madeDocs } from '../documents/make.ts';
import { tr, type Lang } from '../i18n.ts';
import { MAX_SHARE_PICTURES, type ShareSnapshot, type SharePicture } from '../share.ts';
import { foldName } from '../work/clients.ts';
import { clientsOf } from '../tools/work.ts';
import { usDate } from './invoices.ts';
import { fmtMoney } from './money.ts';
import { bizStore, localDay, shownStatus } from './store.ts';

/** Share rows of portals carry this before the client's id instead of a conversation id. */
export const PORTAL_PREFIX = 'portal:';
/** Files a client may open from the page (never HTML or anything a browser would run). */
const SAFE = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

export interface PortalItem {
  number: string;
  kind: 'invoice' | 'quote';
  issued: string;
  due: string | null;
  status: string;
  total: string;
  lines: { desc: string; qty: number; amount: string }[];
  file?: number;
}
export interface PortalData {
  business: string;
  contact: string;
  payment: string;
  client: string;
  asOf: string;
  invoices: PortalItem[];
  docs: { name: string; file: number }[];
}
export type PortalSnapshot = ShareSnapshot & { portal?: PortalData };

const mimeOf = (name: string) => SAFE[(/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase() as keyof typeof SAFE];

/** Builds the frozen page for a client; throws in plain words when there is nothing to share. */
export function buildPortal(app: AppContext, client: string, o: { docs?: number[] } = {}): { snapshot: PortalSnapshot; pictures: SharePicture[]; key: string; name: string } {
  const b = bizStore(app);
  const known = clientsOf(app).find(client);
  const name = known?.name ?? client.trim();
  const f = foldName(name);
  const email = (known?.email ?? '').toLowerCase();
  if (!f) throw new Error('Say which client.');
  const today = localDay(app.now(), app.settings.get().timeZone);
  const mine = b.invoices().filter((i) => (foldName(i.clientName) === f || (email && i.clientEmail.toLowerCase() === email)) && i.status !== 'draft' && i.status !== 'void');
  if (!mine.length) throw new Error(`There are no invoices or quotes sent to ${name} yet (drafts and void ones are never shown).`);
  const pictures: SharePicture[] = [];
  const add = (fileName: string, data: Buffer | undefined): number | undefined => {
    const mime = mimeOf(fileName);
    if (!mime || !data || pictures.length >= MAX_SHARE_PICTURES) return undefined;
    pictures.push({ mime, data });
    return pictures.length - 1;
  };
  const made = madeDocs(app);
  const invoices: PortalItem[] = mine.slice(0, 40).map((i) => {
    let file: number | undefined;
    for (const id of i.docIds) {
      const m = made.get(id);
      const doc = m?.libraryId ? app.library?.get(m.libraryId) : undefined;
      if (doc && file === undefined) file = add(doc.name, app.library?.file(doc) ?? undefined);
    }
    return { number: i.number, kind: i.kind, issued: i.issued, due: i.due, status: shownStatus(i, today), total: fmtMoney(i.totalCents, i.currency), lines: i.lines.slice(0, 30).map((l) => ({ desc: l.desc, qty: l.qty, amount: fmtMoney(l.amountCents, i.currency) })), ...(file !== undefined ? { file } : {}) };
  });
  const docs: { name: string; file: number }[] = [];
  for (const id of (o.docs ?? []).slice(0, MAX_SHARE_PICTURES)) {
    const doc = app.library?.get(Number(id));
    if (!doc) throw new Error(`There is no Library document #${id}.`);
    if (!mimeOf(doc.name)) throw new Error(`“${doc.name}” can't go on the page: share PDFs or pictures.`);
    const n = add(doc.name, app.library?.file(doc) ?? undefined);
    if (n === undefined) throw new Error(`Too many files: at most ${MAX_SHARE_PICTURES} on one page.`);
    docs.push({ name: doc.name.slice(0, 160), file: n });
  }
  const biz = b.details();
  const portal = { business: biz.name || app.settings.get().ownerName || '', contact: [biz.email, biz.phone].filter(Boolean).join(' · '), payment: biz.payment, client: name, asOf: today, invoices, docs };
  return { snapshot: { title: `${name}`.slice(0, 200), companion: '', messages: [], hidden: { tools: 0, pictures: 0, scrubbed: 0 }, portal }, pictures, key: `${PORTAL_PREFIX}${known?.id ?? f}`, name };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const STATUS: Record<string, string> = { sent: 'Open', overdue: 'Overdue', paid: 'Paid', accepted: 'Accepted' };

/** The page body (src/routes/share.ts wraps it in its page). */
export function portalHtml(p: PortalData, expiresAt: string, lang: Lang, base: string): string {
  const when = (iso: string) => new Date(iso).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC';
  const rows = p.invoices
    .map((i) => {
      const what = i.kind === 'quote' ? tr('Quote', lang) : tr('Invoice', lang);
      const open = i.file !== undefined ? ` <a class="sh-file" href="${base}/p/${i.file}" rel="noopener">${esc(tr('Open the file', lang))}</a>` : '';
      const due = i.due ? ` · ${esc(i.kind === 'quote' ? tr('Valid until {date}', lang, { date: usDate(i.due) }) : tr('Due {date}', lang, { date: usDate(i.due) }))}` : '';
      return `<article class="sh-msg sh-inv sh-${esc(i.status)}"><h2 class="sh-who">${esc(what)} ${esc(i.number)} · ${esc(i.total)}</h2><p class="sh-text">${esc(tr(STATUS[i.status] ?? 'Open', lang))} · ${esc(tr('Issued {date}', lang, { date: usDate(i.issued) }))}${due}${open}</p>${i.lines.length ? `<ul class="sh-lines">${i.lines.map((l) => `<li>${esc(l.desc)} · ${l.qty} · ${esc(l.amount)}</li>`).join('')}</ul>` : ''}</article>`;
    })
    .join('');
  const docs = p.docs.length ? `<article class="sh-msg"><h2 class="sh-who">${esc(tr('Shared documents', lang))}</h2>${p.docs.map((d) => `<p class="sh-text"><a class="sh-file" href="${base}/p/${d.file}" rel="noopener">${esc(d.name)}</a></p>`).join('')}</article>` : '';
  const pay = p.payment ? `<article class="sh-msg"><h2 class="sh-who">${esc(tr('How to pay', lang))}</h2><div class="sh-text">${esc(p.payment)}</div></article>` : '';
  return `<header class="sh-head"><h1>${esc(p.client)}</h1><p class="sh-ai">${esc(tr('Invoices and documents from {name}, read-only.', lang, { name: p.business || '—' }))}${p.contact ? ` ${esc(p.contact)}` : ''}</p><p class="sh-meta">${esc(tr('As of {date}. This link stops working on {end}.', lang, { date: usDate(p.asOf), end: when(expiresAt) }))}</p></header>${rows}${docs}${pay}`;
}
