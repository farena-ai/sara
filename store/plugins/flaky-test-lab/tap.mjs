// tap.mjs: reads Node's TAP report for one exactly named top-level test (bounded, no eval).
const MAX_LINES = 20_000;

/** The result blocks of top-level tests named `name` in a TAP report, in order. */
export function blocksFor(stdout, name) {
  const lines = String(stdout).split(/\r?\n/).slice(0, MAX_LINES);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(ok|not ok) (\d+) - (.*?)(?: # (TODO|SKIP)\b ?(.*))?$/.exec(lines[i]);
    if (!m || unescape(m[3]) !== name) continue;
    const block = { ok: m[1] === 'ok', directive: m[4] ?? null, reason: m[5] ?? null, fields: {}, stack: [] };
    if (lines[i + 1] === '  ---') {
      let j = i + 2;
      for (; j < lines.length && lines[j] !== '  ...'; j++) {
        const f = /^  ([A-Za-z_]+): ?(.*)$/.exec(lines[j]);
        if (!f) continue;
        const [, key, raw] = f;
        if (raw === '|-' || raw === '|' || raw === '') {
          const body = [];
          for (j++; j < lines.length && (lines[j].startsWith('    ') || lines[j] === ''); j++) body.push(lines[j].slice(4));
          j--;
          if (key === 'stack') block.stack = body.filter(Boolean);
          else block.fields[key] = body.join('\n').trim();
        } else block.fields[key] = scalar(raw);
      }
      i = j;
    }
    out.push(block);
  }
  return out;
}

function unescape(s) {
  return s.replace(/\\#/g, '#').replace(/\\\\/g, '\\');
}

function scalar(raw) {
  const s = raw.trim();
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  return s;
}

/** A stack frame inside the job's copy (`…/<run id>/ws/…`, or `/workspace/…` under bubblewrap): path relative to the copy, line, column. */
export function copyFrame(frame) {
  const s = decodeURIComponent(String(frame).replace(/\\/g, '/'));
  const m = /(?:\/[0-9a-z]+-[0-9a-f]{8}\/ws\/|[( ]\/workspace\/|\(file:\/\/\/workspace\/)([^():]+?):(\d+):(\d+)\)?$/.exec(s);
  if (!m || s.includes('node:internal') || s.includes('/node_modules/')) return null;
  return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
}
