// Phase 124 (2.57.0, docs/store/SARA_STORE.md §6.1, §6.2, §11.1): the Sara Store, part 1 in the
// app. Settings → Data & health → Privacy gets the *Sara Store* row (on by default; off: no store
// reads at all), when the list was last checked, *Check now*, and a line for each add-on the store
// pulled. Plugins, Skills and Other programs (MCP) get *More in the Sara Store* (a plain link to the
// website). Browsing and installing in Settings (*Get more*) are Phase 125. Everything here comes
// from /api/store on Sara's own server; the page never talks to the store, and every text from the
// store is set with textContent.
import { serverText, t } from './naming.js';

const $ = (sel) => document.querySelector(sel);
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

const st = { demo: false };
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** The freshness line, in words (§6.2). */
export function freshnessLine(s) {
  if (!s.on) return t('The Sara Store is off: Sara doesn’t look for add-ons. Your add-ons keep working.');
  if (s.blocked === 'private') return t('Private local mode is on, so the Sara Store is off. Your add-ons keep working.');
  if (s.freshness === 'none') return t('Sara hasn’t checked the store yet.');
  if (s.freshness === 'unreachable') return t('Sara couldn’t reach the store. Check your internet, then Check now.');
  const parts = [];
  if (s.freshness === 'expired') parts.push(t('The list expired: installs wait until Sara can check again.'));
  else if (s.freshness === 'offline') parts.push(t('You’re offline: showing the list from {when}.', { when: when(s.fetchedAt) }));
  else if (s.checkedAt) parts.push(t('Checked {when}.', { when: when(s.checkedAt) }));
  const n = s.items?.length ?? 0;
  if (n) parts.push(n === 1 ? t('1 add-on in the store.') : t('{n} add-ons in the store.', { n }));
  if (s.failures >= 3) parts.push(t('Sara couldn’t check the store’s list, so she kept the last good one.'));
  if (s.tooOld) parts.push(t('The store needs a newer Sara. Update Sara.'));
  return parts.join(' ');
}

function render(s) {
  $('#store-on').checked = Boolean(s.on);
  $('#store-status').textContent = freshnessLine(s);
  $('#store-check').disabled = !s.on || Boolean(s.blocked && s.blocked !== 'offline');
  for (const a of document.querySelectorAll('a.store-link')) if (s.url) a.href = s.url;
  const box = $('#store-notices');
  box.replaceChildren();
  for (const n of s.notices ?? []) {
    const row = document.createElement('div');
    row.className = 'skl-note store-notice';
    const p = document.createElement('span');
    p.textContent = n.action === 'disable' ? t('{name} was pulled from the Sara Store: {reason} Sara switched it off. Nothing was deleted.', { name: n.name, reason: n.reason }) : t('The Sara Store warns about {name}: {reason}', { name: n.name, reason: n.reason });
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'ghost';
    ok.textContent = t('Got it');
    ok.addEventListener('click', async () => {
      try {
        render(await api(`/store/notices/${encodeURIComponent(n.item)}/dismiss`, { method: 'POST', body: {} }));
      } catch (err) {
        $('#store-status').textContent = err.message;
      }
    });
    row.append(p, ok);
    box.append(row);
  }
}

export async function loadStorePrivacy() {
  if (st.demo) return;
  try {
    render(await api('/store'));
  } catch (err) {
    // A household member (403) or an older server: the row stays out of the way.
    $('#store-status').textContent = err.status === 403 ? '' : err.message;
  }
}

export function initStore(o = {}) {
  st.demo = Boolean(o.demo);
  $('#store-on')?.addEventListener('change', async () => {
    try {
      await api('/store/settings', { method: 'PUT', body: { on: $('#store-on').checked } });
      await loadStorePrivacy();
    } catch (err) {
      $('#store-status').textContent = err.message;
    }
  });
  $('#store-check')?.addEventListener('click', async () => {
    const b = $('#store-check');
    b.disabled = true;
    $('#store-status').textContent = t('Checking…');
    try {
      const r = await api('/store/check', { method: 'POST', body: {} });
      render(r.store);
      if (r.result && !r.result.ok && r.result.reason === 'refused') $('#store-status').textContent = t('The store’s list didn’t check out, so Sara kept the last good one.');
    } catch (err) {
      $('#store-status').textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
}
