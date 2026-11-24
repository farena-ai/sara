// U5.32 (docs/WHATS_NEW.md): "What's new in 3.x", the plain-words page after each update. The server
// (GET /api/whats-new) says whether to open it by itself (once, after an update, with the releases
// since the last version this person saw) and gives the members' subset to members and nothing in kid
// mode. Each highlight has Show me (the place it lives) and, for the owner, Try it (the matching Try
// these item). Closing it (Got it, ✕ or Esc) marks it seen; Help → What's new shows it again.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(serverText(data, `HTTP ${res.status}`)), { status: res.status });
  return data;
}

const ctx = { tryIt: null, member: false };
let view = null;
let markOnClose = false;

function item(i) {
  const li = el('li', `wn-item wn-${i.kind}`);
  li.dataset.id = i.id;
  const head = el('p', 'wn-text');
  head.append(el('span', `wn-chip wn-chip-${i.kind}`, i.kind === 'fixed' ? t('Fixed') : t('New')), ' ', t(i.text));
  li.append(head);
  const acts = el('div', 'wn-acts');
  if (i.link) {
    const b = el('button', 'ghost small wn-go', t('Show me'));
    b.type = 'button';
    b.addEventListener('click', () => {
      $('#whats-new').close();
      location.hash = i.link;
    });
    acts.append(b);
  }
  if (!ctx.member && i.try?.length && ctx.tryIt) {
    const b = el('button', 'ghost small wn-try', t('Try it'));
    b.type = 'button';
    b.addEventListener('click', () => {
      $('#whats-new').close();
      void ctx.tryIt(i.try[0]);
    });
    acts.append(b);
  }
  // T43 (A1): the owner says whether it worked when he tried it. Kept on the server, so the list of
  // what nobody has tried yet, and what did not work, is one look away after every update.
  if (!ctx.member) {
    const was = view?.tried?.[i.id];
    const box = el('span', 'wn-tried');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('Did it work when you tried it?'));
    for (const [ok, label] of [[true, t('Worked')], [false, t('Did not work')]]) {
      const b = el('button', `ghost small wn-tried-btn${was && was.ok === ok ? ' on' : ''}`, label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(Boolean(was && was.ok === ok)));
      b.addEventListener('click', async () => {
        try {
          view = { ...view, ...(await api('/whats-new/tried', { method: 'POST', body: { id: i.id, ok: was && was.ok === ok ? null : ok } })), releases: view.releases };
          render(lastFromHelp);
        } catch {}
      });
      box.append(b);
    }
    acts.append(box);
  }
  if (acts.childElementCount) li.append(acts);
  return li;
}

let lastFromHelp = false;
function render(fromHelp) {
  if (!view) return;
  lastFromHelp = Boolean(fromHelp);
  $('#wn-title').textContent = t("What's new in {version}", { version: view.version });
  $('#wn-lead').textContent = !fromHelp && view.show && view.seen
    ? t('Sara was updated. Here is what changed since {version}, in plain words.', { version: view.seen })
    : t('The newest changes, in plain words. Show me opens the place it lives.');
  $('#wn-list').replaceChildren(
    ...view.releases.map((r) => {
      const sec = el('section', 'wn-release');
      sec.append(el('h3', '', t('New in {version}', { version: r.version })));
      if (r.title) sec.append(el('p', 'muted small wn-rtitle', t(r.title)));
      const ul = el('ul', 'wn-items');
      ul.append(...r.items.map(item));
      sec.append(ul);
      return sec;
    }),
  );
  $('#wn-auto').checked = view.auto !== false;
}

/** Help → What's new (every kept release), or the after-update page (the releases since last seen). */
export async function openWhatsNew({ fromHelp = true } = {}) {
  const d = $('#whats-new');
  if (!d) return;
  try {
    view = fromHelp ? await api('/whats-new?all=1') : view ?? (await api('/whats-new'));
  } catch {
    return;
  }
  if (view.kid || !view.releases.length) return;
  render(fromHelp);
  markOnClose = !fromHelp;
  if (!d.open) d.showModal();
  $('#wn-list').scrollTop = 0;
}

/** On load: after an update, open it once (through the first-run queue, never over another window). */
export async function initWhatsNew(o = {}) {
  ctx.tryIt = o.tryIt ?? null;
  ctx.member = Boolean(o.member);
  const d = $('#whats-new');
  if (!d || o.demo) {
    $('#help-whatsnew')?.setAttribute('hidden', '');
    return;
  }
  $('#help-whatsnew')?.addEventListener('click', () => {
    if ($('#help-menu')?.open) $('#help-menu').close();
    void openWhatsNew({ fromHelp: true });
  });
  $('#wn-ok').addEventListener('click', () => d.close());
  d.addEventListener('close', () => {
    if (!markOnClose) return;
    markOnClose = false;
    void api('/whats-new/seen', { method: 'POST', body: {} }).then((v) => (view = v)).catch(() => {});
  });
  $('#wn-auto').addEventListener('change', async (e) => {
    try {
      view = { ...view, ...(await api('/whats-new', { method: 'PUT', body: { auto: e.target.checked } })), releases: view?.releases ?? [] };
    } catch {
      e.target.checked = !e.target.checked;
    }
  });
  try {
    view = await api('/whats-new');
  } catch {
    return;
  }
  // Kid mode never sees it, not even in Help.
  if (view.kid) return void $('#help-whatsnew')?.setAttribute('hidden', '');
  if (view.show && view.releases.length) o.queue?.add('whats-new', () => void openWhatsNew({ fromHelp: false }));
}
