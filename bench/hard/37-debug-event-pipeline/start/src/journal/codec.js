// Journal records, one JSON object per line. docs/JOURNAL.md describes every record type.

export class JournalError extends Error {}

const TYPES = new Set(['enq', 'fail', 'done', 'dead']);

export function encode(record) {
  if (!TYPES.has(record.t)) throw new JournalError(`unknown record type "${record.t}"`);
  return `${JSON.stringify(record)}\n`;
}

/** Splits a segment's text into records. A last line without its newline is a torn write and is skipped. */
export function decodeSegment(text, name) {
  const records = [];
  const lines = text.split('\n');
  // The piece after the last "\n" is either empty or a torn line: never a record.
  const complete = lines.length - 1;
  for (let i = 0; i < complete; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new JournalError(`${name}:${i + 1}: not valid JSON`);
    }
    if (!record || !TYPES.has(record.t) || !Number.isInteger(record.seq)) throw new JournalError(`${name}:${i + 1}: not a journal record`);
    records.push(record);
  }
  return { records, torn: !text.endsWith('\n') && text.length > 0 };
}
