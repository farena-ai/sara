// E7: "Always allow" for one tool on its approval card (with Undo), and one choice per tool server
// (Ask me first / Always allow the safe ones / Always allow everything / Never) in Settings → Tools.
import { serverText, t } from './naming.js';

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
  if (!res.ok) throw new Error(serverText(data, `HTTP ${res.status}`));
  return data;
}
function tip(text) {
  const b = el('button', 'tip', '?');
  b.type = 'button';
  b.dataset.tip = text;
  return b;
}

/**
 * The card's "Always allow this tool" button. It allows this call, the tool becomes Always allowed,
 * and the card turns into one line with Undo (back to Ask me first).
 */
export function alwaysAllowButton(ev, card) {
  const b = el('button', 'ghost', t('Always allow this tool'));
  b.type = 'button';
  b.addEventListener('click', async () => {
    card.querySelectorAll('button').forEach((x) => (x.disabled = true));
    try {
      await api(`/approvals/${ev.approvalId}`, { method: 'POST', body: { approved: true, how: 'tool' } });
      const line = el('p', 'muted small approval-always', t('Always allowed now: {tool}. You can change it in Settings → Coding → Tools and approvals.', { tool: ev.name }));
      line.dataset.raw = '';
      const undo = el('button', 'linkish', t('Undo'));
      undo.type = 'button';
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try {
          await api('/tools', { method: 'PUT', body: { permissions: { [ev.name]: 'ask' } } });
          line.textContent = t('She asks you first again.');
        } catch (err) {
          line.textContent = err.message;
        }
      });
      line.append(' ', undo);
      card.replaceChildren(line);
    } catch (err) {
      card.querySelectorAll('button').forEach((x) => (x.disabled = false));
      card.append(el('p', 'bad small', err.message));
    }
  });
  return b;
}

const POLICY_LABEL = { ask: 'Ask me first', safe: 'Always allow the safe ones', all: 'Always allow everything', never: 'Never' };

/** One row per tool server: the choice, and exactly which of its tools each choice covers. */
export function serverPolicyRows(servers, reload) {
  return (servers ?? []).map((s) => {
    const row = el('div', 'tool-policy');
    row.dataset.noauto = '';
    const lab = el('label', 'tool-policy-label');
    const name = el('strong', '', s.name);
    name.dataset.raw = '';
    const sel = document.createElement('select');
    sel.dataset.server = s.name;
    sel.setAttribute('aria-label', t('Approvals for {server}', { server: s.name }));
    if (!s.policy) sel.append(new Option(t('As set per tool'), ''));
    for (const [v, label] of Object.entries(POLICY_LABEL)) sel.append(new Option(t(label), v));
    sel.value = s.policy ?? '';
    const note = el('span', 'muted small');
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      sel.disabled = true;
      try {
        await api('/tools/policy', { method: 'PUT', body: { server: s.name, policy: sel.value } });
        await reload();
      } catch (err) {
        note.textContent = err.message;
        sel.disabled = false;
      }
    });
    lab.append(name, ' ', sel, ' ', tip(t("One choice for all of this server's tools. The safe ones only read or make pictures and results. Installs, downloads, restarts, removing and training always keep asking unless you change that tool itself.")));
    const list = el('details', 'tool-policy-list');
    list.append(el('summary', 'small', t('Which tools each choice covers')));
    const line = (label, names) => {
      const p = el('p', 'small');
      p.append(el('span', 'muted', label), ' ');
      const code = el('code', '', names.length ? names.join(', ') : '—');
      code.dataset.raw = '';
      p.append(code);
      return p;
    };
    list.append(line(t('Safe ones (read or make outputs):'), s.safe ?? []), line(t('Also with everything:'), s.other ?? []), line(t('Always ask unless you change the tool itself:'), s.destructive ?? []));
    row.append(lab, note, list);
    return row;
  });
}
