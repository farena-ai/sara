// C16: team pages in a workspace (docs/ops/C16_DESIGN.md). Markdown pages with search, edit history,
// threaded comments with @mentions, Markdown/PDF export, and "Ask Sara" handing a page to the composer.
import { t, attachTips } from './business-i18n.js';

const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, onclick, className) => { const b = element('button', text, className); b.type = 'button'; b.onclick = onclick; return b; };
const when = value => new Date(value).toLocaleString();

/**
 * Mounts the Pages panel for one workspace. `ask(page, prompt)` sends the page to the composer as
 * context; Sara's answer is only a proposal until a member saves it (`openDraft`).
 */
export function createPages({ api, run, host, ask }) {
  let workspace = '', role = '', page = null, version = 0, replyTo = null;
  const base = () => `/workspaces/${workspace}/pages`;
  const can = { edit: () => role === 'contributor' || role === 'manager', remove: () => role === 'manager' };
  host.replaceChildren();
  const aside = element('aside', undefined, 'tp-aside');
  const search = element('label', t('Search pages')); const query = element('input'); query.id = 'tp-search'; query.type = 'search'; query.maxLength = 200; query.dataset.tip = t('Finds pages whose title or text contains these words.'); search.append(query);
  const create = button(t('New page'), () => edit(null)); create.id = 'tp-new';
  const draft = button(t('Draft a page with Sara'), () => ask(null, t('Draft a team page about: '))); draft.id = 'tp-draft';
  const mentions = element('div', undefined, 'tp-mentions'); mentions.id = 'tp-mentions';
  const list = element('div', undefined, 'tp-list'); list.id = 'tp-list';
  aside.append(element('h2', t('Team pages')), search, create, draft, mentions, list);
  const main = element('div', undefined, 'tp-main'); main.id = 'tp-main';
  host.append(aside, main);
  attachTips(aside);
  let typing;
  query.oninput = () => { clearTimeout(typing); typing = setTimeout(() => run(loadList), 250); };

  async function loadMentions(v) {
    const rows = await api(`/workspaces/${workspace}/page-mentions`); if (v !== version) return;
    const unread = rows.filter(row => !row.read);
    mentions.replaceChildren();
    if (!unread.length) return;
    mentions.append(element('h3', t('Mentions for you ({count})', { count: unread.length })));
    for (const row of unread.slice(0, 10)) mentions.append(button(t('{name} mentioned you on {page}', { name: row.by || t('A colleague'), page: row.pageTitle }), () => run(() => open(row.pageId))));
    mentions.append(button(t('Mark all as read'), () => run(async () => { await api(`/workspaces/${workspace}/page-mentions/read`, {}); await loadMentions(version); })));
  }
  async function loadList() {
    const v = version; const q = query.value.trim();
    const rows = await api(base() + (q ? `?q=${encodeURIComponent(q)}` : '')); if (v !== version) return;
    list.replaceChildren(...(rows.length ? rows.map(row => {
      const b = button('', () => run(() => open(row.id)), 'tp-item'); b.dataset.page = row.id;
      b.append(element('strong', row.title), element('span', t('By {name} · {when}', { name: row.author || t('Former member'), when: when(row.updatedAt) })));
      if (row.openComments) b.append(element('span', t('{count} open comments', { count: row.openComments }), 'tp-badge'));
      if (page?.id === row.id) b.setAttribute('aria-current', 'true');
      return b;
    }) : [element('p', q ? t('No pages match.') : t('No pages yet.'), 'muted')]));
  }
  async function open(id) {
    const v = version;
    const [value, comments] = await Promise.all([api(`/workspaces/${workspace}/pages/${id}`), api(`/workspaces/${workspace}/pages/${id}/comments`)]); if (v !== version) return;
    page = value; replyTo = null; render(comments); await loadList();
  }
  function render(comments) {
    const head = element('div', undefined, 'tp-head'); head.append(element('h2', page.title));
    head.append(element('p', t('Written by {name} · revision {revision} · updated {when}', { name: page.author || t('Former member'), revision: page.revision, when: when(page.updatedAt) }), 'muted'));
    const actions = element('div', undefined, 'tp-actions');
    if (can.edit()) actions.append(button(t('Edit'), () => edit(page)));
    actions.append(button(t('History'), () => run(history)));
    for (const [format, label] of [['md', t('Export Markdown')], ['pdf', t('Export PDF')]]) { const a = element('a', label, 'button'); a.href = `/api/business${base()}/${page.id}/export?format=${format}`; a.setAttribute('download', ''); actions.append(a); }
    actions.append(button(t('Ask Sara about this page'), () => ask(page, t('Summarize this page and its open comments.'))));
    if (can.remove()) actions.append(button(t('Delete page'), () => run(remove), 'danger'));
    const body = element('div', page.body, 'tp-body'); body.id = 'tp-body';
    const thread = element('section', undefined, 'tp-comments'); thread.append(element('h3', t('Comments')));
    const children = new Map();
    for (const c of comments) { const key = comments.some(x => x.id === c.parentId) ? c.parentId : ''; children.set(key, [...(children.get(key) || []), c]); }
    const item = (c, depth) => {
      const box = element('article', undefined, 'tp-comment' + (c.resolvedAt ? ' resolved' : '') + (depth ? ' reply' : ''));
      box.append(element('strong', c.author || t('Former member')), element('span', ' · ' + when(c.createdAt), 'muted'), element('p', c.body));
      const row = element('div', undefined, 'tp-actions');
      if (!depth) row.append(button(t('Reply'), () => { replyTo = c; composeLabel.textContent = t('Reply to {name}', { name: c.author || t('Former member') }); input.focus(); }));
      if (can.edit() || c.authorId === self()) row.append(button(c.resolvedAt ? t('Reopen') : t('Resolve'), () => run(async () => { await api(`/workspaces/${workspace}/pages/${page.id}/comments/${c.id}/resolve`, { resolved: !c.resolvedAt }); await open(page.id); })));
      if (c.resolvedAt) row.append(element('span', t('Resolved'), 'tp-badge'));
      box.append(row);
      return [box, ...(children.get(c.id) || []).map(r => item(r, 1)).flat()];
    };
    thread.append(...(children.get('') || []).flatMap(c => item(c, 0)));
    if (!comments.length) thread.append(element('p', t('No comments yet.'), 'muted'));
    const form = element('form'); form.id = 'tp-comment-form';
    const composeLabel = element('label', t('Add a comment')); const input = element('textarea'); input.id = 'tp-comment'; input.rows = 3; input.maxLength = 4000; input.dataset.tip = t('Everyone in this workspace can read comments. Type @ and a member’s name to notify them.');
    composeLabel.append(input);
    const submit = element('button', t('Comment'), 'primary'); submit.type = 'submit';
    form.append(composeLabel, submit);
    form.onsubmit = event => { event.preventDefault(); if (!input.value.trim()) return; void run(async () => { await api(`/workspaces/${workspace}/pages/${page.id}/comments`, { body: input.value, ...(replyTo ? { parentId: replyTo.id } : {}) }); await open(page.id); }, submit); };
    thread.append(form);
    main.replaceChildren(head, actions, body, thread); attachTips(main);
  }
  let selfId = '';
  const self = () => selfId;
  function edit(current, initial) {
    const form = element('form', undefined, 'tp-editor'); form.id = 'tp-editor';
    const titleLabel = element('label', t('Page title')); const title = element('input'); title.id = 'tp-title'; title.maxLength = 200; title.required = true; title.dataset.tip = t('A short name colleagues will search for.'); titleLabel.append(title);
    const bodyLabel = element('label', t('Page text (Markdown)')); const body = element('textarea'); body.id = 'tp-text'; body.rows = 16; body.dataset.tip = t('Use # for headings, - for lists and **bold**. Every saved version is kept in History.'); bodyLabel.append(body);
    title.value = current?.title ?? initial?.title ?? ''; body.value = current?.body ?? initial?.body ?? '';
    const save = element('button', current ? t('Save changes') : t('Create page'), 'primary'); save.type = 'submit';
    const cancel = button(t('Cancel'), () => (page ? run(() => open(page.id)) : main.replaceChildren()));
    form.append(element('h2', current ? t('Edit page') : t('New page')), titleLabel, bodyLabel, save, cancel);
    if (initial) form.insertBefore(element('p', t('Sara drafted this. Nothing is saved until you choose Create page.'), 'step-guidance'), titleLabel);
    form.onsubmit = event => { event.preventDefault(); void run(async () => {
      const saved = current ? await api(`/workspaces/${workspace}/pages/${current.id}`, { title: title.value, body: body.value, revision: current.revision }) : await api(base(), { title: title.value, body: body.value });
      await open(saved.id);
    }, save); };
    main.replaceChildren(form); attachTips(form); title.focus();
  }
  async function history() {
    const v = version; const rows = await api(`/workspaces/${workspace}/pages/${page.id}/history`); if (v !== version) return;
    const box = element('section', undefined, 'tp-history'); box.id = 'tp-history';
    box.append(element('h3', t('History')), element('p', t('Every saved version, newest first. Versions cannot be changed.'), 'muted'));
    for (const row of rows) { const d = element('details'); d.append(element('summary', t('Revision {revision} · {name} · {when}', { revision: row.revision, name: row.editor || t('Former member'), when: when(row.editedAt) })), element('h4', row.title), element('div', row.body, 'tp-body')); box.append(d); }
    main.append(box); box.scrollIntoView({ block: 'nearest' });
  }
  async function remove() {
    if (!confirm(t('Delete “{title}” with its history and comments? This cannot be undone.', { title: page.title }))) return;
    await api(`/workspaces/${workspace}/pages/${page.id}/delete`, {}); page = null; main.replaceChildren(); await loadList();
  }
  return {
    async show(id, nextRole, actorId) {
      if (id !== workspace) { page = null; main.replaceChildren(); query.value = ''; }
      workspace = id; role = nextRole; selfId = actorId; const v = ++version;
      create.hidden = !can.edit(); draft.hidden = !can.edit();
      await Promise.all([loadList(), loadMentions(v)]);
    },
    refresh() { if (workspace) void run(async () => { await loadList(); await loadMentions(version); }); },
    /** Opens the editor with Sara's answer; the member's Create page is the approval. */
    openDraft(text) { page = null; edit(null, { title: '', body: text }); },
    clear() { version++; workspace = ''; page = null; list.replaceChildren(); mentions.replaceChildren(); main.replaceChildren(); },
  };
}

/** Organization administration: a legal hold per workspace and per-person page export/delete. */
export async function renderPagesAdmin({ api, host, run, current, users }) {
  const section = element('section', undefined, 'sso-settings tp-admin'); section.id = 'tp-admin';
  section.append(element('h2', t('Team pages: legal hold and personal data')));
  section.append(element('p', t('A hold stops anyone deleting pages, comments or other content in that workspace until you release it. Edits stay possible and every version is kept.')));
  const spaces = await api('/workspaces'); if (!current()) return;
  for (const space of spaces) {
    const { held } = await api(`/workspaces/${space.id}/hold`); if (!current()) return;
    const label = element('label', t('Legal hold: {name}', { name: space.name }), 'check'); const box = element('input'); box.type = 'checkbox'; box.id = `tp-hold-${space.id}`; box.checked = held; box.dataset.tip = t('While on, nothing in this workspace can be deleted, including a person’s comments.');
    box.onchange = () => run(async () => { await api(`/workspaces/${space.id}/hold`, { on: box.checked }); }, box);
    label.prepend(box); section.append(label);
  }
  const pick = element('label', t('Person')); const select = element('select'); select.id = 'tp-person'; select.dataset.tip = t('Download or delete the pages, page versions and comments this person wrote.');
  for (const user of users) { const option = element('option', user.name); option.value = user.id; select.append(option); }
  pick.append(select);
  const download = element('a', t('Download their pages'), 'button'); download.setAttribute('download', '');
  const sync = () => { download.href = `/api/business/org/users/${select.value}/pages-export`; };
  select.onchange = sync; sync();
  const status = element('p'); status.setAttribute('role', 'status');
  const erase = button(t('Delete their comments and name'), () => run(async () => {
    const name = select.selectedOptions[0]?.textContent || '';
    if (!confirm(t('Delete every page comment by {name} and remove their name from pages they wrote? Pages stay for the team.', { name }))) return;
    const receipt = await api(`/org/users/${select.value}/pages-delete`, { confirm: true });
    status.textContent = t('Done: {comments} comments and {mentions} mentions deleted, {attributions} names removed.', receipt);
  }), 'danger');
  const actions = element('div', undefined, 'actions'); actions.append(download, erase);
  section.append(pick, actions, status);
  host.append(section); attachTips(section);
}
