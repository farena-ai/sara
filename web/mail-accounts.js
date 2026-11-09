// M1 (docs/EMAIL.md): Settings → Add-ons → Email and calendar. Every mailbox she can read: the list
// (provider, address, default, Test, Remove) and three ways to add one: Gmail (its own page),
// Outlook / Microsoft 365 (numbered steps for the owner's own Microsoft app, the redirect address to
// copy, then Sign in with Microsoft) and another provider (pick it, the app-password steps, Add and
// check). Passwords and secrets go to the server once and are never shown again.
import { t } from './naming.js';
import { api, btn, checking, copyRow, el, enc, field, link, okLine, stepper, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);
let view = null;
let adding = '';
let msOpen = 'register';
let preset = '';

/** Where each provider makes an app password, in plain steps (the server knows the servers). */
const HOW = {
  gmail: () => t('Google Account → Security: 2-Step Verification must be on. Then App passwords, name it Sara, Create, and copy the 16 letters.'),
  yahoo: () => t('Yahoo Account → Account security → Generate app password, name it Sara, copy the code.'),
  aol: () => t('AOL Account → Account security → Generate app password, name it Sara, copy the code.'),
  icloud: () => t('account.apple.com → Sign-In and Security → App-Specific Passwords → Generate, name it Sara.'),
  fastmail: () => t('Fastmail Settings → Privacy & Security → Manage app passwords → New app password, with access to IMAP and SMTP.'),
  zoho: () => t('Zoho Accounts → Security → App Passwords → Generate New Password. IMAP access must be on in Zoho Mail → Settings → Mail Accounts.'),
  'zoho-eu': () => t('Zoho Accounts → Security → App Passwords → Generate New Password. IMAP access must be on in Zoho Mail → Settings → Mail Accounts.'),
  gmx: () => t('Switch IMAP on in GMX → E-mail settings → POP3 & IMAP. With two-step sign-in on, make an application-specific password under Security.'),
  'gmx-de': () => t('Switch IMAP on in GMX → E-mail settings → POP3 & IMAP. With two-step sign-in on, make an application-specific password under Security.'),
  webde: () => t('Switch IMAP on in WEB.DE → E-mail settings → POP3/IMAP. With two-step sign-in on, make an application-specific password.'),
  proton: () => t('Install Proton Mail Bridge on this computer and sign in there (paid Proton plans). Use the password Bridge shows under your account → Mailbox details, not your Proton password.'),
  other: () => t('Your mail host calls it an app password or a mailbox password. Its help pages list the IMAP and SMTP server names.'),
};
const KIND = { google: 'Gmail', microsoft: 'Outlook' };

const MS_STEPS = ['register', 'redirect', 'secret', 'permissions', 'signin'];
const MS_TITLES = {
  register: () => t('Register a free app in Microsoft Entra'),
  redirect: () => t('Paste the redirect address'),
  secret: () => t('Copy the Application ID and make a secret'),
  permissions: () => t('Give it the mail and calendar permissions'),
  signin: () => t('Save, sign in and test'),
};

function msBody(id) {
  const body = el('div', 'wa-step-body');
  const ms = view.microsoft;
  const ol = (lines) => {
    const list = el('ol', 'small setup-steps');
    for (const l of lines) list.append(el('li', '', l));
    return list;
  };
  if (id === 'register') {
    body.append(
      el('p', 'small', t('Outlook.com, Hotmail and Microsoft 365 sign in through Microsoft, with a small app that you own (free, about 10 minutes, once). Nothing goes through anyone else.')),
      ol([
        t('Open the Microsoft Entra admin center and sign in with your Microsoft account (a personal Outlook.com account gets a free directory the first time).'),
        t('Go to Identity → Applications → App registrations → New registration.'),
        t('Name: Sara. Supported account types: "Accounts in any organizational directory and personal Microsoft accounts".'),
      ]),
      link(t('Open the Microsoft Entra admin center ↗'), 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade', 'button-link'),
    );
  }
  if (id === 'redirect') {
    body.append(
      el('p', 'small', t('Still on the New registration page: under Redirect URI choose Web and paste this address, then press Register.')),
      copyRow(t('Redirect URI'), ms.redirect, t('Microsoft sends you back here after you allow Sara. It must match exactly.')),
    );
    if (!/^https:|^http:\/\/localhost[:/]/.test(ms.redirect)) body.append(el('p', 'muted small', t('Microsoft only accepts http:// addresses for localhost. Open Sara at http://localhost:<port> on this computer (or through https) while you sign in.')));
  }
  if (id === 'secret') {
    body.append(ol([
      t('On the app\'s Overview page, copy the Application (client) ID.'),
      t('Open Certificates & secrets → Client secrets → New client secret, description Sara, expiry 24 months → Add.'),
      t('Copy the Value at once (not the Secret ID): Microsoft shows it only now.'),
    ]));
  }
  if (id === 'permissions') {
    body.append(
      ol([t('Open API permissions → Add a permission → Microsoft Graph → Delegated permissions.'), t('Tick offline_access, User.Read, Mail.ReadWrite, Mail.Send and Calendars.ReadWrite, then Add permissions.')]),
      el('p', 'muted small', t('No admin consent is needed for your own mailbox. Sara never deletes mail for good: trash is the Deleted Items folder.')),
    );
  }
  if (id === 'signin') {
    const out = el('div', 'wa-check');
    body.append(
      field('ma-ms-id', t('Application (client) ID'), t('From the app\'s Overview page.'), { value: ms.clientId ?? '', placeholder: '1a2b3c4d-…' }),
      field('ma-ms-secret', t('Client secret value'), t("Kept encrypted in Sara's vault and never shown again."), { type: 'password', placeholder: ms.configured ? t('Saved (type to replace)') : '' }),
    );
    const row = el('div', 'add-row');
    row.append(
      btn(t('Save'), 'ghost', async () => {
        const secret = $('#ma-ms-secret').value;
        $('#ma-ms-secret').value = '';
        try {
          view = await api('/mail/microsoft/client', { method: 'PUT', body: { clientId: $('#ma-ms-id').value.trim(), clientSecret: secret } });
          out.replaceChildren(okLine(t('Saved. Now sign in.')));
        } catch (err) {
          out.replaceChildren(el('p', 'error small', err.message));
        }
      }),
      btn(t('Sign in with Microsoft'), '', async () => {
        try {
          const r = await api('/mail/microsoft/connect', { method: 'POST', body: {} });
          location.href = r.url;
        } catch (err) {
          out.replaceChildren(el('p', 'error small', err.message));
        }
      }),
    );
    body.append(row, out);
  }
  return body;
}

function otherForm() {
  const box = el('div', 'kit-card ma-other');
  const out = el('div', 'wa-check');
  const pick = el('select', '');
  pick.id = 'ma-preset';
  pick.append(new Option(t('Pick your provider'), ''));
  for (const p of view.presets) pick.append(new Option(p.name, p.id));
  pick.append(new Option(t('Other (type the servers)'), 'other'));
  pick.value = preset;
  pick.addEventListener('change', () => ((preset = pick.value), render()));
  const label = el('label', 'plg-field');
  label.append(el('span', 'plg-field-name', t('Mail provider')), pick);
  box.append(el('h3', '', t('Add another provider')), el('p', 'muted small', t('Yahoo, AOL, iCloud, Fastmail, Zoho, GMX, WEB.DE, Proton Mail (with Bridge) or your own host, with an app password. Outlook.com and Hotmail use the Microsoft sign-in above.')), label);
  if (!preset) return box;
  const p = view.presets.find((x) => x.id === preset);
  // Numbered like the move-in wizard: where to click, what to copy, where to paste it.
  const steps = el('ol', 'small setup-steps ma-steps');
  if (p?.passwordUrl) {
    const first = el('li', '', t('Open your provider\'s app-password page and sign in there:'));
    first.append(' ', link(t('Where to make an app password ↗'), p.passwordUrl, 'button-link'));
    steps.append(first);
  }
  steps.append(el('li', '', (HOW[preset] ?? HOW.other)()), el('li', '', t('Type the email address and paste the app password below, then press Add and check. Sara signs in to both servers and sends nothing.')));
  box.append(steps);
  box.append(
    field('ma-address', t('Email address'), t('The whole address of the mailbox.'), { mode: 'email', placeholder: 'you@…' }),
    field('ma-password', t('App password'), t("The app password, not your normal password. Kept encrypted in Sara's vault and never shown again."), { type: 'password' }),
  );
  if (preset === 'other') {
    box.append(
      field('ma-imap', t('IMAP server'), t('Like imap.example.com. Port 993 (or 143 with STARTTLS).'), { placeholder: 'imap.example.com' }),
      field('ma-imap-port', t('IMAP port'), t('993 for most hosts.'), { value: '993', mode: 'numeric' }),
      field('ma-smtp', t('SMTP server'), t('Like smtp.example.com. Port 465 (or 587 with STARTTLS).'), { placeholder: 'smtp.example.com' }),
      field('ma-smtp-port', t('SMTP port'), t('465 or 587.'), { value: '465', mode: 'numeric' }),
      field('ma-user', t('Sign-in name'), t('Leave empty when it is the email address.'), {}),
    );
  } else if (p) box.append(el('p', 'muted small', t('Servers: {imap} and {smtp}', { imap: `${p.imap.host}:${p.imap.port}`, smtp: `${p.smtp.host}:${p.smtp.port}` })));
  box.append(
    btn(t('Add and check'), '', async () => {
      const pw = $('#ma-password');
      const body = { preset, address: $('#ma-address').value.trim(), password: pw.value };
      if (preset === 'other') Object.assign(body, { imapHost: $('#ma-imap').value.trim(), imapPort: Number($('#ma-imap-port').value), smtpHost: $('#ma-smtp').value.trim(), smtpPort: Number($('#ma-smtp-port').value), user: $('#ma-user').value.trim() });
      pw.value = '';
      checking(out);
      try {
        view = await api('/mail/imap', { method: 'POST', body });
        adding = '';
        preset = '';
        render();
        status(t('Added. Sara signed in to both servers and sent nothing.'));
      } catch (err) {
        out.replaceChildren(el('p', 'error small', err.message));
      }
    }),
    out,
  );
  return box;
}

function status(text) {
  const s = $('#ma-status');
  if (s) s.textContent = text;
}

function accountRow(a) {
  const li = el('li', `ma-row${a.problem ? ' bad' : ''}`);
  const name = el('span', 'ma-name');
  name.append(el('strong', 'ma-provider', KIND[a.kind] ?? (view.presets.find((p) => p.id === a.provider)?.name ?? t('Other'))), el('span', 'ma-address', ` ${a.address}`));
  name.lastChild.dataset.raw = '';
  li.append(name);
  if (a.calendar) li.append(el('span', 'rc-chip', t('Mail and calendar')));
  if (view.default === a.id) li.append(el('span', 'rc-chip ok', t('Default')));
  if (a.problem) li.append(el('span', 'error small', t('Signed out: sign in again.')));
  const acts = el('span', 'ma-acts');
  if (view.default !== a.id) acts.append(btn(t('Make default'), 'ghost small', async () => ((view = await api('/mail/default', { method: 'PUT', body: { id: a.id } })), render())));
  acts.append(btn(t('Test'), 'ghost small', async () => {
    status(t('Checking…'));
    const r = await api(`/mail/accounts/${enc(a.id)}/test`, { method: 'POST', body: {} }).catch((err) => ({ ok: false, text: err.message }));
    status(`${r.ok ? '✓' : '✕'} ${r.text}`);
  }));
  if (a.kind === 'google') acts.append(btn(t('Open'), 'ghost small', () => globalThis.openSettingsPage?.('ab-google')));
  else
    acts.append(btn(t('Remove'), 'ghost small', async () => {
      if (!confirm(t('Remove {address} from Sara? Its sign-in is deleted; your mail stays where it is.', { address: a.address }))) return;
      view = await api(`/mail/accounts/${enc(a.id)}`, { method: 'DELETE' });
      render();
    }));
  li.append(acts);
  return li;
}

/** A household member's Outlook: the owner's Microsoft app signs them in (no setup steps here). */
function memberMs() {
  const box = el('div', 'kit-card ma-other');
  const out = el('div', 'wa-check');
  box.append(el('h3', '', t('Outlook or Microsoft 365')));
  if (!view.microsoft.configured) {
    box.append(el('p', 'muted small', t('Outlook signs in through a Microsoft app that the owner of this server sets up once. Ask them to add it in their Settings → Email and calendar.')));
    return box;
  }
  box.append(
    el('p', 'small', t('Sign in with your own Microsoft account. Your mailbox is yours alone: the owner and other people here never see it.')),
    btn(t('Sign in with Microsoft'), '', async () => {
      try {
        const r = await api('/mail/microsoft/connect', { method: 'POST', body: {} });
        location.href = r.url;
      } catch (err) {
        out.replaceChildren(el('p', 'error small', err.message));
      }
    }),
    out,
  );
  return box;
}

function render() {
  const page = $('#ma-page');
  if (!page || !view) return;
  const list = el('ul', 'ma-list');
  for (const a of view.accounts) list.append(accountRow(a));
  if (view.off) {
    page.replaceChildren(el('p', 'muted small ma-off', t('Your admin switched off mailboxes for household members on this server.')), list);
    return;
  }
  if (!view.accounts.length) list.append(el('li', 'ma-empty small', t('No mailbox yet. Add one below: Gmail, Outlook or another provider.')));
  const add = el('div', 'add-row');
  // A member adds Gmail with an app password (the Google sign-in is the owner's).
  const addGmail = view.member ? () => ((adding = 'other'), (preset = 'gmail'), render()) : () => globalThis.openSettingsPage?.('ab-google');
  add.append(
    btn(t('Add Gmail'), adding === 'google' ? '' : 'ghost', addGmail),
    btn(t('Add Outlook or Microsoft 365'), adding === 'ms' ? '' : 'ghost', () => ((adding = adding === 'ms' ? '' : 'ms'), render())),
    btn(t('Add another provider'), adding === 'other' ? '' : 'ghost', () => ((adding = adding === 'other' ? '' : 'other'), render())),
    tip(t('Several mailboxes can be connected. She uses the default one unless you name another ("search my Outlook for…").')),
  );
  const parts = [list, add];
  if (view.member) parts.unshift(el('p', 'muted small ma-own', t('These are your own mailboxes: only your companions use them, and nobody else on this server can see them.')));
  if (adding === 'ms' && view.member) parts.push(memberMs());
  else if (adding === 'ms') {
    const steps = MS_STEPS.map((id) => ({ id, ok: id === 'signin' ? view.accounts.some((a) => a.kind === 'microsoft' && !a.problem) : MS_STEPS.indexOf(id) < MS_STEPS.indexOf(msOpen) || (id !== 'signin' && view.microsoft.configured) }));
    parts.push(stepper({ title: t('Outlook or Microsoft 365'), steps, open: msOpen, titleOf: (id) => MS_TITLES[id](), bodyOf: msBody, onOpen: (id) => ((msOpen = id), render()) }));
  }
  if (adding === 'other') parts.push(otherForm());
  page.replaceChildren(...parts);
}

export async function loadMailAccounts() {
  view = await api('/mail/accounts').catch(() => null);
  if (!view) return;
  // Coming back from Microsoft's sign-in page.
  const m = /^#microsoft=(\w+)/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    status({ connected: t('Outlook is connected. Try: "what needs an answer in my Outlook?"'), refused: t('Microsoft sign-in was cancelled.'), failed: t("Microsoft sign-in didn't work. Check the steps and try again.") }[m[1]] ?? '');
    adding = m[1] === 'connected' ? '' : 'ms';
    msOpen = 'signin';
  }
  render();
}
