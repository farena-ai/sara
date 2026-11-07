// EC1 (docs/ops/EC1_DESIGN.md): Settings → Chat apps → Slack. Before it is added: what it is, what he
// needs and Start. After that the shared stepper (web/setup-card.js): one step open at a time, the
// exact Slack screens as a numbered list, a check Sara runs; a step turns ✓ only when Sara checked it.
// Step 1 shows the app manifest he pastes at api.slack.com (Socket Mode, so no public address). Every
// failure is one plain sentence with the fix (DIAG, the same codes as plugins/slack/diagnose.mjs).
// Connected: a summary, Test, her channels (Answer here), Disconnect. The tokens go to the vault and
// never come back to this page.
import { t } from './naming.js';
import { addBuiltin, reviewCard } from './plugins.js';
import { api, btn, checking, copyRow, diagLine as diagWith, el, enc, field, foldedLine, link, okLine, pathList, setupCard, startFirstParty, stepNav, stepper, testList, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);
const APPS = 'https://api.slack.com/apps';

/** Every diagnosis code: the title, then the fix. */
export const DIAG = {
  NOT_SET: () => [t('Paste both Slack tokens first.'), t('Step 2.')],
  BOT_TOKEN_SHAPE: () => [t("That isn't a bot token (it starts with xoxb-)."), t('Copy the Bot User OAuth Token from Install App.')],
  APP_TOKEN_SHAPE: () => [t("That isn't an app-level token (it starts with xapp-)."), t('Copy it from Basic Information → App-Level Tokens.')],
  TOKENS_SWAPPED: () => [t("The two tokens are in each other's boxes."), t('Swap them: xoxb- goes in Bot token, xapp- in App-level token.')],
  TOKEN_WRONG: () => [t('Slack did not accept that token.'), t('Copy it again from your Slack app and paste the whole token.')],
  TOKEN_GONE: () => [t('Slack ended her token (the app was removed or the token revoked).'), t('Install the app again and paste the new tokens.')],
  SOCKET_OFF: () => [t('Socket Mode is off for this Slack app.'), t('In your Slack app: Socket Mode → Enable Socket Mode, then check again.')],
  MISSING_SCOPE: () => [t('The Slack app is missing a permission.'), t('Paste the manifest from step 1 again (App Manifest), then reinstall the app.')],
  NOT_IN_CHANNEL: () => [t("She isn't in that channel."), t('In the channel, type /invite and her name.')],
  RATE_LIMITED: () => [t('Slack asked her to slow down.'), t("She'll send the rest shortly.")],
  FILE_TOO_BIG: () => [t('That file is too big to send.'), t("It's in the app.")],
  PRIVATE_LOCAL: () => [t('Paused: "Nothing leaves this computer" is on.'), t('Slack keeps your messages; she reads them when it is off.')],
  CANT_REACH: () => [t("Couldn't reach Slack."), t('Check this computer is online, then try again.')],
  NOT_RUNNING: () => [t("The Slack plugin isn't running."), t('Switch it on for her in Settings → Plugins.')],
  NOT_ON: () => [t('Slack is added but switched off.'), t('Switch it on for her in Settings → Plugins.')],
  UNKNOWN: () => [t('Slack said something Sara does not know.'), t('Press Details, or try again.')],
};

/**
 * The app manifest he pastes at api.slack.com (Create New App → From a manifest). Socket Mode on (no
 * public address), interactivity on (the Allow / Deny buttons), /sara, her DMs and her mentions.
 */
export function appManifest(name = 'Sara') {
  const n = String(name || 'Sara').slice(0, 35);
  return {
    display_information: { name: n, description: t('Your companion from Sara, in Slack.').slice(0, 120), background_color: '#2b2d42' },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: n, always_online: true },
      slash_commands: [{ command: '/sara', description: t('Talk to her: /sara help, /sara new, /sara stop').slice(0, 100), usage_hint: 'help | new | stop', should_escape: false }],
    },
    oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'files:read', 'files:write', 'users:read', 'channels:read', 'groups:read', 'commands', 'reactions:write'] } },
    settings: {
      event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** The four steps: title, the exact path (one click per line), the page to open. */
const STEPS = {
  app: () => [t('Create the Slack app'), t('api.slack.com/apps → Create New App → From a manifest → pick your workspace → JSON → replace everything with the manifest below → Next → Create'), APPS],
  tokens: () => [t('Make the two tokens and paste them'), t('Basic Information → App-Level Tokens → Generate Token and Scopes → any name → Add Scope: connections:write → Generate → copy the xapp- token → Install App → Install to Workspace → Allow → copy the Bot User OAuth Token (xoxb-)'), APPS],
  link: () => [t('Link your Slack account'), t('In Slack: Apps → her app → Messages → send her the code below'), null],
  test: () => [t('Test'), t('Checks every step and sends nothing to anyone.'), null],
};

let view = null;
let open = '';
let companion = 'main';
let code = '';

const diagLine = (d) => diagWith(d, DIAG);

async function newCode() {
  const r = await api('/plugins/slack/fix', { method: 'POST', body: { companion, fix: 'link' } }).catch(() => null);
  code = r?.code ?? '';
}

function stepBody(id) {
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  const st = view.steps.find((s) => s.id === id);
  const [, path] = STEPS[id]();
  body.append(pathList(path));
  if (id === 'app') {
    const json = JSON.stringify(appManifest(view.herName), null, 2);
    const head = el('span', 'plg-field-name');
    head.append(el('span', '', t('The app manifest')), tip(t('Paste it at api.slack.com when you create the app. It turns on Socket Mode, so Slack needs no address for Sara, and asks only for what she uses: her DMs, mentions, files and the /sara command.')));
    body.append(head, el('pre', 'lsk-pre wa-mono', json), btn(t('Copy the manifest'), 'ghost', async (b) => {
      await globalThis.navigator?.clipboard?.writeText(json).catch(() => undefined);
      b.textContent = t('Copied');
    }), el('p', 'muted small', t('Use a workspace where you may add apps. A free workspace of your own works.')));
  }
  if (id === 'tokens') {
    if (view.team) body.append(okLine(t('Connected to {team}', { team: view.team })));
    body.append(
      field('sl-bot', t('Bot token'), t("Starts with xoxb-. In your Slack app: Install App → Bot User OAuth Token. Kept encrypted in Sara's vault and never shown again."), { type: 'password', placeholder: view.botTokenSet ? t('Saved (paste to replace)') : 'xoxb-…' }),
      field('sl-app', t('App-level token'), t("Starts with xapp-. In your Slack app: Basic Information → App-Level Tokens, with the connections:write scope. It lets Sara connect out to Slack (Socket Mode); kept encrypted in Sara's vault."), { type: 'password', placeholder: view.appTokenSet ? t('Saved (paste to replace)') : 'xapp-…' }),
      btn(t('Save and check'), '', async () => {
        checking(out);
        const bot = $('#sl-bot');
        const app = $('#sl-app');
        try {
          const r = await api('/plugins/slack/tokens', { method: 'POST', body: { companion, botToken: bot.value.trim(), appToken: app.value.trim() } });
          bot.value = '';
          app.value = '';
          if (!r.ok) return void out.replaceChildren(diagLine(r.diagnosis));
          out.replaceChildren(okLine(t('Connected to {team}', { team: r.team })));
          await load();
        } catch (err) {
          out.replaceChildren(diagLine({ code: 'UNKNOWN', detail: err.message }));
        }
      }),
    );
  }
  if (id === 'link') {
    const row = el('div', 'add-row');
    row.append(btn(t('Link my Slack'), '', async () => {
      await newCode();
      render();
    }), tip(t("Gives a code for 10 minutes. Send it to her in a Slack DM. That's how she knows which Slack account is you.")));
    body.append(row);
    if (code) body.append(copyRow(t('Send this to her in Slack'), `link ${code}`, t('In her DM. Typing /sara link and the code works too.')));
    if (view.linked.length) body.append(okLine(t('Linked')));
  }
  if (id === 'test') {
    const row = el('div', 'add-row');
    row.append(btn(t('Test'), '', () => test(out)), tip(t('Checks both tokens, Socket Mode, the live connection and the link. Sends nothing to anyone.')));
    body.append(row);
  }
  if (st?.diagnosis && !out.childNodes.length) out.append(diagLine(st.diagnosis));
  body.append(out);
  body.append(stepNav(view.steps.map((s) => s.id), id, { primary: st?.ok || id === 'app' }, (to) => ((open = to), render())));
  return body;
}

async function test(out) {
  checking(out);
  const r = await api('/plugins/slack/check', { method: 'POST', body: { companion, step: 'test' } }).catch((err) => ({ ok: false, steps: [{ label: err.message, ok: false }] }));
  out.replaceChildren(testList(r));
  if (r.ok) await load();
}

function side() {
  const col = el('div', 'wa-side');
  const card = el('div', 'kit-card');
  const [, path, url] = STEPS[open]?.() ?? [];
  card.append(el('h3', '', t('The screen you need')), el('p', 'small', path ?? ''));
  if (url) card.append(link(t('Open api.slack.com ↗'), url, 'button-link'));
  card.append(link(t('This screen looks different?'), '/help#slack'));
  const good = el('div', 'kit-card');
  good.append(el('h3', '', t('Good to know')), el('p', 'small', t('Slack keeps the messages in your workspace: whoever runs it (your company) can read them. For private chats use Signal.')), el('p', 'small', t('In channels she answers only when mentioned, and only where you switch her on.')));
  col.append(card, good);
  return col;
}

function intro(box, builtin) {
  box.replaceChildren(setupCard('slack', {
    builtin,
    missing: t("Slack doesn't come with this copy of Sara."),
    onStart: async () => {
      await startFirstParty('slack', box, { name: 'Slack', reach: t('It can reach slack.com only: her messages, the files in them and the channels she is in.'), reviewCard, full: addBuiltin, done: load });
    },
  }));
}

function channelsCard() {
  const card = el('div', 'kit-card');
  const head = el('div', 'card-head');
  head.append(el('h3', '', t('Channels')), tip(t('She answers in a channel only when someone mentions her, and only in channels you switch on here. Add her first: type /invite and her name in the channel.')));
  card.append(head);
  const ul = el('ul', 'dev-list');
  for (const c of view.channels) {
    const li = el('li', '');
    li.append(el('span', '', `#${c.name}${c.private ? ` · ${t('private')}` : ''} · ${c.on ? t('she answers here') : t('off')}`));
    li.append(btn(c.on ? t('Stop answering here') : t('Answer here'), 'ghost', async () => {
      await api('/plugins/slack/group', { method: 'POST', body: { companion, chat: c.id, on: !c.on } }).catch(() => undefined);
      await load();
    }));
    ul.append(li);
  }
  card.append(view.channels.length ? ul : el('p', 'muted small', t('She is in no channels yet.')));
  return card;
}

function summary() {
  const card = el('div', 'kit-card');
  card.append(el('h3', '', t('Connected')), el('p', '', [view.team, view.connected ? t('Connected') : t('Connecting…')].filter(Boolean).join(' · ')));
  const out = el('div', 'wa-check');
  const row = el('div', 'add-row');
  row.append(
    btn(t('Test'), '', () => test(out)),
    btn(t('Disconnect'), 'ghost', async (b) => {
      if (!confirm(t('Disconnect Slack? Her bot token is revoked at Slack and both tokens are removed from Sara.'))) return;
      b.disabled = true;
      await api('/plugins/slack/fix', { method: 'POST', body: { companion, fix: 'logout' } }).catch(() => undefined);
      await load();
    }),
  );
  card.append(row, out, el('p', 'muted small', t('To remove the app from your workspace too: api.slack.com/apps → her app → Install App → Remove.')));
  const who = el('div', 'kit-card');
  who.append(el('h3', '', t('Who can reach her')), el('p', 'small', view.others ? t('You, and the people on your list as partners: no tools, nothing private, the AI notice first.') : t('Only you. Anyone else who writes to her gets one line, then nothing.')), el('p', 'small', view.workInGroups ? t('Your mentions in channels may use her tools (Owners can use her tools in groups is on).') : t('Mentions in channels are answered without tools or anything private.')));
  return [foldedLine(t('Slack: working'), () => ((open = 'app'), (view.forceSteps = true), render())), card, channelsCard(), who];
}

function render() {
  const box = $('#sl-box');
  const chip = $('#sl-chip');
  if (!box || !view) return;
  const all = view.done === view.steps.length;
  chip.textContent = view.state === 'ok' && all ? t('Connected') : view.state === 'paused' ? t('Paused (Nothing leaves this computer)') : view.installed ? t('{n} of {total} done', { n: view.done, total: view.steps.length }) : t('Not set up');
  chip.dataset.state = view.state === 'ok' && all ? 'ok' : view.state === 'error' || view.state === 'paused' ? 'warn' : '';
  if (!view.installed) return;
  if (all && !view.forceSteps) return void box.replaceChildren(...summary());
  if (!open || !view.steps.some((s) => s.id === open)) open = (view.steps.find((s) => !s.ok) ?? view.steps[0]).id;
  const left = stepper({ title: t('Set up Slack'), steps: view.steps, open, titleOf: (id) => STEPS[id]()[0], bodyOf: stepBody, onOpen: (id) => ((open = id), render()) });
  const grid = el('div', 'wa-grid');
  grid.append(left, side());
  box.replaceChildren(grid);
}

async function load() {
  try {
    const { plugins } = await api('/plugins');
    const p = plugins.find((x) => x.id === 'slack');
    companion = p?.companions.find((c) => c.on)?.id ?? companion;
    const keep = view?.forceSteps;
    view = await api(`/plugins/slack/setup?companion=${enc(companion)}`);
    if (keep) view.forceSteps = true;
    if (!view.installed) {
      const { builtin } = await api('/plugins/builtin');
      render();
      intro($('#sl-box'), builtin.some((b) => b.id === 'slack'));
      return;
    }
    render();
  } catch (err) {
    $('#sl-box')?.replaceChildren(el('p', 'muted small', err.message));
  }
}

export async function loadSlackPage() {
  await load();
}
