import { t } from './naming.js';

// Recovery reviews are data previews. Only the normal chat Send path may execute a new request.
export function createRecovery(ctx) {
  const { root, api } = ctx;
  let generation = 0;
  let deliveryGeneration = 0;
  let deliveryFilter = 'unresolved';
  let deliveryItems = [];
  let nextCursor = null;
  let deliveryRoot = null;
  const node = (tag, text = '', cls = '') => {
    const n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  };
  const note = node('p', '', 'muted recovery-status');
  note.setAttribute('role', 'status');
  const allowed = () => ctx.isOwner();
  const error = () => { note.textContent = t('Recovery unavailable. Refresh and try again; nothing was sent.'); };
  const button = (label, action) => {
    const b = node('button', label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (!allowed()) return;
      b.disabled = true;
      try { await action(b); } catch { error(); }
      finally { b.disabled = false; }
    });
    return b;
  };
  function dialog(title, opener) {
    const previous = opener ?? document.activeElement;
    let afterClose = null;
    const d = node('dialog', '', 'recovery-dialog');
    const head = node('h2', title);
    head.id = 'recovery-dialog-title';
    d.setAttribute('aria-labelledby', head.id);
    const status = node('p', '', 'recovery-status');
    status.setAttribute('role', 'status');
    const close = button(t('Close'), () => d.close());
    d.append(head, status);
    d.addEventListener('close', () => {
      d.remove();
      if (afterClose) afterClose();
      else {
        const restore = () => {
          if (!previous?.disabled && previous?.isConnected !== false && previous?.getClientRects?.().length !== 0) previous?.focus();
        };
        // A fast close may precede the launch handler's finally block; let it enable the opener.
        if (previous?.disabled) setTimeout(restore, 0);
        else restore();
      }
    });
    // Native modal dialogs handle Tab containment and Escape; closing restores the launch button.
    document.body.append(d);
    d.append(close);
    d.showModal();
    close.focus();
    return { d, status, finish: (action) => { afterClose = action; d.close(); } };
  }
  function preview(text, conversationId, attachments = [], warning = '', opener) {
    if (typeof text !== 'string' || (!text.trim() && !attachments.length)) throw new Error('unavailable');
    const { d, status, finish } = dialog(t('Review recovery'), opener);
    const capturedConversation = ctx.getConversation();
    const canUse = () => Boolean(text.trim()) && allowed() && !ctx.getDraft() && !ctx.hasPendingChat?.() && ctx.getConversation() === capturedConversation && (!conversationId || conversationId === capturedConversation);
    const pre = node('pre', text, 'recovery-preview');
    pre.setAttribute('tabindex', '0');
    pre.setAttribute('data-raw', '');
    d.append(node('p', t('Review carefully. This may repeat effects. Nothing is sent automatically.')));
    if (attachments.length) {
      d.append(node('p', t('Attachments are metadata only. Check and attach the files yourself before sending.')));
      const list = node('ul');
      for (const item of attachments) list.append(node('li', [item.name, item.mime, Number.isFinite(item.size) ? `${item.size}` : ''].filter(Boolean).join(' · ')));
      d.append(list);
    }
    if (warning) d.append(node('p', warning));
    d.append(pre);
    const copy = button(t('Copy'), async () => {
      try { await navigator.clipboard.writeText(text); status.textContent = t('Copied. Nothing was sent.'); }
      catch { status.textContent = t('Copy unavailable. Select the preview text to copy it.'); }
    });
    const use = button(t('Use in chat'), () => {
      if (!canUse()) { status.textContent = t('Keep your draft and conversation. Copy this preview instead.'); return; }
      finish(() => { if (canUse()) ctx.useDraft(text); else error(); });
    });
    use.disabled = !canUse();
    if (use.disabled) status.textContent = t('Keep your draft and conversation. Copy this preview instead.');
    copy.disabled = !text.trim();
    d.append(copy, use);
  }
  async function reviewJob(id, opener) {
    if (!allowed()) return;
    const launch = opener ?? document.activeElement;
    if (!root.children.length) root.append(note);
    try {
      const r = await api(`/jobs/${encodeURIComponent(id)}/recovery`, { method: 'POST', body: {} });
      if (!allowed()) return;
      const warnings = {
        "This restarts the whole command. Previous effects may already have happened. The timeout is the execution bound; this command has no token or dollar cap. Review before sending; current chat policies and approvals still apply.": t("This restarts the whole command. Previous effects may already have happened. The timeout is the execution bound; this command has no token or dollar cap. Review before sending; current chat policies and approvals still apply."),
        "This restarts the whole request. Previous effects may already have happened. Old usage remains on the original job; the new attempt has a separate bounded budget. Review before sending; current chat policies and approvals still apply.": t("This restarts the whole request. Previous effects may already have happened. Old usage remains on the original job; the new attempt has a separate bounded budget. Review before sending; current chat policies and approvals still apply."),
      };
      preview(r.draft, r.conversationId, [], warnings[r.warning] ?? '', launch);
    } catch {
      error();
      if (allowed()) { const { status } = dialog(t('Review recovery'), launch); status.textContent = note.textContent; }
    }
  }
  async function resumeTeam(id, opener) {
    const { d, status } = dialog(t('Resume interrupted team'), opener);
    d.append(node('p', t('The unfinished step may already have changed something. Check its receipts before resuming. Completed steps are kept.')));
    const label = node('label', '', 'recovery-ack');
    label.title = t('Check receipts first. Resuming can repeat an unfinished external effect.');
    const check = node('input');
    check.type = 'checkbox';
    label.append(check, node('span', t('I understand the unfinished step may repeat effects.')));
    const confirm = button(t('Resume after acknowledgment'), async () => {
      if (!check.checked) return;
      try { await api(`/team/${encodeURIComponent(id)}/resume`, { method: 'POST', body: { acknowledgeUnknown: true } }); d.close(); await refresh(); }
      catch { status.textContent = t('Resume unavailable. Refresh and review the current state.'); }
    });
    confirm.disabled = true;
    check.addEventListener('change', () => { confirm.disabled = !check.checked; });
    d.append(label, confirm);
  }
  const stateLabel = (state, held) => ({ queued: held === true ? t('Queued — held') : t('Queued — waiting; may still send'), attempted: t('Attempted — awaiting outcome'), acknowledged: t('Platform acknowledged — not proof of reading'), failed: t('Failed — platform rejected'), outcome_unknown: t('Outcome unknown — check before trying again') })[state] ?? t('Unknown state — held');
  const resolutionLabel = (decision) => ({confirmed_received:t('Human confirmed receipt'),confirmed_not_received:t('Human confirmed no receipt'),dismissed:t('Human dismissed review')})[decision] ?? '';
  function deliveryRow(item) {
    const row = node('article', '', 'recovery-card');
    row.append(node('h3', `${item.bridge ?? ''} · ${stateLabel(item.state, item.held)}`));
    if (item.createdAt) row.append(node('p', String(item.createdAt), 'muted small'));
    if (item.state === 'outcome_unknown' || item.state === 'attempted') row.append(node('p', t('It may have arrived. Check the destination before asking Sara to send again.')));
    if (item.state === 'queued' && item.held === true) row.append(node('p', t('Held after interruption. This page never resends queued work.')));
    const queuedWarning = item.state === 'queued' && item.held !== true ? t('This message is still in the live queue and may send. Check before creating another request.') : '';
    if (queuedWarning) row.append(node('p', queuedWarning));
    if (item.resolution) row.append(node('p', resolutionLabel(item.resolution)));
    if (!item.resolution && item.reviewAvailable !== false && ['queued', 'failed', 'outcome_unknown'].includes(item.state)) {
      row.append(button(t('Review message'), async (opener) => {
        const r = await api(`/deliveries/${encodeURIComponent(item.id)}/review`, {method:'POST',body:{}});
        if (!allowed()) return;
        const attachments = Array.isArray(r.attachments) ? r.attachments.filter(a => a && typeof a.name === 'string').slice(0, 20) : [];
        preview(r.text, null, attachments, queuedWarning, opener);
      }));
    }
    if (!item.resolution && (['failed', 'outcome_unknown'].includes(item.state) || (item.state === 'queued' && item.held === true))) {
      for (const [label, decision] of [[t('I confirmed receipt'),'confirmed_received'],[t('I confirmed no receipt'),'confirmed_not_received'],[t('Dismiss review'),'dismissed']]) row.append(button(label, async () => {
        await api(`/deliveries/${encodeURIComponent(item.id)}/resolve`, {method:'POST',body:{expectedState:item.state,decision}});
        deliveryItems = deliveryItems.map(d => d.id === item.id ? { ...d, resolution: decision, reviewAvailable: false } : d);
        if (deliveryFilter === 'unresolved') deliveryItems = deliveryItems.filter(d => d.id !== item.id);
        paintDeliveries();
        note.textContent = t('Review recorded. Platform acknowledgment is unchanged.');
      }));
      row.append(node('p', t('Your confirmation records human evidence; it does not change the platform acknowledgment.')));
    }
    return row;
  }
  const deliveryUrl = (cursor = null) => {
    if (deliveryFilter === 'unresolved' && !cursor) return '/deliveries';
    return `/deliveries?filter=${deliveryFilter}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  };
  function paintDeliveries() {
    if (!deliveryRoot) return;
    const filters = node('div', '', 'recovery-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', t('Delivery history filter'));
    for (const [value, label] of [['unresolved', t('Unresolved')], ['all', t('All history')]]) {
      const b = button(label, async () => {
        if (deliveryFilter === value) return;
        deliveryFilter = value;
        await loadDeliveryPage(true);
      });
      b.setAttribute('aria-pressed', String(deliveryFilter === value));
      filters.append(b);
    }
    deliveryRoot.replaceChildren(filters, ...deliveryItems.map(deliveryRow));
    if (!deliveryItems.length) deliveryRoot.append(node('p', t('No delivery records.')));
    if (nextCursor) deliveryRoot.append(button(t('Load more deliveries'), () => loadDeliveryPage(false)));
  }
  async function loadDeliveryPage(reset) {
    const request = ++deliveryGeneration;
    if (reset) { deliveryItems = []; nextCursor = null; paintDeliveries(); }
    note.textContent = t('Loading recovery…');
    try {
      const page = await api(deliveryUrl(reset ? null : nextCursor));
      if (request !== deliveryGeneration || !allowed()) return;
      deliveryItems = [...new Map([...deliveryItems, ...(page.deliveries ?? [])].map(d => [d.id, d])).values()];
      nextCursor = page.nextCursor ?? null;
      paintDeliveries();
      note.textContent = t('Review interrupted work. Nothing restarts or resends automatically.');
    } catch { if (request === deliveryGeneration) error(); }
  }
  async function refresh() {
    const request = ++generation;
    ++deliveryGeneration;
    nextCursor = null;
    deliveryItems = [];
    deliveryRoot = null;
    root.replaceChildren();
    if (!allowed()) return;
    root.append(note);
    note.textContent = t('Loading recovery…');
    try {
      const [jobs, teams, delivery] = await Promise.all([api('/jobs'), api('/team'), api(deliveryUrl())]);
      if (request !== generation || !allowed()) return;
      root.replaceChildren(note, button(t('Refresh recovery'), refresh), node('p', t('Only native Telegram and Discord message creation is tracked here. Plugins, commands and other external effects are not covered. There is no global exactly-once guarantee.')));
      note.textContent = t('Review interrupted work. Nothing restarts or resends automatically.');
      root.append(node('h2', t('Jobs')));
      const interrupted = jobs.filter(j => ['interrupted','budget'].includes(j.status));
      for (const job of interrupted) {
        const row = node('article', '', 'recovery-card');
        row.append(node('h3', `${t('Job')} #${job.id} · ${job.label ?? ''}`));
        if (job.recovery?.mode === 'restart-review') row.append(button(t('Review restart'), (opener) => reviewJob(job.id, opener)));
        else row.append(node('p', t('Restart review unavailable. Inspect the old result and start a fresh request if needed.')));
        root.append(row);
      }
      if (!interrupted.length) root.append(node('p', t('No interrupted jobs.')));
      root.append(node('h2', t('Teams')));
      const held = (teams.tasks ?? []).filter(t => t.status === 'interrupted');
      for (const team of held) { const row = node('article', '', 'recovery-card'); row.append(node('h3', String(team.goal ?? `#${team.id}`)), button(t('Resume team'), (opener) => resumeTeam(team.id, opener))); root.append(row); }
      if (!held.length) root.append(node('p', t('No interrupted teams.')));
      root.append(node('h2', t('Native message deliveries')));
      deliveryItems = delivery.deliveries ?? [];
      nextCursor = delivery.nextCursor ?? null;
      deliveryRoot = node('div');
      root.append(deliveryRoot);
      paintDeliveries();
    } catch { if (request === generation) error(); }
  }
  return { refresh, reviewJob };
}
