// V3 (docs/ops/V3_DESIGN.md §2): the Settings home (every page under its group, one click away) and
// the breadcrumbs above a page (Settings › group › page). Pure data and helpers, so
// test/v3-design.test.ts runs them in Node; web/settings-nav.js draws them.

/** Marks a string for translation (scripts/i18n-extract.ts finds t('…')); settings-nav.js translates it when it draws. */
const t = (s) => s;

/** The groups in order, each with the one line the home shows under its name (English; t() at draw). */
export const SETTINGS_GROUP_INFO = [
  { name: 'Her', desc: t('Who she is, how she looks and sounds, and how she reaches you.') },
  { name: 'You', desc: t('About you, how Sara looks on this device, your briefing and reminders.') },
  { name: 'Models', desc: t('Which AI runs her, for which job, and models on this computer.') },
  { name: 'Chat apps', desc: t('Talk to her from Telegram, Discord, Signal, email and more.') },
  { name: 'Add-ons', desc: t('The store, skills, plugins, web search, the library and tool servers.') },
  { name: 'Coding', desc: t('Coding projects, tools and approvals, GitHub, budgets and servers.') },
  { name: 'Connections', desc: t('Your phone, this computer, computer use, other apps and agents.') },
  { name: 'Data & health', desc: t('Safety, health, backups, devices, usage, updates and privacy.') },
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

/** Breadcrumbs for a page: Settings (→ home) › its group (→ home at that group) › the page. */
export function crumbsFor(page) {
  return [
    { label: 'Settings', to: 'home' },
    { label: page.dataset.group, to: `home:${page.dataset.group}` },
    { label: page.dataset.title, to: '' },
  ];
}
