// C16 (docs/ops/C16_DESIGN.md): team pages in a business workspace. Markdown pages with every saved
// version kept (append-only), threaded comments with @mentions of workspace members, resolve, and a
// workspace legal hold that blocks deletes. Roles: viewers read and comment, contributors create and
// edit, managers delete; organization administrators set the hold and run per-person export/delete.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { appendAudit } from './audit.ts';
import { businessText } from './documents.ts';
import { contentHeld } from './pages-schema.ts';
import { BusinessAccessError, exactFields, validId } from './policy.ts';
import type { BusinessProfile } from './profile.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessPrincipal, WorkspaceContext } from './types.ts';
import { openWorkspaceDatabase, type BusinessWorkspaces } from './workspaces.ts';
import { en } from '../i18n.ts';

export const HOLD_MESSAGE = en('This workspace is under a legal hold. An organization administrator must release it first.');
const held = () => new BusinessAccessError(409, HOLD_MESSAGE);
export const PAGE_BYTES = 65_000;
export const COMMENT_BYTES = 4096;
export interface PageSummary { id: string; title: string; authorId: string | null; author: string | null; updatedAt: string; updatedBy: string | null; revision: number; openComments: number }
export interface Page extends PageSummary { body: string; createdAt: string }
export interface PageVersion { revision: number; title: string; body: string; editorId: string | null; editor: string | null; editedAt: string }
export interface PageComment { id: string; parentId: string | null; authorId: string; author: string | null; body: string; createdAt: string; resolvedAt: string | null; resolvedBy: string | null }
export interface PageMention { id: string; pageId: string; pageTitle: string; commentId: string; by: string | null; createdAt: string; read: boolean }

const now = () => new Date().toISOString();
const rows = <T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] => db.prepare(sql).all(...params).map(row => ({ ...row }) as T);

export class BusinessPages {
  readonly #profile: BusinessProfile;
  readonly #control: BusinessControlStore;
  readonly #workspaces: BusinessWorkspaces;
  constructor(deps: { profile: BusinessProfile; control: BusinessControlStore; workspaces: BusinessWorkspaces }) {
    this.#profile = deps.profile; this.#control = deps.control; this.#workspaces = deps.workspaces;
  }
  #name(id: string | null): string | null { return id ? this.#control.identities.get(id)?.name ?? null : null; }
  #page(db: DatabaseSync, id: string): Page {
    validId(id);
    const row = db.prepare(`SELECT id,title,body,author_id AS authorId,created_at AS createdAt,updated_at AS updatedAt,updated_by AS updatedBy,revision,
      (SELECT count(*) FROM page_comments c WHERE c.page_id=pages.id AND c.resolved_at IS NULL) AS openComments FROM pages WHERE id=?`).get(id);
    if (!row) throw new BusinessAccessError(404);
    const page = { ...row } as unknown as Page;
    return { ...page, author: this.#name(page.authorId) };
  }
  #input(input: unknown, fields: string[]): { title: string; body: string } {
    exactFields(input, fields);
    return { title: businessText(input.title, 200).trim(), body: businessText(input.body, PAGE_BYTES, true) };
  }

  list(context: WorkspaceContext, query = ''): PageSummary[] {
    if (typeof query !== 'string' || query.length > 256) throw new BusinessAccessError(400);
    const q = query.trim();
    return this.#workspaces.pages(context, 'read', db => rows<PageSummary>(db, `SELECT id,title,author_id AS authorId,updated_at AS updatedAt,updated_by AS updatedBy,revision,
      (SELECT count(*) FROM page_comments c WHERE c.page_id=pages.id AND c.resolved_at IS NULL) AS openComments FROM pages
      WHERE ?='' OR instr(lower(title),lower(?))>0 OR instr(lower(body),lower(?))>0 ORDER BY updated_at DESC,id LIMIT 200`, q, q, q))
      .map(page => ({ ...page, author: this.#name(page.authorId) }));
  }
  get(context: WorkspaceContext, id: string): Page { return this.#workspaces.pages(context, 'read', db => this.#page(db, id)); }
  history(context: WorkspaceContext, id: string): PageVersion[] {
    return this.#workspaces.pages(context, 'read', db => {
      this.#page(db, id);
      return rows<PageVersion>(db, 'SELECT revision,title,body,editor_id AS editorId,edited_at AS editedAt FROM page_versions WHERE page_id=? ORDER BY revision DESC LIMIT 200', id);
    }).map(version => ({ ...version, editor: this.#name(version.editorId) }));
  }
  create(context: WorkspaceContext, input: unknown): Page {
    const { title, body } = this.#input(input, ['title', 'body']);
    const id = randomUUID(); const at = now(); const actor = context.principal.identityId;
    return this.#workspaces.pages(context, 'document', db => {
      db.prepare('INSERT INTO pages(id,title,body,author_id,created_at,updated_at,updated_by,revision) VALUES (?,?,?,?,?,?,?,1)').run(id, title, body, actor, at, at, actor);
      db.prepare('INSERT INTO page_versions(page_id,revision,title,body,editor_id,edited_at) VALUES (?,1,?,?,?,?)').run(id, title, body, actor, at);
      return this.#page(db, id);
    }, { action: 'page.create', subjectId: id, revision: 1 });
  }
  /** Optimistic: the edit names the revision it started from; a newer save is a 409, never overwritten. */
  edit(context: WorkspaceContext, id: string, input: unknown): Page {
    validId(id);
    exactFields(input, ['title', 'body', 'revision']);
    const from = input.revision;
    if (!Number.isSafeInteger(from) || (from as number) < 1) throw new BusinessAccessError(400);
    const { title, body } = this.#input({ title: input.title, body: input.body }, ['title', 'body']);
    const revision = (from as number) + 1; const at = now(); const actor = context.principal.identityId;
    return this.#workspaces.pages(context, 'document', db => {
      const current = this.#page(db, id);
      if (current.revision !== from) throw new BusinessAccessError(409, en('This page changed since you opened it. Reload it, then make your change again.'));
      db.prepare('UPDATE pages SET title=?,body=?,updated_at=?,updated_by=?,revision=? WHERE id=?').run(title, body, at, actor, revision, id);
      db.prepare('INSERT INTO page_versions(page_id,revision,title,body,editor_id,edited_at) VALUES (?,?,?,?,?,?)').run(id, revision, title, body, actor, at);
      return this.#page(db, id);
    }, { action: 'page.edit', subjectId: id, revision });
  }
  delete(context: WorkspaceContext, id: string): void {
    validId(id);
    this.#workspaces.pages(context, 'manage', db => {
      this.#page(db, id);
      if (contentHeld(db)) throw held();
      for (const table of ['page_mentions', 'page_comments', 'page_versions']) db.prepare(`DELETE FROM ${table} WHERE page_id=?`).run(id);
      db.prepare('DELETE FROM pages WHERE id=?').run(id);
    }, { action: 'page.delete', subjectId: id });
  }

  comments(context: WorkspaceContext, pageId: string): PageComment[] {
    return this.#workspaces.pages(context, 'read', db => {
      this.#page(db, pageId);
      return rows<PageComment>(db, 'SELECT id,parent_id AS parentId,author_id AS authorId,body,created_at AS createdAt,resolved_at AS resolvedAt,resolved_by AS resolvedBy FROM page_comments WHERE page_id=? ORDER BY created_at,id LIMIT 500', pageId);
    }).map(comment => ({ ...comment, author: this.#name(comment.authorId) }));
  }
  /** Any member may comment (viewers included). `@Name` of an active workspace member notifies that member. */
  comment(context: WorkspaceContext, pageId: string, input: unknown): PageComment {
    validId(pageId); exactFields(input, ['body', 'parentId']);
    const body = businessText(input.body, COMMENT_BYTES).trim();
    const parentId = input.parentId === undefined || input.parentId === null ? null : input.parentId;
    if (parentId !== null) validId(parentId);
    const actor = context.principal.identityId; const id = randomUUID(); const at = now();
    const lower = body.toLowerCase();
    const mentioned = this.#members(context.workspaceId).filter(member => member.id !== actor && mentions(lower, member.name.toLowerCase()));
    const comment = this.#workspaces.pages(context, 'read', db => {
      this.#page(db, pageId);
      if (parentId && !db.prepare('SELECT 1 FROM page_comments WHERE id=? AND page_id=?').get(parentId, pageId)) throw new BusinessAccessError(404);
      db.prepare('INSERT INTO page_comments(id,page_id,parent_id,author_id,body,created_at) VALUES (?,?,?,?,?,?)').run(id, pageId, parentId, actor, body, at);
      for (const member of mentioned) db.prepare('INSERT INTO page_mentions(id,identity_id,page_id,comment_id,by_id,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), member.id, pageId, id, actor, at);
      return { id, parentId, authorId: actor, author: this.#name(actor), body, createdAt: at, resolvedAt: null, resolvedBy: null };
    }, { action: 'page.comment', subjectId: pageId });
    return comment;
  }
  /** A comment's author may resolve it; contributors and managers may resolve any. */
  resolve(context: WorkspaceContext, pageId: string, commentId: string, input: unknown): void {
    validId(pageId); validId(commentId); exactFields(input, ['resolved']);
    if (typeof input.resolved !== 'boolean') throw new BusinessAccessError(400);
    const resolved = input.resolved; const actor = context.principal.identityId;
    this.#workspaces.pages(context, 'read', db => {
      const row = db.prepare('SELECT author_id FROM page_comments WHERE id=? AND page_id=?').get(commentId, pageId);
      if (!row || (context.role === 'viewer' && row.author_id !== actor)) throw new BusinessAccessError(404);
      db.prepare('UPDATE page_comments SET resolved_at=?,resolved_by=? WHERE id=?').run(resolved ? now() : null, resolved ? actor : null, commentId);
    }, { action: 'page.resolve', subjectId: pageId, revision: resolved ? 1 : 0 });
  }
  mentions(context: WorkspaceContext): PageMention[] {
    return this.#workspaces.pages(context, 'read', db => rows<{ id: string; pageId: string; pageTitle: string; commentId: string; byId: string; createdAt: string; readAt: string | null }>(db,
      'SELECT m.id,m.page_id AS pageId,p.title AS pageTitle,m.comment_id AS commentId,m.by_id AS byId,m.created_at AS createdAt,m.read_at AS readAt FROM page_mentions m JOIN pages p ON p.id=m.page_id WHERE m.identity_id=? ORDER BY m.created_at DESC LIMIT 100', context.principal.identityId))
      .map(m => ({ id: m.id, pageId: m.pageId, pageTitle: m.pageTitle, commentId: m.commentId, by: this.#name(m.byId), createdAt: m.createdAt, read: m.readAt !== null }));
  }
  markMentionsRead(context: WorkspaceContext): void {
    this.#workspaces.pages(context, 'read', db => { db.prepare('UPDATE page_mentions SET read_at=? WHERE identity_id=? AND read_at IS NULL').run(now(), context.principal.identityId); });
  }
  #members(workspaceId: string): { id: string; name: string }[] {
    return this.#control.database.prepare(`SELECT i.id,i.name FROM workspace_members m JOIN business_identities i ON i.id=m.identity_id JOIN organization_members o ON o.identity_id=i.id
      WHERE m.workspace_id=? AND m.status='active' AND i.status='active' AND o.status='active'`).all(workspaceId).map(row => ({ id: String(row.id), name: String(row.name) }));
  }
  markdown(context: WorkspaceContext, id: string): { title: string; markdown: string } {
    const page = this.get(context, id);
    return { title: page.title, markdown: `# ${page.title}\n\n${page.body.replace(/\s+$/, '')}\n` };
  }

  // ---- organization administrators: workspace legal hold and per-person export/delete ----
  #workspaceDb<T>(workspaceId: string, operation: (db: DatabaseSync) => T): T {
    const db = openWorkspaceDatabase(this.#profile, workspaceId);
    try { return operation(db); } finally { db.close(); }
  }
  #workspaceIds(): string[] { return this.#control.database.prepare('SELECT id FROM workspaces ORDER BY created_at,id').all().map(row => String(row.id)); }
  held(principal: BusinessPrincipal, workspaceId: string): boolean {
    this.#control.policy.requireOrganizationAdmin(principal); validId(workspaceId);
    if (!this.#control.workspace(workspaceId)) throw new BusinessAccessError(404);
    return this.#workspaceDb(workspaceId, contentHeld);
  }
  setHold(principal: BusinessPrincipal, workspaceId: string, input: unknown): boolean {
    exactFields(input, ['on']);
    if (typeof input.on !== 'boolean') throw new BusinessAccessError(400);
    const on = input.on;
    this.held(principal, workspaceId);
    this.#workspaceDb(workspaceId, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (on) db.prepare("INSERT OR IGNORE INTO sara_legal_hold(scope,since) VALUES ('workspace',?)").run(now());
        else db.exec('DELETE FROM sara_legal_hold');
        appendAudit(db, { action: 'content.hold', actorId: principal.identityId, workspaceId, revision: on ? 1 : 0 });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    return on;
  }
  #personRows(db: DatabaseSync, person: string) {
    return {
      pages: rows<Record<string, unknown>>(db, 'SELECT id,title,body,created_at AS createdAt,updated_at AS updatedAt,revision FROM pages WHERE author_id=? ORDER BY created_at,id', person),
      versions: rows<Record<string, unknown>>(db, 'SELECT page_id AS pageId,revision,title,body,edited_at AS editedAt FROM page_versions WHERE editor_id=? ORDER BY page_id,revision', person),
      comments: rows<Record<string, unknown>>(db, 'SELECT id,page_id AS pageId,parent_id AS parentId,body,created_at AS createdAt,resolved_at AS resolvedAt FROM page_comments WHERE author_id=? ORDER BY created_at,id', person),
      mentions: rows<Record<string, unknown>>(db, 'SELECT page_id AS pageId,comment_id AS commentId,created_at AS createdAt FROM page_mentions WHERE identity_id=? ORDER BY created_at', person),
    };
  }
  /** Only rows this person wrote (pages they created, versions they saved, their comments). */
  exportPerson(principal: BusinessPrincipal, person: string) {
    this.#control.policy.requireOrganizationAdmin(principal); validId(person);
    const identity = this.#control.identities.get(person); if (!identity) throw new BusinessAccessError(404);
    const workspaces = [];
    for (const id of this.#workspaceIds()) {
      const data = this.#workspaceDb(id, db => this.#personRows(db, person));
      if (Object.values(data).some(list => list.length)) workspaces.push({ id, name: this.#control.workspace(id)?.name ?? '', ...data });
    }
    return { kind: 'sara-business-pages-export', version: 1, person: { id: person, name: identity.name }, exportedAt: now(), workspaces };
  }
  /**
   * Deletes the person's comments and mentions and removes their name from pages and versions they
   * wrote (the team's pages stay). Refused whole when any workspace holding their rows is held.
   */
  deletePerson(principal: BusinessPrincipal, person: string, input: unknown) {
    exactFields(input, ['confirm']);
    if (input.confirm !== true) throw new BusinessAccessError(400);
    this.#control.policy.requireOrganizationAdmin(principal); validId(person);
    if (!this.#control.identities.get(person)) throw new BusinessAccessError(404);
    const involved = this.#workspaceIds().filter(id => this.#workspaceDb(id, db => Object.values(this.#personRows(db, person)).some(list => list.length) || !!db.prepare('SELECT 1 FROM pages WHERE updated_by=? UNION SELECT 1 FROM page_comments WHERE resolved_by=? UNION SELECT 1 FROM page_mentions WHERE by_id=?').get(person, person, person)));
    if (involved.some(id => this.#workspaceDb(id, contentHeld))) throw held();
    const receipt = { person, deletedAt: now(), workspaces: involved.length, comments: 0, mentions: 0, attributions: 0 };
    for (const id of involved) this.#workspaceDb(id, db => {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (contentHeld(db)) throw held();
        receipt.mentions += Number(db.prepare('DELETE FROM page_mentions WHERE identity_id=? OR by_id=? OR comment_id IN (SELECT id FROM page_comments WHERE author_id=?)').run(person, person, person).changes);
        receipt.comments += Number(db.prepare('DELETE FROM page_comments WHERE author_id=?').run(person).changes);
        for (const sql of ['UPDATE pages SET author_id=NULL WHERE author_id=?', 'UPDATE pages SET updated_by=NULL WHERE updated_by=?', 'UPDATE page_versions SET editor_id=NULL WHERE editor_id=?', 'UPDATE page_comments SET resolved_by=NULL WHERE resolved_by=?']) receipt.attributions += Number(db.prepare(sql).run(person).changes);
        appendAudit(db, { action: 'page.person.delete', actorId: principal.identityId, workspaceId: id, subjectId: person });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    this.#control.transaction(() => appendAudit(this.#control.database, { action: 'page.person.delete', actorId: principal.identityId, subjectId: person }));
    return receipt;
  }
}

/** `@name` followed by the end, whitespace or punctuation (so `@Al` doesn't notify Alex). */
function mentions(lowerBody: string, lowerName: string): boolean {
  if (!lowerName) return false;
  let at = lowerBody.indexOf('@' + lowerName);
  while (at >= 0) {
    const next = lowerBody[at + 1 + lowerName.length];
    if (next === undefined || !/[\p{L}\p{N}_]/u.test(next)) return true;
    at = lowerBody.indexOf('@' + lowerName, at + 1);
  }
  return false;
}
