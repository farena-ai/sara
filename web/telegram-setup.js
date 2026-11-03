// PL2a (docs/design/POLISH2.md N1, N5): Settings → Chat apps → Telegram opens on the shared setup card
// and three plain steps (open @BotFather, /newbot, paste the key: ✓ when Sara reached the bot), then
// Link and Test. Every option stays where it was, folded under *More* below (ids unchanged), so the
// first screen is the steps, not eight checkboxes.
import { t } from './naming.js';
import { api, btn, checking, copyRow, el, field, foldedLine, link, okLine, setupCard, stepNav, stepper, testList, tip, useTranslator } from './setup-card.js';

useTranslator(t);
const $ = (sel) => document.querySelector(sel);
const BOTFATHER = 'https://t.me/BotFather';

const STEPS = {
  bot: () => t('Open @BotFather in Telegram'),
  newbot: () => t('Send /newbot and pick her names'),
  token: () => t('Paste the key it gives you'),
  link: () => t('Link your Telegram'),
  test: () => t('Test'),
};

let st = { open: '', started: false, force: false, tested: false };
let last = null;
let hooks = { reload: async () => undefined };

const warn = (title, fix) => {
  const box = el('div', 'wa-diag');
  box.setAttribute('role', 'status');
  box.dataset.state = 'warn';
  box.append(el('strong', '', title), el('span', '', fix));
  return box;
};

function stepBody(id) {
  const tg = last;
  const body = el('div', 'wa-step-body');
  const out = el('div', 'wa-check');
  if (id === 'bot') body.append(el('p', 'small', t('In Telegram, search for @BotFather (with the blue tick) and press Start.')), link(t('Open @BotFather ↗'), BOTFATHER, 'button-link'));
  if (id === 'newbot') {
    body.append(copyRow(t('Send this'), '/newbot', t('BotFather asks for two names: what people see (like Sara) and a username that ends in bot (like sara_frank_bot).')));
    body.append(el('p', 'small', t('BotFather answers with a long key (like 123456:ABC-…). Copy it.')));
  }
  if (id === 'token') {
    body.append(field('tg-setup-token', t('Bot key (token)'), t("The key BotFather sent. Kept encrypted in Sara's vault and never shown again. Anyone with it can use the bot as her."), { type: 'password', placeholder: tg.hasToken ? t('Saved (type to replace)') : '123456:ABC-…' }));
    body.append(btn(t('Save and check'), '', async () => {
      const input = $('#tg-setup-token');
      const token = input.value.trim();
      input.value = '';
      checking(out);
      try {
        await api('/bridges/telegram', { method: 'PUT', body: { ...(token ? { token } : {}), enabled: true } });
        // The bot starts in the background: look every second for up to 15 s.
        for (let i = 0; i < 15; i++) {
          const now = await api('/bridges/telegram');
          if (now.running || now.error) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        await hooks.reload();
      } catch (err) {
        out.replaceChildren(warn(t("Telegram didn't accept that key."), err.message));
      }
    }));
    if (tg.running) body.append(okLine(t('Connected as {bot}', { bot: `@${tg.bot}` })));
    else if (tg.error) out.append(warn(t("Telegram didn't accept that key."), t('Copy it again from @BotFather: /mybots → your bot → API Token.')));
  }
  if (id === 'link') {
    const row = el('div', 'add-row');
    row.append(btn(t('Link my Telegram'), '', async () => {
      try {
        const { code, bot } = await api('/bridges/telegram/link', { method: 'POST', body: {} });
        out.replaceChildren(copyRow(t('Send this to @{bot}', { bot }), `/link ${code}`, t('Open her bot in Telegram and send this within 10 minutes. That is how she knows which chat is you.')));
      } catch (err) {
        out.replaceChildren(warn(t('Paste the key first.'), err.message));
      }
    }), tip(t('Gives a code for 10 minutes. Send it to her bot from your own Telegram.')));
    body.append(row);
    if (tg.linked) body.append(okLine(t('Linked to you')));
  }
  if (id === 'test') {
    body.append(btn(t('Test'), '', async () => {
      checking(out);
      const now = await api('/bridges/telegram').catch(() => last);
      const steps = [
        { ok: Boolean(now.hasToken), label: t('Her key is saved'), fix: t('Step 3.') },
        { ok: Boolean(now.running), label: now.running ? t('Connected as {bot}', { bot: `@${now.bot}` }) : t('Sara reaches her bot'), fix: t('Step 3.') },
        { ok: Boolean(now.linked), label: t('Linked to you'), fix: t('Step 4.') },
      ];
      let sent = false;
      if (steps.every((s) => s.ok)) sent = await api('/bridges/telegram/test-picture', { method: 'POST', body: {} }).then(() => true, () => false);
      steps.push({ ok: sent, label: t('A test picture went to your chat with her'), fix: t('Write to her once in Telegram, then test again.') });
      out.replaceChildren(testList({ steps }));
      if (sent) ((st.tested = true), sessionStorage.setItem('sara.telegram.tested', '1'));
    }), tip(t('Checks the key, the connection and the link, then sends a small test picture to your private chat with her.')));
  }
  body.append(out, stepNav(Object.keys(STEPS), id, { primary: id === 'bot' || id === 'newbot' || stepOk(id) }, (to) => ((st.open = to), draw())));
  return body;
}

const stepOk = (id) => ({ bot: last.hasToken, newbot: last.hasToken, token: last.running, link: last.linked, test: last.running && last.linked && st.tested })[id];

function draw() {
  const box = $('#tg-setup');
  if (!box || !last) return;
  const steps = Object.keys(STEPS).map((id) => ({ id, ok: Boolean(stepOk(id)) }));
  const working = last.running && last.linked;
  // The options fold under More until it works.
  const more = $('#tg-more');
  if (more && !more.dataset.touched) more.open = working;
  if (!st.started && !last.hasToken) return void box.replaceChildren(setupCard('telegram', { onStart: () => ((st.started = true), draw()) }));
  if (working && !st.force) return void box.replaceChildren(foldedLine(t('Telegram: working as {bot}', { bot: `@${last.bot}` }), () => ((st.force = true), (st.open = 'bot'), draw())));
  if (!st.open) st.open = (steps.find((s) => !s.ok) ?? steps[0]).id;
  box.replaceChildren(stepper({ title: t('Set up Telegram'), steps, open: st.open, titleOf: (id) => STEPS[id](), bodyOf: stepBody, onOpen: (id) => ((st.open = id), draw()) }));
}

/** Called by app.js renderTelegram with the bridge's state; `reload` reads it again. */
export function renderTelegramSetup(tg, o = {}) {
  last = tg;
  if (o.reload) hooks = { reload: o.reload };
  st.tested ||= sessionStorage.getItem('sara.telegram.tested') === '1';
  const more = $('#tg-more');
  if (more && !more.dataset.wired) {
    more.dataset.wired = '1';
    more.addEventListener('toggle', () => (more.dataset.touched = '1'));
  }
  draw();
}
