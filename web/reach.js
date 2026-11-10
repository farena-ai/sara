// 3.3.0 (easy reach): reach Sara from your phone and away from home, no networking words needed.
//   - renderPhoneConnect(host): "Connect the Sara phone app" (Phone and notifications, Devices):
//     where to get the app, then one QR that opens the app already paired, or, when no other
//     device can reach this computer yet, "Set up access" instead of a QR that can't work.
//   - renderAway(host): "Use Sara away from home", three steps with live checks: Tailscale on
//     this computer, Tailscale on the phone, then Sara tests the address herself.
//   - reachLine(): one plain line for Health.
// The server decides the address (src/reach.ts): never 127.0.0.1 for another device.
import { serverText, t } from './naming.js';

const ANDROID_APP = 'https://play.google.com/store/apps/details?id=com.backstagecoding.sara';

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status, data });
  return data;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function link(href, text) {
  const a = el('a', '', text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}
function button(text, cls, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', () => void onClick(b));
  return b;
}
function qrImg(src, alt) {
  const i = el('img', 'pair-qr rch-qr');
  i.src = src;
  i.alt = alt;
  return i;
}

let deps = { openAway: () => {}, member: () => false };
/** app.js passes how to open the away-from-home section (Settings → Devices and sign-in). */
export function initReach(d) {
  deps = { ...deps, ...d };
  globalThis.document?.addEventListener('sara:open-away', () => deps.openAway());
}

/** Where to get the phone app: Google Play, or the download page. */
function getTheApp() {
  const p = el('p', 'small rch-get');
  p.append(el('strong', '', t('1. Get the Sara app on your Android phone:')), ' ', link(ANDROID_APP, t('Sara on Google Play')));
  // 3.3.0: no direct APK link until a release carries one (GitHub releases have none; Play is the route).
  return [p];
}

/** The plain words for where the address works. */
function whereWords(r) {
  if (r.awayAddress) return t('Your phone can reach Sara anywhere ✓');
  if (r.address) return t('Your phone can reach Sara at home, on the same Wi-Fi.');
  return t('Right now Sara only answers on this computer.');
}

let pairTimer = 0;
/** "Connect the Sara phone app": the app, then a QR that opens it paired (or Set up access). */
export async function renderPhoneConnect(host) {
  if (!host) return;
  if (deps.member()) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const card = el('section', 'rch-card');
  card.append(el('h3', '', t('Connect the Sara phone app')));
  card.append(...getTheApp());
  const step2 = el('div', 'rch-step2');
  const go = button(t('2. Show the code to scan'), 'primary', async (b) => {
    b.disabled = true;
    try {
      await showPairCode(step2);
    } catch (err) {
      step2.replaceChildren(el('p', 'small warn', err.message));
    } finally {
      b.disabled = false;
    }
  });
  step2.append(go);
  card.append(step2);
  host.replaceChildren(card);
}

async function showPairCode(box) {
  const p = await api('/pair', { method: 'POST', body: {} });
  clearInterval(pairTimer);
  const kids = [];
  if (p.phone) {
    kids.push(qrImg(p.phone.qr, t('QR code that opens the Sara app, signed in')));
    kids.push(el('p', 'small', t("Point your phone's camera at the code and tap the link: the Sara app opens and signs in by itself.")));
    kids.push(el('p', 'muted small', t('iPhone: the app is not in the App Store yet. Open the address below in Safari, sign in with the code, then Share → Add to Home Screen.')));
    if (!p.phone.away) kids.push(el('p', 'muted small', t('This works while your phone is on the same Wi-Fi as this computer. To use Sara when you are out, set up Use Sara away from home.')));
  } else {
    const warn = el('div', 'rch-noreach');
    const head = el('p');
    head.append(el('strong', '', t("Your phone can't reach this computer yet")));
    warn.append(head);
    warn.append(el('p', 'small', t('Sara only answers on this computer right now. A free app called Tailscale links your phone and this computer, at home and away. It takes about five minutes.')));
    warn.append(button(t('Set up access'), 'primary', () => deps.openAway()));
    kids.push(warn);
  }
  const code = el('p', 'small rch-code');
  code.append(`${t('Or type the code in the app:')} `, el('strong', 'pair-code-big', p.code));
  if (p.phone) code.append(` ${t('and this address:')} `, el('code', '', p.phone.address));
  code.querySelectorAll('strong, code').forEach((n) => n.setAttribute('data-raw', ''));
  kids.push(code);
  const exp = el('p', 'muted small rch-exp');
  kids.push(exp);
  box.replaceChildren(...kids);
  const ends = Date.parse(p.expiresAt);
  const tick = () => {
    const left = Math.max(0, Math.round((ends - Date.now()) / 1000));
    exp.textContent = left ? t('Works once, for {time} more.', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` }) : t('This code expired.');
    if (!left || !box.isConnected) clearInterval(pairTimer);
  };
  tick();
  pairTimer = setInterval(tick, 1000);
}

/** One line for Health: where other devices reach her, and a way to fix it. */
export async function reachLine(host) {
  if (!host) return;
  const r = await api('/access/reach').catch(() => null);
  if (!r) return void (host.hidden = true);
  host.hidden = false;
  const p = el('p', 'small');
  p.append(el('strong', '', `${t('Your other devices:')} `), whereWords(r));
  if (r.address) p.append(' ', el('code', '', r.awayAddress ?? r.address));
  if (!r.awayAddress) p.append(' ', button(t('Use Sara away from home'), 'ghost small', () => deps.openAway()));
  host.replaceChildren(p);
}

const STATE_WORDS = {
  NeedsLogin: () => t('Tailscale is installed but not signed in yet. Open Tailscale and sign in.'),
  Stopped: () => t('Tailscale is installed but switched off. Open Tailscale and switch it on.'),
};
const SERVE_ERRORS = {
  NO_TAILSCALE: () => t('Tailscale is not installed on this computer yet (step 1).'),
  NOT_RUNNING: () => t('Tailscale is not signed in on this computer yet (step 1).'),
  NO_HTTPS: () => t('Your Tailscale account has secure addresses (HTTPS) switched off. Open the Tailscale page, choose DNS, press Enable HTTPS, then try again.'),
  NEEDS_APPROVAL: () => t('Tailscale wants your OK once. Open its page, allow it, then press the button again.'),
  PORTS_TAKEN: () => t('Every secure address Sara could use on Tailscale is already used by something else on this computer.'),
  NOT_OURS: () => t('Sara did not turn this on, so she leaves it as it is.'),
  FAILED: () => t("Tailscale didn't do it. Its own words are below."),
};
const CHECK_ERRORS = {
  NO_ADDRESS: () => t('There is no address for your phone yet. Do steps 1 to 3 first.'),
  TIMEOUT: () => t('Sara tried her address and got no answer within 10 seconds.'),
  OTHER: () => t('Something else answered at that address, not this Sara.'),
  UNREACHABLE: () => t("Sara couldn't reach her own address."),
  PRIVATE_LOCAL: () => t('Nothing leaves this computer is on, so Sara cannot test this.'),
};

function stepBox(n, title, done) {
  const s = el('li', `rch-step${done ? ' done' : ''}`);
  const h = el('p', 'rch-step-h');
  h.append(el('span', 'rch-mark', done ? '✓' : String(n)), el('strong', '', title));
  s.append(h);
  return s;
}

/** "Use Sara away from home": three steps with live checks. Owner only. */
export async function renderAway(host, opts = {}) {
  if (!host) return;
  if (deps.member()) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  let r;
  try {
    r = await api(`/access/reach${opts.fresh ? '?fresh=1' : ''}`);
  } catch (err) {
    host.replaceChildren(el('p', 'small warn', err.message));
    return;
  }
  const ts = r.tailscale;
  const wrap = el('div', 'rch-away');
  const status = el('p', `rch-status${r.awayAddress ? ' ok' : ''}`, whereWords(r));
  status.setAttribute('role', 'status');
  wrap.append(status);
  wrap.append(el('p', 'small', t('Tailscale is a free app from another company. It links your own phone and computers privately, so your phone reaches Sara from anywhere, and nobody else on the internet can.')));
  const ol = el('ol', 'rch-steps');

  // 1. This computer.
  const s1 = stepBox(1, t('Install Tailscale on this computer and sign in'), ts.running);
  if (ts.running) s1.append(el('p', 'small muted', t('Tailscale is on and signed in here.')));
  else if (ts.installed) s1.append(el('p', 'small', (STATE_WORDS[ts.state] ?? (() => t('Tailscale is installed but not connected. Open Tailscale and sign in.')))()));
  else {
    const p = el('p', 'small');
    p.append(link(r.get.tailscale[r.system] ?? r.get.tailscale.windows, t('Get Tailscale for this computer')), ` ${t('It is free. Install it, open it and sign in, for example with your Google or Apple account.')}`);
    s1.append(p);
  }
  ol.append(s1);

  // 2. The phone.
  const s2 = stepBox(2, t('Install Tailscale on your phone and sign in with the same account'), false);
  s2.append(el('p', 'small', t("Point your phone's camera at its code. Use the same account as on this computer, then switch Tailscale on.")));
  const qrs = el('div', 'rch-qrs');
  for (const [src, label, href] of [[r.qr?.tailscaleAndroid, t('Android'), r.get.tailscale.android], [r.qr?.tailscaleIos, t('iPhone'), r.get.tailscale.ios]]) {
    if (!src) continue;
    const f = el('figure', 'rch-fig');
    const cap = el('figcaption', 'small');
    cap.append(link(href, label));
    f.append(qrImg(src, t('QR code for Tailscale in the app store')), cap);
    qrs.append(f);
  }
  s2.append(qrs);
  ol.append(s2);

  // 3. Let the phone reach Sara, and test it.
  const s3 = stepBox(3, t('Let your phone reach Sara'), Boolean(r.awayAddress));
  const say = el('p', 'small rch-say');
  say.setAttribute('role', 'status');
  const out = el('pre', 'rch-out');
  out.hidden = true;
  if (r.awayAddress) {
    const p = el('p', 'small');
    p.append(`${t('Her address for your devices:')} `, el('code', '', r.awayAddress));
    s3.append(p);
  } else if (ts.canServe) {
    s3.append(el('p', 'small', t('Sara asks Tailscale for a private, secure address that only your own devices can open. Nothing on this computer is opened to the internet. You can turn it off here any time.')));
  } else if (!ts.running) {
    s3.append(el('p', 'small muted', t('Finish step 1 first, then press Check again.')));
  }
  const row = el('p', 'rch-row');
  if (ts.canServe && !r.awayAddress) {
    row.append(button(t('Turn on secure access with Tailscale'), 'primary', async (b) => {
      if (!confirm(t('Turn on secure access with Tailscale? Your own devices on Tailscale can then open Sara at a private https address. You can turn it off here.'))) return;
      b.disabled = true;
      say.textContent = t('Asking Tailscale…');
      try {
        const res = await api('/access/serve', { method: 'POST', body: { action: 'on', confirm: true } });
        if (res.ok) return void (await renderAway(host, { fresh: true, said: t('Secure access is on.') }));
        showServeError(res, say, out);
      } catch (err) {
        say.textContent = err.message;
      } finally {
        b.disabled = false;
      }
    }));
  }
  if (r.awayAddress || r.address) {
    row.append(button(t('Test it'), r.awayAddress ? 'primary' : 'ghost', async (b) => {
      b.disabled = true;
      say.textContent = t('Sara is trying her own address…');
      try {
        const c = await api('/access/reach/check', { method: 'POST', body: {} });
        say.textContent = c.ok ? (c.address === r.awayAddress ? t('Your phone can reach Sara anywhere ✓') : t('Your phone can reach Sara at home ✓')) : (CHECK_ERRORS[c.code] ?? (() => t("Sara couldn't reach her own address.")))();
        say.classList.toggle('ok', Boolean(c.ok));
      } catch (err) {
        say.textContent = err.message;
      } finally {
        b.disabled = false;
      }
    }));
  }
  if (ts.serve?.on && ts.serve.ours) {
    row.append(button(t('Turn off secure access'), 'ghost small', async (b) => {
      if (!confirm(t('Turn off secure access? Your phone then can’t reach Sara through Tailscale until you turn it on again.'))) return;
      b.disabled = true;
      try {
        const res = await api('/access/serve', { method: 'POST', body: { action: 'off', confirm: true } });
        if (res.ok) return void (await renderAway(host, { fresh: true, said: t('Secure access is off.') }));
        showServeError(res, say, out);
      } catch (err) {
        say.textContent = err.message;
      } finally {
        b.disabled = false;
      }
    }));
  }
  row.append(button(t('Check again'), 'ghost small', () => renderAway(host, { fresh: true })));
  s3.append(row, say, out);
  if (opts.said) say.textContent = opts.said;
  ol.append(s3);
  wrap.append(ol);
  if (r.awayAddress) wrap.append(el('p', 'small', t('Last step: connect the Sara phone app with the code above (or under Phone and notifications). Then Sara works on your phone wherever you are.')));
  wrap.append(el('p', 'muted small', t('Tailscale is made by Tailscale Inc., not by Sara. It is free for personal use. Signing in there is your account with them.')));
  host.replaceChildren(wrap);
}

function showServeError(res, say, out) {
  say.textContent = (SERVE_ERRORS[res.code] ?? SERVE_ERRORS.FAILED)();
  if (res.link) {
    say.append(' ', link(res.link, t("Open Tailscale's page")));
  }
  if (res.output && res.code === 'FAILED') {
    out.textContent = res.output;
    out.hidden = false;
  }
}
