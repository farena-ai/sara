// V3 (docs/ops/V3_DESIGN.md §2): the Settings home (every page under its group, one click away) and
// the breadcrumbs above a page (Settings › group › page). Pure data and helpers, so
// test/v3-design.test.ts runs them in Node; web/settings-nav.js draws them.

/** Marks a string for translation (scripts/i18n-extract.ts finds t('…')); settings-nav.js translates it when it draws. */
const t = (s) => s;

/** The groups in order, each with the one line the home shows under its name (English; t() at draw). */
export const SETTINGS_GROUP_INFO = [
  { name: 'Sara', desc: t('Who she is, how she looks and sounds, and how she reaches you.') },
  { name: 'You', desc: t('About you, how Sara looks on this device, your briefing and reminders.') },
  { name: 'Models & usage', desc: t('Which AI runs her, for which job, what it costs and its limits.') },
  { name: 'Connections', desc: t('Apps and services, your devices, your phone and this computer.') },
  { name: 'Skills & tools', desc: t('The store, skills, plugins, tools, the library and coding.') },
  { name: 'Privacy & system', desc: t('Safety, privacy, backups, moving in, health and updates.') },
  { name: 'Household', desc: t('The people on this server and your own account.') },
];

/**
 * The home's sections: [{ group, desc, pages }] in group order; inside a group the pages keep
 * `orderOf` (the nav's order). `pages` are the Settings page elements (dataset.page/group/title).
 */
export function homeModel(pages, orderOf = () => 0) {
  const rank = (g) => {
    const i = SETTINGS_GROUP_INFO.findIndex((x) => x.name === g);
    return i < 0 ? SETTINGS_GROUP_INFO.length : i;
  };
  const by = new Map();
  for (const p of [...pages].sort((a, b) => orderOf(a) - orderOf(b))) {
    const g = p.dataset.group;
    if (!by.has(g)) by.set(g, []);
    if (!by.get(g).some((x) => x.dataset.page === p.dataset.page)) by.get(g).push(p);
  }
  return [...by].sort(([a], [b]) => rank(a) - rank(b)).map(([group, list]) => ({ group, desc: SETTINGS_GROUP_INFO.find((x) => x.name === group)?.desc ?? '', pages: list }));
}

/**
 * Breadcrumbs for a page: Settings (→ home) › its group (→ home at that group) › the page. SETTINGS3: a
 * tile page sits under Apps and services (co-services), a merged page under its host.
 */
export function crumbsFor(page, titleOf = (id) => id) {
  const host = page.dataset.host;
  return [
    { label: 'Settings', to: 'home' },
    { label: page.dataset.group, to: `home:${page.dataset.group}` },
    ...(page.dataset.tile ? [{ label: t('Apps and services'), to: 'co-services' }] : []),
    ...(host ? [{ label: titleOf(host), to: host }] : []),
    { label: page.dataset.title, to: '' },
  ];
}
