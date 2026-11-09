const lifetimes = new WeakMap();

/** Session-only scoped mutations; stale callbacks cannot overwrite another draft or revive logout. */
export class BusinessDrafts {
  constructor(storage, actor, session) {
    this.storage = storage; this.key = `business-drafts:${actor}:${session}`;
    if (!lifetimes.has(storage)) lifetimes.set(storage, new Map());
    this.lifetimes = lifetimes.get(storage);
    this.generation = this.lifetimes.get(this.key) || 0;
    this.firstAttempts = new Map();
  }
  get active() { return this.generation === (this.lifetimes.get(this.key) || 0); }
  scope(workspace, conversation) { return `${workspace}/${conversation}`; }
  snapshot() {
    if (!this.active) return {};
    try { return JSON.parse(this.storage.getItem(this.key) || '{}'); } catch { return {}; }
  }
  mutate(workspace, conversation, change, requestId) {
    if (!this.active) return;
    const data = this.snapshot(); const key = this.scope(workspace, conversation);
    if (requestId && data[key]?.pending?.requestId !== requestId) return;
    const record = change(data[key] || {});
    if (record) data[key] = record; else delete data[key];
    this.storage.setItem(this.key, JSON.stringify(data));
  }
  read(workspace, conversation) { return this.snapshot()[this.scope(workspace, conversation)]?.draft || { text: '', documentIds: [] }; }
  save(workspace, conversation, draft) { this.mutate(workspace, conversation, record => ({ ...record, draft })); }
  pending(workspace, conversation) { return this.snapshot()[this.scope(workspace, conversation)]?.pending; }
  ready(workspace, conversation) { return this.snapshot()[this.scope(workspace, conversation)]?.notAdmitted === true; }
  markReady(workspace, conversation, value, requestId) { this.mutate(workspace, conversation, record => ({ ...record, notAdmitted: value }), requestId); }
  begin(workspace, conversation, input) {
    this.mutate(workspace, conversation, record => {
      if (record.pending) return record;
      const requestId = crypto.randomUUID(); this.firstAttempts.set(requestId, null);
      return { ...record, pending: { ...input, requestId }, uncertain: true, notAdmitted: false };
    });
    return structuredClone(this.pending(workspace, conversation));
  }
  dispatch(workspace, conversation, requestId) {
    const attempt = crypto.randomUUID(); const first = this.firstAttempts.has(requestId) && this.firstAttempts.get(requestId) === null;
    if (first) this.firstAttempts.set(requestId, attempt); else this.firstAttempts.delete(requestId);
    // Persist before HTTP I/O. Recovered records never inherit this realm's first-attempt proof.
    this.mutate(workspace, conversation, record => ({ ...record, uncertain: true, attempt }), requestId);
    return first ? attempt : undefined;
  }
  uncertain(workspace, conversation, requestId) { this.firstAttempts.delete(requestId); this.mutate(workspace, conversation, record => ({ ...record, uncertain: true }), requestId); }
  finish(workspace, conversation, requestId) { this.firstAttempts.delete(requestId); this.mutate(workspace, conversation, () => undefined, requestId); }
  unsubmitted(workspace, conversation, requestId, attempt) {
    if (!attempt || this.firstAttempts.get(requestId) !== attempt) return;
    this.mutate(workspace, conversation, record => {
      if (record.attempt !== attempt) return record;
      delete record.pending; delete record.notAdmitted; delete record.attempt; return record;
    }, requestId);
    this.firstAttempts.delete(requestId);
  }
  clear() {
    if (!this.active) return;
    this.firstAttempts.clear(); this.lifetimes.set(this.key, this.generation + 1); this.storage.removeItem(this.key);
  }
}
