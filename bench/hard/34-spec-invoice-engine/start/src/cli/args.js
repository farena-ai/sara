// Command-line arguments: `tally <command> <file> [--json] [--lang en|de] [--lines A:2,B]
// [--number N] [--date YYYY-MM-DD]`.

export class UsageError extends Error {}

const FLAGS = new Set(['json']);
const OPTIONS = new Set(['lang', 'lines', 'number', 'date']);

export function parseArgs(argv) {
  const out = { command: null, file: null, json: false, lang: 'en', lines: null, number: null, date: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split('=', 2);
    if (FLAGS.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      out[name] = true;
    } else if (OPTIONS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      out[name] = value;
    } else {
      throw new UsageError(`unknown option --${name}`);
    }
  }
  if (rest.length !== 2) throw new UsageError('usage: tally <calc|credit> <invoice.json> [options]');
  [out.command, out.file] = rest;
  if (!['calc', 'credit'].includes(out.command)) throw new UsageError(`unknown command ${out.command}`);
  if (out.lines !== null) out.lines = parseCreditLines(out.lines);
  return out;
}

/** "A:2,B" -> [{ id: "A", quantity: "2" }, { id: "B" }] */
export function parseCreditLines(s) {
  return s.split(',').map((part) => {
    const [id, quantity] = part.split(':');
    if (!id) throw new UsageError(`bad --lines entry "${part}"`);
    return quantity === undefined ? { id } : { id, quantity };
  });
}
