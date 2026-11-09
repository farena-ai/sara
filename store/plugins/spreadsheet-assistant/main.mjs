import { plugin } from './native.mjs';
import { only, text, result, tool } from './workflow.mjs';
// Strict comma-separated UTF-8 text. Quotes may contain CR/LF and doubled quotes.
function parseCSV(input) {
  const s = input.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', state = 'plain', touched = false;
  const field = () => { if (cell.length > 1000) throw new Error('Cell exceeds 1000 characters.'); row.push(cell); cell = ''; if (row.length > 12) throw new Error('At most 12 columns.'); };
  const line = () => { field(); rows.push(row); row = []; touched = false; if (rows.length > 51) throw new Error('At most 50 data rows.'); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]; touched = true;
    if (state === 'quoted') {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else state = 'closed'; }
      else cell += c;
      continue;
    }
    if (c === ',') { field(); state = 'plain'; continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && s[i + 1] === '\n') i++; line(); state = 'plain'; continue; }
    if (state === 'closed') throw new Error('Unexpected character after closing quote.');
    if (c === '"') { if (cell) throw new Error('Quote must start a field.'); state = 'quoted'; }
    else cell += c;
  }
  if (state === 'quoted') throw new Error('Unclosed quoted field.');
  if (touched || row.length || cell) line();
  if (!rows.length) throw new Error('Supply a header row.');
  const headers = rows.shift();
  if (headers.some(h => !h.trim()) || new Set(headers).size !== headers.length) throw new Error('Headers must be nonempty and unique.');
  if (rows.some(r => r.length !== headers.length)) throw new Error('Every row must match header width.');
  return { headers, rows };
}
const numeric = s => /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s.trim()) && Number.isFinite(Number(s));
plugin({ tools: [tool('Validate and profile supplied CSV, optionally exact-match filter, and return spreadsheet-safe CSV text. No XLSX, formula evaluation, file writes or model arithmetic.', async args => {
  only(args, ['csv', 'filter']);
  text(args.csv, 'csv', 12000); // Validate bounds without normalizing source cells.
  const { headers, rows } = parseCSV(args.csv);
  const columns = headers.map((name, i) => {
    const values = rows.map(r => r[i]), nums = values.filter(numeric).map(Number);
    const sum = nums.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum)) throw new Error('Numeric sum overflow.');
    return { name, empty: values.filter(v => v.trim() === '').length, numeric: nums.length, sum: nums.length ? sum : null, min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null, mean: nums.length ? sum / nums.length : null };
  });
  let selected = rows;
  if (args.filter !== undefined) {
    only(args.filter, ['column', 'equals']); const name = text(args.filter.column, 'filter.column', 100), equal = text(args.filter.equals, 'filter.equals', 1000, true);
    const i = headers.indexOf(name); if (i < 0) throw new Error('Filter column is not in the header.'); selected = rows.filter(r => r[i] === equal);
  }
  let formulaEscapes = 0;
  const quote = value => {
    // Escape all potential formulas, even numeric -/+ cells, before RFC-style quoting.
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value)) { value = "'" + value; formulaEscapes++; }
    return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  };
  const exported = [headers, ...selected].map(r => r.map(quote).join(',')).join('\r\n') + '\r\n';
  return result({ rows: rows.length, selectedRows: selected.length, columns, formulaEscapes, export: { filename: 'reviewed.csv', mime: 'text/csv', text: exported }, warning: 'Statistics cover all input rows, not just the filter. Numeric subset only; JS floating-point arithmetic. No formulas evaluated. Export prefixes risky cells with apostrophes; review before import.' });
})] });
