// EC7 (docs/ops/EC7_DESIGN.md): Settings → Chat apps → Microsoft Teams. Before it is added: what it
// is, what he needs and Start. After that the shared stepper (web/setup-card.js): one step open at a
// time, the exact Azure and Teams screens as a numbered list, a check Sara runs; a step turns ✓ only
// when Sara checked it. Teams must call Sara, so step 3 says plainly what that needs (a public https
// address, or the Funnel door / a tunnel when there is none) and step 5 builds the Teams app package
// (a zip) he uploads in Teams. Every failure is one plain sentence with the fix (DIAG, the same codes
// as plugins/teams/diagnose.mjs). The client secret goes to the vault and never comes back here.
import { t } from './naming.js';
import { addBuiltin, reviewCard } from './plugins.js';
import { api, btn, checking, copyRow, diagLine as diagWith, el, enc, field, foldedLine, link, okLine, pathList, setupCard, startFirstParty, stepNav, stepper, testList, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);
const AZURE = 'https://portal.azure.com/#create/Microsoft.AzureBot';
const PORTAL = 'https://portal.azure.com';
const TEAMS = 'https://teams.microsoft.com';

/** Every diagnosis code: the title, then the fix. */
export const DIAG = {
  NOT_SET: () => [t('Paste the App ID, the Directory (tenant) ID and the client secret first.'), t('Step 2.')],
  APP_ID_SHAPE: () => [t("That isn't an App ID (it looks like 8-4-4-4-12 letters and digits)."), t('Copy Microsoft App ID from the Azure Bot → Configuration.')],
  TENANT_SHAPE: () => [t("That isn't a Directory (tenant) ID."), t('Copy App Tenant ID from the Azure Bot → Configuration.')],
  SECRET_SHAPE: () => [t("That's the secret's ID, not its value."), t('Make a new client secret and copy its Value right away (Azure shows it only once).')],
  APP_ID_WRONG: () => [t('Microsoft does not know that App ID in this directory.'), t('Check both IDs on the Azure Bot → Configuration page.')],
  TENANT_WRONG: () => [t('Microsoft does not know that directory (tenant).'), t('Copy App Tenant ID again from the Azure Bot → Configuration.')],
  SECRET_WRONG: () => [t('Microsoft did not accept that client secret.'), t('Make a new client secret and paste its Value.')],
  SECRET_EXPIRED: () => [t('The client secret has expired.'), t('Make a new client secret and paste its Value.')],
  NO_DOOR: () => [t('Teams has no way to reach Sara yet.'), t('Step 3: open the public door or paste a tunnel address.')],
  NOT_CALLED: () => [t('Teams has not called Sara yet.'), t('Check the messaging endpoint and the Teams channel, then send her a message in Teams.')],
  BAD_SIGNATURE: () => [t('Calls arrive that Microsoft did not sign.'), t('Paste the App ID again; if this goes on, someone else may be calling the address.')],
  FORBIDDEN: () => [t("Teams didn't let her post there."), t('Add her to that team or chat again.')],
  RATE_LIMITED: () => [t('Teams asked her to slow down.'), t("She'll send the rest shortly.")],
  FILE_TOO_BIG: () => [t('That file is too big to send.'), t("It's in the app.")],
  FILE_NOT_HERE: () => [t('In channels she can’t send files.'), t("It's in the app, or ask her in your personal chat with her.")],
  PRIVATE_LOCAL: () => [t('Paused: "Nothing leaves this computer" is on.'), t('Teams tries again for a while; she reads what arrives once it is off.')],
  CANT_REACH: () => [t("Couldn't reach Microsoft."), t('Check this computer is online, then try again.')],
  NOT_RUNNING: () => [t("The Teams plugin isn't running."), t('Switch it on for her in Settings → Plugins.')],
  NOT_ON: () => [t('Teams is added but switched off.'), t('Switch it on for her in Settings → Plugins.')],
  UNKNOWN: () => [t('Microsoft said something Sara does not know.'), t('Press Details, or try again.')],
};

/** The seven steps: title, the exact path (one click per line), the page to open. */
const STEPS = {
  bot: () => [t('Make the Azure Bot'), t('portal.azure.com → Create a resource → Azure Bot → Create → any bot handle → Pricing tier: Free (F0) → Type of App: Single Tenant → Create new Microsoft App ID → Review + create → Create → Go to resource'), AZURE],
  credentials: () => [t('Copy three values and paste them'), t('Your Azure Bot → Settings → Configuration → copy Microsoft App ID and App Tenant ID → Manage Password → Certificates & secrets → New client secret → Add → copy the Value (not the Secret ID)'), PORTAL],
  door: () => [t('Give Teams a way in'), t('Teams calls a public https address. Only /hook/ is public; the app stays private.'), null],
  endpoint: () => [t('Paste the messaging endpoint and add Teams'), t('Your Azure Bot → Settings → Configuration → Messaging endpoint: paste the address below → Apply → Channels → Microsoft Teams → Agree → Apply'), PORTAL],
  package: () => [t('Add her in Teams'), t('Download the package below → Teams → Apps → Manage your apps → Upload an app → Upload a custom app → pick sara-teams.zip → Add → Open → say hello'), TEAMS],
  link: () => [t('Link your Teams account'), t('In Teams: her chat → send her the code below'), null],
  test: () => [t('Test'), t('Checks every step and sends nothing to anyone.'), null],
};

let view = null;
let open = '';
let companion = 'main';
let code = '';

const diagLine = (d) => diagWith(d, DIAG);

async function newCode() {
  const r = await api('/plugins/teams/fix', { method: 'POST', body: { companion, fix: 'link' } }).catch(() => null);
  code = r?.code ?? '';
}

/** The zip comes from Sara (it needs his session), then is saved as sara-teams.zip. */
async function download(out) {
  const res = await fetch(`/api/plugins/teams/app-package?companion=${enc(companion)}`);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return void out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: e.error ?? `HTTP ${res.status}` }));
  }
  const url = URL.createObjectURL(await res.blob());
  const a = el('a', '');
  a.href = url;
  a.download = 'sara-teams.zip';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  out.replaceChildren(okLine(t('Downloaded sara-teams.zip')));
}

function doorBody(body, out) {
  const d = view.door;
  if (d.hookUrl) {
    body.append(okLine(t('Teams can reach Sara at {url}', { url: d.hookUrl })));
    body.append(el('p', 'muted small', t('Sara has a public https address, so nothing else is needed here.')));
  } else {
    body.append(el('p', 'small', t("No public address: Teams can't reach this computer. It needs a public https address that forwards /hook/ to Sara. Open the Tailscale Funnel door (free), or paste a tunnel's address.")));
    const row = el('div', 'add-row');
    row.append(
      btn(t('Open the public door'), '', async () => {
        try {
          const r = await api('/access/door', { method: 'POST', body: { action: 'open' } });
          out.replaceChildren(r.ok ? okLine(t('The door is open.')) : el('pre', 'wa-mono', r.output || r.command));
          if (r.ok) await load();
        } catch (err) {
          out.replaceChildren(diagLine({ code: 'NO_DOOR', detail: err.message }));
        }
      }),
      tip(t("Lets Teams reach Sara's message address on the internet through Tailscale Funnel. Only that address is public; the app itself stays private. Close it any time.")),
    );
    body.append(row, copyRow(t('Or run this yourself'), d.command, t('The same command the button runs. Funnel may first need Allow Funnel in the Tailscale admin console.')));
  }
  body.append(
    field('te-door-url', t('Something else: your tunnel address'), t('A Cloudflare Tunnel or another https proxy that forwards /hook/ to Sara. Paste its public address.'), { placeholder: 'https://…', value: d.pasted ? d.hookUrl : '' }),
    btn(t('Use this address'), 'ghost', async () => {
      try {
        await api('/plugins/teams/door-url', { method: 'POST', body: { companion, url: $('#te-door-url').value.trim() } });
        await load();
      } catch (err) {
        out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
      }
    }),
  );
}

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const st = view.steps.find((s) => s.id === id);
  const [, path] = STEPS[id]();
  body.append(pathList(path));
  if (id === 'bot') body.append(el('p', 'muted small', t('You need an Azure account (free) in the same Microsoft 365 organization as your Teams. The Free tier is enough: Teams messages cost nothing.')));
  if (id === 'credentials') {
    body.append(
      field('te-app', t('App ID'), t('The Microsoft App ID of your Azure Bot (Configuration page). It looks like 8-4-4-4-12 letters and digits.'), { placeholder: '00000000-0000-0000-0000-000000000000', value: view.appId }),
      field('te-tenant', t('Directory (tenant) ID'), t('Your Microsoft 365 directory: Azure Bot → Configuration → App Tenant ID. Leave empty only for an older multi-tenant bot.'), { placeholder: '00000000-0000-0000-0000-000000000000', value: view.tenantId }),
      field('te-secret', t('Client secret'), t("The Value of a client secret (Manage Password → Certificates & secrets), not its Secret ID. Kept encrypted in Sara's vault and never shown again."), { type: 'password', placeholder: view.secretSet ? t('Saved (paste to replace)') : '' }),
      btn(t('Save and check'), '', async () => {
        checking(out);
        const secret = $('#te-secret');
        try {
          const r = await api('/plugins/teams/credentials', { method: 'POST', body: { companion, appId: $('#te-app').value.trim(), tenantId: $('#te-tenant').value.trim(), appPassword: secret.value.trim() } });
          secret.value = '';
          if (!r.ok) return void out.replaceChildren(diagLine(r.diagnosis));
          out.replaceChildren(okLine(t('Microsoft accepted them.')));
          await load();
        } catch (err) {
          out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
        }
      }),
    );
  }
  if (id === 'door') doorBody(body, out);
  if (id === 'endpoint') {
    if (view.endpoint) body.append(copyRow(t('Messaging endpoint'), view.endpoint, t('Paste it into the Azure Bot → Configuration → Messaging endpoint. The address is secret: keep it to yourself. Sara checks Microsoft’s signature on every call.')));
    else body.append(diagLine({ code: view.appId ? 'NO_DOOR' : 'NOT_SET' }));
    if (view.lastCall) body.append(okLine(t('Microsoft reached Sara at {time}', { time: new Date(view.lastCall).toLocaleString() })));
    else body.append(el('p', 'muted small', t('This turns ✓ when her first message from Teams arrives (after step 5).')));
    body.append(btn(t('Check'), '', async () => {
      checking(out);
      const r = await api('/plugins/teams/check', { method: 'POST', body: { companion, step: 'endpoint' } }).catch((err) => ({ ok: false, diagnosis: { code: 'UNKNOWN', detail: err.message } }));
      out.replaceChildren(r.ok ? okLine(t('Microsoft reached Sara.')) : diagLine(r.diagnosis));
      if (r.ok) await load();
    }));
  }
  if (id === 'package') {
    const row = el('div', 'add-row');
    row.append(btn(t('Download the Teams app package'), '', () => download(out)), tip(t('A small zip Sara makes for your bot: its name, her icon and what it may do. Upload it in Teams; nothing is sent to Microsoft until you do.')));
    body.append(row, el('p', 'muted small', t("No Upload a custom app? Your Teams admin must allow custom apps (Teams admin center → Teams apps → Setup policies → Upload custom apps).")));
  }
  if (id === 'link') {
    const row = el('div', 'add-row');
    row.append(btn(t('Link my Teams'), '', async () => {
      await newCode();
      render();
    }), tip(t("Gives a code for 10 minutes. Send it to her in her Teams chat. That's how she knows which Teams account is you.")));
    body.append(row);
    if (code) body.append(copyRow(t('Send this to her in Teams'), `link ${code}`, t('In her personal chat in Teams.')));
    if (view.linked.length) body.append(okLine(t('Linked')));
  }
  if (id === 'test') {
    const row = el('div', 'add-row');
    row.append(btn(t('Test'), '', () => test(out)), tip(t('Checks the three values, a token from Microsoft, the public address, a signed call from Teams and the link. Sends nothing to anyone.')));
    body.append(row);
  }
  if (st?.diagnosis && !out.childNodes.length) out.append(diagLine(st.diagnosis));
  body.append(out);
  body.append(stepNav(view.steps.map((s) => s.id), id, { primary: st?.ok || id === 'bot' || id === 'endpoint' || id === 'package' }, (to) => ((open = to), render())));
  return body;
}

async function test(out) {
  checking(out);
  const r = await api('/plugins/teams/check', { method: 'POST', body: { companion, step: 'test' } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
  out.replaceChildren(testList(r));
  if (r.ok) await load();
}

function side() {
  const col = el('div', 'wa-side');
  const card = el('div', 'kit-card');
  const [, path, url] = STEPS[open]?.() ?? [];
  card.append(el('h3', '', t('The screen you need')), el('p', 'small', path ?? ''));
  if (url) card.append(link(url === TEAMS ? t('Open Teams ↗') : t('Open portal.azure.com ↗'), url, 'button-link'));
  card.append(link(t('This screen looks different?'), '/help#teams'));
  const good = el('div', 'kit-card');
  good.append(el('h3', '', t('Good to know')), el('p', 'small', t('Teams keeps the messages in your Microsoft 365 organization: whoever runs it (your company) can read them. For private chats use Signal.')), el('p', 'small', t('In channels she answers only when mentioned, and only where you switch her on.')));
  col.append(card, good);
  return col;
}

function intro(box, builtin) {
  box.replaceChildren(setupCard('teams', {
    builtin,
    missing: t("Microsoft Teams doesn't come with this copy of Sara."),
    onStart: async () => {
      await startFirstParty('teams', box, { name: 'Microsoft Teams', reach: t('It can reach Microsoft only (login.microsoftonline.com, the Teams Bot Connector and your OneDrive), and Teams reaches Sara at one public address.'), reviewCard, full: addBuiltin, done: load });
    },
  }));
}

function channelsCard() {
  const card = el('div', 'kit-card');
  const head = el('div', 'card-head');
  head.append(el('h3', '', t('Channels and group chats')), tip(t('She answers in a channel or group chat only when someone mentions her, and only where you switch her on. A place shows here after she is first mentioned there.')));
  card.append(head);
  const ul = el('ul', 'dev-list');
  for (const c of view.channels) {
    const li = el('li', '');
    li.append(el('span', '', `${c.name || t('Teams channel')} · ${c.on ? t('she answers here') : t('off')}`));
    li.append(btn(c.on ? t('Stop answering here') : t('Answer here'), 'ghost', async () => {
      await api('/plugins/teams/group', { method: 'POST', body: { companion, chat: c.id, on: !c.on } }).catch(() => undefined);
      await load();
    }));
    ul.append(li);
  }
  card.append(view.channels.length ? ul : el('p', 'muted small', t('No channels yet. Add her to a team, then mention her there once.')));
  return card;
}

function summary() {
  const card = el('div', 'kit-card');
  card.append(el('h3', '', t('Connected')), el('p', '', [view.lastCall ? t('Last message from Teams: {time}', { time: new Date(view.lastCall).toLocaleString() }) : '', view.state === 'ok' ? t('Connected') : t('Connecting…')].filter(Boolean).join(' · ')));
  const out = el('div', 'wa-check');
  const row = el('div', 'add-row');
  row.append(
    btn(t('Test'), '', () => test(out)),
    btn(t('Disconnect'), 'ghost', async (b) => {
      if (!confirm(t('Disconnect Microsoft Teams? The client secret is removed from Sara.'))) return;
      b.disabled = true;
      await api('/plugins/teams/fix', { method: 'POST', body: { companion, fix: 'logout' } }).catch(() => undefined);
      await load();
    }),
  );
  card.append(row, out, el('p', 'muted small', t('To end it at Microsoft too: delete the client secret (Certificates & secrets) or the Azure Bot, and remove her app in Teams.')));
  const who = el('div', 'kit-card');
  who.append(el('h3', '', t('Who can reach her')), el('p', 'small', view.others ? t('You, and the people on your list as partners: no tools, nothing private, the AI notice first.') : t('Only you. Anyone else who writes to her gets one line, then nothing.')), el('p', 'small', view.workInGroups ? t('Your mentions in channels may use her tools (Owners can use her tools in groups is on).') : t('Mentions in channels are answered without tools or anything private.')));
  return [foldedLine(t('Microsoft Teams: working'), () => ((open = 'bot'), (view.forceSteps = true), render())), card, channelsCard(), who];
}

function render() {
  const box = $('#te-box');
  const chip = $('#te-chip');
  if (!box || !view) return;
  const all = view.done === view.steps.length;
  chip.textContent = view.state === 'ok' && all ? t('Connected') : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.installed ? t('{n} of {total} done', { n: view.done, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = view.state === 'ok' && all ? 'ok' : view.state === 'error' || view.state === 'paused' ? 'warn' : '';
  if (!view.installed) return;
  if (all && !view.forceSteps) return void box.replaceChildren(...summary());
  if (!open || !view.steps.some((s) => s.id === open)) open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  const left = stepper({ title: t('Set up Microsoft Teams'), steps: view.steps, open, titleOf: (id) => STEPS[id]()[0], bodyOf: stepBody, onOpen: (id) => ((open = id), render()) });
  const grid = el('div', 'wa-grid');
  grid.append(left, side());
  box.replaceChildren(grid);
}

async function load() {
  try {
    const { plugins } = await api('/plugins');
    const p = plugins.find((x) => x.id === 'teams');
    companion = p?.companions.find((c) => c.on)?.id ?? companion;
    const keep = view?.forceSteps;
    view = await api(`/plugins/teams/setup?companion=${enc(companion)}`);
    if (keep) view.forceSteps = true;
    if (!view.installed) {
      const { builtin } = await api('/plugins/builtin');
      render();
      intro($('#te-box'), builtin.some((b) => b.id === 'teams'));
      return;
    }
    render();
  } catch (err) {
    $('#te-box')?.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadTeamsPage() {
  await load();
}
