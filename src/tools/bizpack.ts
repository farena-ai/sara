// U4.29 (docs/BUSINESS_PACK.md): the business pack's chat tools on top of E6/N7.
//   invoice_from_quote  a quote becomes an invoice (same lines and tax; the quote is marked accepted)
//   invoice_send        emails an invoice or quote with its file attached, only after the person's OK
//                       on the card (it goes through mail_send), then marks it sent (due reminders)
// She never charges a card or takes a payment: the email and the portal page say how to pay.
import type { AppContext } from '../chat.ts';
import { madeDocs } from '../documents/make.ts';
import { privateLocalOn } from '../net-guard.ts';
import { KIND_WORD, usDate } from '../biz/invoices.ts';
import { fmtMoney } from '../biz/money.ts';
import { quoteInvoiceOf, setQuoteInvoice } from '../biz/pack.ts';
import { bizStore, type Invoice } from '../biz/store.ts';
import { createBizTools } from './biz.ts';
import { clientsOf } from './work.ts';
import { ToolError, type Tool, type ToolContext } from './types.ts';

export const BIZPACK_TOOLS = ['invoice_from_quote', 'invoice_send'] as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const bizTool = (getApp: () => AppContext, name: string) => createBizTools(getApp).find((t) => t.spec.name === name)!;

function invoiceOf(app: AppContext, ref: unknown): Invoice {
  const inv = bizStore(app).find(ref);
  if (!inv) throw new ToolError(`There is no invoice or quote “${String(ref ?? '')}”. invoice_list shows them.`);
  return inv;
}

/** Makes the invoice for a quote (shared by the tool and the Business page). */
export async function invoiceFromQuote(getApp: () => AppContext, ref: unknown, ctx: ToolContext, format?: string): Promise<{ text: string; invoice: Invoice }> {
  const app = getApp();
  const q = invoiceOf(app, ref);
  if (q.kind !== 'quote') throw new ToolError(`${q.number} is not a quote.`);
  if (q.status === 'void') throw new ToolError(`${q.number} was voided.`);
  const had = quoteInvoiceOf(app, q.id);
  if (had !== undefined) throw new ToolError(`${q.number} was already invoiced as ${bizStore(app).invoice(had)?.number ?? `#${had}`}.`);
  const store = bizStore(app);
  const lastId = Math.max(0, ...store.invoices().map((i) => i.id));
  const text = String(
    await bizTool(getApp, 'invoice_make').run(
      {
        kind: 'invoice',
        client: q.clientEmail ? `${q.clientName} <${q.clientEmail}>` : q.clientName,
        ...(q.clientAddress ? { client_address: q.clientAddress } : {}),
        items: q.lines.map((l) => ({ desc: l.desc, qty: l.qty, unit_price: (l.unitCents / 100).toFixed(2) })),
        tax_rate: q.taxRatePct,
        notes: `From quote ${q.number}.${q.notes ? ` ${q.notes}` : ''}`.slice(0, 2000),
        ...(format ? { format } : {}),
      },
      ctx,
    ),
  );
  const invoice = store.invoices().find((i) => i.id > lastId && i.kind === 'invoice');
  if (!invoice) throw new ToolError('The invoice could not be made.');
  setQuoteInvoice(app, q.id, invoice.id);
  if (q.status !== 'accepted') store.setInvoice(q.id, { status: 'accepted' });
  return { text: `${text}\nQuote ${q.number} is marked accepted and now points to ${invoice.number}.`, invoice };
}

/** The email for an invoice: filled into args once, so the card and the send match exactly. */
function emailOf(app: AppContext, args: Record<string, unknown>): { inv: Invoice; to: string; subject: string; body: string; attachments: string[]; files: string[] } {
  const inv = invoiceOf(app, args.id);
  if (inv.status === 'void') throw new ToolError(`${inv.number} was voided.`);
  const biz = bizStore(app).details();
  const known = clientsOf(app).find(inv.clientName, inv.clientEmail);
  const to = String(args.to ?? '').trim() || inv.clientEmail || known?.email || '';
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to)) throw new ToolError(`There is no email address for ${inv.clientName}. Ask for it and give it as to.`);
  const word = KIND_WORD[inv.kind];
  const from = biz.name || app.settings.get().ownerName || '';
  const subject = String(args.subject ?? '').trim() || `${word} ${inv.number}${from ? ` from ${from}` : ''}`;
  const total = fmtMoney(inv.totalCents, inv.currency);
  const when = inv.due ? (inv.kind === 'quote' ? `, valid until ${usDate(inv.due)}` : `, due ${usDate(inv.due)}`) : '';
  const body =
    String(args.message ?? '').trim() ||
    [`Hello,`, '', `Please find attached ${word.toLowerCase()} ${inv.number} for ${total}${when}.`, inv.kind === 'invoice' && biz.payment ? `\nHow to pay:\n${biz.payment}` : '', '', 'Thank you,', from].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
  const made = madeDocs(app);
  const docs = inv.docIds.map((id) => made.get(id)).filter((m) => m?.libraryId && app.library?.get(m.libraryId));
  if (!docs.length) throw new ToolError(`${inv.number} has no file to attach. Make it again with invoice_make.`);
  args.to = to;
  args.subject = subject;
  args.message = body;
  return { inv, to, subject, body, attachments: docs.map((m) => String(m!.libraryId)), files: docs.map((m) => m!.name) };
}

export function createBizPackTools(getApp: () => AppContext): Tool[] {
  const fromQuote: Tool = {
    spec: {
      name: 'invoice_from_quote',
      description: 'Turn an accepted (or sent) quote into an invoice: same client, lines and tax, numbered as a new invoice with its PDF; the quote is marked accepted. A quote is invoiced once.',
      parameters: obj({ id: { type: 'string', description: 'The quote number (Q-2026-0003) or "3".' }, format: { type: 'string', enum: ['pdf', 'docx', 'both'] } }, ['id']),
    },
    defaultPermission: 'auto',
    summarize: (a) => `Invoice quote ${String(a.id ?? '?')}`,
    async run(args, ctx) {
      return (await invoiceFromQuote(getApp, args.id, ctx, typeof args.format === 'string' ? args.format : undefined)).text;
    },
  };

  const send: Tool = {
    spec: {
      name: 'invoice_send',
      description:
        "Email an invoice or quote to the client with its file attached, from the person's mailbox. The person sees the exact email on a card and approves it first. Then it is marked sent (reminders before it is due). Never takes a payment or charges a card: the email says how to pay.",
      parameters: obj({ id: { type: 'string', description: 'The number (INV-2026-0003) or "3".' }, to: { type: 'string', description: "Default: the client's email." }, subject: { type: 'string' }, message: { type: 'string', description: 'The email text; default: a short note with the total, due date and how to pay.' } }, ['id']),
    },
    defaultPermission: 'ask',
    isAvailable: () => !privateLocalOn() && Boolean(getApp().tools.get('mail_send')) && (getApp().tools.get('mail_send')!.isAvailable?.() ?? true),
    summarize: (a) => `SEND invoice ${String(a.id ?? '?')} by email${a.to ? ` to ${String(a.to)}` : ''}`,
    async prepare(args) {
      try {
        const e = emailOf(getApp(), args);
        return { summary: `SEND ${KIND_WORD[e.inv.kind].toLowerCase()} ${e.inv.number} (${fmtMoney(e.inv.totalCents, e.inv.currency)})\nTo: ${e.to}\nSubject: ${e.subject}\nAttached: ${e.files.join(', ')}\n\n${e.body.slice(0, 4000)}` };
      } catch (err) {
        return { refuse: `Error: ${(err as Error).message}` };
      }
    },
    async run(args, ctx) {
      const app = getApp();
      const e = emailOf(app, args);
      const mail = app.tools.get('mail_send');
      if (!mail) throw new ToolError('No mailbox is connected: connect one in Settings → Connections → Email and calendar.');
      const sent = String(await mail.run({ to: e.to, subject: e.subject, body: e.body, attachments: e.attachments }, ctx));
      let marked = '';
      if (e.inv.status === 'draft') marked = String(await bizTool(getApp, 'invoice_mark').run({ id: e.inv.number, status: 'sent' }, ctx));
      return `${sent}\n${marked ? `Marked sent: ${marked}` : `${e.inv.number} was already ${e.inv.status}; its status is unchanged.`}`;
    },
  };
  return [fromQuote, send];
}
