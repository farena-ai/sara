import { randomUUID } from 'node:crypto';
import type { WorkspaceContext } from './types.ts';
import { BusinessAccessError, exactFields } from './policy.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessWorkspaces, WorkspaceDocument, WorkspaceUpload } from './workspaces.ts';

export const BUSINESS_DOCUMENT_BYTES = 32768;
export function businessText(value: unknown, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || !allowEmpty && !value.trim() || Buffer.byteLength(value, 'utf8') > maximum || value.includes('\u0000')) throw new BusinessAccessError(400);
  // Reject lone surrogates rather than silently changing an uploaded source into replacement text.
  if (new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'utf8')) !== value) throw new BusinessAccessError(400);
  return value;
}
function mime(value: unknown): 'text/plain' | 'text/markdown' {
  if (value !== 'text/plain' && value !== 'text/markdown') throw new BusinessAccessError(400);
  return value;
}
/** Explicit UTF-8 only; no subprocess extraction, URL fetching or personal-library adapter. */
export class BusinessDocuments {
  readonly #control: BusinessControlStore;
  readonly #workspaces: BusinessWorkspaces;
  constructor(control: BusinessControlStore, workspaces: BusinessWorkspaces) { this.#control = control; this.#workspaces = workspaces; }
  async create(context: WorkspaceContext, input: unknown, guard: () => void = () => {}): Promise<WorkspaceDocument> {
    return this.#control.identities.lifecycle.run(() => this.#create(context, input, guard));
  }
  async #create(context: WorkspaceContext, input: unknown, guard: () => void): Promise<WorkspaceDocument> {
    this.#control.policy.revalidateWorkspace(context, 'document'); guard();
    exactFields(input, ['title', 'mime', 'body']);
    const title = businessText(input.title, 200); const type = mime(input.mime); const text = businessText(input.body, BUSINESS_DOCUMENT_BYTES);
    await Promise.resolve();
    this.#control.policy.revalidateWorkspace(context, 'document'); guard();
    const document: WorkspaceDocument = { id: randomUUID(), title, mime: type, body: text, createdAt: new Date().toISOString(), actorId: context.principal.identityId };
    this.#workspaces.mutate(context, 'document', db => {
      guard(); db.prepare('INSERT INTO documents(id,title,mime,body,created_at) VALUES (?,?,?,?,?)').run(document.id, title, type, text, document.createdAt);
      db.prepare("INSERT INTO content_authorship(kind,resource_id,actor_id) VALUES ('document',?,?)").run(document.id, context.principal.identityId);
      db.prepare("INSERT INTO notifications(id,kind,resource_id,created_at) VALUES (?,'document.changed',?,?)").run(randomUUID(), document.id, document.createdAt);
    }, guard);
    guard(); return document;
  }
  async upload(context: WorkspaceContext, input: unknown, guard: () => void = () => {}): Promise<WorkspaceUpload & { documentId: string }> {
    return this.#control.identities.lifecycle.run(() => this.#upload(context, input, guard));
  }
  async #upload(context: WorkspaceContext, input: unknown, guard: () => void): Promise<WorkspaceUpload & { documentId: string }> {
    this.#control.policy.revalidateWorkspace(context, 'document'); guard();
    exactFields(input, ['name', 'mime', 'contentBase64']);
    const name = businessText(input.name, 160); const type = mime(input.mime);
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _().-]{0,150}\.(?:txt|md|markdown)$/iu.test(name) || name.includes('..') || type === 'text/plain' && !/\.txt$/i.test(name) || type === 'text/markdown' && !/\.(?:md|markdown)$/i.test(name)) throw new BusinessAccessError(400);
    if (typeof input.contentBase64 !== 'string' || input.contentBase64.length > Math.ceil(BUSINESS_DOCUMENT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64)) throw new BusinessAccessError(400);
    const staged = Buffer.from(input.contentBase64, 'base64');
    if (staged.toString('base64') !== input.contentBase64 || staged.length > BUSINESS_DOCUMENT_BYTES) throw new BusinessAccessError(400);
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(staged); } catch { throw new BusinessAccessError(400); }
    const text = businessText(decoded, BUSINESS_DOCUMENT_BYTES);
    await Promise.resolve();
    this.#control.policy.revalidateWorkspace(context, 'document'); guard();
    const createdAt = new Date().toISOString(); const id = randomUUID(); const documentId = randomUUID();
    this.#workspaces.mutate(context, 'document', db => {
      guard(); db.prepare('INSERT INTO documents(id,title,mime,body,created_at) VALUES (?,?,?,?,?)').run(documentId, name, type, text, createdAt);
      db.prepare('INSERT INTO uploads(id,name,mime,body,created_at) VALUES (?,?,?,?,?)').run(id, name, type, text, createdAt);
      for (const [kind, resource] of [['document', documentId], ['upload', id]]) db.prepare('INSERT INTO content_authorship(kind,resource_id,actor_id) VALUES (?,?,?)').run(kind, resource, context.principal.identityId);
      db.prepare("INSERT INTO notifications(id,kind,resource_id,created_at) VALUES (?,'document.changed',?,?)").run(randomUUID(), documentId, createdAt);
    }, guard);
    guard(); return { id, documentId, name, mime: type, body: text, createdAt, actorId: context.principal.identityId };
  }
}
