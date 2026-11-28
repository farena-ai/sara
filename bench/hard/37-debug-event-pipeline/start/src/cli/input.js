// Reads an events file: one JSON event per line ({ "id", "key", "data" }); blank lines and lines starting
// with "#" are skipped.
import { readFileSync } from 'node:fs';
import { UsageError } from './args.js';

export function readEvents(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
  const events = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      throw new UsageError(`${file}:${i + 1}: not valid JSON`);
    }
    if (typeof event?.id !== 'string' || typeof event?.key !== 'string') throw new UsageError(`${file}:${i + 1}: an event needs "id" and "key"`);
    events.push(event);
  });
  return events;
}

/** "--lock acct-3:1500" → { account: "acct-3", until: 1500 } */
export function parseLock(text) {
  const m = /^(.+):(\d+)$/.exec(text);
  if (!m) throw new UsageError(`--lock wants ACCOUNT:UNTIL_MS (got "${text}")`);
  return { account: m[1], until: Number(m[2]) };
}
