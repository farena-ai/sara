// W3.3 team workspace (docs/design/W3_TEAM.md): the Team tab of the business desk. Your team role and
// the permission matrix, the workspace's team inbox (assign, reply as the team, approval by role),
// approvals routed by role (spend over the limit needs an admin), and for admins the roles and the
// spend limit. Every rule is enforced by the server; this page only hides what the role cannot use.
import { t, attachTips } from './business-i18n.js';

const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const button = (text, onclick, className) => { const b = element('button', text, className); b.type = 'button'; b.onclick = onclick; return b; };
const field = (label, control, tip) => { const wrap = element('label', label); if (tip) control.dataset.tip = tip; wrap.append(control); return wrap; };
const input = (id, type = 'text', max = 200) => { const node = element('input'); node.id = id; node.type = type; if (type === 'text') node.maxLength = max; return node; };
const when = value => new Date(value).toLocaleString();
const money = cents => (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
const ROLE = () => ({ owner: t('Owner'), admin: t('Admin'), member: t('Member'), guest: t('Guest') });
const STATUS = () => ({ open: t('Open'), done: t('Done'), pending: t('Waiting for approval'), approved: t('Approved, ready to send'), refused: t('Refused'), sent: t('Sent') });

/** Mounts the Team panel. `show(workspaceId, workspaceRole)` redraws it for the current workspace. */
export function createTeam({ api, run, host }) {
  let workspace = '', wsRole = '', team = null, openItem = null;
  const staff = () => team && team.role !== 'guest';
  const writer = () => staff() && (wsRole === 'contributor' || wsRole === 'manager');

  async function show(workspaceId, workspaceRole) {
    workspace = workspaceId; wsRole = workspaceRole; openItem = null;
    team = await api('/team');
    host.replaceChildren();
    const head = element('div', undefined, 'tm-head');
    head.append(element('h2', t('Team')), element('p', t('Your team role: {role}', { role: ROLE()[team.role] }), 'tm-role'));
    head.append(element('p', team.role === 'guest' ? t('Guests read the workspaces they were added to. The team inbox and approvals are for members.') : t('The team inbox and approvals belong to this workspace. Replies from members wait for a manager; spending over the limit waits for an admin.'), 'muted'));
    host.append(head);
    const grid = element('div', undefined, 'tm-grid'); host.append(grid);
    if (staff()) { grid.append(inboxSection(), approvalsSection()); await Promise.all([loadInbox(), loadApprovals()]); }
    host.append(matrixSection());
    if (team.people) host.append(adminSection());
    attachTips(host);
  }

  // ---- Team inbox ----
  let inboxList, thread;
  function inboxSection() {
    const section = element('section', undefined, 'tm-card'); section.id = 'tm-inbox';
    section.append(element('h3', t('Team inbox')));
    if (writer()) {
      const form = element('form'); form.id = 'tm-add';
      const subject = input('tm-subject'); const sender = input('tm-sender', 'text', 320); const body = element('textarea'); body.id = 'tm-body'; body.rows = 3; body.maxLength = 32000;
      form.append(field(t('Subject'), subject, t('A short title the team will recognize, such as the customer and the question.')),
        field(t('From'), sender, t('Who wrote in: a name or an email address. Sara does not send mail from here.')),
        field(t('Message'), body, t('Paste the message the team should handle. It stays in this workspace.')));
      const add = element('button', t('Add to the team inbox'), 'primary'); add.type = 'submit'; form.append(add);
      form.onsubmit = event => { event.preventDefault(); void run(async () => { await api(`/workspaces/${workspace}/inbox`, { subject: subject.value, sender: sender.value, body: body.value }); form.reset(); await loadInbox(); }); };
      const fold = element('details', undefined, 'tm-fold'); fold.append(element('summary', t('Add a message')), form); section.append(fold);
    }
    inboxList = element('div', undefined, 'tm-list'); inboxList.id = 'tm-items';
    thread = element('div', undefined, 'tm-thread'); thread.id = 'tm-thread';
    section.append(inboxList, thread); return section;
  }
  async function loadInbox() {
    const items = await api(`/workspaces/${workspace}/inbox`);
    inboxList.replaceChildren(...(items.length ? items.map(item => {
      const row = button('', () => run(() => openThread(item.id)), 'tm-item'); row.dataset.id = item.id; if (item.id === openItem) row.setAttribute('aria-current', 'true');
      row.append(element('strong', item.subject), element('span', [item.sender, item.assignee ? t('Assigned to {name}', { name: item.assignee }) : t('Not assigned'), STATUS()[item.status], item.waiting ? t('{count} waiting', { count: item.waiting }) : ''].filter(Boolean).join(' · ')));
      return row;
    }) : [element('p', t('Nothing in the team inbox yet.'), 'muted')]));
    if (openItem) await openThread(openItem);
  }
  async function openThread(id) {
    openItem = id;
    const [item, people] = await Promise.all([api(`/workspaces/${workspace}/inbox/${id}`), writer() ? api(`/workspaces/${workspace}/team-people`) : []]);
    for (const row of inboxList.querySelectorAll('.tm-item')) row.toggleAttribute('aria-current', false);
    const box = element('article', undefined, 'tm-message');
    box.append(element('h4', item.subject), element('p', t('From {sender} · added by {name} · {time}', { sender: item.sender, name: item.addedByName ?? t('Former member'), time: when(item.addedAt) }), 'muted'), element('p', item.body, 'tm-body-text'));
    if (writer()) {
      const pick = element('select'); pick.id = 'tm-assign';
      pick.append(new Option(t('Not assigned'), ''), ...people.map(p => new Option(p.name, p.id)));
      pick.value = item.assigneeId ?? '';
      pick.onchange = () => run(async () => { await api(`/workspaces/${workspace}/inbox/${id}/assign`, { assigneeId: pick.value || null }); await loadInbox(); });
      const actions = element('div', undefined, 'tm-actions');
      actions.append(field(t('Assigned to'), pick, t('The person who handles this message. Only members of this workspace who are not guests can be picked.')),
        button(item.status === 'done' ? t('Reopen') : t('Mark done'), () => run(async () => { await api(`/workspaces/${workspace}/inbox/${id}/done`, item.status === 'done' ? { open: true } : {}); await loadInbox(); })));
      box.append(actions);
    }
    const replies = element('div', undefined, 'tm-replies');
    for (const reply of item.replies) {
      const r = element('div', undefined, `tm-reply ${reply.status}`);
      r.append(element('strong', t('Reply as the team by {name}', { name: reply.author ?? t('Former member') })), element('span', STATUS()[reply.status], 'tm-badge'), element('p', reply.body));
      if (reply.decidedBy && reply.status !== 'pending') r.append(element('span', t('Decided by {name}', { name: reply.decidedBy }), 'muted'));
      if (reply.status === 'approved' && writer()) r.append(button(t('Mark as sent'), () => run(async () => { await api(`/workspaces/${workspace}/inbox/${id}/replies/${reply.id}/sent`, {}); await openThread(id); })));
      replies.append(r);
    }
    box.append(replies);
    if (writer()) {
      const draft = element('textarea'); draft.id = 'tm-reply'; draft.rows = 3; draft.maxLength = 32000;
      box.append(field(t('Reply as the team'), draft, wsRole === 'manager' ? t('As a manager your reply is ready to send at once. Copy it into your mail, then mark it as sent.') : t('Your reply waits for a manager of this workspace to approve it. Then copy it into your mail and mark it as sent.')));
      box.append(button(wsRole === 'manager' ? t('Save reply') : t('Ask for approval'), () => run(async () => { if (!draft.value.trim()) return; await api(`/workspaces/${workspace}/inbox/${id}/reply`, { body: draft.value }); await Promise.all([loadInbox(), loadApprovals()]); }), 'primary'));
    }
    thread.replaceChildren(box); attachTips(box);
    for (const row of inboxList.querySelectorAll('.tm-item')) if (row.dataset.id === id) row.setAttribute('aria-current', 'true');
  }

  // ---- Approvals ----
  let approvalList;
  function approvalsSection() {
    const section = element('section', undefined, 'tm-card'); section.id = 'tm-approvals';
    section.append(element('h3', t('Approvals')), element('p', t('Spending up to {limit} needs a manager of this workspace; more needs an admin who is in this workspace. Nobody approves their own request.', { limit: money(team.settings.spendLimitCents) }), 'muted'));
    if (writer()) {
      const form = element('form'); form.id = 'tm-request';
      const title = input('tm-spend-title'); const amount = input('tm-spend-amount', 'number'); amount.min = '0.01'; amount.step = '0.01';
      form.append(field(t('What for'), title, t('What the money is for, such as the item and the supplier.')), field(t('Amount (USD)'), amount, t('The total to spend. Over the spend limit an admin must approve it.')));
      const ask = element('button', t('Ask for approval'), 'primary'); ask.type = 'submit'; form.append(ask);
      form.onsubmit = event => { event.preventDefault(); void run(async () => { await api(`/workspaces/${workspace}/approvals`, { kind: 'spend', title: title.value, amountCents: Math.round(Number(amount.value) * 100) }); form.reset(); await loadApprovals(); }); };
      const fold = element('details', undefined, 'tm-fold'); fold.append(element('summary', t('Ask to spend money')), form); section.append(fold);
    }
    approvalList = element('div', undefined, 'tm-list'); approvalList.id = 'tm-approval-list'; section.append(approvalList); return section;
  }
  async function loadApprovals() {
    const rows = await api(`/workspaces/${workspace}/approvals`);
    approvalList.replaceChildren(...(rows.length ? rows.map(row => {
      const card = element('div', undefined, `tm-approval ${row.status}`);
      const what = row.kind === 'spend' ? t('{title} for {amount}', { title: row.title, amount: money(row.amountCents) }) : t('Reply: {title}', { title: row.title });
      card.append(element('strong', what), element('span', [row.needs === 'admin' ? t('Needs an admin') : t('Needs a manager'), t('asked by {name}', { name: row.mine ? t('you') : row.requester ?? t('Former member') }), STATUS()[row.status], row.decidedBy ? t('Decided by {name}', { name: row.decidedBy }) : ''].filter(Boolean).join(' · '), 'muted'));
      if (row.canDecide) {
        const actions = element('div', undefined, 'tm-actions');
        actions.append(button(t('Approve'), () => decide(row.id, true), 'primary'), button(t('Refuse'), () => decide(row.id, false)));
        card.append(actions);
      }
      return card;
    }) : [element('p', t('No approvals yet.'), 'muted')]));
  }
  const decide = (id, approve) => run(async () => { await api(`/workspaces/${workspace}/approvals/${id}/decide`, { approve }); await Promise.all([loadApprovals(), openItem ? openThread(openItem) : null]); });

  // ---- Roles and permissions ----
  function matrixSection() {
    const section = element('section', undefined, 'tm-card tm-matrix'); section.id = 'tm-matrix';
    section.append(element('h3', t('Roles and permissions')), element('p', t('Who may do what. Inside a workspace the workspace role (view only, contributor, manager) applies too.'), 'muted'));
    const table = element('table'); const head = element('tr'); head.append(element('th', t('Action')), ...team.roles.map(role => element('th', ROLE()[role])));
    const thead = element('thead'); thead.append(head); const tbody = element('tbody');
    for (const row of team.matrix) {
      const tr = element('tr'); const name = element('td', t(row.label)); if (row.workspace) name.append(element('span', t('In the workspace: {role}', { role: t(row.workspace) }), 'muted tm-ws'));
      tr.append(name, ...team.roles.map(role => { const cell = element('td', row.roles.includes(role) ? '✓' : '–', row.roles.includes(role) ? 'yes' : 'no'); cell.setAttribute('aria-label', row.roles.includes(role) ? t('Allowed') : t('Not allowed')); cell.dataset.role = ROLE()[role]; return cell; }));
      tbody.append(tr);
    }
    table.append(thead, tbody); const scroll = element('div', undefined, 'tm-scroll'); scroll.append(table); section.append(scroll); return section;
  }
  function adminSection() {
    const section = element('section', undefined, 'tm-card'); section.id = 'tm-admin';
    section.append(element('h3', t('Team roles')), element('p', t('Admins manage people and settings, members work in their workspaces, guests only read. Company sign-in groups can set these roles at every sign-in.'), 'muted'));
    for (const person of team.people) {
      const row = element('div', undefined, 'row');
      row.append(element('p', person.name));
      if (person.role === 'owner') row.append(element('span', ROLE().owner, 'tm-badge'));
      else {
        const pick = element('select'); pick.id = `tm-role-${person.id}`; pick.setAttribute('aria-label', t('Team role for {name}', { name: person.name }));
        for (const role of ['admin', 'member', 'guest']) pick.append(new Option(ROLE()[role], role));
        pick.value = person.role ?? 'member';
        pick.onchange = () => run(async () => { await api(`/team/people/${person.id}`, { role: pick.value }); await show(workspace, wsRole); });
        row.append(pick);
      }
      section.append(row);
    }
    const form = element('form'); form.id = 'tm-settings';
    const limit = input('tm-limit', 'number'); limit.min = '0'; limit.step = '0.01'; limit.value = String(team.settings.spendLimitCents / 100);
    form.append(field(t('Spend limit (USD)'), limit, t('Spending requests up to this amount need a workspace manager; above it they need an admin.')));
    const save = element('button', t('Save spend limit')); save.type = 'submit'; form.append(save);
    form.onsubmit = event => { event.preventDefault(); void run(async () => { await api('/team/settings', { spendLimitCents: Math.round(Number(limit.value) * 100) }); await show(workspace, wsRole); }); };
    section.append(form); return section;
  }
  return { show };
}
