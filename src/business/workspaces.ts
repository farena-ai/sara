import { initializeAudit, appendAudit, readAudit, type AuditRecord } from './audit.ts';
import { installPages } from './pages-schema.ts';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BusinessProfile } from './profile.ts';
import type { BusinessControlStore } from './store.ts';
import { BusinessAccessError, validId } from './policy.ts';
import type { WorkspaceAction, WorkspaceContext } from './types.ts';

export interface WorkspaceConversation { id: string; title: string; createdAt: string }
export interface WorkspaceMessage { id: string; conversationId: string; actorId: string; role: 'user' | 'assistant'; body: string; createdAt: string }
export interface WorkspaceDocument { id: string; title: string; mime: 'text/plain' | 'text/markdown'; body: string; createdAt: string; actorId?: string }
export interface WorkspaceUpload { id: string; name: string; mime: 'text/plain' | 'text/markdown'; body: string; createdAt: string; actorId?: string }
export interface WorkspaceMemory { id: string; body: string; createdAt: string }
export interface WorkspaceCitation { id: string; documentId: string; excerpt: string }
export interface WorkspaceNotification { id: string; kind: 'document.changed' | 'conversation.changed'; resourceId: string; createdAt: string }
export interface WorkspaceSearchHit { kind: 'message' | 'document' | 'memory'; id: string; text: string }
export interface WorkspacePage { id: string; title: string; body: string; updatedAt: string }
export interface WorkspacePageComment { actorId: string; body: string }
export interface WorkspaceAudience { count: number; members: { name: string; role: string }[] }

/** Independent content schema: deliberately contains no owner settings, tools or personal imports. */
const SCHEMA = `
  CREATE TABLE content_scope (singleton INTEGER PRIMARY KEY CHECK(singleton=1), profile TEXT NOT NULL CHECK(profile='business'), workspace_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1));
  CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), actor_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')), body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX messages_conversation ON messages(conversation_id,created_at,id);
  CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, mime TEXT NOT NULL CHECK(mime IN ('text/plain','text/markdown')), body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE uploads (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL CHECK(mime IN ('text/plain','text/markdown')), body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE memories (id TEXT PRIMARY KEY, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE citations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), excerpt TEXT NOT NULL);
  CREATE TABLE notifications (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('document.changed','conversation.changed')), resource_id TEXT NOT NULL, created_at TEXT NOT NULL);
`;

function checkedPath(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || realpathSync(path) !== path) throw new BusinessAccessError(404);
}

/** Trusted operator/registry seam; never accepts a caller-supplied filesystem path. */
export function openWorkspaceDatabase(profile: BusinessProfile, workspaceId: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    validId(workspaceId);
    // Recheck every ancestor and SQLite sidecar before opening; requests never supply a path.
    checkedPath(profile.root, true); checkedPath(profile.businessDir, true);
    const root = join(profile.businessDir, 'workspaces');
    if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
    checkedPath(root, true);
    const dir = join(root, workspaceId);
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    checkedPath(dir, true);
    const path = join(dir, 'content.db');
    let fresh = false;
    if (!existsSync(path)) { closeSync(openSync(path, 'wx', 0o600)); fresh = true; }
    checkedPath(path, false);
    for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) checkedPath(path + suffix, false);
    db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
    if (fresh) {
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(SCHEMA); db.prepare("INSERT INTO content_scope(singleton,profile,workspace_id,schema_version) VALUES (1,'business',?,1)").run(workspaceId); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    const scope = db.prepare('SELECT singleton,profile,workspace_id,schema_version FROM content_scope').all();
    if (scope.length !== 1 || scope[0].singleton !== 1 || scope[0].profile !== 'business' || scope[0].workspace_id !== workspaceId || scope[0].schema_version !== 1) throw new BusinessAccessError(404);
    db.exec("CREATE TABLE IF NOT EXISTS content_authorship (kind TEXT NOT NULL CHECK(kind IN ('document','upload','conversation')),resource_id TEXT NOT NULL,actor_id TEXT NOT NULL,PRIMARY KEY(kind,resource_id));");
    initializeAudit(db);
    installPages(db);
    return db;
  } catch (error) { db?.close(); throw error; }
}

/** No content cache or retained DB handle: every operation opens exactly its registry UUID store. */
export class BusinessWorkspaces {
  readonly #profile: BusinessProfile;
  readonly #control: BusinessControlStore;
  #closed = false;
  constructor(profile: BusinessProfile, control: BusinessControlStore) { this.#profile = profile; this.#control = control; }

  #read<T>(context: WorkspaceContext, operation: (db: DatabaseSync) => T): T {
    this.revalidate(context);
    let db: DatabaseSync | undefined;
    try {
      db = openWorkspaceDatabase(this.#profile, context.workspaceId);
      this.revalidate(context);
      const value = operation(db);
      this.revalidate(context); return value;
    } catch (error) { if (error instanceof BusinessAccessError) throw error; throw new BusinessAccessError(404); }
    finally { db?.close(); }
  }

  revalidate(context: WorkspaceContext): void {
    if (this.#closed) throw new BusinessAccessError(404);
    this.#control.policy.revalidateWorkspace(context, 'read');
  }
  /** Internal, synchronous writer. Readers and HTTP input never receive this capability. */
  mutate<T>(context: WorkspaceContext, action: Extract<WorkspaceAction, 'send' | 'document'>, operation: (db: DatabaseSync) => T, guard: () => void = () => {}): T {
    this.#control.policy.revalidateWorkspace(context, action);
    return this.#read(context, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        this.#control.policy.revalidateWorkspace(context, action);
        const result = operation(db);
        if (result && typeof result === 'object' && 'then' in result) throw new BusinessAccessError(400);
        this.#control.policy.revalidateWorkspace(context, action);
        guard();
        appendAudit(db, { action: action === 'send' ? 'content.send' : 'content.document', actorId: context.principal.identityId, workspaceId: context.workspaceId, revision: context.policyRevision });
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  /** C16 team pages: one read (or write transaction with its audit row) under a revalidated role. */
  pages<T>(context: WorkspaceContext, action: 'read' | 'document' | 'manage', operation: (db: DatabaseSync) => T, audit?: Omit<AuditRecord, 'actorId' | 'workspaceId'>): T {
    this.#control.policy.revalidateWorkspace(context, action);
    return this.#read(context, db => {
      if (!audit) { const value = operation(db); this.#control.policy.revalidateWorkspace(context, action); return value; }
      db.exec('BEGIN IMMEDIATE');
      try {
        this.#control.policy.revalidateWorkspace(context, action);
        const result = operation(db);
        if (result && typeof result === 'object' && 'then' in result) throw new BusinessAccessError(400);
        this.#control.policy.revalidateWorkspace(context, action);
        appendAudit(db, { ...audit, actorId: context.principal.identityId, workspaceId: context.workspaceId });
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
  }
  openWorkspace(context: WorkspaceContext): WorkspaceReader {
    this.revalidate(context);
    const read = async <T>(operation: (db: DatabaseSync) => T): Promise<T> => {
      const result = await Promise.resolve(this.#read(context, operation));
      this.revalidate(context); return result;
    };
    const one = <T>(db: DatabaseSync, sql: string, id: string): T => { validId(id); const row = db.prepare(sql).get(id); if (!row) throw new BusinessAccessError(404); return { ...row } as T; };
    const all = <T>(db: DatabaseSync, sql: string, ...params: string[]): T[] => db.prepare(sql).all(...params).map(row => ({ ...row } as T));
    return Object.freeze({
      workspaceId: context.workspaceId,
      conversations: () => read(db => all<WorkspaceConversation>(db, 'SELECT id,title,created_at AS createdAt FROM conversations ORDER BY created_at DESC,id LIMIT 100')),
      conversation: (id: string) => read(db => one<WorkspaceConversation>(db, 'SELECT id,title,created_at AS createdAt FROM conversations WHERE id=?', id)),
      messages: (conversationId: string) => read(db => { one<WorkspaceConversation>(db, 'SELECT id FROM conversations WHERE id=?', conversationId); return all<WorkspaceMessage>(db, 'SELECT id,conversation_id AS conversationId,actor_id AS actorId,role,body,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at,id LIMIT 200', conversationId); }),
      recentMessages: (conversationId: string) => read(db => { one<WorkspaceConversation>(db, 'SELECT id FROM conversations WHERE id=?', conversationId); return all<WorkspaceMessage>(db, 'SELECT id,conversation_id AS conversationId,actor_id AS actorId,role,body,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 20', conversationId).reverse(); }),
      recentHistory: (conversationId: string) => read(db => { one<WorkspaceConversation>(db, 'SELECT id FROM conversations WHERE id=?', conversationId); return all<WorkspaceMessage>(db, 'SELECT id,conversation_id AS conversationId,actor_id AS actorId,role,body,created_at AS createdAt FROM messages WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 200', conversationId).reverse(); }),
      message: (id: string) => read(db => one<WorkspaceMessage>(db, 'SELECT id,conversation_id AS conversationId,actor_id AS actorId,role,body,created_at AS createdAt FROM messages WHERE id=?', id)),
      documents: () => read(db => all<Omit<WorkspaceDocument, 'body'>>(db, 'SELECT id,title,mime,created_at AS createdAt FROM documents ORDER BY created_at DESC,id LIMIT 100')),
      document: (id: string) => read(db => one<WorkspaceDocument>(db, "SELECT d.id,d.title,d.mime,d.body,d.created_at AS createdAt,a.actor_id AS actorId FROM documents d LEFT JOIN content_authorship a ON a.kind='document' AND a.resource_id=d.id WHERE d.id=?", id)),
      memories: () => read(db => all<WorkspaceMemory>(db, 'SELECT id,body,created_at AS createdAt FROM memories ORDER BY created_at DESC,id LIMIT 100')),
      citation: (id: string) => read(db => one<WorkspaceCitation>(db, 'SELECT id,document_id AS documentId,excerpt FROM citations WHERE id=?', id)),
      upload: (id: string) => read(db => one<WorkspaceUpload>(db, "SELECT u.id,u.name,u.mime,u.body,u.created_at AS createdAt,a.actor_id AS actorId FROM uploads u LEFT JOIN content_authorship a ON a.kind='upload' AND a.resource_id=u.id WHERE u.id=?", id)),
      page: (id: string) => read(db => one<WorkspacePage>(db, 'SELECT id,title,body,updated_at AS updatedAt FROM pages WHERE id=?', id)),
      openComments: (pageId: string) => read(db => { one<WorkspacePage>(db, 'SELECT id FROM pages WHERE id=?', pageId); return all<WorkspacePageComment>(db, 'SELECT author_id AS actorId,body FROM page_comments WHERE page_id=? AND resolved_at IS NULL ORDER BY created_at,id LIMIT 100', pageId); }),
      notifications: () => read(db => all<WorkspaceNotification>(db, 'SELECT id,kind,resource_id AS resourceId,created_at AS createdAt FROM notifications ORDER BY created_at DESC,id LIMIT 100')),
      search: (query: string) => {
        if (typeof query !== 'string' || !query.trim() || query.length > 256) return Promise.reject(new BusinessAccessError(400));
        return read(db => all<WorkspaceSearchHit>(db, `SELECT 'message' AS kind,id,substr(body,1,500) AS text FROM messages WHERE instr(lower(body),lower(?))>0 UNION ALL SELECT 'document',id,substr(body,1,500) FROM documents WHERE instr(lower(body),lower(?))>0 UNION ALL SELECT 'memory',id,substr(body,1,500) FROM memories WHERE instr(lower(body),lower(?))>0 LIMIT 50`, query, query, query));
      },
    });
  }
  audience(context: WorkspaceContext): WorkspaceAudience {
    this.revalidate(context);
    const members = this.#control.database.prepare(`SELECT i.name,m.role FROM workspace_members m JOIN business_identities i ON i.id=m.identity_id JOIN organization_members o ON o.identity_id=i.id WHERE m.workspace_id=? AND m.status='active' AND i.status='active' AND o.status='active' ORDER BY i.name,i.id`).all(context.workspaceId).map(row => ({ name: String(row.name), role: String(row.role) }));
    this.revalidate(context); return { count: members.length, members };
  }
  audit(context: WorkspaceContext) { this.#control.policy.revalidateWorkspace(context, 'audit'); return this.#read(context, db => readAudit(db, context.workspaceId)); }
  close(): void { this.#closed = true; }
}

export interface WorkspaceReader {
  readonly workspaceId: string;
  conversations(): Promise<WorkspaceConversation[]>;
  conversation(id: string): Promise<WorkspaceConversation>;
  messages(conversationId: string): Promise<WorkspaceMessage[]>;
  /** Latest20 in chronological createdAt/id order, independent of the oldest200 HTTP page. */
  recentMessages(conversationId: string): Promise<WorkspaceMessage[]>;
  recentHistory(conversationId: string): Promise<WorkspaceMessage[]>;
  message(id: string): Promise<WorkspaceMessage>;
  documents(): Promise<Omit<WorkspaceDocument, 'body'>[]>;
  document(id: string): Promise<WorkspaceDocument>;
  memories(): Promise<WorkspaceMemory[]>;
  citation(id: string): Promise<WorkspaceCitation>;
  upload(id: string): Promise<WorkspaceUpload>;
  notifications(): Promise<WorkspaceNotification[]>;
  page(id: string): Promise<WorkspacePage>;
  openComments(pageId: string): Promise<WorkspacePageComment[]>;
  search(query: string): Promise<WorkspaceSearchHit[]>;
}
