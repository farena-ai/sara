// SETTINGS3 S6 (docs/design/SETTINGS3.md): the top of the Settings home, a calm overview. A search field,
// her status, "Needs your attention" (from the safety check-up and the Apps and services tiles; hidden when
// empty), quick settings that drive the real controls (one source of truth: each quick switch sets its
// page's own input, which saves exactly as if it was changed there), connected apps and the household.
// The groups with every page one click away follow (settings-nav.js buildSettingsHome).

/** Marks a string for translation (scripts/i18n-extract.ts finds t('…')); buildOverview translates at draw. */
const t = (s) => s;
/** The quick settings: the real input's id, the page it lives on, its label and where it lives. Night or Day is a choice. */
export const QUICK = [
  { id: 'ap-theme', page: 'you-appearance', label: t('Night or Day'), where: t('Appearance'), choices: [['dark', t('Night')], ['light', t('Day')], ['system', t('System')]] },
  { id: 'br-enabled', page: 'you-briefing', label: t('Send me a morning briefing'), where: t('Briefing and reminders') },
  { id: 'cl-on', page: 'her-calls', label: t('Let her call me'), where: t('Calls from her') },
  { id: 'wk-on', page: 'her-hey', label: t('Listen for “Hey Sara” on this computer'), where: t('Hey Sara') },
  { id: 'compact-auto', page: 'models-default', label: t('Tidy long chats on their own'), where: t('Default model') },
  { id: 'ap-a11y', page: 'you-appearance', label: t('Accessibility mode'), where: t('Appearance') },
];

/**
 * Copies a quick control's value to the real one and lets the real one's own listeners run (a non-bubbling
 * change: the window's autosave only hears the quick control's own trusted change, so it saves once).
 */
export function applyQuick(q, value, doc = document) {
  const real = doc.getElementById(q.id);
  if (!real) return false;
  if (q.choices) real.value = value;
  else real.checked = Boolean(value);
  real.dispatchEvent(new Event('change'));
  return true;
}

/** Draws the overview into `box`. ctx: { t, el, open(page), search(), facts, safety, model, owner, member, tiles }. */
export function buildOverview(box, ctx) {
  if (!box) return;
  const { t, el } = ctx;
  const card = (cls, title, extra) => {
    const c = el('section', `s3-ov-card ${cls}`);
    const h = el('div', 's3-ov-head');
    h.append(el('h3', '', title), ...(extra ? [extra] : []));
    c.append(h);
    return c;
  };
  const link = (text, page) => {
    const b = el('button', 'linkish s3-ov-link', text);
    b.type = 'button';
    b.addEventListener('click', () => ctx.open(page));
    return b;
  };
  // Search, the hero.
  const find = el('button', 's3-ov-search');
  find.type = 'button';
  find.append(el('span', 's3-ov-search-text', t('Search every setting, page and how-to')), el('kbd', 's3-ov-kbd', 'Ctrl K'));
  find.addEventListener('click', () => ctx.search());
  // Her status.
  const status = card('s3-ov-status', ctx.model ? t('Sara is ready') : t('Connect a model'));
  const rows = el('div', 's3-ov-facts');
  const fact = (k, v, page) => {
    const f = el('button', 's3-ov-fact');
    f.type = 'button';
    f.append(el('span', 's3-ov-k', k), el('span', 's3-ov-v', v));
    f.addEventListener('click', () => ctx.open(page));
    rows.append(f);
  };
  fact(t('Thinking with'), ctx.model || t('No model yet'), 'models-default');
  const on = Object.values(ctx.facts ?? {}).filter((x) => x.state === 'on').length;
  fact(t('Apps and services'), on ? t('{n} connected', { n: on }) : t('None connected yet'), 'co-services');
  if (ctx.safety) fact(t('Safety check-up'), t('{fine} of {total} fine', { fine: ctx.safety.fine, total: ctx.safety.total }), 'dh-safety');
  if (ctx.owner) fact(t('Signed in as'), ctx.owner, ctx.member ? 'account' : 'dh-devices');
  status.append(rows);
  // Needs your attention (hidden when empty).
  const needs = [
    ...(ctx.safety?.checks ?? []).filter((c) => c.status !== 'green').map((c) => ({ title: c.title, line: c.line, page: 'dh-safety', level: c.status === 'red' ? 'bad' : 'warn' })),
    ...(ctx.tiles ?? []).filter((x) => ctx.facts?.[x.id]?.state === 'warn').map((x) => ({ title: t(x.title), line: ctx.facts[x.id].line, page: x.id, level: 'warn' })),
  ];
  const attention = card('s3-ov-needs', t('Needs your attention'), el('span', 's3-ov-count', String(needs.length)));
  for (const n of needs.slice(0, 4)) {
    const b = el('button', 's3-ov-need');
    b.type = 'button';
    const dot = el('span', 's3-dot');
    dot.dataset.state = n.level;
    dot.setAttribute('aria-hidden', 'true');
    const text = el('span', 's3-ov-need-text');
    text.append(el('span', 's3-ov-need-title', n.title), el('span', 's3-ov-need-line', n.line));
    b.append(dot, text, el('span', 's3-tile-chev', '›'));
    b.addEventListener('click', () => ctx.open(n.page));
    attention.append(b);
  }
  attention.hidden = !needs.length;
  // Quick settings: the real controls, one click away.
  const quick = card('s3-ov-quick', t('Quick settings'));
  for (const q of QUICK) {
    const real = document.getElementById(q.id);
    if (!real || real.closest('.settings-page')?.matches('[data-owner-only]') && ctx.member) continue;
    const row = el('div', 's3-ov-row');
    const text = el('span', 's3-ov-row-text');
    text.append(el('span', 's3-ov-row-label', t(q.label)), el('span', 's3-ov-row-where', t(q.where)));
    row.append(text);
    if (q.choices) {
      const seg = el('div', 's3-ov-seg');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', t(q.label));
      for (const [v, label] of q.choices) {
        const l = el('label', 's3-ov-seg-opt');
        const r = el('input');
        r.type = 'radio';
        r.name = `s3-quick-${q.id}`;
        r.value = v;
        r.checked = real.value === v;
        r.addEventListener('change', () => applyQuick(q, v));
        l.append(r, el('span', '', t(label)));
        seg.append(l);
      }
      row.append(seg);
    } else {
      const l = el('label', 'row s3-ov-switch');
      const c = el('input');
      c.type = 'checkbox';
      c.checked = real.checked;
      c.disabled = real.disabled;
      c.setAttribute('aria-label', t(q.label));
      c.addEventListener('change', () => applyQuick(q, c.checked));
      l.append(c);
      row.append(l);
    }
    quick.append(row);
  }
  // Connected apps.
  const apps = card('s3-ov-apps', t('Connected apps'), link(t('All apps and services'), 'co-services'));
  const grid = el('div', 's3-ov-app-grid');
  const shown = (ctx.tiles ?? []).filter((x) => ctx.facts?.[x.id]).slice(0, 6);
  for (const x of shown.length ? shown : (ctx.tiles ?? []).slice(0, 4)) {
    const st = ctx.facts?.[x.id] ?? { state: 'off', line: t('Not set up') };
    const b = el('button', 's3-ov-app');
    b.type = 'button';
    const mark = el('span', 's3-tile-mark', x.mark);
    mark.setAttribute('aria-hidden', 'true');
    const text = el('span', 's3-tile-text');
    const line = el('span', 's3-tile-line');
    const dot = el('span', 's3-dot');
    dot.dataset.state = st.state;
    line.append(dot, el('span', '', t(st.line)));
    text.append(el('span', 's3-tile-title', t(x.title)), line);
    b.append(mark, text);
    b.addEventListener('click', () => ctx.open(x.id));
    grid.append(b);
  }
  apps.append(grid);
  const cols = el('div', 's3-ov-cols');
  const left = el('div', 's3-ov-col');
  const right = el('div', 's3-ov-col');
  left.append(status, quick);
  right.append(attention, apps);
  if (!ctx.member) {
    const hh = card('s3-ov-house', t('Household'), link(t('People on this server'), 'household'));
    hh.append(el('p', 'muted small', t('Invite another adult to a private space of their own, with the models and limits you choose.')));
    right.append(hh);
  }
  cols.append(left, right);
  box.replaceChildren(find, cols);
}
