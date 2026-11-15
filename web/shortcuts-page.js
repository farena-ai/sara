// R4 (docs/IPHONE.md): Settings → Connections → iPhone Shortcuts. A token per iPhone (shown once,
// with a QR code), the steps to build "Share to Sara", "Ask Sara" and the widget shortcut with this
// server and the new token filled in, the owner's ready-made iCloud links, and the Home Screen guide.
import { t } from './naming.js';
import { needsInstallGuide, isStandalone } from './ios-web.js';

const $ = (s) => document.querySelector(s);
/** @type {{ api: (path: string, o?: object) => Promise<any>, el: (tag: string, cls?: string, text?: string) => HTMLElement, copyText: (text: string, btn?: HTMLElement) => Promise<void> } | null} */
let ctx = null;
let view = null;
/** The token made just now (shown once; gone when the page closes). */
let fresh = null;

export function initShortcutsPage(c) {
  ctx = c;
  $('#ish-make')?.addEventListener('click', () => void make());
  $('#ish-links-save')?.addEventListener('click', () => void saveLinks());
  const page = document.querySelector('.settings-page[data-page="co-shortcuts"]');
  if (page)
    new MutationObserver(() => {
      if (page.hidden) {
        fresh = null;
        if ($('#ish-new')) $('#ish-new').hidden = true;
      } else void load();
    }).observe(page, { attributes: true, attributeFilter: ['hidden'] });
}

const status = (text) => {
  const s = $('#ish-status');
  if (s) s.textContent = text;
};

async function load() {
  if (!ctx || !$('#ish-tokens')) return;
  try {
    view = await ctx.api('/shortcuts');
  } catch (e) {
    status(e.message);
    return;
  }
  render();
}

/** One step: words, and (optional) a value to copy. */
function step(text, copy) {
  const li = ctx.el('li', '', text);
  if (copy) {
    const row = ctx.el('span', 'ish-copy');
    row.append(ctx.el('code', '', copy));
    const b = ctx.el('button', 'ghost small', t('Copy'));
    b.type = 'button';
    b.addEventListener('click', () => void ctx.copyText(copy, b));
    row.append(b);
    li.append(' ', row);
  }
  return li;
}

/** The three recipes, with this server's address and (right after making one) the token. */
export function recipes(server, token) {
  const auth = `Bearer ${token || `<${t('your token')}>`}`;
  return {
    share: [
      [t('Open the Shortcuts app, tap +, and name the shortcut “Share to Sara”.')],
      [t('Tap the ⓘ button (or the name at the top) and turn on Show in Share Sheet. At the top, set it to receive Images, Files, URLs and Text from the Share Sheet.')],
      [t('Add the action Get Contents of URL. Tap URL and paste:'), `${server}/api/shortcuts/share`],
      [t('Tap Show More. Method: POST. Under Headers, add Authorization with this value:'), auth],
      [t('Request Body: Form. Add a field of type File named file, and set it to Shortcut Input.')],
      [t('Add the action Show Result (it shows Contents of URL). Done.')],
      [t('Try it: in Photos, tap Share and pick Share to Sara. The photo goes to your Library and a chat opens in Sara with it.')],
    ],
    ask: [
      [t('Open the Shortcuts app, tap +, and name the shortcut “Ask Sara”. Siri uses this name.')],
      [t('Add the action Ask for Input (Text) with the prompt: What do you want to ask Sara?')],
      [t('Add the action Get Contents of URL. Tap URL and paste:'), `${server}/api/shortcuts/ask`],
      [t('Tap Show More. Method: POST. Under Headers, add Authorization with this value:'), auth],
      [t('Request Body: JSON. Add a Text field named text, and set it to Provided Input.')],
      [t('Add the action Speak Text (or Show Result) with Contents of URL. Done.')],
      [t('Try it: say “Hey Siri, Ask Sara”. Long tasks keep going and you get a notification when she is done.')],
    ],
    widget: [
      [t('Make a shortcut named “Sara today” with Get Contents of URL:'), `${server}/api/shortcuts/widget`],
      [t('Method: GET. Under Headers, add Authorization with this value:'), auth],
      [t('Add the action Show Result with Contents of URL.')],
      [t('On the Home Screen, touch and hold, tap Edit → Add Widget → Shortcuts, and pick “Sara today”. A tap shows her next reminder, your watches and what waits for you. On iOS 18 you can also add it as a Lock Screen or Control Center control.')],
    ],
  };
}

function render() {
  if (!view) return;
  const server = view.server || location.origin;
  $('#ish-private').hidden = !view.privateLocal;
  // The tokens (each iPhone its own; household members make their own).
  const list = $('#ish-tokens');
  list.replaceChildren();
  if (!view.tokens.length) list.append(ctx.el('p', 'muted small', t('No iPhone has a token yet.')));
  for (const tok of view.tokens) {
    const row = ctx.el('div', 'item ish-token');
    const what = tok.scopes.map((s) => (s === 'share' ? t('Share') : t('Ask and widget'))).join(' · ');
    row.append(ctx.el('span', '', tok.label), ctx.el('span', 'muted small', `${what} · ${t('last used {date}', { date: new Date(tok.lastSeen).toLocaleDateString() })}`));
    const rm = ctx.el('button', 'ghost small', t('Remove'));
    rm.type = 'button';
    rm.addEventListener('click', () => void remove(tok));
    row.append(rm);
    list.append(row);
  }
  // Shown once, right after making it.
  const box = $('#ish-new');
  box.hidden = !fresh;
  if (fresh) {
    $('#ish-new-token').textContent = fresh.token;
    $('#ish-new-qr').src = fresh.qr;
  }
  // The owner's ready-made shortcuts (iCloud links): Get, then answer the two questions.
  const links = view.links ?? {};
  $('#ish-ready').hidden = !links.share && !links.ask;
  for (const k of ['share', 'ask']) {
    const a = $(`#ish-get-${k}`);
    if (!a) continue;
    a.hidden = !links[k];
    if (links[k]) a.href = links[k];
  }
  $('#ish-ready-server').textContent = server;
  if ($('#ish-admin')) {
    $('#ish-admin').hidden = !view.owner;
    if (document.activeElement?.id !== 'ish-link-share') $('#ish-link-share').value = links.share ?? '';
    if (document.activeElement?.id !== 'ish-link-ask') $('#ish-link-ask').value = links.ask ?? '';
  }
  const r = recipes(server, fresh?.token);
  for (const k of ['share', 'ask', 'widget']) {
    const ol = $(`#ish-steps-${k}`);
    ol.replaceChildren(...r[k].map(([words, copy]) => step(words, copy)));
  }
  renderInstallGuide($('#ish-install'));
}

async function make() {
  const scopes = [$('#ish-share').checked && 'share', $('#ish-ask').checked && 'ask'].filter(Boolean);
  try {
    const out = await ctx.api('/shortcuts/tokens', { method: 'POST', body: { label: $('#ish-label').value.trim(), scopes } });
    fresh = { token: out.token, qr: out.qr };
    view = out;
    $('#ish-label').value = '';
    status(t('Copy the token now: it is shown only once.'));
    render();
  } catch (e) {
    status(e.message);
  }
}

async function remove(tok) {
  if (!confirm(t('Remove the token for {name}? Its shortcuts stop working.', { name: tok.label }))) return;
  try {
    view = await ctx.api(`/shortcuts/tokens/${encodeURIComponent(tok.id)}`, { method: 'DELETE' });
    status(t('Removed.'));
    render();
  } catch (e) {
    status(e.message);
  }
}

async function saveLinks() {
  try {
    view = await ctx.api('/shortcuts/links', { method: 'PUT', body: { share: $('#ish-link-share').value.trim(), ask: $('#ish-link-ask').value.trim() } });
    status(t('Saved.'));
    render();
  } catch (e) {
    status(e.message);
  }
}

/** The "Add to Home Screen" guide in a box, shown only on an iPhone in a Safari tab. */
export function renderInstallGuide(box) {
  if (!box || !ctx) return;
  const show = needsInstallGuide({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone(window) });
  box.hidden = !show;
  if (!show) return;
  const ol = ctx.el('ol', 'small');
  for (const s of [
    t('In Safari, tap the Share button (the square with an arrow) at the bottom of the screen.'),
    t('Scroll down, tap Add to Home Screen, then Add.'),
    t('Open Sara from the new icon on your Home Screen and sign in there.'),
    t('Then turn on notifications: Settings → Connections → Phone and notifications → Turn on for this device.'),
  ])
    ol.append(ctx.el('li', '', s));
  box.replaceChildren(ctx.el('h3', '', t('Add Sara to your Home Screen')), ctx.el('p', 'muted small', t('On an iPhone, notifications and the app badge work only in Sara opened from the Home Screen.')), ol);
}
