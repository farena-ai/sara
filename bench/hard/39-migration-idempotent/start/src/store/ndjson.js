// NDJSON files: one JSON value per line. Reading keeps every non-blank line in order, parsed when it is a JSON
// object; anything else comes back as { raw } so a migration step can quarantine it.
import { canonical } from './canonical.js';

export function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value;
    try {
      value = JSON.parse(trimmed);
    } catch {
      out.push({ raw: line.replace(/\r$/, '') });
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push({ record: value });
    else out.push({ raw: line.replace(/\r$/, '') });
  }
  return out;
}

/** Records as file content: canonical JSON, one per line, each line ending in "\n" (empty: ""). */
export function formatLines(records) {
  return records.map((r) => `${canonical(r)}\n`).join('');
}
