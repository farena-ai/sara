// Phase 122 (docs/design/WHATSAPP.md §5, §6.3): Settings → Connections → WhatsApp. Before it is
// added: what it is, what he needs, Meta's terms box (a tick he must give) and Start. After that a
// stepper: one step open at a time, the exact Meta screen in bold, the values to paste or copy, and
// a check Sara runs; a step turns ✓ only when Sara checked it. Every failure is one plain sentence
// with the fix (DIAG, the same codes as plugins/whatsapp/diagnose.mjs). Connected: a summary card,
// Test, *Send me a test message*, the 24-hour window in words, and who else may talk to her.
import { t } from './naming.js';
import { addBuiltin } from './plugins.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(label, cls, onClick) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  b.setAttribute('aria-label', text);
  return b;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
const enc = encodeURIComponent;
const META = 'https://developers.facebook.com/apps';
const TERMS = 'https://www.whatsapp.com/legal/business-solution-terms';

/** Every diagnosis code (§5.3): the title, then the fix. */
export const DIAG = {
  TOKEN_EXPIRED: () => [t('Your WhatsApp key has expired.'), t('Make one that never expires: step 5, expiry Never.')],
  TOKEN_WRONG_APP: () => [t("This key can't see that phone number."), t('In Business Settings → System users → sara → Assign assets, give it your WhatsApp account, then make a new key.')],
  PERMISSION: () => [t('The key is missing a permission.'), t('Tick whatsapp_business_messaging and whatsapp_business_management when you make it.')],
  IDS_SWAPPED: () => [t('Those two numbers are swapped.'), t('Phone number ID is the one next to the phone number.')],
  NOT_REGISTERED: () => [t("This number isn't switched on for the Cloud API yet."), t('Press Register my number.')],
  NO_DOOR: () => [t("Meta can't reach Sara yet."), t('It needs a public https address; choose one in step 7.')],
  DOOR_CLOSED: () => [t("Meta couldn't reach Sara."), t('Is Tailscale running and Funnel allowed? (Admin console → Access controls → Funnel.)')],
  VERIFY_TOKEN: () => [t('Meta knocked, but with a different verify token.'), t("Copy Sara's verify token again into Meta's Verify token box.")],
  BAD_SIGNATURE: () => [t("Messages from Meta aren't signed with the secret Sara has."), t('Copy the App secret again (App settings → Basic → Show).')],
  NOT_SUBSCRIBED: () => [t("Meta isn't sending her your messages."), t('In Configuration → Webhook fields, subscribe to messages, or press Fix it.')],
  DEV_MODE: () => [t('Your Meta app may still be in development mode.'), t('App Dashboard → Publish (it asks for a privacy policy address).')],
  NOT_RECIPIENT: () => [t('The test number can only write to numbers on its list.'), t('Add yours in API Setup → To → Manage phone number list.')],
  WINDOW_CLOSED: () => [t("It's been more than 24 hours since you wrote to her on WhatsApp."), t("Write to her and she'll answer. It's in the app meanwhile.")],
  PAIR_RATE: () => [t('Too many messages to you too quickly.'), t("She'll send the rest in a minute.")],
  THROUGHPUT: () => [t('Meta is busy with this number.'), t("She'll try again.")],
  NOT_DELIVERED: () => [t("WhatsApp couldn't deliver this."), t('The phone may be offline or on an old WhatsApp. It is in the app.')],
  MEDIA_FAILED: () => [t("She couldn't download that file from WhatsApp."), t('Send it again, or use the app.')],
  IDENTITY_CHANGED: () => [t('Your WhatsApp identity changed.'), t("Confirm it's you below, or unlink.")],
  RESTRICTED: () => [t('Meta has restricted this WhatsApp account or number.'), t('Sara can\'t fix this: open WhatsApp Manager → Account quality to see why and appeal.')],
  PRIVATE_LOCAL: () => [t('Paused: "Nothing leaves this computer" is on.'), t('Meta keeps your messages for up to 7 days and sends them when it is off.')],
  MEDIA_HOST: () => [t('Meta now sends files from another host.'), t('Update Media host under Advanced in its settings.')],
  REGISTER_LIMIT: () => [t('Meta allows 10 registration tries in 3 days.'), t('Wait, then try once more with the right PIN.')],
  NOT_SET: () => [t('Paste the two IDs and the key first.'), t('Steps 3 and 5.')],
  NOT_RUNNING: () => [t("The WhatsApp plugin isn't running."), t('Switch it on for her in step 1.')],
  NOT_ON: () => [t("WhatsApp is added but switched off."), t('Switch it on for her in step 1.')],
  UNKNOWN: () => [t('WhatsApp said something Sara does not know.'), t('Press Details, or try again.')],
};

/** The ten steps (§5.1): title, exactly where in Meta, the Meta page to open. */
const STEPS = {
  add: () => [t('Add WhatsApp to Sara'), t('Read its card, press Install, then switch it on for her.'), null],
  app: () => [t('Make a Meta app'), t('developers.facebook.com/apps → Create app → name it → Connect with customers through WhatsApp → Next → pick or create a business portfolio → Create app.'), META],
  ids: () => [t('Copy two numbers'), t('Your app → Quickstart → Start using the API → API Setup: copy Phone number ID and WhatsApp Business Account ID (or Messaging account ID).'), META],
  phone: () => [t('Let your phone talk to the test number'), t('Same API Setup page → To → Manage phone number list → Add phone number → your number → the code WhatsApp sends you → Verify.'), META],
  token: () => [t("Make a key that doesn't expire"), t('business.facebook.com/settings → Users → System users → Add (sara, Admin) → Assign assets: the app and the WhatsApp account, Full control → Generate token → expiry Never → whatsapp_business_messaging and whatsapp_business_management → Copy.'), 'https://business.facebook.com/settings'],
  secret: () => [t("Copy the app's secret"), t('Your app → App settings → Basic → App secret → Show (Facebook asks for your password).'), META],
  door: () => [t('Give Meta a way in'), t('Meta calls a public https address. Only /hook/ is public; the app stays private.'), null],
  connect: () => [t('Connect Meta to Sara'), t('Your app → Use cases → Customize → Configuration → Webhook → Edit → paste the Callback URL and Verify token → Verify and save → Webhook fields → Manage → messages → Subscribe.'), META],
  hello: () => [t('Say hello'), t('On your phone, start a WhatsApp chat with her test number and send the code from Link my WhatsApp.'), null],
  test: () => [t('Test'), t('Checks every step and sends nothing to anyone.'), null],
};

let view = null;
let open = '';
let companion = 'main';

function diagLine(d, extra = []) {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  if (!d) return box;
  const [title, fix] = (DIAG[d.code] ?? DIAG.UNKNOWN)();
  box.dataset.state = 'warn';
  box.append(el('strong', '', title), el('span', '', fix), ...extra);
  if (d.detail) {
    const det = el('details', 'wa-details');
    det.append(el('summary', '', t('Details')), el('code', '', `${d.params?.code ?? ''} ${d.detail}`.trim()));
    box.append(det);
  }
  return box;
}
function okLine(text) {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  box.dataset.state = 'ok';
  box.textContent = `✓ ${text}`;
  return box;
}
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

function field(id, label, tipText, o = {}) {
  const row = el('label', 'plg-field');
  const head = el('span', 'plg-field-name');
  head.append(el('span', '', label), tip(tipText));
  const input = document.createElement('input');
  input.id = id;
  input.type = o.type ?? 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.nodirty = '';
  if (o.value) input.value = o.value;
  if (o.placeholder) input.placeholder = o.placeholder;
  if (o.mode) input.inputMode = o.mode;
  row.append(head, input);
  return row;
}
function copyRow(label, value, tipText) {
  const row = el('div', 'wa-copy');
  const head = el('span', 'plg-field-name');
  head.append(el('span', '', label), tip(tipText));
  const code = el('code', 'wa-mono', value || '—');
  row.append(head, code, btn(t('Copy'), 'ghost', async (b) => {
    await navigator.clipboard?.writeText(value).catch(() => undefined);
    b.textContent = t('Copied');
  }));
  return row;
}

async function check(step, out) {
  out.replaceChildren(el('span', 'muted small', t('Checking…')));
  try {
    const r = await api('/plugins/whatsapp/check', { method: 'POST', body: { companion, step } });
    if (r.ok && step === 'test') return void (await load());
    out.replaceChildren(r.ok ? okLine(t('Checked')) : diagLine(r.diagnosis));
    if (r.ok) await load();
  } catch (err) {
    out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
  }
}

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const st = view.steps.find((s) => s.id === id);
  const [, path] = STEPS[id]();
  // The Meta screens as a short numbered list (one click per line), not one long arrow chain.
  const clicks = String(path).split(' → ').map((x) => x.trim()).filter(Boolean);
  const list = el('ol', 'wa-path');
  for (const c of clicks) list.append(el('li', '', c));
  body.append(clicks.length > 1 ? list : el('p', 'wa-path', path));
  if (id === 'add') {
    body.append(el('p', 'muted small', view.on ? t('Added and on for her.') : t('Added, but switched off. Switch it on for her in Settings → Plugins.')));
  }
  if (id === 'ids') {
    body.append(
      field('wa-phone-id', t('Phone number ID'), t("A long number from Meta's API Setup page, next to her phone number (not the phone number itself). Sara uses it to send as that number."), { mode: 'numeric' }),
      field('wa-waba-id', t('WhatsApp account ID'), t('Also on API Setup (Meta may call it Messaging account ID or WhatsApp Business Account ID). Sara uses it to check the setup.'), { mode: 'numeric' }),
      btn(t('Save and check'), '', async () => {
        try {
          await api('/plugins/whatsapp/settings', { method: 'PUT', body: { companion, values: { phoneNumberId: $('#wa-phone-id').value.trim(), wabaId: $('#wa-waba-id').value.trim() } } });
        } catch (err) {
          return void out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
        }
        await check('ids', out);
      }),
    );
  }
  if (id === 'phone') body.append(el('p', 'muted small', t('Nothing to paste here. Step 9 proves it when your first message arrives.')));
  if (id === 'token') {
    body.append(
      field('wa-token', t('Access token'), t("The key from Business Settings → System users → Generate token, with expiry Never. Kept encrypted in Sara's vault and never shown again. Anyone with it can send as this number."), { type: 'password', placeholder: 'EAA…' }),
      btn(t('Save and check'), '', async () => {
        const v = $('#wa-token').value.trim();
        if (v) {
          try {
            await api('/plugins/whatsapp/settings', { method: 'PUT', body: { companion, values: { token: v } } });
          } catch (err) {
            return void out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
          }
          await new Promise((r) => setTimeout(r, 800));
        }
        await check('token', out);
      }),
    );
  }
  if (id === 'secret') {
    body.append(
      field('wa-app-secret', t('App secret'), t("From App settings → Basic. Sara uses it to check that each message really comes from Meta. Kept in the vault; the WhatsApp plugin never sees it."), { type: 'password' }),
      btn(t('Save'), '', async () => {
        try {
          await api('/plugins/whatsapp/webhook', { method: 'POST', body: { companion, appSecret: $('#wa-app-secret').value.trim() } });
          out.replaceChildren(okLine(t('Saved. The first message from Meta proves it.')));
          await load();
        } catch (err) {
          out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
        }
      }),
    );
  }
  if (id === 'door') {
    const d = view.door;
    if (d.hookUrl) body.append(okLine(t('Meta can reach Sara at {url}', { url: d.hookUrl })));
    else {
      const row = el('div', 'add-row');
      row.append(
        btn(t('Open the public door'), '', async () => {
          try {
            const r = await api('/access/door', { method: 'POST', body: { action: 'open' } });
            out.replaceChildren(r.ok ? okLine(t('The door is open.')) : el('pre', 'wa-mono', r.output || r.command));
            if (r.ok) await load();
          } catch (err) {
            out.replaceChildren(diagLine({ code: 'DOOR_CLOSED', detail: err.message }));
          }
        }),
        tip(t('Lets Meta reach Sara\'s message address on the internet through Tailscale Funnel. Only that address is public; the app itself stays private. Close it any time.')),
      );
      body.append(row, copyRow(t('Or run this yourself'), d.command, t('The same command the button runs. Funnel may first need Allow Funnel in the Tailscale admin console.')));
    }
    const other = field('wa-door-url', t('Something else: your tunnel address'), t('A Cloudflare Tunnel or another https proxy that forwards /hook/ to Sara. Paste its public address.'), { placeholder: 'https://…', value: d.pasted ? d.hookUrl : '' });
    body.append(other, btn(t('Use this address'), 'ghost', async () => {
      try {
        await api('/plugins/whatsapp/door-url', { method: 'POST', body: { companion, url: $('#wa-door-url').value.trim() } });
        await load();
      } catch (err) {
        out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
      }
    }));
  }
  if (id === 'connect') {
    const h = view.hook;
    if (!h) body.append(diagLine({ code: 'NOT_SET' }));
    else {
      body.append(copyRow(t('Callback URL'), h.callbackUrl ?? '', t('Paste both into Meta\'s Webhook settings. The address is secret: keep it to yourself. The verify token only proves to Meta that this is your Sara.')));
      if (h.verifyToken) body.append(copyRow(t('Verify token'), h.verifyToken, t('Paste both into Meta\'s Webhook settings. The address is secret: keep it to yourself. The verify token only proves to Meta that this is your Sara.')));
      if (h.verifiedAt) body.append(okLine(t('Meta reached Sara at {time}', { time: clock(h.verifiedAt) })));
      body.append(btn(t('Check'), '', () => check('connect', out)), btn(t('Fix it (subscribe the app)'), 'ghost', async () => {
        await api('/plugins/whatsapp/fix', { method: 'POST', body: { companion, fix: 'subscribe' } }).catch(() => undefined);
        await check('connect', out);
      }));
    }
  }
  if (id === 'hello') {
    const row = el('div', 'add-row');
    row.append(
      btn(t('Link my WhatsApp'), '', async () => {
        try {
          const r = await api('/plugins/whatsapp/link', { method: 'POST', body: { companion } });
          out.replaceChildren(el('p', '', t('Send this to her number from your own WhatsApp: /link {code}', { code: r.code })));
        } catch (err) {
          out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
        }
      }),
      tip(t("Gives a code for 10 minutes. Send it to her number from your own WhatsApp. That's how she knows which chat is you, and it opens the 24-hour window.")),
    );
    body.append(row);
    if (view.number?.display) body.append(el('p', 'muted small', t('Her number: {n}', { n: view.number.display })));
  }
  if (id === 'test') {
    const row = el('div', 'add-row');
    row.append(btn(t('Test'), '', () => test(out)), tip(t('Checks each step (the key, the number, Meta reaching Sara, the link) and says what to fix. Sends nothing to anyone.')));
    body.append(row);
  }
  if (st?.diagnosis && !out.childNodes.length) out.append(diagLine(st.diagnosis));
  body.append(out);
  const nav = el('div', 'wa-nav');
  const ids = view.steps.map((s) => s.id);
  const i = ids.indexOf(id);
  if (i > 0) nav.append(btn(`← ${t('Back')}`, 'ghost', () => ((open = ids[i - 1]), render())));
  if (i < ids.length - 1) nav.append(btn(st?.ok ? t('Next') : id === 'phone' || id === 'door' ? t('Skip for now') : t('Next'), st?.ok || id === 'phone' || id === 'door' ? '' : 'ghost', () => ((open = ids[i + 1]), render())));
  body.append(nav);
  return body;
}

async function test(out) {
  out.replaceChildren(el('span', 'muted small', t('Checking…')));
  const r = await api('/plugins/whatsapp/check', { method: 'POST', body: { companion, step: 'test' } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
  const ul = el('ul', 'wa-test');
  let first = true;
  for (const s of r.steps ?? []) {
    const li = el('li', s.ok ? 'ok' : first ? 'bad' : 'grey', `${s.ok ? '✓' : '✕'} ${s.label}`);
    if (!s.ok && first && s.fix) li.append(el('span', 'muted small', ` ${s.fix}`));
    if (!s.ok) first = false;
    ul.append(li);
  }
  out.replaceChildren(ul);
}

function windowWords() {
  const w = view.window;
  if (!w?.open || !w.openUntil) return t("It's been more than 24 hours since you wrote to her on WhatsApp. Write to her any time to reopen it.");
  const h = Math.max(1, Math.round((Date.parse(w.openUntil) - Date.now()) / 3_600_000));
  return h === 1 ? t('You can get messages from her for 1 more hour. Write to her any time to reopen it.') : t('You can get messages from her for {n} more hours. Write to her any time to reopen it.', { n: h });
}

function side() {
  const col = el('div', 'wa-side');
  const card = el('div', 'kit-card');
  const [, , url] = STEPS[open]?.() ?? [];
  card.append(el('h3', '', t('The screen you need')), el('p', 'small', STEPS[open]?.()[1] ?? ''));
  if (url) {
    const a = el('a', 'button-link', t('Open Meta ↗'));
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    card.append(a);
  }
  const diff = el('a', 'small', t('This screen looks different?'));
  diff.href = '/help#whatsapp';
  diff.target = '_blank';
  card.append(el('p', 'muted small', t('Easier on a computer: Meta\'s console is hard to use on a phone.')), diff);
  const good = el('div', 'kit-card');
  good.append(el('h3', '', t('Good to know')), el('p', 'small', t('Chats you start are free. She can only write first within 24 hours of your last message.')), el('p', 'small', t('WhatsApp chats pass through Meta, unlike Signal\'s end-to-end path.')));
  col.append(card, good);
  return col;
}

function termsBox(onTick) {
  const box = el('div', 'kit-card wa-terms');
  box.append(el('h3', '', t("About Meta's rules")), el('p', 'small', t('This uses the WhatsApp Business service with a Meta account and number that you own, under Meta\'s WhatsApp Business terms. Since January 2026 those terms forbid offering a general-purpose AI assistant on WhatsApp as a product. Sara is your own companion on your own account, but Meta decides how its terms apply and can restrict an account or number. Use a number you can afford to lose, keep her to you and people you choose, and read the terms.')));
  const a = el('a', 'small', t('WhatsApp Business Solution Terms ↗'));
  a.href = TERMS;
  a.target = '_blank';
  a.rel = 'noopener';
  const row = el('label', 'row');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'wa-terms-tick';
  cb.dataset.nodirty = '';
  cb.addEventListener('change', () => onTick(cb.checked));
  row.append(cb, el('span', '', t('I understand and want to continue.')));
  box.append(a, row);
  return box;
}

function intro(box, builtin) {
  const card = el('div', 'kit-card');
  card.append(el('h3', '', t('Set up WhatsApp')), el('p', '', t("Text her on WhatsApp. Uses Meta's official WhatsApp Business service with an account you own. About 30 minutes, once.")));
  const ul = el('ul', 'plg-setup');
  for (const x of [t('A Facebook account (a personal one is fine)'), t('Your phone with WhatsApp'), t('About 30 minutes at a computer'), t('A public https address for Sara (step 7 helps)')]) ul.append(el('li', '', x));
  card.append(el('h4', '', t('What you need')), ul);
  const start = btn(t('Start'), '', async () => {
    localStorage.setItem('wa-terms', new Date().toISOString());
    await addBuiltin('whatsapp');
  });
  start.disabled = true;
  if (!builtin) start.hidden = true;
  box.replaceChildren(card, termsBox((on) => (start.disabled = !on)), start, ...(builtin ? [] : [el('p', 'muted small', t("WhatsApp doesn't come with this copy of Sara."))]));
}

function summary() {
  const card = el('div', 'kit-card');
  const n = view.number;
  card.append(el('h3', '', t('Connected')), el('p', '', [n?.display, n?.verifiedName ? `(${n.verifiedName})` : '', view.linked.length ? t('linked to you') : '', n?.quality ? t('quality: {q}', { q: String(n.quality).toLowerCase() }) : ''].filter(Boolean).join(' · ')), el('p', 'small', windowWords()));
  const out = el('div', 'wa-check');
  const row = el('div', 'add-row');
  row.append(
    btn(t('Test'), '', () => test(out)),
    btn(t('Send me a test message'), 'ghost', async () => {
      const r = await api('/plugins/whatsapp/send-test', { method: 'POST', body: { companion } }).catch((err) => ({ ok: false, diagnosis: { code: 'UNKNOWN', detail: err.message } }));
      out.replaceChildren(r.ok ? okLine(t('Sent.')) : diagLine(r.diagnosis));
    }),
    btn(t('Set up again'), 'ghost', () => ((open = 'add'), (view.forceSteps = true), render())),
  );
  card.append(row, out);
  const who = el('div', 'kit-card');
  who.append(el('h3', '', t('Who can reach her')), el('p', 'small', view.others ? t('You and the numbers on your list, as partners: no tools, nothing private, the AI notice first.') : t('Only you. Change it in WhatsApp settings: Let other people talk to her, and the numbers who may.')));
  for (const m of view.muted ?? []) who.append(el('p', 'small', t('{who} said stop, so she stays quiet with them.', { who: m })), btn(t('Unmute'), 'ghost', async () => {
    await api('/plugins/whatsapp/unmute', { method: 'POST', body: { companion, who: m } });
    await load();
  }));
  const works = el('div', 'kit-card');
  works.append(el('h3', '', t('While she works')), el('p', 'small', t("WhatsApp can't edit messages, so long jobs get one Working on it line with a Stop button, and then her answer.")), el('pre', 'prog-preview', `${t('Working on it: {step}', { step: t('Working…') })}\n[${t('⏹ Stop')}]`));
  return [card, who, works];
}

// Phase 122 (§4.9): a changed WhatsApp identity pauses her tools there until he says it's him.
function identityCards() {
  return (view.identityChanged ?? []).map((c) => {
    const warn = el('div', 'skl-warn small plg-identity');
    warn.append(el('p', '', t('Your WhatsApp identity changed.')), el('p', '', t('Until you confirm it, she treats messages from this chat like anyone else\'s: no tools, no memory.')));
    const row = el('div', 'add-row');
    const act = (action) => async () => {
      await api('/plugins/whatsapp/identity', { method: 'POST', body: { companion, chat: c.chat, action } }).catch(() => null);
      await load();
    };
    row.append(btn(t("It's me"), '', act('confirm')), btn(t('Unlink'), 'ghost', act('unlink')));
    warn.append(row);
    return warn;
  });
}

function render() {
  const box = $('#wa-box');
  const chip = $('#wa-chip');
  if (!box || !view) return;
  chip.textContent = view.state === 'ok' && view.done === view.steps.length ? t('Connected') : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.installed ? t('{n} of {total} done', { n: view.done, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = view.state === 'ok' && view.done === view.steps.length ? 'ok' : view.state === 'error' || view.state === 'paused' ? 'warn' : '';
  if (!view.installed) return;
  if (view.done === view.steps.length && !view.forceSteps) return void box.replaceChildren(...identityCards(), ...summary());
  if (!open || !view.steps.some((s) => s.id === open)) open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  const list = el('ol', 'wa-steps');
  for (const [i, s] of view.steps.entries()) {
    const [title] = STEPS[s.id]();
    const li = el('li', `wa-step${s.ok ? ' done' : ''}${s.id === open ? ' open' : ''}`);
    const head = btn(`${s.ok ? '✓' : s.id === open ? '●' : '○'} ${i + 1} ${title}`, 'wa-step-head', () => ((open = s.id), render()));
    head.setAttribute('aria-expanded', String(s.id === open));
    li.append(head);
    if (s.id === open) li.append(stepBody(s.id));
    list.append(li);
  }
  const left = el('div', 'kit-card wa-stepper');
  left.append(el('div', 'card-head', ''), list);
  left.firstChild.append(el('h3', '', t('Set up WhatsApp')), el('span', 'muted small', t('{n} of {total}', { n: view.done, total: view.steps.length })));
  const grid = el('div', 'wa-grid');
  grid.append(left, side());
  box.replaceChildren(...identityCards(), grid);
}

async function load() {
  try {
    const { plugins } = await api('/plugins');
    const p = plugins.find((x) => x.id === 'whatsapp');
    companion = p?.companions.find((c) => c.on)?.id ?? companion;
    view = await api(`/plugins/whatsapp/setup?companion=${enc(companion)}`);
    if (view.installed && !view.terms && localStorage.getItem('wa-terms')) await api('/plugins/whatsapp/terms', { method: 'POST', body: { companion } }).catch(() => undefined);
    if (!view.installed) {
      const { builtin } = await api('/plugins/builtin');
      render();
      intro($('#wa-box'), builtin.some((b) => b.id === 'whatsapp'));
      return;
    }
    render();
  } catch (err) {
    $('#wa-box')?.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadWhatsAppPage() {
  await load();
}
