// Phase 122 part 3 (docs/design/BRIDGES4.md §7.1, §8.3): Settings → Connections → iMessage. Before it
// is added: what it is, that it needs a Mac, what he needs, the terms box (a tick he must give) and
// Start. After that the WhatsApp stepper (web/whatsapp.js): one step open at a time, the exact Mac
// screens as a numbered list, a check Sara runs; a step turns ✓ only when Sara checked it. Every
// failure is one plain sentence with the fix (DIAG, the same codes as plugins/imessage/diagnose.mjs).
// Connected: a summary (basic or Private API, doorbell or polling), Test, who can reach her. The
// BlueBubbles password goes to the vault and is never shown again; Sara never gives SIP instructions.
import { t } from './naming.js';
import { addBuiltin, reviewCard } from './plugins.js';
import { api, btn, checking, copyRow, diagLine as diagWith, el, enc, field, foldedLine, link, okLine, pathList, setupCard, startFirstParty, stepNav, stepper, testList, tick, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);
const APPLE = 'https://account.apple.com';
const RELEASES = 'https://github.com/BlueBubblesApp/bluebubbles-server/releases/latest';

/** Every diagnosis code (§7.4): the title, then the fix. */
export const DIAG = {
  BB_UNREACHABLE: () => [t("Sara can't reach BlueBubbles."), t('Is the Mac on and awake, and BlueBubbles open? On another computer, check the address in step 5.')],
  BB_PASSWORD: () => [t("BlueBubbles didn't accept the password."), t('Copy it again from BlueBubbles → Settings → Server password.')],
  MESSAGES_SIGNED_OUT: () => [t("Messages on the Mac isn't signed in to iMessage."), t('On the Mac: Messages → Settings → iMessage → sign in with her Apple ID.')],
  OWN_APPLE_ID: () => [t('This Mac is signed in with your own Apple ID.'), t('Sara would see all your chats and answer as you. Give her her own Apple ID and macOS user (steps 1 and 2).')],
  NETWORK_SWITCH: () => [t('That address is on your network.'), t('Switch on BlueBubbles runs on another computer on my network.')],
  TAILNET_OFF: () => [t("That's a Tailscale address, but this computer isn't on Tailscale."), t('Start Tailscale on this computer, then check again.')],
  NO_DOORBELL: () => [t("BlueBubbles can't reach Sara, so she checks every few seconds instead."), t('That works; for faster answers put both on Tailscale.')],
  MAC_ASLEEP: () => [t('The Mac seems asleep or BlueBubbles closed.'), t('Keep it awake (step 3) and BlueBubbles open.')],
  SEND_FAILED: () => [t("iMessage didn't send this."), t("Is she still signed in on the Mac? It's in the app.")],
  NOT_IMESSAGE: () => [t("That number isn't on iMessage, and Sara can only send blue messages."), t('Text her from an iPhone, iPad or Mac.')],
  HEIC: () => [t("She can't see HEIC photos yet."), t('iPhone: Settings → Camera → Formats → Most Compatible.')],
  PRIVATE_LOCAL: () => [t('Paused: "Nothing leaves this computer" is on.'), t('Messages wait on the Mac; she reads them when it is off.')],
  NOT_SET: () => [t('Tell Sara where BlueBubbles is and its password first.'), t('Steps 4 and 5.')],
  NOT_RUNNING: () => [t("The iMessage plugin isn't running."), t('Switch it on for her in Settings → Plugins.')],
  NOT_ON: () => [t('iMessage is added but switched off.'), t('Switch it on for her in Settings → Plugins.')],
  UNKNOWN: () => [t('BlueBubbles said something Sara does not know.'), t('Press Details, or try again.')],
};

/** The eight steps (§7.1): title, the exact path (one click per line), the page to open. */
const STEPS = {
  appleid: () => [t('Give her an Apple ID'), t('Any browser: account.apple.com → Create Your Apple Account → name Sara, a birthday, a new email address for her, a password, your own phone number for the codes → the codes Apple sends'), APPLE],
  macuser: () => [t('Give her a place on the Mac'), t("On your own Mac: System Settings → Users & Groups → Add User… → Standard, name Sara → Create User → Apple menu → Log Out → log in as Sara. On a spare Mac, skip this."), null],
  messages: () => [t('Sign her in to Messages and keep the Mac awake'), t('As Sara on the Mac: Messages → Settings… → iMessage → sign in with her Apple ID → tick her email under You can be reached for messages at → System Settings → Energy (laptops: Battery → Options) → Prevent automatic sleeping when the display is off'), null],
  install: () => [t('Install BlueBubbles'), t('github.com/BlueBubblesApp/bluebubbles-server/releases/latest → the .dmg under Assets → Finder → Downloads → right-click → Open → drag it to Applications → open it → Permissions: System Settings → Privacy & Security → Full Disk Access → switch on BlueBubbles → Notifications: continue without them → Connection: type a server password and press the floppy-disk icon → Proxy service: Dynamic DNS / Custom URL, address empty'), RELEASES],
  server: () => [t('Tell Sara where BlueBubbles is'), t('Same Mac as Sara: 127.0.0.1:1234. Another Mac: System Settings → Wi-Fi → Details… → IP address, or the Tailscale menu → This Device'), null],
  doorbell: () => [t('Let BlueBubbles ring Sara'), t('Sara adds her address to BlueBubbles and waits for its hello. Nothing to do on the Mac.'), null],
  hello: () => [t('Say hello from your iPhone'), t('Messages → New message → To: her email → send the code below'), null],
  test: () => [t('Test'), t('Checks every step and sends nothing to anyone.'), null],
};

let view = null;
let open = '';
let companion = 'main';
let code = '';

const diagLine = (d) => diagWith(d, DIAG);

const serverLine = (s) => t('BlueBubbles {version} on macOS {os}, signed in as {account}', { version: s.version || '?', os: s.os || '?', account: s.account || '?' }) + (s.privateApi ? ` · ${t('Private API on')}` : ` · ${t("Private API off (that's fine)")}`);

async function post(path, body, out) {
  checking(out);
  try {
    const r = await api(`/plugins/imessage/${path}`, { method: 'POST', body: { companion, ...body } });
    out.replaceChildren(r.ok ? okLine(r.version ? serverLine(r) : t('Checked')) : diagLine(r.diagnosis));
    await load(true);
    return r;
  } catch (err) {
    out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
    return null;
  }
}

async function linkCode() {
  if (code) return;
  const r = await api('/plugins/imessage/fix', { method: 'POST', body: { companion, fix: 'link' } }).catch(() => null);
  code = r?.code ?? '';
}

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const st = view.steps.find((s) => s.id === id);
  const [, path] = STEPS[id]();
  body.append(pathList(path));
  if (id === 'appleid') body.append(el('p', 'muted small', t('A separate Apple ID for her, never your own: on your own Apple ID she would see all your chats and answer as you. Sara checks this in step 5.')));
  if (id === 'install') {
    body.append(
      field('im-pass', t('BlueBubbles server password'), t("The password you saved in BlueBubbles' Connection step. Kept encrypted in Sara's vault. Anyone with it can read and send her messages."), { type: 'password', placeholder: view.passwordSet ? t('Saved (type to replace)') : '' }),
      btn(t('Save and check'), '', async () => {
        const pass = $('#im-pass');
        const v = pass.value;
        pass.value = '';
        await post('password', { password: v }, out);
      }),
    );
  }
  if (id === 'server') {
    body.append(
      field('im-server', t('BlueBubbles address'), t("Where BlueBubbles runs, with its port. 127.0.0.1:1234 if Sara runs on the same Mac; otherwise the Mac's address on your home network or its Tailscale name, like 192.168.1.20:1234."), { value: view.server.address || '127.0.0.1:1234' }),
      tick('im-other', t('BlueBubbles runs on another computer on my network'), t('Lets Sara talk to BlueBubbles on another computer at home or on your Tailscale network. Never anything on the internet.'), view.server.onOtherMachine),
    );
    const adv = el('details', 'wa-details');
    adv.append(el('summary', '', t('Advanced')), tick('im-https', t('BlueBubbles uses HTTPS'), t('Turn on only if you gave BlueBubbles a certificate for the address above. Without it the password travels unencrypted on your home network; Tailscale or the same Mac avoids that.'), view.server.https));
    body.append(adv, el('p', 'muted small', t('On your home network the password travels unencrypted; Tailscale or running Sara on the same Mac avoids that.')));
    body.append(btn(t('Save and check'), '', () => post('address', { server: $('#im-server').value.trim(), onOtherMachine: $('#im-other').checked, https: $('#im-https').checked }, out)));
    if (st?.ok) body.append(okLine(serverLine(view.server)));
  }
  if (id === 'doorbell') {
    body.append(copyRow(t('Where BlueBubbles reaches Sara'), view.saraAddress ?? '', t('This computer when Sara and BlueBubbles share a Mac; otherwise her address on your home network or Tailscale.')));
    const adv = el('details', 'wa-details');
    adv.append(el('summary', '', t('Advanced: another address')), field('im-sara', t("Sara's address for BlueBubbles"), t('Only if BlueBubbles must use another address to reach Sara, like http://192.168.1.10:7860.'), { value: '' }));
    body.append(adv);
    const row = el('div', 'add-row');
    row.append(
      btn(t('Ring'), '', async () => {
        const r = await post('fix', { fix: 'doorbell', ...($('#im-sara')?.value.trim() ? { saraAddress: $('#im-sara').value.trim() } : {}) }, out);
        if (r?.ok) out.replaceChildren(okLine(t('BlueBubbles reached Sara')));
      }),
      btn(t('Use polling'), 'ghost', (b) => {
        b.disabled = true;
        return post('fix', { fix: 'polling' }, out);
      }),
      tip(t('Polling works without the doorbell; answers take a few seconds longer.')),
    );
    body.append(row);
    if (view.doorbell === 'ok') body.append(okLine(t('BlueBubbles reached Sara')));
    else if (view.doorbell === 'polling') body.append(okLine(t('Polling (answers take a few seconds)')));
  }
  if (id === 'hello') {
    body.append(copyRow(t('Her address'), view.server.account, t('Send your message to this address from Messages on your iPhone.')));
    const row = el('div', 'add-row');
    row.append(btn(t('Link my iMessage'), '', async () => {
      code = '';
      await linkCode();
      render();
    }), tip(t("Gives a code for 10 minutes. Send it to her from your iPhone. That's how she knows which number or email is you.")));
    body.append(row);
    if (code) body.append(copyRow(t('Send this to her'), `/link ${code}`, t('Type it in Messages exactly like this. Sara link and the code works too.')));
  }
  if (id === 'test') {
    const row = el('div', 'add-row');
    row.append(btn(t('Test'), '', () => test(out)), tip(t('Checks BlueBubbles, the password, Messages, the Apple ID, the doorbell or polling and the link. Sends nothing to anyone.')));
    body.append(row);
  }
  if (st?.diagnosis && !out.childNodes.length) out.append(diagLine(st.diagnosis));
  body.append(out);
  const ids = view.steps.map((s) => s.id);
  body.append(stepNav(ids, id, { primary: st?.ok || ids.indexOf(id) < 3 }, (to) => ((open = to), render())));
  return body;
}

async function test(out) {
  checking(out);
  const r = await api('/plugins/imessage/check', { method: 'POST', body: { companion, step: 'test' } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
  out.replaceChildren(testList(r));
  if (r.ok) await load(true);
}

function goodToKnow() {
  const good = el('div', 'kit-card');
  const head = el('h3', '', t('Good to know'));
  good.append(head, el('p', 'small', t('Needs a Mac that stays on.')));
  const p = el('p', 'small', t('Works without the Private API.'));
  p.append(' ', tip(t('A BlueBubbles add-on for typing dots, tapbacks and edits. It needs a Mac security feature (SIP) turned off. Sara works without it and never asks you to turn SIP off.')));
  good.append(p, el('p', 'small', t('Commands work with her name first too: Sara help, Sara new.')));
  return good;
}

function side() {
  const col = el('div', 'wa-side');
  const card = el('div', 'kit-card');
  const [, path, url] = STEPS[open]?.() ?? [];
  card.append(el('h3', '', t('The screen you need')), el('p', 'small', path ?? ''));
  if (url) card.append(link(url === APPLE ? t('Open account.apple.com ↗') : t('Open the download page ↗'), url, 'button-link'));
  card.append(link(t('This screen looks different?'), '/help#imessage'));
  col.append(card, goodToKnow());
  return col;
}

// PL2a (N1, N2): the shared setup card; Start → the short consent step (Sara's own plugin).
function intro(box, builtin) {
  const mail = el('a', 'small', t('Send these steps to my email'));
  mail.href = `mailto:?subject=${enc(t('Set up iMessage'))}&body=${enc(Object.values(STEPS).map((f, i) => `${i + 1}. ${f()[0]}: ${f()[1]}`).join('\n\n'))}`;
  box.replaceChildren(setupCard('imessage', {
    builtin,
    extra: [mail],
    missing: t("iMessage doesn't come with this copy of Sara."),
    onStart: async () => {
      localStorage.setItem('im-terms', new Date().toISOString());
      await startFirstParty('imessage', box, { name: 'iMessage', reach: t("It can reach BlueBubbles on your Mac, and only on your own network; nothing else."), reviewCard, full: addBuiltin, done: load });
    },
  }));
}

function summary() {
  const card = el('div', 'kit-card');
  const mode = view.server.privateApi ? t('Connected (Private API)') : t('Connected (basic)');
  const door = view.doorbell === 'ok' ? t('doorbell ✓') : t('polling');
  card.append(el('h3', '', t('Connected')), el('p', '', [view.server.account, mode, view.linked.length ? t('linked to you') : '', door].filter(Boolean).join(' · ')));
  const basic = el('p', 'small', view.server.privateApi ? t('Typing dots, tapbacks and edited progress are on.') : t('Basic mode: answers, pictures and files. A line says when she is working on something long.'));
  basic.append(' ', tip(t('A BlueBubbles add-on for typing dots, tapbacks and edits. It needs a Mac security feature (SIP) turned off. Sara works without it and never asks you to turn SIP off.')));
  const out = el('div', 'wa-check');
  const row = el('div', 'add-row');
  row.append(btn(t('Test'), '', () => test(out)));
  card.append(basic, row, out);
  if (view.sentToday) card.append(el('p', 'muted small', view.sentToday === 1 ? t('1 message sent today') : t('{n} messages sent today', { n: view.sentToday })));
  const who = el('div', 'kit-card');
  who.append(el('h3', '', t('Who can reach her')), el('p', 'small', view.others ? t('You and the people on your list, as partners: no tools, nothing private, the AI notice first.') : t('Only you. Anyone else gets one line saying she only chats with you, then nothing.')));
  const terms = el('p', 'muted small', t('BlueBubbles is not made or approved by Apple. Use your own Mac and a separate Apple ID for her.'));
  return [foldedLine(t('iMessage: working'), () => ((open = 'appleid'), (view.forceSteps = true), render())), card, who, terms];
}

function render() {
  const box = $('#im-box');
  const chip = $('#im-chip');
  if (!box || !view) return;
  const all = view.done === view.steps.length;
  chip.textContent = view.refused ? t('Refused: your own Apple ID') : view.state === 'ok' && all ? (view.server.privateApi ? t('Connected (Private API)') : t('Connected (basic)')) : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.installed ? t('{n} of {total} done', { n: view.done, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = view.state === 'ok' && all && !view.refused ? 'ok' : view.state === 'error' || view.state === 'paused' || view.refused ? 'warn' : '';
  if (!view.installed) return;
  if (all && !view.forceSteps) return void box.replaceChildren(...summary());
  if (!open || !view.steps.some((s) => s.id === open)) open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  const left = stepper({ title: t('Set up iMessage'), note: t('Do this at the Mac.'), steps: view.steps, open, titleOf: (id) => STEPS[id]()[0], bodyOf: stepBody, onOpen: (id) => ((open = id), render()) });
  const grid = el('div', 'wa-grid');
  grid.append(left, side());
  box.replaceChildren(grid);
}

async function load(keepOpen = false) {
  try {
    const { plugins } = await api('/plugins');
    const p = plugins.find((x) => x.id === 'imessage');
    companion = p?.companions.find((c) => c.on)?.id ?? companion;
    const keep = view?.forceSteps;
    view = await api(`/plugins/imessage/setup?companion=${enc(companion)}`);
    if (keep) view.forceSteps = true;
    if (!keepOpen && open && view.steps.find((s) => s.id === open)?.ok) open = '';
    if (view.installed && !view.terms && localStorage.getItem('im-terms')) await api('/plugins/imessage/terms', { method: 'POST', body: { companion } }).catch(() => undefined);
    if (!view.installed) {
      const { builtin } = await api('/plugins/builtin');
      render();
      intro($('#im-box'), builtin.some((b) => b.id === 'imessage'));
      return;
    }
    render();
  } catch (err) {
    $('#im-box')?.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadIMessagePage() {
  await load();
}
