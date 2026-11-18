// V1.3 (docs/design/V1BRIDGES.md): "Where do you text?", the picker at the top of Connections → Apps
// and services. One button per place people already text; the phone switch marks the easiest fits.
// A pick shows what it needs and its state; Set it up opens that app's own page (its guided setup card)
// with defaults filled (sessionStorage, read once by matrix.js / imessage.js through takeWhereDefaults).
// Set-up plugins get Check (each plugin's own Test as plain lines) and Send me a test. iMessage gets a
// BlueBubbles reachability test right here, before anything is added. No imports: tests load this file
// in Node; app.js lends t/api/open through drawWhere's ctx.

/** Marks a string for translation (scripts/i18n-extract.ts finds t('…')); drawWhere translates at draw. */
const t = (s) => s;

/** Per app: label, what it needs, which phones it is easiest on, a note when it can't work. */
const INFO = {
  imessage: { label: t('Messages on iPhone'), need: t('A Mac that stays on, with BlueBubbles, and an Apple ID for her'), easy: ['iphone'], no: { android: t('Needs an iPhone and a Mac.') } },
  whatsapp: { label: t('WhatsApp'), need: t("A WhatsApp Business number you own; Meta's rules apply"), easy: [] },
  signal: { label: t('Signal'), need: t('A phone number for her and signal-cli on this computer'), easy: [] },
  telegram: { label: t('Telegram'), need: t('A free bot from @BotFather, about 2 minutes'), easy: ['iphone', 'android'] },
  discord: { label: t('Discord'), need: t('A free bot from the Discord developer portal'), easy: [] },
  matrix: { label: t('Element or another Matrix app'), need: t('A free Matrix account for her, about 15 minutes'), easy: ['android'] },
  slack: { label: t('Slack'), need: t('A small Slack app in your workspace'), easy: [] },
  teams: { label: t('Microsoft Teams'), need: t('A free Azure Bot and a public https address'), easy: [] },
  email: { label: t('Email'), need: t('An email address of her own'), easy: [] },
};

/** Two-letter marks, the same as the tiles below (settings-services.js MARK). */
const MARK = Object.fromEntries('imessage=iM whatsapp=Wa signal=Si telegram=Tg discord=Dc matrix=Mx slack=Sl teams=Te email=@'.split(' ').map((x) => x.split('=')));

/** The picker model: [{ id, page, label, need, easy, note }], the easiest fits for `phone` first. Pure, for tests. */
export function whereModel(apps, phone = '') {
  const rows = apps.map((a, i) => {
    const x = INFO[a.id] ?? { label: a.name ?? a.id, need: '', easy: [] };
    return { ...a, i, label: x.label, need: x.need, easy: Boolean(phone && x.easy.includes(phone)), note: (phone && x.no?.[phone]) || '' };
  });
  return rows.sort((a, b) => Number(b.easy) - Number(a.easy) || Number(Boolean(a.note)) - Number(Boolean(b.note)) || a.i - b.i);
}

/** 'on' (set up and linked), 'started' (added, not finished) or 'off'; Telegram/Discord read the tile facts. */
export function whereState(row = {}, fact) {
  if (row.installed) return row.linked && (row.running ?? row.on) ? 'on' : 'started';
  if (fact?.state === 'on') return 'on';
  if (fact?.state === 'warn') return 'started';
  return 'off';
}

const KEY = 'sara.where.defaults';
/** The page's side: the defaults the picker left for `app` (they only fill empty fields). */
export function takeWhereDefaults(app) {
  try {
    const raw = sessionStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && v.app === app ? (v.defaults ?? {}) : {};
  } catch {
    return {};
  }
}

let cache = null;
let picked = '';
let phone = '';
let loading = null;

const PROBE = {
  BAD_ADDRESS: t('Type the address with its port, like 192.168.1.20:1234.'),
  NOT_LOCAL: t('Only this computer, or your home network with the switch on. Never an internet address.'),
  DOWN: t("Nothing answers there. Is the Mac on and BlueBubbles open? Check the address and port."),
  SLOW: t("It didn't answer within 3 seconds. Check the address, or that both are on the same network."),
  NOT_BB: t('Something answers there, but it is not BlueBubbles. Check the port (BlueBubbles uses 1234).'),
};
const SEND = {
  NOT_LINKED: t('Finish the link step on its page first.'),
  NOT_ON: t('It is added but switched off.'),
  PRIVATE_LOCAL: t('Paused: "Nothing leaves this computer" is on.'),
  NO_TEST_MESSAGE: t('This app has no test message; use Check.'),
  SEND_FAILED: t('The message did not go out. Press Check to see why.'),
};

/**
 * Draws the picker at the top of `box` (the Apps and services hub; buildServices just filled it).
 * ctx: { t, api(path, opts), facts, open(pageId), member }.
 */
export function drawWhere(box, ctx) {
  if (!box || ctx.member) return;
  // eslint-disable-next-line no-shadow
  const t = ctx.t ?? ((s) => s);
  const doc = box.ownerDocument;
  const mk = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (label, cls, onClick) => {
    const b = mk('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', () => void onClick(b));
    return b;
  };
  const tip = (text) => {
    const b = mk('button', 'tip', '?');
    b.type = 'button';
    b.dataset.tip = text;
    b.setAttribute('aria-label', text);
    return b;
  };
  try {
    phone ||= localStorage.getItem('sara.where.phone') ?? '';
  } catch {
    // no storage: no remembered phone
  }
  const sec = mk('section', 's3-tiles wdt-where');
  sec.dataset.tiles = 'where';
  const head = mk('div', 'wdt-head');
  const h = mk('h3', 's3-tiles-head', t('Where do you text?'));
  h.id = 's3-tiles-where';
  sec.setAttribute('aria-labelledby', h.id);
  head.append(h, tip(t('Pick the app you already use every day. Sara opens its setup with what she can fill in, then checks each step with you.')));
  const lead = mk('p', 'muted small wdt-lead', t('Talk to her where you already text. Pick one; you can add more later.'));
  const phones = mk('div', 's3-filter wdt-phone');
  phones.setAttribute('role', 'group');
  phones.setAttribute('aria-label', t('Your phone'));
  for (const [id, label] of [['iphone', t('iPhone')], ['android', t('Android')]]) {
    const b = button(label, 's3-filter-opt', () => {
      phone = phone === id ? '' : id;
      try {
        localStorage.setItem('sara.where.phone', phone);
      } catch {
        // not remembered
      }
      paint();
      sec.querySelector(`[data-phone="${id}"]`)?.focus();
    });
    b.dataset.phone = id;
    b.setAttribute('aria-pressed', String(phone === id));
    phones.append(b);
  }
  const grid = mk('div', 'wdt-grid');
  const panel = mk('div', 'wdt-panel');
  panel.hidden = true;
  sec.append(head, lead, phones, grid, panel);
  box.prepend(sec);

  function paint() {
    for (const b of phones.querySelectorAll('[data-phone]')) b.setAttribute('aria-pressed', String(b.dataset.phone === phone));
    const apps = cache?.apps ?? [];
    const rows = whereModel(apps, phone);
    grid.replaceChildren(
      ...rows.map((x) => {
        const st = whereState(x, ctx.facts?.[x.page]);
        const b = button('', 'wdt-pick', () => {
          picked = picked === x.id ? '' : x.id;
          paint();
          if (picked) panel.querySelector('h4')?.scrollIntoView?.({ block: 'nearest' });
        });
        b.dataset.app = x.id;
        b.dataset.state = st;
        b.setAttribute('aria-expanded', String(picked === x.id));
        const mark = mk('span', 's3-tile-mark', MARK[x.id] ?? x.id.slice(0, 2));
        mark.setAttribute('aria-hidden', 'true');
        const txt = mk('span', 'wdt-pick-text');
        txt.append(mk('span', 'wdt-pick-name', t(x.label)));
        const line = mk('span', 's3-tile-line');
        const dot = mk('span', 's3-dot');
        dot.dataset.state = st === 'on' ? 'on' : st === 'started' ? 'warn' : 'off';
        dot.setAttribute('aria-hidden', 'true');
        line.append(dot, mk('span', '', st === 'on' ? t('Connected') : st === 'started' ? t('Started') : x.easy ? t('Easiest for you') : x.note ? t(x.note) : t('Not set up')));
        txt.append(line);
        b.append(mark, txt);
        return b;
      }),
    );
    const x = rows.find((r) => r.id === picked);
    panel.hidden = !x;
    if (x) drawPanel(x);
  }

  function drawPanel(x) {
    const st = whereState(x, ctx.facts?.[x.page]);
    const out = mk('div', 'wdt-out');
    out.setAttribute('role', 'status');
    const h4 = mk('h4', '', t(x.label));
    const need = mk('p', 'small', `${t('What you need')}: ${t(x.need)}`);
    const parts = [h4, need];
    if (x.note) parts.push(mk('p', 'small wdt-note', t(x.note)));
    if (x.plugin && x.available === false) parts.push(mk('p', 'muted small', t("It doesn't come with this copy of Sara.")));
    const row = mk('div', 'add-row wdt-actions');
    const go = () => {
      try {
        sessionStorage.setItem(KEY, JSON.stringify({ app: x.id, defaults: x.defaults ?? {} }));
      } catch {
        // the page starts empty
      }
      ctx.open(x.page);
    };
    row.append(button(st === 'off' ? t('Set it up') : t('Open its page'), '', go));
    if (x.plugin && x.installed) {
      row.append(button(t('Check'), 'ghost', async (b) => {
        b.disabled = true;
        out.replaceChildren(mk('p', 'muted small', t('Checking…')));
        try {
          const r = await ctx.api('/plugins/where/check', { method: 'POST', body: { app: x.id } });
          const ul = mk('ul', 'wa-test');
          let first = true;
          for (const s of r.steps ?? []) {
            const li = mk('li', s.ok ? 'ok' : first ? 'bad' : 'grey', `${s.ok ? '✓' : '✕'} ${t(s.label)}`);
            if (!s.ok && first && s.fix) li.append(mk('span', 'muted small', ` ${t(s.fix)}`));
            if (!s.ok) first = false;
            ul.append(li);
          }
          out.replaceChildren(ul);
        } catch (err) {
          out.replaceChildren(mk('p', 'small', err.message));
        }
        b.disabled = false;
      }));
    }
    if (x.canSendTest) {
      row.append(button(t('Send me a test'), 'ghost', async (b) => {
        b.disabled = true;
        try {
          const r = await ctx.api('/plugins/where/send-test', { method: 'POST', body: { app: x.id } });
          out.replaceChildren(mk('p', 'small', r.ok ? t('Sent. Look in {app} for a message from her.', { app: x.name ?? t(x.label) }) : t(SEND[r.code] ?? SEND.SEND_FAILED)));
        } catch (err) {
          out.replaceChildren(mk('p', 'small', err.message));
        }
        b.disabled = false;
      }));
    }
    parts.push(row);
    if (x.id === 'imessage' && st !== 'on') parts.push(probeBox(x, out));
    parts.push(out);
    panel.replaceChildren(...parts);
  }

  function probeBox(x, out) {
    const wrap = mk('div', 'wdt-probe');
    const label = mk('label', 'plg-field');
    const name = mk('span', 'plg-field-name');
    name.append(mk('span', '', t('Is your Mac reachable?')), tip(t("BlueBubbles' address with its port. Sara knocks once, sends no password, and only tries this computer or, with the switch, your home network.")));
    const input = mk('input');
    input.id = 'wdt-bb-address';
    input.type = 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.nodirty = '';
    input.value = x.defaults?.server ?? '127.0.0.1:1234';
    label.append(name, input);
    const lan = mk('label', 'row wdt-lan');
    const box2 = mk('input');
    box2.type = 'checkbox';
    box2.id = 'wdt-bb-lan';
    box2.dataset.nodirty = '';
    box2.checked = !/^(127\.|localhost)/.test(input.value);
    lan.append(box2, doc.createTextNode(` ${t('The Mac is another computer on my network')}`));
    const test = button(t('Test it'), 'ghost', async (b) => {
      b.disabled = true;
      out.replaceChildren(mk('p', 'muted small', t('Checking…')));
      try {
        const r = await ctx.api('/plugins/where/probe', { method: 'POST', body: { app: 'imessage', address: input.value.trim(), onOtherMachine: box2.checked } });
        if (r.ok) {
          x.defaults = { ...(x.defaults ?? {}), server: r.address };
          out.replaceChildren(mk('p', 'small wdt-ok', `✓ ${t('BlueBubbles answers at {address}. Set it up next; the password comes in step 4.', { address: r.address })}`));
        } else out.replaceChildren(mk('p', 'small', `✕ ${t(PROBE[r.code] ?? PROBE.DOWN)}`));
      } catch (err) {
        out.replaceChildren(mk('p', 'small', err.message));
      }
      b.disabled = false;
    });
    wrap.append(label, lan, test);
    return wrap;
  }

  paint();
  if (!cache) {
    loading ??= ctx.api('/plugins/where').then((r) => (cache = r)).catch(() => null).finally(() => (loading = null));
    void loading.then(() => sec.isConnected && paint());
  } else {
    // Refresh quietly (a page may have changed it); repaint when it is back.
    void ctx.api('/plugins/where').then((r) => {
      cache = r;
      if (sec.isConnected) paint();
    }).catch(() => undefined);
  }
}
