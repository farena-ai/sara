// Her words for Slack (docs/ops/EC1_DESIGN.md): Markdown → Slack's mrkdwn, escape first. `&`, `<`
// and `>` are escaped before anything else, so nothing she writes can become a Slack control sequence
// (`<!channel>`, `<@U…>`, a link with another label); then **bold** → *bold*, headings → bold lines,
// "- " lists → "• ", and [label](https URL) → <URL|label> (any other scheme keeps the label only).
// And Slack's text in: <@U…> mentions, <URL|label> links, <#C…|name> channels and the three escapes
// back to plain words for the model.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toMrkdwn(md) {
  const out = [];
  for (const raw of String(md ?? '').split('\n')) {
    let line = esc(raw);
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) line = `*${h[1].replace(/\*\*/g, '')}*`;
    line = line.replace(/^(\s*)[-*]\s+/, '$1• ');
    // Code spans stay as they are (already escaped); bold and links outside them.
    line = line
      .split(/(`[^`]*`)/)
      .map((part) => (part.startsWith('`') ? part : part.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/__(.+?)__/g, '*$1*').replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (_m, label, url) => (/^https?:\/\/[^\s|]+$/i.test(url) ? `<${url.replace(/&amp;/g, '&')}|${label.replace(/\|/g, '/')}>` : label))))
      .join('');
    out.push(line);
  }
  return out.join('\n');
}

/** Slack's message text → plain words; her own mention (`<@me>`) at the start is dropped. */
export function fromSlack(text, me = '') {
  let s = String(text ?? '');
  if (me) s = s.replace(new RegExp(`^\\s*<@${me}(?:\\|[^>]*)?>[,:]?\\s*`), '');
  s = s
    .replace(/<@([A-Z0-9]+)\|([^>]+)>/g, '@$2')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, '#$2')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)(?:\|[^>]*)?>/g, '$1');
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

/** Text in pieces of at most `max` characters, at a line break when there is one. */
export function split(text, max) {
  const parts = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}
