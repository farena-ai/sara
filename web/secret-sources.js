// EC10 (docs/ops/EC10_DESIGN.md): Settings → Data & health → Operations → Secret sources. Lists
// where each server key comes from (Sara's vault or a reference) and whether it can be read now.
// The server never sends a value; this view only shows names, references and status.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);

const KIND = {
  env: () => t('Environment variable'),
  file: () => t('File'),
  vault: () => t('Vault or OpenBao'),
  op: () => t('1Password Connect server'),
  keychain: () => t('Keychain'),
  cmd: () => t('Command'),
};

/** The status line of one reference, in the app's language. */
export function refLine(r) {
  if (r.ok === null) return t('Not read yet.');
  if (r.ok) return t('Working.');
  return r.errorKey ? t(r.errorKey, r.params ?? {}) : (r.error ?? t('Not working.'));
}

/** "Vault: set up · 1Password Connect: not set up · Commands: off · read again every 5 min". */
export function summaryLine(v) {
  const parts = [
    v.configured.vault ? t('Vault: set up') : t('Vault: not set up'),
    v.configured.onepassword ? t('1Password Connect: set up') : t('1Password Connect: not set up'),
    v.commands ? t('Commands: allowed') : t('Commands: off'),
    t('read again every {n} min', { n: Math.max(1, Math.round(v.ttlSeconds / 60)) }),
  ];
  if (v.pinned) parts.push(t('Your policy allows only references for server keys.'));
  return parts.join(' · ');
}

export function createSecretSources({ api, el, isOwner }) {
  const say = (msg) => ($('#ss-status').textContent = msg);
  const paint = (v) => {
    $('#ss-summary').textContent = summaryLine(v);
    const list = $('#ss-list');
    if (!v.sources.length) {
      list.replaceChildren(el('li', 'muted small', t('No server keys yet.')));
      return;
    }
    list.replaceChildren(
      ...v.sources.map((s) => {
        const li = el('li', 'ss-item');
        li.append(el('code', 'ss-name', s.name));
        if (s.source === 'vault') {
          li.append(el('span', 'ss-src muted small', t("Sara's vault")));
          return li;
        }
        const refs = el('ul', 'ss-refs');
        s.refs.forEach((r, i) => {
          const row = el('li', 'ss-ref');
          row.dataset.ok = r.ok === null ? 'unknown' : String(r.ok);
          row.append(el('span', 'ss-kind small', KIND[r.kind]?.() ?? r.kind), el('code', 'ss-ref-text', r.ref));
          if (s.refs.length > 1 && i === s.active) row.append(el('span', 'ss-active small', t('in use')));
          row.append(el('span', 'ss-state small', refLine(r)));
          refs.append(row);
        });
        li.append(refs);
        return li;
      }),
    );
  };
  async function load(path, method) {
    try {
      const v = await api(path, method ? { method } : undefined);
      paint(v);
      return v;
    } catch (e) {
      say(e.message);
      return null;
    }
  }
  async function refresh() {
    const box = $('#ss-box');
    if (!box) return;
    box.hidden = !isOwner();
    if (!box.hidden) await load('/secrets');
  }
  $('#ss-check')?.addEventListener('click', async () => {
    say(t('Reading…'));
    if (await load('/secrets/check', 'POST')) say(t('Read again just now.'));
  });
  return { refresh };
}
