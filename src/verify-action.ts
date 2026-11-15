// N1 (docs/design/NEXT.md "Did it work?"): after a tool that changes something, a small read-back
// whose one line joins the tool's result: "Verified: ..." or "Could not verify: ...". She reads it
// before she answers, and src/receipts.ts holds "done / saved / sent / added" claims to it.
// Read-only tools get nothing. Tools that can only check from the inside (mail, calendars) write
// their own line (src/tools/google.ts, src/tools/mail.ts); this layer then leaves them alone.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolveInside } from './tools/workspace.ts';

export const VERIFIED = 'Verified:';
export const NOT_VERIFIED = 'Could not verify:';

/** The tools that change something and get a "did it work?" line. */
export const VERIFY_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'fill_document',
  'make_document',
  'invoice_make',
  'mail_draft',
  'mail_send',
  'gmail_draft',
  'gmail_send',
  'calendar_add',
  // R6 (docs/WORK_APPS.md): each reads its change back itself.
  'gdoc_append',
  'gdoc_replace_text',
  'gsheet_update_range',
  'gsheet_append_rows',
  'excel_update_range',
  'word_fill',
  'slack_post',
  'slack_react',
  'slack_status',
  'slack_remind',
  'todo',
  'change_setting',
  'pc_run',
  'pc_click',
  'pc_type',
  'pc_keys',
  'pc_scroll',
  'pc_open_app',
  'pc_drag',
]);

/** What the checks may read (tests pass fakes). */
export interface VerifyDeps {
  /** Her workspace folder (file tools). */
  wsDir?: string;
  readFile?: (abs: string) => Promise<Buffer>;
  /** A made document by number (make_document, fill_document, invoice_make). */
  madeDoc?: (id: number) => { name?: string; title?: string } | undefined;
  /** A planner task by number. */
  task?: (id: number) => { id: number; title: string; status: string } | undefined;
  /** The saved name she calls the owner (change_setting name). */
  ownerName?: () => string | undefined;
}

/** "Verified: ..." / "Could not verify: ..." already in a tool's own output. */
export function verifyState(output: string): 'verified' | 'unverified' | undefined {
  if (new RegExp(`^${NOT_VERIFIED}`, 'm').test(output)) return 'unverified';
  if (new RegExp(`^${VERIFIED}`, 'm').test(output)) return 'verified';
  return undefined;
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const ok = (s: string) => `${VERIFIED} ${s}`;
const no = (s: string) => `${NOT_VERIFIED} ${s}`;

/**
 * The one line for a changing tool's successful result (undefined for tools that change nothing,
 * and for results that already say whether they were verified).
 */
export async function verifyAction(name: string, args: Record<string, unknown>, output: string, deps: VerifyDeps = {}): Promise<string | undefined> {
  if (!VERIFY_TOOLS.has(name) || verifyState(output)) return undefined;
  try {
    switch (name) {
      case 'write_file':
      case 'edit_file':
        return await verifyFile(name, args, deps);
      case 'fill_document': {
        if (/Nothing was filled/.test(output)) return no('nothing was filled, so there is no filled copy.');
        if (/Tell them in a sentence that it is filled in\./.test(output)) return ok('the filled copy was read back and every field is filled (the report above).');
        if (/Don't say the form is filled/.test(output)) return no('not every field is filled (the report above says which).');
        return docLine(output, deps) ?? no('the filled copy could not be read back.');
      }
      case 'make_document':
      case 'invoice_make':
        return docLine(output, deps) ?? no('no saved document number came back.');
      case 'mail_draft':
      case 'mail_send':
      case 'gmail_draft':
      case 'gmail_send':
        return no(name.endsWith('send') ? 'the mail service gave no id for the sent email.' : 'the mail service gave no id for the draft.');
      case 'calendar_add':
        return /\(event [^)\s]+\)/.test(output) ? no('the calendar returned an event id but it was not read back.') : no('the calendar returned no event id.');
      case 'todo': {
        const action = String(args.action ?? 'add');
        if (action === 'list') return undefined;
        const id = Number(/#(\d+)/.exec(output)?.[1]);
        if (!id || !deps.task) return no('the task was not read back.');
        const t = deps.task(id);
        if (action === 'delete') return t ? no(`task #${id} is still there.`) : ok(`task #${id} is gone.`);
        if (!t) return no(`task #${id} is not in the planner.`);
        if (action === 'done' && t.status !== 'done' && !/repeats/.test(output)) return no(`task #${id} is not marked done.`);
        return ok(`read task #${id} back from the planner ("${t.title.slice(0, 80)}", ${t.status}).`);
      }
      case 'change_setting': {
        if (String(args.setting) === 'name' || /From now on call them/.test(output)) {
          const want = /is now "([^"]*)"/.exec(output)?.[1];
          const have = deps.ownerName?.();
          return want !== undefined && have === want ? ok(`the saved name reads "${have}".`) : no('the saved name did not read back as asked.');
        }
        return no('this setting is applied by the device they are using (the card in the chat shows it).');
      }
      case 'pc_run': {
        if (/^Timed out after/m.test(output)) return no('the command timed out.');
        if (/^Stopped on/m.test(output)) return no('the command was stopped.');
        const code = /exit code (-?\d+|unknown)/.exec(output)?.[1];
        if (code === undefined || code === 'unknown') return no('no exit code came back.');
        return code === '0' ? ok('exit code 0.') : no(`exit code ${code} (not 0).`);
      }
      default: {
        // Desktop actions: the existing fresh look after the action (src/tools/computer.ts).
        const fresh = /Fresh verification: (.*)$/m.exec(output)?.[1];
        if (fresh === undefined) return undefined;
        return fresh && !/^\(no accessible elements returned\)$/.test(fresh.trim()) ? ok('looked at the window again after the action (above).') : no('the fresh look after the action returned nothing.');
      }
    }
  } catch (err) {
    return no(`the read-back failed (${(err as Error).message.replace(/\s+/g, ' ').slice(0, 120)}).`);
  }
}

async function verifyFile(name: string, args: Record<string, unknown>, deps: VerifyDeps): Promise<string> {
  if (!deps.wsDir) return no('no workspace to read the file back from.');
  const path = String(args.path ?? '');
  const abs = resolveInside(deps.wsDir, path);
  const buf = await (deps.readFile ?? ((p: string) => readFile(p)))(abs);
  const short = sha(buf).slice(0, 12);
  if (name === 'write_file') {
    const want = typeof args.content === 'string' ? args.content : '';
    return sha(Buffer.from(want)) === sha(buf) ? ok(`read ${path} back (${buf.length} bytes, sha256 ${short}), the same as written.`) : no(`${path} reads back different from what was written.`);
  }
  const put = typeof args.new_string === 'string' ? args.new_string : '';
  const text = buf.toString('utf8');
  const found = !put || text.includes(put) || text.includes(put.replace(/\r?\n/g, '\r\n'));
  return found ? ok(`read ${path} back (sha256 ${short}); the new text is there.`) : no(`the new text is not in ${path} when read back.`);
}

function docLine(output: string, deps: VerifyDeps): string | undefined {
  const id = Number(/document #(\d+)/.exec(output)?.[1]);
  if (!id) return undefined;
  if (!deps.madeDoc) return no(`document #${id} was not read back.`);
  const d = deps.madeDoc(id);
  return d ? ok(`document #${id} is saved ("${String(d.name ?? d.title ?? '').slice(0, 80)}").`) : no(`document #${id} is not in her documents.`);
}
