// N4 (docs/MAIL.md "Attachments"): files from the Library (or a file she just made in the chat) attached to
// a draft or an email. Ids: a Library document number (12, "12", "library:12") or a chat file id (the file
// card's id, e.g. from fill_document, invoice_make or an automation). Each provider has a size cap for the
// whole email (Gmail and IMAP/SMTP 20 MB; Outlook 3 MB, the size Microsoft Graph takes in one request).
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { AppContext } from '../chat.ts';
import { sharedFile } from '../bridges/media.ts';
import { mimeOf } from '../tools/send-file.ts';

export interface MailAttachment {
  name: string;
  mime: string;
  data: Buffer;
}

export const ATTACH_CAP: Record<'google' | 'graph' | 'imap', number> = { google: 20 * 1024 * 1024, graph: 3 * 1024 * 1024, imap: 20 * 1024 * 1024 };
export const MAX_ATTACHMENTS = 10;

export class AttachmentError extends Error {}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;

/** Reads each file by its id; throws AttachmentError with a plain reason. */
export function resolveAttachments(app: AppContext, ids: unknown, kind: keyof typeof ATTACH_CAP): MailAttachment[] {
  if (ids === undefined || ids === null || ids === '') return [];
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x).trim()).filter(Boolean);
  if (list.length > MAX_ATTACHMENTS) throw new AttachmentError(`At most ${MAX_ATTACHMENTS} attachments in one email.`);
  const out: MailAttachment[] = [];
  for (const raw of list) {
    const lib = /^(?:library:|#)?(\d{1,9})$/i.exec(raw);
    let path: string | undefined;
    let name = '';
    if (lib) {
      const doc = app.library?.get(Number(lib[1]));
      path = doc ? app.library?.filePath(doc) : undefined;
      if (!doc || !path || !existsSync(path)) throw new AttachmentError(`Library document ${lib[1]} has no file to attach.`);
      name = doc.name;
    } else {
      const f = sharedFile(app, raw.replace(/^file:/, ''));
      if (!f || f.status !== 'ok' || !f.path || !existsSync(f.path) || (f.expiresAt && Date.parse(f.expiresAt) < app.now().getTime())) throw new AttachmentError(`No file \u201c${raw.slice(0, 40)}\u201d to attach (it may have expired: use the Library document instead).`);
      path = f.path;
      name = f.name ?? 'file';
    }
    const size = statSync(path).size;
    if (size > ATTACH_CAP[kind]) throw new AttachmentError(`${name} is ${mb(size)}; ${kind === 'graph' ? 'Outlook' : kind === 'google' ? 'Gmail' : 'this mailbox'} takes attachments up to ${mb(ATTACH_CAP[kind])} here.`);
    out.push({ name: name.replace(/[\r\n"\\]/g, '_').slice(0, 180), mime: mimeOf(name), data: readFileSync(path) });
  }
  const total = out.reduce((n, a) => n + a.data.length, 0);
  if (total > ATTACH_CAP[kind]) throw new AttachmentError(`Together the files are ${mb(total)}; ${kind === 'graph' ? 'Outlook' : kind === 'google' ? 'Gmail' : 'this mailbox'} takes up to ${mb(ATTACH_CAP[kind])} in one email here.`);
  return out;
}

/** The N1 line for attachments: names read back from the saved draft / sent email. */
export function attachmentCheck(want: MailAttachment[], got: string[] | undefined, what: string): string {
  if (!want.length) return '';
  const names = want.map((a) => a.name);
  if (!got) return `\nCould not verify the attachments: ${what} gave no file list back (attached: ${names.join(', ')}).`;
  const missing = names.filter((n) => !got.includes(n));
  return missing.length ? `\nCould not verify: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on ${what} (it has: ${got.join(', ') || 'no attachments'}).` : `\nVerified: ${what} has the attachment${names.length === 1 ? '' : 's'} ${names.join(', ')} (read back).`;
}
