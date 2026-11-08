import { appendAudit, initializeAudit } from './audit.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BusinessAccessError, validId } from './policy.ts';

/** Integer nano-US dollars. Lifetime allowances never reset implicitly. */
export interface BusinessBudgetBounds {
  instanceAllowanceNanoUsd: number; workspaceAllowanceNanoUsd: number; maxConcurrent: number;
  maxInputTokens: number; maxOutputTokens: number; inputNanoUsdPerToken: number; outputNanoUsdPerToken: number;
  /** The configured model name, kept on the ledger row for the usage report (EC15). */
  modelName?: string;
}
export interface BusinessRequestKey { requestId: string; actorId: string; workspaceId: string; conversationId: string; payloadHash: string; policyHash: string }
export interface BusinessRequestRecord extends BusinessRequestKey {
  state: 'pending' | 'held' | 'completed' | 'blocked'; existing: boolean;
  answerId: string | null; outcome: string | null;
}
export class BusinessAdmissionError extends Error {
  readonly status = 409;
  constructor(message: string) { super(message); }
}
export function boundedInteger(value: unknown, maximum = 1_000_000_000_000_000, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new BusinessAdmissionError('Invalid model pricing or limits.');
  return value;
}
function cost(input: number, output: number, inputRate: number, outputRate: number): number {
  const result = BigInt(input) * BigInt(inputRate) + BigInt(output) * BigInt(outputRate);
  if (result > 1_000_000_000_000_000n) throw new BusinessAdmissionError('Invalid model pricing or limits.');
  return Number(result);
}

/** All reservations share the control DB write lock, across every workspace and connection. */
export class BusinessBudget {
  readonly #db: DatabaseSync;
  readonly #admission: () => void;
  constructor(db: DatabaseSync, admission: () => void = () => {}) {
    this.#admission = admission;
    this.#db = db;
    initializeAudit(db);
    db.exec(`CREATE TABLE IF NOT EXISTS business_operator_exposure(generation TEXT PRIMARY KEY,amount INTEGER NOT NULL CHECK(amount>=0),policy_hash TEXT NOT NULL);
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS business_model_requests (
        request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, policy_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','held','completed','blocked')),
        reserved INTEGER NOT NULL CHECK(reserved>=0), charged INTEGER, input_rate INTEGER NOT NULL, output_rate INTEGER NOT NULL,
        max_input INTEGER NOT NULL, max_output INTEGER NOT NULL, input_usage INTEGER, output_usage INTEGER,
        answer_id TEXT, outcome TEXT, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS business_one_pending_turn ON business_model_requests(workspace_id,conversation_id) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS business_model_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_spending_pauses (
        id TEXT PRIMARY KEY,reason TEXT NOT NULL CHECK(reason IN ('usage-uncertain','interrupted','recovery','legacy')),
        created_at INTEGER NOT NULL,accepted_at INTEGER,policy_hash TEXT,additional_exposure INTEGER CHECK(additional_exposure>=0)
      );
      CREATE TABLE IF NOT EXISTS business_disclosures (session_id TEXT NOT NULL,actor_id TEXT NOT NULL,acknowledged_at INTEGER NOT NULL,PRIMARY KEY(session_id,actor_id));`);
    // EC15: the model each request used (older rows have none and report as unknown).
    if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get('business_model_requests', 'model')) db.exec('ALTER TABLE business_model_requests ADD COLUMN model TEXT');
    db.exec(`CREATE TRIGGER IF NOT EXISTS audit_model_reserve AFTER INSERT ON business_model_requests BEGIN INSERT INTO business_audit(at,action,actor_id,workspace_id,subject_id) VALUES (unixepoch()*1000,'model.reserve',NEW.actor_id,NEW.workspace_id,NEW.request_id); END;
      CREATE TRIGGER IF NOT EXISTS audit_model_state AFTER UPDATE ON business_model_requests BEGIN INSERT INTO business_audit(at,action,actor_id,workspace_id,subject_id) VALUES (unixepoch()*1000,'model.state',NEW.actor_id,NEW.workspace_id,NEW.request_id); END;`);
    // Upgrade existing paused ledgers conservatively; do not alter request costs or clear a pause.
    this.#transaction(() => {
      const paused = db.prepare("SELECT value FROM business_model_state WHERE key='paused'").get();
      const current = db.prepare("SELECT p.id FROM business_spending_pauses p JOIN business_model_state s ON s.key='pause_id' AND s.value=p.id WHERE p.accepted_at IS NULL").get();
      if (paused && !current) this.#newPause(['usage-uncertain', 'interrupted', 'recovery'].includes(String(paused.value)) ? String(paused.value) : 'legacy', false);
    });
  }
  #transaction<T>(operation: () => T): T {
    this.#admission();
    this.#db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.#db.exec('COMMIT'); return result; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #key(key: BusinessRequestKey): void {
    for (const value of [key.requestId, key.actorId, key.workspaceId, key.conversationId]) validId(value);
    if (!/^[a-f0-9]{64}$/.test(key.payloadHash) || !/^[a-f0-9]{64}$/.test(key.policyHash)) throw new BusinessAccessError(400);
  }
  lookup(key: BusinessRequestKey): BusinessRequestRecord | undefined {
    this.#key(key);
    const row = this.#db.prepare(`SELECT request_id AS requestId,actor_id AS actorId,workspace_id AS workspaceId,conversation_id AS conversationId,
      payload_hash AS payloadHash,policy_hash AS policyHash,state,answer_id AS answerId,outcome FROM business_model_requests WHERE request_id=?`).get(key.requestId);
    if (!row) return undefined;
    if (row.actorId !== key.actorId || row.workspaceId !== key.workspaceId || row.conversationId !== key.conversationId) throw new BusinessAccessError(404);
    if (row.payloadHash !== key.payloadHash) throw new BusinessAdmissionError('Request ID is already bound to different content.');
    return { ...row, existing: true } as unknown as BusinessRequestRecord;
  }
  reserve(key: BusinessRequestKey, limits: BusinessBudgetBounds, guard: () => void = () => {}): BusinessRequestRecord {
    this.#key(key);
    return this.#transaction(() => {
      guard();
      const existing = this.lookup(key); if (existing) return existing;
      for (const field of ['instanceAllowanceNanoUsd', 'workspaceAllowanceNanoUsd', 'inputNanoUsdPerToken', 'outputNanoUsdPerToken'] as const) boundedInteger(limits[field]);
      boundedInteger(limits.maxConcurrent, 16, 1); boundedInteger(limits.maxInputTokens, 131072, 1); boundedInteger(limits.maxOutputTokens, 32768, 1);
      const reserved = cost(limits.maxInputTokens, limits.maxOutputTokens, limits.inputNanoUsdPerToken, limits.outputNanoUsdPerToken);
      if (this.#db.prepare("SELECT value FROM business_model_state WHERE key='paused'").get()) throw new BusinessAdmissionError('Model spending is paused for operator reconciliation.');
      const exposure = this.exposure(key.workspaceId);
      if (exposure.instanceNanoUsd + reserved > limits.instanceAllowanceNanoUsd || exposure.workspaceNanoUsd + reserved > limits.workspaceAllowanceNanoUsd) throw new BusinessAdmissionError('Budget allowance exhausted.');
      const active = Number(this.#db.prepare("SELECT count(*) AS n FROM business_model_requests WHERE state='pending'").get()!.n);
      if (active >= limits.maxConcurrent || this.#db.prepare("SELECT request_id FROM business_model_requests WHERE workspace_id=? AND conversation_id=? AND state='pending'").get(key.workspaceId, key.conversationId)) throw new BusinessAdmissionError('Another model request is in progress.');
      const model = typeof limits.modelName === 'string' && /^[\w.\-/:]{1,150}$/.test(limits.modelName) ? limits.modelName : null;
      this.#db.prepare(`INSERT INTO business_model_requests(request_id,actor_id,workspace_id,conversation_id,payload_hash,policy_hash,state,reserved,input_rate,output_rate,max_input,max_output,created_at,model)
        VALUES (?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`).run(key.requestId, key.actorId, key.workspaceId, key.conversationId, key.payloadHash, key.policyHash, reserved, limits.inputNanoUsdPerToken, limits.outputNanoUsdPerToken, limits.maxInputTokens, limits.maxOutputTokens, Date.now(), model);
      guard();
      return { ...this.lookup(key)!, existing: false };
    });
  }
  recordNoCall(key: BusinessRequestKey, outcome: 'minor' | 'crisis' | 'adult'): BusinessRequestRecord {
    this.#key(key);
    return this.#transaction(() => {
      const existing = this.lookup(key); if (existing) return existing;
      this.#db.prepare(`INSERT INTO business_model_requests(request_id,actor_id,workspace_id,conversation_id,payload_hash,policy_hash,state,reserved,charged,input_rate,output_rate,max_input,max_output,outcome,created_at)
        VALUES (?,?,?,?,?,?,'blocked',0,0,0,0,0,0,?,?)`).run(key.requestId, key.actorId, key.workspaceId, key.conversationId, key.payloadHash, key.policyHash, outcome, Date.now());
      return { ...this.lookup(key)!, existing: false };
    });
  }
  exposure(workspaceId = ''): { instanceNanoUsd: number; workspaceNanoUsd: number } {
    const rows = this.#db.prepare('SELECT workspace_id,reserved,charged FROM business_model_requests').all();
    const carried = this.#db.prepare('SELECT amount FROM business_operator_exposure').all().reduce((sum, row) => sum + BigInt(boundedInteger(row.amount)), 0n);
    let total = carried; let workspace = carried;
    for (const row of rows) {
      const value = BigInt(boundedInteger(row.charged ?? row.reserved)); total += value;
      if (row.workspace_id === workspaceId) workspace += value;
    }
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new BusinessAdmissionError('Budget ledger requires operator reconciliation.');
    return { instanceNanoUsd: Number(total), workspaceNanoUsd: Number(workspace) };
  }
  settle(requestId: string, usage?: { input: number; output: number; cached?: number }): void {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT * FROM business_model_requests WHERE request_id=?').get(requestId);
      if (!row || row.state !== 'pending' || row.charged !== null) return;
      try {
        if (!usage) throw new Error('Unknown usage');
        boundedInteger(usage.input, Number(row.max_input)); boundedInteger(usage.output, Number(row.max_output));
        if (usage.cached !== undefined) boundedInteger(usage.cached, usage.input);
        const charged = cost(usage.input, usage.output, Number(row.input_rate), Number(row.output_rate));
        this.#db.prepare('UPDATE business_model_requests SET charged=?,input_usage=?,output_usage=? WHERE request_id=?').run(charged, usage.input, usage.output, requestId);
      } catch { this.#hold(requestId, true); }
    });
  }
  #hold(requestId: string, pause: boolean): void {
    const changed = this.#db.prepare("UPDATE business_model_requests SET state='held',outcome='uncertain' WHERE request_id=? AND state='pending'").run(requestId);
    if (pause && changed.changes) this.#newPause('usage-uncertain');
  }
  #newPause(reason: string, updateReason = true): void {
    const id = randomUUID();
    this.#db.prepare('INSERT INTO business_spending_pauses(id,reason,created_at) VALUES (?,?,?)').run(id, reason, Date.now());
    this.#db.prepare("INSERT OR REPLACE INTO business_model_state(key,value) VALUES ('pause_id',?)").run(id);
    if (updateReason) this.#db.prepare("INSERT OR REPLACE INTO business_model_state(key,value) VALUES ('paused',?)").run(reason);
    appendAudit(this.#db, { action: 'model.state', subjectId: id });
  }
  pauseStatus() {
    if (!this.#db.prepare("SELECT value FROM business_model_state WHERE key='paused'").get()) return null;
    const pause = this.#db.prepare("SELECT p.id,p.reason,p.created_at FROM business_spending_pauses p JOIN business_model_state s ON s.key='pause_id' AND s.value=p.id WHERE p.accepted_at IS NULL").get();
    if (!pause) throw new BusinessAdmissionError('Pause requires operator reconciliation.');
    const rows = this.#db.prepare('SELECT state,reserved,charged FROM business_model_requests').all();
    let known = 0n; let unknown = 0n; let held = 0; let unknownRequests = 0;
    for (const row of rows) {
      if (row.charged !== null) known += BigInt(boundedInteger(row.charged));
      if (row.state === 'held') { held++; if (row.charged === null) { unknownRequests++; unknown += BigInt(boundedInteger(row.reserved)); } }
    }
    if (known > BigInt(Number.MAX_SAFE_INTEGER) || unknown > BigInt(Number.MAX_SAFE_INTEGER)) throw new BusinessAdmissionError('Budget ledger requires operator reconciliation.');
    return { pauseId: String(pause.id), reason: String(pause.reason), createdAt: Number(pause.created_at), heldRequests: held, unknownRequests,
      knownChargesNanoUsd: Number(known), unknownReservedNanoUsd: Number(unknown), exposureNanoUsd: this.exposure().instanceNanoUsd };
  }
  hold(requestId: string): void { this.#transaction(() => this.#hold(requestId, true)); }
  finish(requestId: string, answerId: string, outcome: 'answer' | 'minor' | 'crisis' | 'adult'): void {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT state,charged FROM business_model_requests WHERE request_id=?').get(requestId);
      if (!row || row.state !== 'pending' || row.charged === null) throw new BusinessAdmissionError('Request held for operator reconciliation.');
      this.#db.prepare('UPDATE business_model_requests SET state=?,answer_id=?,outcome=? WHERE request_id=?').run(outcome === 'answer' ? 'completed' : 'blocked', answerId, outcome, requestId);
    });
  }
  interruptPending(): void {
    this.#transaction(() => {
      if (this.#db.prepare("SELECT request_id FROM business_model_requests WHERE state='pending' LIMIT 1").get()) {
        this.#db.exec("UPDATE business_model_requests SET state='held',outcome='interrupted' WHERE state='pending';");
        this.#newPause('interrupted');
      }
    });
  }
  lastDisclosure(sessionId: string, actorId: string): Date | undefined {
    const row = this.#db.prepare('SELECT acknowledged_at FROM business_disclosures WHERE session_id=? AND actor_id=?').get(sessionId, actorId);
    return row ? new Date(Number(row.acknowledged_at)) : undefined;
  }
  acknowledgeDisclosure(sessionId: string, actorId: string): void {
    this.#admission();
    this.#db.prepare('INSERT OR REPLACE INTO business_disclosures(session_id,actor_id,acknowledged_at) VALUES (?,?,?)').run(sessionId, actorId, Date.now());
  }
}
