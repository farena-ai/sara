// The `tally` command: prints an invoice or credit note for an invoice document.
import { calculateInvoice } from '../engine/invoice.js';
import { createCreditNote } from '../credit/creditNote.js';
import { InvoiceError } from '../errors.js';
import { loadInvoice } from '../io/load.js';
import { renderText } from '../render/text.js';
import { parseArgs, UsageError } from './args.js';

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n`);
      return 2;
    }
    throw e;
  }
  try {
    const doc = loadInvoice(args.file);
    const result =
      args.command === 'calc'
        ? calculateInvoice(doc)
        : createCreditNote(doc, { ...(args.lines ? { lines: args.lines } : {}), ...(args.number ? { number: args.number } : {}), ...(args.date ? { issueDate: args.date } : {}) });
    io.out(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderText(result, args.lang));
    return 0;
  } catch (e) {
    if (e instanceof InvoiceError) {
      io.err(`error: ${e.message}\n`);
      return 1;
    }
    if (e && e.code === 'ENOENT') {
      io.err(`error: no such file ${args.file}\n`);
      return 1;
    }
    throw e;
  }
}
