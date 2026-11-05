// Explicit project context only. Saving or clearing never starts work or grants approval.
let checkpointIds = 0;

/** A self-contained editor; api follows app.js's authenticated JSON API convention. */
export function renderProjectCheckpoint({ workspace, path, api, t }) {
  const node = (tag, text = '', cls = '') => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const root = node('details', '', 'project-checkpoint team-detail');
  root.append(node('summary', t('Project checkpoint')));
  root.append(node('p', t('Historical context, not verified results or permission to act. Saving never starts work.'), 'muted small'));
  const saved = node('div');
  const history = node('details');
  history.append(node('summary', t('Saved history (latest five)')));
  const historyRows = node('div');
  history.append(historyRows);
  const form = node('form', '', 'pj-list');
  const prefix = `project-checkpoint-${++checkpointIds}`;
  let revision = 0;
  let request = 0;
  let loaded = false;
  let busy = false;
  let reconcile = false;
  let current = null;
  let records = [];
  let confirmation = null;
  const status = node('p', t('Loading checkpoint…'), 'muted small');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const confirmBox = node('div');
  confirmBox.hidden = true;
  const fields = [];
  function field(name, labelText, tipText, { multiline = false, maxLength = 240, required = false } = {}) {
    const row = node('div');
    const words = node('div', '', 'label-words');
    const label = node('label', labelText);
    const input = node(multiline ? 'textarea' : 'input');
    input.id = `${prefix}-${name}`;
    input.dataset.field = name;
    input.maxLength = maxLength;
    input.required = required;
    if (multiline) input.rows = 3;
    else input.type = 'text';
    label.htmlFor = input.id;
    const tip = node('details');
    const tipToggle = node('summary', '?', 'small');
    tipToggle.setAttribute('aria-label', t('Help: {field}', { field: labelText }));
    const help = node('p', tipText, 'muted small');
    help.id = `${input.id}-tip`;
    input.setAttribute('aria-describedby', help.id);
    tip.append(tipToggle, help);
    words.append(label, tip);
    row.append(words, input);
    form.append(row);
    fields.push(input);
    input.addEventListener('input', () => {
      revision++;
      cancelConfirmation();
    });
    return input;
  }
  const logic = field('logic', t('Current logic'), t('Explain the current approach in 1–1500 characters. This is saved context, not a test result.'), { multiline: true, maxLength: 1500, required: true });
  const blockers = field('blockers', t('Blockers (one per line)'), t('Optional: at most five blockers, one per line, up to 240 characters each.'), { multiline: true, maxLength: 1204 });
  const stepTip = t('Keep one concrete next step per field, up to 240 characters. The first is required; the other two are optional.');
  const next = [
    field('next1', t('Next step 1'), stepTip, { required: true }),
    field('next2', t('Next step 2 (optional)'), stepTip),
    field('next3', t('Next step 3 (optional)'), stepTip),
  ];
  const actions = node('div', '', 'actions-left');
  function button(label, action, cls = 'ghost small') {
    const b = node('button', label, cls);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  }
  const save = node('button', t('Save checkpoint'), 'small');
  save.type = 'submit';
  const clear = button(t('Clear checkpoint history'), () => offerConfirmation('clear'));
  const reload = button(t('Reload saved checkpoint'), () => read(true));
  actions.append(save, clear, reload);
  form.append(actions);
  root.append(saved, history, form, confirmBox, node('p', t('Reload replaces unsaved fields with the saved checkpoint. Clear removes saved history and keeps your fields.'), 'muted small'), status);

  function cancelConfirmation() {
    confirmation = null;
    confirmBox.hidden = true;
    confirmBox.replaceChildren();
  }
  function controls() {
    save.textContent = current ? t('Replace checkpoint') : t('Save checkpoint');
    save.disabled = !loaded || busy || reconcile;
    clear.disabled = !loaded || busy || reconcile || !current;
    reload.disabled = busy;
  }
  function setFields(record) {
    logic.value = record?.logic ?? '';
    blockers.value = record?.blockers.join('\n') ?? '';
    next.forEach((input, index) => { input.value = record?.nextSteps[index] ?? ''; });
    revision++;
  }
  function renderRecord(record) {
    const detail = node('details');
    const source = record.sourceConversationId === null ? t('Owner editor') : t('Coding chat {id}', { id: record.sourceConversationId });
    detail.append(node('summary', t('Saved {time} · {source}', { time: record.createdAt, source })));
    const text = node('p', record.logic, 'lib-passage');
    text.setAttribute('data-raw', '');
    detail.append(node('strong', t('Current logic')), text);
    for (const [title, items] of [[t('Blockers'), record.blockers], [t('Next steps'), record.nextSteps]]) {
      detail.append(node('strong', title));
      const list = node('ul');
      if (!items.length) list.append(node('li', t('None')));
      for (const item of items) {
        const li = node('li', item, 'lib-passage');
        li.setAttribute('data-raw', '');
        list.append(li);
      }
      detail.append(list);
    }
    return detail;
  }
  function renderSaved() {
    saved.replaceChildren(current ? renderRecord(current) : node('p', t('No saved checkpoint.'), 'muted small'));
    historyRows.replaceChildren(...records.slice(0, 5).map(renderRecord));
    history.hidden = records.length === 0;
    controls();
  }
  async function read(explicit = false) {
    if (busy) return;
    const id = ++request;
    const startedRevision = revision;
    cancelConfirmation();
    status.textContent = t('Loading checkpoint…');
    try {
      const view = await api(`/code-projects/checkpoints?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(path)}`);
      if (id !== request) return;
      current = view.current;
      records = view.history;
      loaded = true;
      const untouched = startedRevision === revision;
      if (untouched) {
        setFields(current);
        reconcile = false;
      }
      renderSaved();
      status.textContent = untouched ? t('Checkpoint loaded.') : t('Saved state loaded; kept your draft because you edited while loading.');
      // A reconciliation reload must actually replace the editor before a mutation is allowed.
      if (explicit && !untouched && reconcile) controls();
    } catch {
      if (id !== request) return;
      status.textContent = t('Checkpoint unavailable. Your fields are kept. Reload to try again.');
    }
  }
  function input() {
    const value = {
      logic: logic.value.trim(),
      blockers: blockers.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean),
      nextSteps: next.map(n => n.value.trim()).filter(Boolean),
    };
    if (!value.logic || value.logic.length > 1500 || !next[0].value.trim() || value.nextSteps.some(s => s.length > 240)) {
      status.textContent = t('Enter current logic and a first next step within the field limits.');
      return null;
    }
    if (value.blockers.length > 5 || value.blockers.some(s => s.length > 240)) {
      status.textContent = t('Use at most five blockers, up to 240 characters each.');
      return null;
    }
    return value;
  }
  function offerConfirmation(kind) {
    if (!loaded || busy || reconcile || !current) return;
    const value = kind === 'save' ? input() : null;
    if (kind === 'save' && !value) return;
    const token = { kind, expectedId: current.id, revision, value };
    confirmation = token;
    const yes = button(kind === 'save' ? t('Confirm replace') : t('Confirm clear'), async () => {
      if (confirmation !== token || token.revision !== revision || busy || reconcile) return;
      await mutate(token.kind, token.value, token.expectedId);
    });
    const cancel = button(t('Cancel'), () => { cancelConfirmation(); (kind === 'save' ? save : clear).focus(); });
    const row = node('div', '', 'actions-left');
    row.append(yes, cancel);
    confirmBox.replaceChildren(node('p', kind === 'save' ? t('Replace the current checkpoint with these fields?') : t('Clear all saved checkpoint history for this project? Your fields stay here.')), row);
    confirmBox.hidden = false;
    yes.focus();
  }
  async function mutate(kind, value, expectedId) {
    if (!loaded || busy || reconcile) return;
    busy = true;
    request++;
    cancelConfirmation();
    fields.forEach(n => { n.disabled = true; });
    controls();
    try {
      const result = await api('/code-projects/checkpoints', {
        method: kind === 'clear' ? 'DELETE' : 'POST',
        body: { workspace, path, ...(value ?? {}), expectedId },
      });
      if (kind === 'clear') {
        current = null;
        records = [];
        status.textContent = t('Checkpoint history cleared. Your fields are kept.');
      } else {
        current = result;
        records = [result, ...records.filter(record => record.id !== result.id)].slice(0, 5);
        status.textContent = t('Checkpoint saved. Nothing was started.');
      }
      renderSaved();
    } catch (error) {
      if (error.status === 400) status.textContent = t('Checkpoint rejected. Your fields are kept; review them and try again.');
      else {
        reconcile = true;
        status.textContent = error.status === 409
          ? t('Checkpoint changed elsewhere. Your draft is kept. Reload the saved checkpoint before replacing or clearing it.')
          : t('The write could not be confirmed. Your draft is kept. Reload the saved checkpoint before trying again.');
      }
    } finally {
      busy = false;
      fields.forEach(n => { n.disabled = false; });
      controls();
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!loaded || busy || reconcile) return;
    if (current) offerConfirmation('save');
    else {
      const value = input();
      if (value) await mutate('save', value, 0);
    }
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && confirmation) {
      event.preventDefault();
      event.stopPropagation();
      cancelConfirmation();
      save.focus();
    }
  });
  controls();
  void read();
  return root;
}
