// V1 design §5 (chat): each turn's head line, name · time · how long she took. Only data already in
// the message rows (createdAt, role, meta.speaker); nothing is written back. No imports and no DOM,
// so the tests run it in Node; app.js builds the elements.

/** A stored timestamp as a Date ('YYYY-MM-DD HH:MM:SS' rows are UTC), or null. */
export function rowDate(iso) {
  if (!iso) return null;
  const s = String(iso);
  const d = new Date(s.replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** How long a reply took, in words: "4 s", "1 min", "12 min"; '' when unknown, zero or over an hour. */
export function durationWords(ms, t) {
  if (!Number.isFinite(ms) || ms < 1000 || ms >= 3_600_000) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? t('{n} s', { n: s }) : t('{n} min', { n: Math.round(s / 60) });
}

/**
 * The head of each turn in `messages` (by index): { name, iso, ms } for your messages and for the
 * first of her consecutive replies; ms = her reply's time minus your message before it. Other rows
 * (notices, a companion speaking in a group, the second part of one reply) get none.
 */
export function turnHeads(messages, { herName, youName }) {
  const out = new Map();
  let lastUser = null;
  let prev = null;
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.set(i, { who: 'you', name: youName, iso: m.createdAt ?? '', ms: NaN });
      lastUser = m;
    } else if (m.role === 'assistant' && !m.meta?.speaker && !m.meta?.groupFrom && !(prev?.role === 'assistant' && !prev.meta?.speaker)) {
      const a = rowDate(m.createdAt), u = rowDate(lastUser?.createdAt);
      out.set(i, { who: 'her', name: herName, iso: m.createdAt ?? '', ms: a && u ? a - u : NaN });
      lastUser = null;
    }
    if (m.role === 'user' || m.role === 'assistant') prev = m; // tool rows sit inside one reply
  });
  return out;
}
