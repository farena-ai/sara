// PL2a (docs/design/POLISH2.md §4.1, C3, N1, N2): the one setup card every chat app uses. Before it is
// set up: what you need, about how long, what it costs, and only where there is one a short Rules
// box with its tick and link (Meta's terms, Apple's). Then the steps, numbered, one open at a time,
// each turning ✓ only when Sara checked it, with the plain fix right under a step that failed, copy
// rows and Test at the end. Sara's own plugins (proven by the server: Review.firstParty) are added
// from a short consent step inside the card; anything else gets the full plugin review card.
// WhatsApp, Matrix, iMessage, Signal, Email and Telegram import these helpers instead of copying them.
//
// No static imports, so the card can be rendered in a test with a stand-in DOM: the pages hand in
// the app's translator once with useTranslator(t).

let tr = (s, p = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m));
/** The app's t() (web/naming.js); until it is given, English with {placeholders} filled. */
export function useTranslator(fn) {
  if (typeof fn === 'function') tr = fn;
}
const t = (s, p) => tr(s, p);
const doc = () => globalThis.document;
export const enc = encodeURIComponent;

export function el(tag, cls, text) {
  const e = doc().createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
export function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
export function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', text);
  return b;
}
export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data });
  return data;
}
export const link = (text, href, cls = 'small') => {
  const a = el('a', cls, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
};

/** A labelled text box with its ? tip. */
export function field(id, label, tipText, o = {}) {
  const row = el('label', 'plg-field');
  const head = el('span', 'plg-field-name');
  head.append(el('span', '', label), tip(tipText));
  const input = doc().createElement('input');
  input.id = id;
  input.type = o.type ?? 'text';
  input.autocomplete = o.type === 'password' ? 'new-password' : 'off';
  input.spellcheck = false;
  input.dataset.nodirty = '';
  if (o.value) input.value = o.value;
  if (o.placeholder) input.placeholder = o.placeholder;
  if (o.mode) input.inputMode = o.mode;
  row.append(head, input);
  return row;
}
/** A tick with its ? tip. */
export function tick(id, label, tipText, on) {
  const row = el('label', 'row');
  const cb = doc().createElement('input');
  cb.type = 'checkbox';
  cb.id = id;
  cb.checked = Boolean(on);
  cb.dataset.nodirty = '';
  row.append(cb, el('span', '', label), tip(tipText));
  return row;
}
/** A value to copy (an address, a command) with Copy. */
export function copyRow(label, value, tipText) {
  const row = el('div', 'wa-copy');
  const head = el('span', 'plg-field-name');
  head.append(el('span', '', label), tip(tipText));
  row.append(head, el('code', 'wa-mono', value || '—'), btn(t('Copy'), 'ghost', async (b) => {
    await globalThis.navigator?.clipboard?.writeText(value).catch(() => undefined);
    b.textContent = t('Copied');
  }));
  return row;
}
export function okLine(text) {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  box.dataset.state = 'ok';
  box.textContent = `✓ ${text}`;
  return box;
}
/** The plain fix under a failed step: the title, then the fix (a page's DIAG table), Details folded. */
export function diagLine(d, table, extra = []) {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  if (!d) return box;
  const [title, fix] = (table[d.code] ?? table.UNKNOWN)(d.params ?? {});
  box.dataset.state = 'warn';
  box.append(el('strong', '', title), el('span', '', fix), ...extra);
  if (d.detail) {
    const det = el('details', 'wa-details');
    det.append(el('summary', '', t('Details')), el('code', '', `${d.params?.code ?? d.code} ${d.detail}`.trim()));
    box.append(det);
  }
  return box;
}
export const checking = (out) => out.replaceChildren(el('span', 'muted small', t('Checking…')));

/** Test's answer: ✓ lines, the first ✕ in bold with its fix, the rest grey. */
export function testList(r) {
  const ul = el('ul', 'wa-test');
  let first = true;
  for (const s of r.steps ?? []) {
    const li = el('li', s.ok ? 'ok' : first ? 'bad' : 'grey', `${s.ok ? '✓' : '✕'} ${s.label}`);
    if (!s.ok && first && s.fix) li.append(el('span', 'muted small', ` ${s.fix}`));
    if (!s.ok) first = false;
    ul.append(li);
  }
  return ul;
}
/** An app's screens as a short numbered list (one click per line), not one long arrow chain. */
export function pathList(path) {
  const clicks = String(path).split(' → ').map((x) => x.trim()).filter(Boolean);
  if (clicks.length < 2) return el('p', 'wa-path', String(path));
  const list = el('ol', 'wa-path');
  for (const c of clicks) list.append(el('li', '', c));
  return list;
}
/** ← Back and Next under an open step. */
export function stepNav(ids, id, o, go) {
  const nav = el('div', 'wa-nav');
  const i = ids.indexOf(id);
  if (i > 0) nav.append(btn(`← ${t('Back')}`, 'ghost', () => go(ids[i - 1])));
  if (i < ids.length - 1) nav.append(btn(o.label ?? t('Next'), o.primary ? '' : 'ghost', () => go(ids[i + 1])));
  return nav;
}
/**
 * The numbered steps: `steps` [{id, ok}], `titleOf(id)`, `bodyOf(id)` for the open one, `onOpen(id)`.
 * A step shows ✓ only when `ok` (Sara checked it).
 */
export function stepper({ title, steps, open, titleOf, bodyOf, onOpen, note }) {
  const done = steps.filter((s) => s.ok).length;
  const list = el('ol', 'wa-steps');
  for (const [i, s] of steps.entries()) {
    const li = el('li', `wa-step${s.ok ? ' done' : ''}${s.id === open ? ' open' : ''}`);
    const head = btn(`${s.ok ? '✓' : s.id === open ? '●' : '○'} ${i + 1} ${titleOf(s.id)}`, 'wa-step-head', () => onOpen(s.id));
    head.setAttribute('aria-expanded', String(s.id === open));
    li.append(head);
    if (s.id === open) li.append(bodyOf(s.id));
    list.append(li);
  }
  const card = el('div', 'kit-card wa-stepper');
  const head = el('div', 'card-head');
  head.append(el('h3', '', title), el('span', 'muted small', t('{n} of {total}', { n: done, total: steps.length })));
  card.append(head, ...(note ? [el('p', 'muted small', note)] : []), list);
  return card;
}
/** Working: the card folds to one line, with Set up again. */
export function foldedLine(text, again) {
  const row = el('div', 'setup-folded');
  row.append(el('span', '', `✓ ${text}`), btn(t('Set up again'), 'ghost', again));
  return row;
}

// ---------- before setup: what you need, how long, what it costs, the rules ----------

/** Every chat app's card text (the DOM test renders all of them). */
export const INTROS = {
  whatsapp: () => ({
    title: t('Set up WhatsApp'),
    lead: t("Text her on WhatsApp. Uses Meta's official WhatsApp Business service with an account you own. About 30 minutes, once."),
    need: [t('A Facebook account (a personal one is fine)'), t('Your phone with WhatsApp'), t('About 30 minutes at a computer'), t('A public https address for Sara (step 7 helps)')],
    time: t('About 30 minutes, once'),
    cost: t("Free for chats you start; Meta's prices apply only to messages she starts after 24 hours"),
    rules: {
      title: t("About Meta's rules"),
      bullets: [t("Since January 2026 Meta's terms forbid offering a general-purpose AI assistant on WhatsApp. Sara is your own companion on your own number, but Meta decides how its terms apply and may restrict the number."), t('Use a number you can lose, and keep her to you and people you choose.')],
      link: [t('WhatsApp Business Solution Terms ↗'), 'https://www.whatsapp.com/legal/business-solution-terms'],
      tick: 'wa-terms-tick',
    },
  }),
  matrix: () => ({
    title: t('Set up Matrix'),
    lead: t('Talk to her in Element or any Matrix app, through a Matrix account of her own. Free, about 15 minutes, once.'),
    need: [t('An email address for her new account (matrix.org asks for one)'), t('Your own Matrix account, in Element'), t('About 15 minutes at a computer')],
    time: t('About 15 minutes, once'),
    cost: t('Free'),
    rules: {
      title: t('About Matrix'),
      bullets: [t('Her room with you is not end-to-end encrypted: whoever runs the servers can read it.'), t("Use a separate account for her, and follow your server's rules.")],
      tick: 'mx-terms-tick',
    },
  }),
  slack: () => ({
    title: t('Set up Slack'),
    lead: t('Talk to her in Slack: her DMs, and channels you choose when someone mentions her. You make a small Slack app from a manifest Sara gives you. Free, about 10 minutes, once.'),
    need: [t('A Slack workspace where you may add apps (a free one of your own works)'), t('Slack open on a computer'), t('About 10 minutes')],
    time: t('About 10 minutes, once'),
    cost: t('Free'),
  }),
  teams: () => ({
    title: t('Set up Microsoft Teams'),
    lead: t('Talk to her in Teams: her personal chat, and channels you choose when someone mentions her. You make a free Azure Bot and upload a Teams app package Sara builds. About 20 minutes, once.'),
    need: [t('A Microsoft 365 organization where you may add custom apps in Teams'), t('An Azure account in that organization (the Free bot tier is enough)'), t('A public https address for Sara (step 3 helps)'), t('About 20 minutes at a computer')],
    time: t('About 20 minutes, once'),
    cost: t('Free'),
  }),
  imessage: () => ({
    title: t('Set up iMessage'),
    lead: t('Text her from Messages on your iPhone, through BlueBubbles on a Mac. Free, about 40 minutes at the Mac, once.'),
    need: [t('A Mac that can stay on (macOS 11 or newer is easiest)'), t('An email address for her new Apple ID'), t('About 40 minutes at that Mac')],
    time: t('About 40 minutes at the Mac, once'),
    cost: t('Free (BlueBubbles is free and open source)'),
    note: t('No Mac? iMessage only works through a Mac. Try Signal or Telegram instead.'),
    rules: {
      title: t('About Apple and BlueBubbles'),
      bullets: [t('BlueBubbles is not made or approved by Apple. Use your own Mac and a separate Apple ID for her.'), t("Apple's license forbids spam and harassment, and Apple can lock an Apple ID that misbehaves."), t("Sara never asks you to turn off your Mac's security (SIP).")],
      tick: 'im-terms-tick',
    },
  }),
  signal: () => ({
    title: t('Set up Signal'),
    lead: t('Text her on Signal, with a number of her own, through signal-cli on this computer. The steps say exactly what to type.'),
    need: [t('A phone number for her that can get one text or call (a cheap SIM or a landline works)'), t('signal-cli on this computer (step 1 shows how to get it)'), t('Your own Signal on your phone')],
    time: t('About 20 minutes, once'),
    cost: t('Free (a second number may cost you a SIM)'),
  }),
  email: () => ({
    title: t('Set up email'),
    lead: t('Give her an email address of her own: write to her, or forward her a mail, and she answers in the same thread.'),
    need: [t('An address only she uses (a new account, or an alias on your domain)'), t('Two-step sign-in on that account, for an app password')],
    time: t('About 10 minutes, once'),
    cost: t('Free with Gmail, iCloud or Fastmail; your plan elsewhere'),
  }),
  telegram: () => ({
    title: t('Set up Telegram'),
    lead: t('Text her from Telegram. You make her a bot in Telegram itself, then paste its key here.'),
    need: [t('Telegram on your phone or computer'), t('Two minutes in a chat with @BotFather')],
    time: t('About 5 minutes, once'),
    cost: t('Free'),
  }),
};

/**
 * The card before setup (`.setup-card`): the title, one line, What you need, About how long, What it
 * costs, the Rules box (its tick enables Start), Start. `builtin` false: Start hides and says why.
 */
export function setupCard(app, o = {}) {
  const x = INTROS[app]();
  const card = el('div', 'kit-card setup-card');
  card.dataset.app = app;
  card.append(el('h3', '', x.title), el('p', '', x.lead));
  if (x.note) card.append(el('p', 'small', x.note));
  const ul = el('ul', 'plg-setup');
  for (const n of x.need) ul.append(el('li', '', n));
  const facts = el('dl', 'setup-facts');
  facts.append(el('dt', '', t('About how long')), el('dd', 'setup-time', x.time), el('dt', '', t('What it costs')), el('dd', 'setup-cost', x.cost));
  card.append(el('h4', '', t('What you need')), ul, facts, ...(o.extra ?? []));
  const start = btn(o.startLabel ?? t('Start'), '', async (b) => {
    b.disabled = true;
    try {
      await o.onStart?.();
    } finally {
      b.disabled = false;
    }
  });
  if (x.rules) {
    const box = el('div', 'setup-rules wa-terms');
    box.append(el('h4', '', x.rules.title));
    const bl = el('ul', 'small');
    for (const r of x.rules.bullets) bl.append(el('li', '', r));
    box.append(bl);
    if (x.rules.link) box.append(link(x.rules.link[0], x.rules.link[1]));
    const row = el('label', 'row');
    const cb = doc().createElement('input');
    cb.type = 'checkbox';
    cb.id = x.rules.tick;
    cb.dataset.nodirty = '';
    cb.addEventListener('change', () => (start.disabled = !cb.checked));
    row.append(cb, el('span', '', t('I understand and want to continue.')));
    box.append(row);
    card.append(box);
    start.disabled = true;
  }
  if (o.builtin === false) {
    start.hidden = true;
    card.append(el('p', 'muted small', o.missing ?? t("This doesn't come with this copy of Sara.")));
  }
  card.append(start);
  return card;
}

// ---------- N2: Sara's own plugins, the short consent step ----------

/** Which card a staged review gets: 'short' only when the server proved it is Sara's own. */
export const consentKind = (review) => (review?.firstParty === true && review.kind === 'install' ? 'short' : 'full');

/**
 * The consent step inside the setup card: one line on what it can reach, Add <name> (one OK), and
 * the full review card under Details (read only). The fingerprint check runs on the server either way.
 */
export function consentStep(review, o) {
  const box = el('div', 'kit-card setup-consent');
  box.append(el('h3', '', t('Add {name} to Sara', { name: o.name })), el('p', '', o.reach));
  box.append(el('p', 'muted small', review.fence === 'node-only' ? t("Made and checked by the Sara team. On this computer it runs with Node's permission limits, without a sandbox.") : t('Made and checked by the Sara team. It runs fenced in, in its own folder.')));
  const det = el('details', 'wa-details setup-consent-details');
  det.append(el('summary', '', t('Details')));
  det.addEventListener('toggle', () => {
    if (!det.open || det.dataset.filled) return;
    det.dataset.filled = '1';
    det.append(o.reviewCard({ ...review, needsTrust: false }, { buttons: [] }));
  });
  const status = el('p', 'muted small');
  status.setAttribute('role', 'status');
  const row = el('div', 'add-row');
  row.append(
    btn(t('Add {name}', { name: o.name }), '', async (b) => {
      b.disabled = true;
      status.textContent = t('Adding…');
      try {
        await o.onAdd();
      } catch (err) {
        status.textContent = err.message;
        b.disabled = false;
      }
    }),
    btn(t('Cancel'), 'ghost', () => o.onCancel()),
  );
  box.append(row, status, det);
  return box;
}

/**
 * Start on a chat app that comes with Sara: stage it; Sara's own → the consent step in `host`
 * (Add installs it and switches it on for her in one OK); otherwise the full review card (`full`).
 */
export async function startFirstParty(id, host, o) {
  let review;
  try {
    review = await api('/plugins/install', { method: 'POST', body: { builtin: id } });
  } catch (err) {
    host.replaceChildren(el('p', 'muted small', err.message));
    return;
  }
  if (consentKind(review) === 'full') return void (await o.full(id));
  const cancel = async () => {
    await api(`/plugins/install/${enc(review.id)}`, { method: 'DELETE' }).catch(() => undefined);
    await o.done();
  };
  host.replaceChildren(
    consentStep(review, {
      name: o.name,
      reach: o.reach,
      reviewCard: o.reviewCard,
      onCancel: cancel,
      onAdd: async () => {
        await api(`/plugins/${enc(review.manifest.id)}/approve`, { method: 'POST', body: { review: review.id, consent: true } });
        const { companions = [] } = await api('/plugins').catch(() => ({}));
        const who = o.companion ?? companions[0]?.id ?? 'main';
        await api(`/plugins/${enc(review.manifest.id)}/enable`, { method: 'POST', body: { companion: who, on: true } }).catch(() => undefined);
        await o.done();
      },
    }),
  );
}
