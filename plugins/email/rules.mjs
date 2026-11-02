// The email bridge's rules (BRIDGES3 §5.5–§5.9), checked against the official RFC text
// (rfc-editor.org, read 2026-11-01):
//
// - RFC 8601 (Authentication-Results): §2.2 `authres-payload = [CFWS] authserv-id [ CFWS
//   authres-version ] ( no-result / 1*resinfo )`, `resinfo = ";" methodspec [reasonspec] *propspec`,
//   `methodspec = method "=" result`, `propspec = ptype "." property "=" pvalue`. §5: a receiving MTA
//   "MUST delete any discovered instance of this header field that claims, by virtue of its
//   authentication service identifier, to have been added within its trust boundary but that did
//   not come directly from another trusted MTA" — so only a header carrying HIS provider's own id
//   can be believed, and Sara (not this plugin) picks it by the id learned at linking.
// - RFC 7489 (DMARC): §3.1.1 relaxed alignment: "the Organizational Domains of both the
//   [DKIM]-authenticated signing domain (taken from the value of the "d=" tag in the signature) and
//   that of the RFC5322.From domain must be equal"; §3.1.2 the same for SPF's MAIL FROM domain;
//   §3.2 the Organizational Domain is the public suffix plus one label (a short built-in list here,
//   never a bare public suffix such as co.uk).
// - RFC 3834 (automatic responses): §2 "Automatic responses SHOULD NOT be issued in response to any
//   message which contains an Auto-Submitted header field … where that field has any value other
//   than \"no\""; §5 `auto-submitted = "no" / "auto-generated" / "auto-replied" / extension`.
// - RFC 2369 / RFC 2919 (List-* headers, List-Id): mailing lists and newsletters.
// - RFC 3464 (delivery status notifications): `multipart/report; report-type=delivery-status`, sent
//   with an empty return path (RFC 5321 §4.5.5 `MAIL FROM:<>`).
// - RFC 5322 §3.6.4: replies carry In-Reply-To (the parent's Message-ID) and References (the
//   parent's References followed by the parent's Message-ID).

import { domainOf, msgIds, parseAddresses } from './mime.mjs';

// ------------------------------------------------------------------ sender checks

/** A short list of public suffixes with two labels (RFC 7489 §3.2's Organizational Domain). */
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'co.za', 'co.in', 'co.kr', 'com.cn', 'com.tw', 'com.hk', 'com.sg', 'com.tr', 'co.il', 'com.es', 'com.pt', 'co.it', 'gv.at', 'co.at', 'or.at', 'com.pl', 'co.id', 'com.my', 'com.ph', 'com.vn', 'com.ua', 'com.ru', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec']);

export function orgDomain(d) {
  const labels = String(d ?? '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return '';
  const two = labels.slice(-2).join('.');
  if (TWO_LABEL_SUFFIXES.has(two)) return labels.length >= 3 ? labels.slice(-3).join('.') : '';
  return two;
}

/** RFC 7489 §3.1 relaxed alignment (never a bare public suffix). */
export function aligned(domain, fromDomain) {
  const a = orgDomain(domain);
  return Boolean(a) && a === orgDomain(fromDomain) && String(domain).toLowerCase() !== a.split('.').slice(1).join('.');
}

function stripCfws(s) {
  let out = '';
  let depth = 0;
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      if (!depth) out += s[i + 1];
      i++;
      continue;
    }
    if (ch === '"' && !depth) {
      q = !q;
      continue;
    }
    if (!q && ch === '(') {
      depth++;
      continue;
    }
    if (!q && ch === ')' && depth) {
      depth--;
      continue;
    }
    if (!depth) out += ch;
  }
  return out;
}

/** One Authentication-Results value → `{ authserv, results: [{ method, result, props }] }` (RFC 8601 §2.2). */
export function parseAuthResults(v) {
  const s = stripCfws(String(v ?? '')).replace(/\s+/g, ' ').trim();
  const parts = s.split(';').map((x) => x.trim());
  const first = (parts.shift() ?? '').split(' ');
  const authserv = (first[0] ?? '').toLowerCase();
  const results = [];
  for (const p of parts) {
    if (!p || p.toLowerCase() === 'none') continue;
    const toks = p.split(' ').filter(Boolean);
    const m = /^([\w.-]+)\s*=\s*([\w-]+)$/.exec(toks.shift() ?? '');
    if (!m) continue;
    const props = {};
    for (const t of toks) {
      const pm = /^([a-z]+)\.([\w-]+)=(.+)$/i.exec(t);
      if (pm) props[`${pm[1].toLowerCase()}.${pm[2].toLowerCase()}`] = pm[3].replace(/^"|"$/g, '');
    }
    results.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props });
  }
  return { authserv, results };
}

/**
 * Every Authentication-Results header, top first, read for the From domain (§5.5): `aligned` when
 * dmarc=pass for that domain, or dkim=pass with an aligned header.d, or spf=pass with an aligned
 * smtp.mailfrom; otherwise `unaligned`. The plugin reports facts; Sara decides which header counts.
 */
export function readAuth(headers, fromAddress) {
  const fromDomain = domainOf(fromAddress);
  const out = [];
  for (const v of headers.all('authentication-results').slice(0, 10)) {
    const ar = parseAuthResults(v);
    if (!/^[\w.-]{1,120}$/.test(ar.authserv)) continue;
    let method = '';
    for (const r of ar.results) {
      if (r.result !== 'pass') continue;
      if (r.method === 'dmarc') {
        const hf = r.props['header.from'];
        if (!hf || hf.toLowerCase() === fromDomain) method ||= 'dmarc';
      } else if (r.method === 'dkim') {
        const d = r.props['header.d'] ?? (r.props['header.i'] ?? '').split('@').pop();
        if (d && aligned(d, fromDomain)) method ||= 'dkim';
      } else if (r.method === 'spf') {
        const mf = r.props['smtp.mailfrom'] ?? '';
        const d = mf.includes('@') ? mf.split('@').pop() : mf;
        if (d && aligned(d, fromDomain)) method ||= 'spf';
      }
    }
    out.push({ authserv: ar.authserv, result: method ? 'aligned' : 'unaligned', ...(method ? { method } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ anti-loop (§5.9), headers only

/** Why a mail is ignored before its body is downloaded, or null. */
export function headerSkip(h, herAddress) {
  const as = (h.get('auto-submitted') ?? '').trim().toLowerCase().split(';')[0].trim();
  if (as && as !== 'no') return 'auto';
  if (h.has('x-autoreply') || h.has('x-autorespond') || h.has('x-auto-response-suppress')) return 'auto';
  const prec = (h.get('precedence') ?? '').trim().toLowerCase();
  if (prec === 'list') return 'list';
  if (['bulk', 'junk', 'auto_reply'].includes(prec)) return 'auto';
  if (h.has('list-id') || h.has('list-unsubscribe') || h.has('list-post')) return 'list';
  const rp = h.get('return-path');
  if (rp !== undefined && /^\s*<\s*>\s*$/.test(rp)) return 'bounce';
  if (/^\s*multipart\/report\b/i.test(h.get('content-type') ?? '')) return 'bounce';
  const from = parseAddresses(h.get('from'));
  if (from.some((a) => /^(mailer-daemon|postmaster)@/i.test(a.address))) return 'bounce';
  if (herAddress && from.some((a) => a.address === herAddress)) return 'self';
  return null;
}

/** Whether her address is one the mail was sent to (To, Cc, or Delivered-To / X-Original-To for aliases). */
export function toHer(h, herAddress) {
  if (!herAddress) return false;
  const all = [...h.all('to'), ...h.all('cc')].flatMap(parseAddresses).map((a) => a.address);
  const direct = [...h.all('delivered-to'), ...h.all('x-original-to')].map((x) => x.trim().replace(/^<|>$/g, '').toLowerCase());
  return all.includes(herAddress) || direct.includes(herAddress);
}

// ------------------------------------------------------------------ threads (§5.6)

/**
 * The thread a mail belongs to: an id from its References / In-Reply-To that the index already
 * knows (a reply to any message in a thread, hers included), else the first id in References,
 * else In-Reply-To, else its own Message-ID (the root).
 */
export function threadOf(h, index) {
  const refs = msgIds(h.get('references'));
  const irt = msgIds(h.get('in-reply-to'));
  for (const id of [...irt, ...refs.slice().reverse()]) {
    const t = index.get(id);
    if (t) return t;
  }
  return refs[0] ?? irt[0] ?? msgIds(h.get('message-id'))[0] ?? null;
}

/** RFC 5322 §3.6.4: References for a reply (the parent's References + its Message-ID), the last 10. */
export function replyReferences(parentRefs, parentId) {
  const ids = [...parentRefs, ...(parentId ? [parentId] : [])];
  const seen = new Set();
  const uniq = ids.filter((x) => (seen.has(x) ? false : (seen.add(x), true)));
  return uniq.slice(-10);
}

const PREFIX = /^\s*((re|fwd?|aw|wg|sv|vs|tr|rv|ref|antw|r|res|enc|i)\s*(\[\d+\])?\s*[:：]\s*)+/i;
/** A subject without its Re:/Fwd:/AW:/WG:/TR:/RV: prefixes. */
export const baseSubject = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(PREFIX, '').trim();
/** `Re: ` + the original subject, never `Re: Re:`. */
export const replySubject = (s) => `Re: ${baseSubject(s) || '(no subject)'}`.slice(0, 200);
export const isForwardSubject = (s) => /^\s*(fwd?|wg|tr|rv|enc|i)\s*:/i.test(String(s ?? ''));

// ------------------------------------------------------------------ the new part, forwarded parts (§5.4, §5.10)

const REPLY_HEADS = [
  /^On .{4,200}(wrote|schrieb):\s*$/i, // en (and Gmail's German-with-English-date)
  /^El .{4,200}escribió:\s*$/i, // es
  /^Le .{4,200}a écrit\s*:\s*$/i, // fr
  /^Am .{4,200}schrieb .{0,120}:\s*$/i, // de
  /^Em .{4,200}escreveu:\s*$/i, // pt
  /^Il .{4,200}ha scritto:\s*$/i, // it
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Mensagem original|Messaggio originale)\s*-{2,}\s*$/i,
];
const OUTLOOK_FROM = /^\*?(From|De|Von|Da|Van)\s*:\*?\s+\S/i;
const OUTLOOK_NEXT = /^\*?(Sent|Date|Envoyé|Gesendet|Enviado|Inviato|Data|Fecha)\s*:/i;
const FORWARD_MARKS = [
  /^-{3,}\s*Forwarded message\s*-{3,}\s*$/i,
  /^Begin forwarded message:\s*$/i,
  /^-{3,}\s*(Forwarded Message|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado|Mensagem encaminhada|Messaggio inoltrato)\s*-{3,}\s*$/i,
];

/**
 * Splits a mail's text into what is new (`fresh`), the quoted history (`quoted`) and forwarded
 * mail (`forwarded`). The quoted history is cut at the first reply header ("On … wrote:" in six
 * languages, Outlook's "From: … Sent: …", "-----Original Message-----") or the first run of ">"
 * lines; the signature at "-- ". If cutting would leave nothing, the whole text is fresh.
 */
export function splitText(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let fwdAt = -1;
  let cutAt = -1;
  let sigAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (fwdAt < 0 && FORWARD_MARKS.some((re) => re.test(l))) {
      fwdAt = i;
      break;
    }
    if (REPLY_HEADS.some((re) => re.test(l))) {
      cutAt = i;
      break;
    }
    // "On Sun, 1 Nov 2026 at 10:42, Alex <a@b>" + "wrote:" on the next line.
    if (/^(On|El|Le|Am|Em|Il) .{4,200}$/.test(l) && /^(wrote|escribió|a écrit|schrieb|escreveu|ha scritto)\s*:?\s*$/i.test((lines[i + 1] ?? '').trim())) {
      cutAt = i;
      break;
    }
    if (OUTLOOK_FROM.test(l) && lines.slice(i + 1, i + 4).some((x) => OUTLOOK_NEXT.test(x.trim()))) {
      cutAt = i;
      break;
    }
    if (l.startsWith('>') && (lines[i + 1] ?? '').trim().startsWith('>')) {
      cutAt = i;
      break;
    }
    if (lines[i] === '-- ' && sigAt < 0) sigAt = i;
  }
  const end = [fwdAt, cutAt].filter((x) => x >= 0).sort((a, b) => a - b)[0] ?? lines.length;
  const freshEnd = sigAt >= 0 && sigAt < end ? sigAt : end;
  const fresh = lines.slice(0, freshEnd).join('\n').trim();
  const forwarded = fwdAt >= 0 ? lines.slice(fwdAt).join('\n').trim() : '';
  const quoted = cutAt >= 0 && fwdAt < 0 ? lines.slice(cutAt).join('\n').trim() : '';
  if (!fresh && !forwarded) return { fresh: String(text ?? '').trim(), quoted: '', forwarded: '', whole: true };
  return { fresh, quoted, forwarded, whole: false };
}

/** The text that reaches her is at most 8000 characters (the contract's cap), with a line saying what was cut. */
export const TEXT_MAX = 8000;
export function capText(text, max = TEXT_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return { text: s, cut: 0 };
  const more = s.length - (max - 120);
  const head = s.slice(0, max - 120);
  return { text: `${head}\n\n[the rest of this email was cut: ${more.toLocaleString('en-US')} more characters]`, cut: more };
}

/** "keep this" in the owner's own new text: the whole mail goes to the library (§12 Q12). */
export const wantsKeep = (fresh) => /(^|[\s,.;:!?])keep (this|it)\b/i.test(String(fresh ?? '').slice(0, 2000));

/** Normalised for the loop breaker: numbers, dates and ids out, white space folded. */
export const loopKey = (t) => String(t ?? '').toLowerCase().replace(/<[^>]*>/g, '').replace(/[0-9a-f]{8,}/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000);

/**
 * The text Sara reads commands from (§5.7): the subject (after Re:/Fwd:) when it starts with "/",
 * "!" or her name, or `Link 123456`; otherwise the new part (its first line is the command line).
 */
export function commandText(subject, fresh, herName) {
  const base = baseSubject(subject);
  if (/^\/?link\s+\d{6}$/i.test(base)) return base;
  const name = String(herName ?? '').trim();
  const isCmd = /^[/!]/.test(base) || (name && new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[\\s,:]`, 'i').test(base));
  if (isCmd) return /\s/.test(base.trim()) || !fresh ? base : `${base}\n${fresh}`;
  return fresh;
}
