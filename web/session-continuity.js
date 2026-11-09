import { t } from './naming.js';

const $ = selector => document.querySelector(selector);
let ctx;

export function initSessionContinuity(context) { ctx = context; }

export async function loadSessionContinuitySettings() {
  const box = $('#continuity-settings');
  if (!ctx || !box) return;
  box.hidden = true;
  try {
    const value = await ctx.api('/chats/continuity');
    $('#continuity-enabled').checked = value.enabled;
    // mnt2: the admin's policy can lower the most replies at the same time.
    const parallel = $('#continuity-parallel');
    if (parallel) { parallel.max = String(value.parallelMax ?? 8); parallel.value = String(value.parallel ?? 4); }
    box.dataset.loaded = '1'; box.hidden = false;
    settingsStatus(value.enabled);
  } catch { /* Owner controls are unavailable in other audiences. */ }
}
function settingsStatus(enabled) {
  $('#continuity-status').textContent = enabled ? t('Session continuity is on.') : t('Session continuity is off. Saved notes stay available to inspect or clear.');
}
export async function saveSessionContinuitySettings() {
  if (!ctx || !$('#continuity-settings')?.dataset.loaded) return;
  try {
    const value = await ctx.api('/chats/continuity', { method: 'PUT', body: { enabled: $('#continuity-enabled').checked, ...parallelChoice() } });
    settingsStatus(value.enabled);
  } catch (error) {
    $('#continuity-status').textContent = t('Could not save session continuity. Your choice is kept; try again.');
    throw error;
  }
}

function parallelChoice() {
  const n = Number($('#continuity-parallel')?.value);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? { parallel: n } : {};
}

/** Each view closes over one target; a late request cannot install another target's clear action. */
export function loadConversationContinuity(conversation) {
  const host = $('#cs-continuity');
  if (!host || !ctx) return;
  host.replaceChildren(); host.hidden = true;
  if (document.body.classList.contains('demo') || document.body.classList.contains('member') || conversation.private || conversation.offRecord || conversation.partner || conversation.archivedAt || conversation.endedAt || !['chat', 'coding'].includes(conversation.mode) || !/^(web|telegram(?:-nsfw)?|discord(?:-nsfw)?|plugin-[a-z0-9-]+)$/.test(conversation.channel)) return;
  host.append(renderSessionContinuity({ api: ctx.api, id: conversation.id })); host.hidden = false;
}

export function renderSessionContinuity({ api, id }) {
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, cls = 'ghost small') => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node; };
  const box = el('section', 'tidy-stack session-continuity');
  const heading = el('h3', '', t('Saved session context'));
  const lead = el('p', 'muted small', t('These notes help your companion carry context into later replies. They do not send messages, mark them as read, or confirm completed work.'));
  const status = el('p', 'muted small'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const content = el('div', 'continuity-records'); const actions = el('div', 'actions-left'); const confirmation = el('div', 'tidy-card tidy-stack'); confirmation.hidden = true;
  let currentId = 0; let loaded = false; let pending = false; let conflict = false;
  const path = `/conversations/${encodeURIComponent(id)}/continuity`;
  const show = button(t('Show saved session context'), () => void reload());
  const refresh = button(t('Reload saved context'), () => void reload()); refresh.hidden = true;
  const clear = button(t('Clear saved context'), () => ask(), 'ghost small danger-text'); clear.hidden = true;
  const sync = () => { show.disabled = pending; refresh.disabled = pending; clear.disabled = pending || conflict || !loaded; };
  const cancel = () => { confirmation.hidden = true; confirmation.replaceChildren(); if (box.isConnected) clear.focus(); };
  async function reload() {
    if (pending) return; pending = true; sync();
    try {
      const result = await api(path);
      const sources = new Set();
      const cards = result.handoffs.map(record => {
        const card = el('article', 'tidy-card tidy-stack');
        const historical = sources.has(record.sourceConversationId);
        sources.add(record.sourceConversationId);
        card.append(el('p', 'muted small', historical ? t('Earlier note (history only)') : t('Latest note from this source')));
        const facts = el('dl', 'continuity-facts');
        const fact = (label, value) => facts.append(el('dt', 'muted small', label), el('dd', '', value));
        fact(t('Source session'), record.sourceTitle || t('Untitled'));
        fact(t('Saved at'), new Date(record.createdAt).toLocaleString());
        fact(t('Eligible until'), new Date(record.expiresAt).toLocaleString());
        const note = el('p', 'continuity-note', record.text); note.dataset.raw = '';
        // All stored labels and notes are data, including strings that look like HTML.
        for (const value of facts.querySelectorAll('dd')) value.dataset.raw = '';
        card.append(facts, note); return card;
      });
      content.replaceChildren(...(cards.length ? cards : [el('p', 'muted small', t('No context is available for later replies. You can still clear saved notes, including expired ones.'))]));
      currentId = result.currentId; loaded = true; conflict = false;
      show.hidden = true; refresh.hidden = false; clear.hidden = false;
      confirmation.hidden = true; confirmation.replaceChildren(); status.textContent = t('Saved session context loaded.');
    } catch {
      status.textContent = loaded ? t('Could not reload saved context. Your previous view is kept.') : t('Saved context is unavailable for this session.');
    } finally { pending = false; sync(); }
  }
  function ask() {
    if (!loaded || pending || conflict) return;
    const expectedId = currentId;
    const question = el('p', 'small', t('Clear the saved context for this session? Original chats, old run records, exports and backups stay.'));
    const row = el('div', 'actions-left');
    const yes = button(t('Confirm clear'), async () => {
      if (pending) return; pending = true; yes.disabled = true; no.disabled = true; sync();
      let focusTarget;
      try {
        await api(path, { method: 'DELETE', body: { expectedId } });
        currentId = 0; content.replaceChildren(el('p', 'muted small', t('No context is available for later replies. You can still clear saved notes, including expired ones.'))); clear.hidden = false;
        confirmation.hidden = true; confirmation.replaceChildren(); status.textContent = t('Saved context cleared for this session.'); focusTarget = refresh;
      } catch (error) {
        conflict = error.status === 409;
        status.textContent = conflict ? t('Saved context changed elsewhere. Your view is kept. Reload before clearing.') : t('Could not clear saved context. Your view is kept; try again.');
        confirmation.hidden = true; confirmation.replaceChildren(); focusTarget = conflict ? refresh : clear;
      } finally {
        pending = false; sync();
        if (focusTarget?.isConnected && !focusTarget.disabled) focusTarget.focus();
      }
    }, 'small danger');
    const no = button(t('Cancel'), cancel);
    row.append(yes, no); confirmation.replaceChildren(question, row); confirmation.hidden = false; yes.focus();
  }
  box.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !confirmation.hidden) { event.preventDefault(); event.stopPropagation(); if (!pending) cancel(); }
  });
  actions.append(show, refresh, clear); box.append(heading, lead, content, actions, confirmation, status);
  return box;
}
