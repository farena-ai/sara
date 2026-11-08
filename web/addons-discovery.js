// Inert discovery inside the existing Settings pages. All mutation authority stays with
// the normal plugin review and MCP forms; a preview never becomes configuration.
import { t } from './naming.js';
import { needsLine } from './prereqs.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, run) {
  const node = el('button', 'ghost small', text);
  node.type = 'button';
  node.addEventListener('click', () => void run(node));
  return node;
}
async function read(path) {
  const response = await fetch(`/api${path}`);
  if (!response.ok) throw new Error(t('Discovery is unavailable. Your existing settings are unchanged.'));
  return response.json();
}
const STATUS = {
  'in-testing': () => t('In testing'),
  tested: () => t('Host-tested'),
  'needs-account': () => t('Needs account'),
  blocked: () => t('Blocked'),
};
const COST = {
  'local-only': () => t('Local hardware'), mixed: () => t('Optional provider cost'),
  provider: () => t('Provider cost'), unconfirmed: () => t('Cost unconfirmed'),
};
const memory = new Map();
function filters(box, id, items, render) {
  const state = memory.get(id) ?? { query: '', status: '', cost: '' };
  memory.set(id, state);
  const row = el('div', 'addon-filters');
  function field(label, tip, input) {
    const wrap = el('label', 'small', label);
    const help = button('?', () => {});
    help.className = 'tip';
    help.dataset.tip = tip;
    help.setAttribute('aria-label', tip);
    input.dataset.noauto = '';
    input.dataset.nodirty = '';
    input.id = `${id}-${input.dataset.filter}`;
    wrap.append(' ', help, input);
    row.append(wrap);
  }
  const query = el('input');
  query.type = 'search'; query.dataset.filter = 'search'; query.value = state.query;
  field(t('Find an entry'), t('Filter this list on this device. Searching does not install anything or change saved settings.'), query);
  function select(key, label, values) {
    const input = el('select'); input.dataset.filter = key;
    input.append(new Option(t('All'), ''), ...values.map(([value, text]) => new Option(text(), value)));
    input.value = state[key];
    field(label, t('Narrow the visible entries. This is a reading filter, not a permission or installation setting.'), input);
    input.addEventListener('change', () => { state[key] = input.value; draw(); });
  }
  select('status', t('Qualification'), Object.entries(STATUS));
  select('cost', t('Cost'), Object.entries(COST));
  const results = el('div', 'skl-list addon-results');
  const count = el('p', 'muted small'); count.setAttribute('role', 'status');
  function draw() {
    const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = items.filter(item => {
      const searchText = `${t(item.name)} ${t(item.summary)} ${item.name} ${item.summary} ${item.id}`.toLowerCase();
      return (!state.status || item.status === state.status) && (!state.cost || item.costTier === state.cost) && words.every(word => searchText.includes(word));
    });
    count.textContent = t('{n} entries shown', { n: shown.length });
    results.replaceChildren(...shown.map(render));
    if (!shown.length) results.append(el('p', 'muted small', t('No entries match these filters.')));
  }
  query.addEventListener('input', () => { state.query = query.value; draw(); });
  box.append(row, count, results); draw();
}
function list(title, values, ordered = false) {
  const section = el('div', 'addon-section');
  section.append(el('strong', 'small', title));
  const rows = el(ordered ? 'ol' : 'ul', 'small');
  for (const value of values ?? []) rows.append(el('li', '', t(value)));
  section.append(rows); return section;
}
function paragraph(title, text) {
  const p = el('p', 'small'); p.append(el('strong', '', title), ' ', t(text)); return p;
}
function link(label, href) {
  const a = el('a', 'small', label);
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.username || url.password) return el('span', 'muted small', label);
    a.href = url.href;
  } catch { return el('span', 'muted small', label); }
  a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
}
function details(label) {
  const node = el('details', 'addon-details'); node.dataset.noauto = '';
  node.append(el('summary', 'small', label)); return node;
}
function card(item) {
  const node = el('article', 'skl-card addon-card'); node.dataset.discoveryId = item.id;
  const head = el('div', 'addon-head');
  head.append(el('strong', '', t(item.name)));
  const chips = el('div', 'skl-chips');
  chips.append(el('span', `skl-chip ${item.status === 'blocked' ? 'bad' : 'warn'}`, STATUS[item.status]?.() ?? t('Qualification unconfirmed')), el('span', 'skl-chip', COST[item.costTier]?.() ?? COST.unconfirmed()));
  head.append(chips);
  node.append(head, el('p', 'muted small', t(item.summary))); return node;
}
function facts(item, disclosure) {
  disclosure.append(el('p', 'small', t(item.description)), list(t('Prerequisites'), item.prerequisites), list(t('Permissions and scope'), item.permissions), paragraph(t('Cost:'), item.cost), paragraph(t('Privacy:'), item.privacy), paragraph(t('Qualification:'), item.qualification), list(t('Limits'), item.limitations));
  const links = el('div', 'add-row');
  links.append(link(t('Source information'), item.source), link(t('Documentation'), item.documentation));
  disclosure.append(links);
}
function pageLink(label, page) {
  const a = el('a', 'small', label); a.href = `#view=settings:${page}`; return a;
}
function installedLink(id) {
  return button(t('Show installed card'), () => {
    const card = document.querySelector(`[data-installed-plugin="${CSS.escape(id)}"]`);
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.focus(); }
  });
}
function nativeCard(item, review) {
  const node = card(item);
  node.append(el('p', 'small addon-origin', t('Local workflow candidate · not a signed store release')));
  const actions = el('div', 'add-row');
  if (item.installed) {
    actions.append(el('span', 'muted small', t('Installed ({version})', { version: item.installedVersion })), installedLink(item.id));
    if (item.installedOrigin !== 'candidate') node.append(el('p', 'muted small', t('Installed from another source; open its installed card to manage it.')));
  } else {
    const action = button(t('Review local candidate'), () => review(item.id));
    action.disabled = item.availability !== 'local-candidate'; actions.append(action);
  }
  if (item.heldReason) node.append(el('p', 'skl-warn small', t(item.heldReason)));
  // PRQ: programs its jobs run beyond Sara's own Node (npm), found or not on this computer.
  if (item.needs?.length) node.append(needsLine(item.needs, () => {}));
  const disclosure = details(t('Details and limits')); facts(item, disclosure);
  node.append(actions, disclosure); return node;
}
const MANUAL = () => t('Manual safety check: inspect each tool in Tools and approvals, select Ask or Off, save, leave this page, reopen and read back the saved permissions. Repeat after discovery, reconnect and updates. Server read-only annotations can auto-allow calls; they do not enforce approval for external effects or cost.');
function mcpCard(item) {
  const node = card(item);
  const disclosure = details(item.recipePreview ? t('View recipe preview') : t('Why blocked'));
  facts(item, disclosure);
  if (item.recipePreview) {
    const recipe = item.recipePreview;
    disclosure.append(el('p', 'skl-warn small', t('Read-only preview. Prepare and review configuration yourself in the existing form. Nothing here saves, connects, authorizes an account or runs a command.')));
    const code = el('pre', 'addon-recipe small'); code.dataset.raw = '';
    code.textContent = recipe.transport === 'http' ? recipe.url : [recipe.command, ...recipe.args].join('\n');
    disclosure.append(paragraph(t('Transport:'), recipe.transport), code);
    for (const value of recipe.environment ?? []) {
      const row = el('p', 'small');
      row.append(el('code', '', `${value.name}=${value.publicValue}`), ' ', el('span', '', t(value.purpose)));
      disclosure.append(row);
    }
    for (const value of recipe.substitutions ?? []) disclosure.append(paragraph(value.key, value.purpose));
    for (const secret of recipe.secrets ?? []) {
      disclosure.append(paragraph(secret.key, secret.purpose));
      if (secret.header) disclosure.append(el('p', 'small', t('HTTP header: {header}; prefix: {prefix}; supply your own secret separately.', { header: secret.header, prefix: secret.prefix })));
    }
    disclosure.append(list(t('Manual preparation checklist'), recipe.guide, true));
  }
  disclosure.append(el('p', 'skl-warn small', MANUAL()), el('p', 'muted small', t('Generic hosted OAuth is unqualified. A recipe preview does not establish real-account access or Sara-host qualification.')), pageLink(t('Tools and approvals'), 'ab-tools'));
  node.append(disclosure); return node;
}
// Developer connections (M01-M30): only a fixture-tested recipe can be copied into the normal add
// form, switched off. Nothing is saved, started or connected until the owner presses Save there.
function copyToAddForm(item) {
  const recipe = item.recipePreview; const form = document.querySelector('#mcp-add');
  if (!form || !recipe) return false;
  const set = (id, value) => { const input = document.querySelector(id); if (input) input.value = value; };
  set('#mcp-preset', ''); document.querySelector('#mcp-preset-help')?.setAttribute('hidden', '');
  set('#mcp-name', item.id);
  set('#mcp-transport', recipe.transport);
  document.querySelector('#mcp-transport')?.dispatchEvent(new Event('change'));
  set('#mcp-command', recipe.transport === 'stdio' ? recipe.command : '');
  set('#mcp-args', recipe.transport === 'stdio' ? recipe.args.join(' ') : '');
  set('#mcp-url', recipe.transport === 'http' ? recipe.url : '');
  set('#mcp-secrets', (recipe.environment ?? []).map(value => `${value.name}=${value.publicValue}`).join('\n'));
  const enabled = document.querySelector('#mcp-enabled'); if (enabled) enabled.checked = false;
  form.open = true; form.scrollIntoView({ block: 'start', behavior: 'smooth' }); document.querySelector('#mcp-name')?.focus();
  return true;
}
function developerCard(item) {
  const node = mcpCard(item);
  if (item.status === 'tested' && item.recipePreview) {
    const actions = el('div', 'add-row'); const note = el('p', 'muted small'); note.setAttribute('role', 'status');
    actions.append(button(t('Copy into the add form'), () => { note.textContent = copyToAddForm(item) ? t('Copied into the add form below, switched off. Review it, then press Save and connect yourself.') : t('The add form is not available on this page.'); }));
    node.insertBefore(actions, node.querySelector('details')); node.insertBefore(note, node.querySelector('details'));
  } else node.insertBefore(el('p', 'skl-warn small', item.status === 'blocked' ? t('Blocked: no install action. See the reason under Limits.') : t('Held: needs your own account, key or service first. No install action.')), node.querySelector('details'));
  return node;
}
function guides(box, packs, candidates, investigations, shelf) {
  const section = details(t('Starter guides'));
  section.id = 'plg-starter-guides';
  section.append(el('p', 'muted small', t('Reading and setup checklists only. Review each member separately; nothing installs or switches on as a group. Private and local depends on your selected models, providers and scopes.')));
  for (const pack of packs) {
    const guide = details(t(pack.name)); guide.dataset.guideId = pack.id;
    guide.append(el('p', 'small', t(pack.summary)), el('p', 'small', t(pack.description)));
    function members(title, refs) {
      const rows = el('ul', 'small addon-members');
      for (const id of refs) {
        const candidate = candidates.find(item => item.id === id);
        const investigation = investigations.find(item => item.id === id);
        const signed = shelf?.items?.find(item => item.id === id);
        const row = el('li');
        if (candidate) row.append(pageLink(t(candidate.name), 'ab-plugins'), ' · ', t('Local candidate; review separately'));
        else if (investigation) row.append(pageLink(t(investigation.name), 'ab-mcp'), ' · ', investigation.recipePreview ? t('Recipe preview only') : t('Blocked investigation'));
        else if (signed) row.append(pageLink(t(signed.name), 'ab-store'), ' · ', !signed.installHeld && shelf.installAllowed && signed.canRun && !signed.held && !signed.blockedHere ? t('Verified store listing; review in Get more') : t('Store listing held; check Get more for its reason'));
        else row.append(el('span', '', id), ' · ', t('Held: no verified listing in the current Get more response.'));
        rows.append(row);
      }
      const wrap = el('div', 'addon-section'); wrap.append(el('strong', 'small', title), rows); return wrap;
    }
    guide.append(members(t('Members'), pack.items), members(t('Alternatives'), pack.alternatives), list(t('Setup checklist'), pack.setup, true), paragraph(t('Privacy:'), pack.privacy), paragraph(t('Cost:'), pack.cost));
    const links = el('div', 'add-row'); links.append(pageLink(t('Plugins'), 'ab-plugins'), pageLink(t('Other programs (MCP)'), 'ab-mcp'), pageLink(t('Get more'), 'ab-store'), pageLink(t('Privacy'), 'dh-privacy'));
    guide.append(links); section.append(guide);
  }
  box.append(section);
}
async function load(box, draw, retry) {
  if (!box) return;
  try { await draw(); }
  catch {
    box.replaceChildren(el('p', 'muted small', t('Discovery is unavailable. Your existing settings are unchanged.')), button(t('Retry discovery'), retry));
  }
}
export async function loadNativeDiscovery(review) {
  const box = document.querySelector('#plg-discovery');
  return load(box, async () => {
    const data = await read('/plugins/candidates');
    const [mcp, shelf] = await Promise.all([read('/mcp/discovery/previews').catch(() => ({ investigations: [] })), read('/store').catch(() => null)]);
    box.replaceChildren(el('h3', '', t('Workflow candidates')), el('p', 'muted small', t('Supplied-data workflows and developer tools. Review exact files and permissions before installing; each companion stays off until you enable it.')));
    filters(box, 'native-discovery', data.candidates, item => nativeCard(item, review));
    guides(box, data.packs, data.candidates, mcp.investigations, shelf);
  }, () => loadNativeDiscovery(review));
}
export async function loadMcpDiscovery() {
  const box = document.querySelector('#mcp-discovery');
  return load(box, async () => {
    const data = await read('/mcp/discovery/previews');
    box.replaceChildren(el('h3', '', t('Connection investigations')), el('p', 'muted small', t('Seven recipe previews and fourteen blocked investigations. These are preparation notes, not installable releases or account connections.')), el('p', 'skl-warn small', MANUAL()));
    filters(box, 'mcp-discovery', data.investigations, mcpCard);
    const developer = data.developer ?? [];
    if (developer.length) {
      box.append(el('h3', '', t('Developer connections')), el('p', 'muted small', t('Fixture-tested recipes can be copied into the add form below, switched off; nothing saves or starts until you press Save and connect. Held entries need your own account, key or service, and blocked entries list their reason. Neither has an install action.')));
      filters(box, 'mcp-developer', developer, developerCard);
    }
  }, loadMcpDiscovery);
}
