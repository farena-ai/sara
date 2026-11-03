// PL2a (docs/design/POLISH2.md N1, N4): Settings → Chat apps → Email as guided steps. The provider
// first (Gmail, iCloud, Fastmail or Other) with the link to that provider's app-password page; then
// Add Email from the short consent step; then her address and the app password (the server names
// fill themselves: src/plugins/manager.ts EMAIL_PRESETS); then the link and Test. A step turns ✓
// only when Sara checked it (signed in, linked, Test passed).
import { t } from './naming.js';
import { addBuiltin, openPluginSettings, reviewCard } from './plugins.js';
import { api, btn, checking, copyRow, el, enc, field, foldedLine, link, okLine, setupCard, startFirstParty, stepNav, stepper, testList, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);

/** Each provider: its app-password help page and the one line on where to make one. */
const PROVIDERS = {
  Gmail: () => ['https://support.google.com/accounts/answer/185833', t('Google Account → Security → 2-Step Verification on → App passwords → make one named Sara.')],
  iCloud: () => ['https://support.apple.com/en-us/102654', t('account.apple.com → Sign-In and Security → App-Specific Passwords → make one named Sara.')],
  Fastmail: () => ['https://www.fastmail.help/hc/en-us/articles/360058752854', t('Fastmail Settings → Privacy & Security → App passwords → New, with IMAP and SMTP.')],
  Other: () => ['', t('Your mail host calls it an app password or a mailbox password. You type its server names in Email settings after this.')],
};

const STEPS = {
  provider: () => t('Pick her mail provider'),
  add: () => t('Add Email to Sara'),
  account: () => t('Her address and app password'),
  link: () => t('Link your address'),
  test: () => t('Test'),
};

let st = { open: '', provider: '' };
let view = null;

function providerBody(body) {
  const pick = el('div', 'setup-os');
  pick.setAttribute('role', 'group');
  pick.setAttribute('aria-label', t('Mail provider'));
  for (const id of Object.keys(PROVIDERS)) {
    const b = btn(id === 'Other' ? t('Other') : id, st.provider === id ? '' : 'ghost', () => ((st.provider = id), sessionStorage.setItem('sara.email.provider', id), render()));
    b.setAttribute('aria-pressed', String(st.provider === id));
    pick.append(b);
  }
  body.append(pick);
  if (!st.provider) return void body.append(el('p', 'muted small', t('Outlook.com needs a sign-in Sara doesn\'t do yet; Gmail, iCloud, Fastmail and most hosts work with an app password.')));
  const [url, how] = PROVIDERS[st.provider]();
  body.append(el('p', 'small', how));
  if (url) body.append(link(t('Where to make an app password ↗'), url, 'button-link'));
}

function accountBody(body, out) {
  if (!view.plugin) return void body.append(el('p', 'muted small', t('Add Email to Sara first (step 2).')));
  body.append(
    field('em-address', t('Her email address'), t('An address only she uses, like sara@yourdomain.com or a new account. Not your own address: she would answer everything in your inbox.'), { value: view.address, placeholder: 'sara@…', mode: 'email' }),
    field('em-password', t('App password'), t("The app password from step 1, not the normal password. Kept encrypted in Sara's vault and never shown again."), { type: 'password', placeholder: view.passwordSet ? t('Saved (type to replace)') : '' }),
  );
  if (st.provider === 'Other') body.append(el('p', 'muted small', t('Other providers: type the server names in Email settings, below.')));
  body.append(btn(t('Save and check'), '', async () => {
    const address = $('#em-address').value.trim();
    const pass = $('#em-password');
    const values = { provider: st.provider || 'Other', address, username: address };
    if (pass.value) values.password = pass.value;
    pass.value = '';
    checking(out);
    try {
      await api('/plugins/email/settings', { method: 'PUT', body: { companion: view.companion, values } });
      await poll(out);
    } catch (err) {
      out.replaceChildren(errLine(err.message));
    }
  }));
  if (view.state === 'ok') body.append(okLine(t('Signed in as {address}', { address: view.address })));
}

const errLine = (text) => {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  box.dataset.state = 'warn';
  box.append(el('strong', '', t("Sara couldn't sign in to her mailbox.")), el('span', '', text || t('Check the address and the app password, then press Save and check again.')));
  return box;
};

/** After a save the plugin restarts: look for up to 20 s (every second) whether she signed in. */
async function poll(out) {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const b = await api(`/plugins/email/bridge?companion=${enc(view.companion)}`).catch(() => null);
    if (b?.state === 'ok') return void (await load());
    if (b?.state === 'error') return void out.replaceChildren(errLine(b.detail));
  }
  out.replaceChildren(errLine(''));
}

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const step = view.steps.find((s) => s.id === id);
  if (id === 'provider') providerBody(body);
  if (id === 'add') {
    if (view.plugin) body.append(okLine(view.on ? t('Added and on for her.') : t('Added, but switched off. Switch it on for her in Settings → Plugins.')));
    else body.append(el('p', 'small', t('Email comes with Sara: one short step, and only Sara holds its connections.')), btn(t('Add email'), '', () => startFirstParty('email', body, { name: t('Email'), reach: t('It can reach her mail servers (IMAP and SMTP, always encrypted); nothing else.'), reviewCard, full: addBuiltin, done: load })));
  }
  if (id === 'account') accountBody(body, out);
  if (id === 'link') {
    const row = el('div', 'add-row');
    row.append(btn(t('Link my email'), '', async () => {
      try {
        const r = await api('/plugins/email/link', { method: 'POST', body: { companion: view.companion } });
        out.replaceChildren(copyRow(t('Send her an email with this subject'), r.code, t('From your own address, to hers, within 10 minutes. That is how she knows which address is you.')));
      } catch (err) {
        out.replaceChildren(errLine(err.message));
      }
    }), tip(t('Gives a code for 10 minutes. Email it to her from your own address as the subject.')));
    body.append(row);
    if (view.linked) body.append(okLine(t('Linked to you')));
  }
  if (id === 'test') {
    body.append(btn(t('Test'), '', async () => {
      checking(out);
      const r = await api('/plugins/email/test', { method: 'POST', body: { companion: view.companion } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
      out.replaceChildren(testList(r));
    }));
  }
  body.append(out, stepNav(view.steps.map((s) => s.id), id, { primary: step?.ok }, (to) => ((st.open = to), render())));
  return body;
}

function render() {
  const box = $('#em-box');
  const chip = $('#em-chip');
  if (!box || !view) return;
  view.steps = [
    { id: 'provider', ok: Boolean(st.provider) },
    { id: 'add', ok: Boolean(view.plugin && view.on) },
    { id: 'account', ok: view.state === 'ok' },
    { id: 'link', ok: view.linked },
    { id: 'test', ok: view.state === 'ok' && view.linked },
  ];
  const all = view.steps.every((s) => s.ok);
  chip.textContent = all ? t('Connected') : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.plugin ? t('{n} of {total} done', { n: view.steps.filter((s) => s.ok).length, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = all ? 'ok' : view.state === 'error' || view.state === 'paused' ? 'warn' : '';
  if (!view.started && !view.plugin) {
    box.replaceChildren(setupCard('email', { builtin: view.builtin, missing: t("Email doesn't come with this copy of Sara."), onStart: () => ((view.started = true), sessionStorage.setItem('sara.email.started', '1'), render()) }));
    return;
  }
  const more = el('div', 'add-row');
  if (view.plugin) more.append(btn(t('Email settings'), 'ghost', () => openPluginSettings(view.plugin)));
  if (view.update) more.append(btn(t('Update available: {version}', { version: view.update }), 'ghost', () => addBuiltin('email')));
  if (all && !view.force) return void box.replaceChildren(foldedLine(t('Email: working'), () => ((view.force = true), (st.open = 'provider'), render())), more);
  if (!st.open || !view.steps.some((s) => s.id === st.open)) st.open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  box.replaceChildren(stepper({ title: t('Set up email'), steps: view.steps, open: st.open, titleOf: (id) => STEPS[id](), bodyOf: stepBody, onOpen: (id) => ((st.open = id), render()) }), more);
}

async function load() {
  const box = $('#em-box');
  if (!box) return;
  try {
    const [{ builtin }, { plugins }] = await Promise.all([api('/plugins/builtin'), api('/plugins')]);
    const b = builtin.find((x) => x.id === 'email');
    const p = plugins.find((x) => x.id === 'email');
    const on = p?.companions.find((c) => c.on);
    const companion = on?.id ?? p?.companions[0]?.id ?? 'main';
    let bridge = { state: on ? 'connecting' : 'off', linked: [] };
    if (on) bridge = await api(`/plugins/email/bridge?companion=${enc(companion)}`).catch(() => bridge);
    let settings = [];
    if (p) settings = (await api(`/plugins/email/settings?companion=${enc(companion)}`).catch(() => ({ settings: [] }))).settings ?? [];
    const value = (k) => settings.find((s) => s.key === k)?.value;
    const keep = view ? { started: view.started, force: view.force } : { started: sessionStorage.getItem('sara.email.started') === '1' };
    view = { ...keep, builtin: Boolean(b), plugin: p ?? null, on: Boolean(on), companion, state: bridge.state, linked: (bridge.linked ?? []).length > 0, address: String(value('address') ?? ''), passwordSet: Boolean(value('password')), update: b?.updateAvailable ? b.version : '', steps: [] };
    st.provider ||= (p && value('provider') && String(value('address') ?? '') ? String(value('provider')) : '') || sessionStorage.getItem('sara.email.provider') || '';
    render();
  } catch (err) {
    box.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadEmailPage() {
  await load();
}
