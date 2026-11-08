// EC16 (docs/ops/EC1617_DESIGN.md, docs/SCIM.md): SCIM 2.0 provisioning (RFC 7643/7644) for business
// instances. Users and Groups under /scim/v2 with one bearer token (its SHA-256 in the operator Vault).
// SCIM only manages accounts it created; membership changes go through BusinessControlStore so the
// session, epoch and last-administrator rules are the same as everywhere else.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { LoginLimiter } from '../auth.ts';
import { appendAudit } from './audit.ts';
import { operatorVault } from './model-config.ts';
import { BusinessAccessError, exactFields } from './policy.ts';
import type { BusinessProfile } from './profile.ts';
import type { BusinessSso } from './sso.ts';
import type { BusinessControlStore } from './store.ts';
import type { BusinessPrincipal } from './types.ts';

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const TOKEN = 'business-scim:token-sha256';
const MAX_BODY = 65_536;
export const SCIM_LIMITS = { users: 5000, groups: 500, members: 5000, filter: 200 } as const;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

export class ScimError extends Error {
  readonly status: number; readonly scimType?: string;
  constructor(status: number, detail: string, scimType?: string) { super(detail); this.status = status; this.scimType = scimType; }
}
const bad = (detail = 'Invalid request.', scimType = 'invalidValue') => new ScimError(400, detail, scimType);
const text = (value: unknown, max: number, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw bad(`Invalid ${field}.`);
  return value.trim();
};
const optional = (value: unknown, max: number, field: string): string | null => value === undefined || value === null || value === '' ? null : text(value, max, field);
/** Entra sends "True"/"False" strings; RFC 7643 booleans are JSON booleans. */
const bool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  throw bad('Invalid active value.');
};

interface UserRow { identity_id: string; user_name: string; external_id: string | null; display_name: string | null; given_name: string | null; family_name: string | null; email: string | null; active: number; created_at: string; modified_at: string }
interface GroupRow { id: string; display_name: string; external_id: string | null; created_at: string; modified_at: string }
interface UserFields { userName: string; externalId: string | null; displayName: string | null; givenName: string | null; familyName: string | null; email: string | null; active: boolean }

export class BusinessScim {
  readonly #profile: BusinessProfile;
  readonly #control: BusinessControlStore;
  readonly #sso: BusinessSso;
  readonly #origin: string;
  #badTokens = new LoginLimiter(20, 60_000);
  #requests = new LoginLimiter(1000, 60_000);

  constructor(options: { profile: BusinessProfile; control: BusinessControlStore; sso: BusinessSso; origin: string }) {
    this.#profile = options.profile; this.#control = options.control; this.#sso = options.sso; this.#origin = options.origin;
    this.#control.database.exec(`CREATE TABLE IF NOT EXISTS business_scim_users (identity_id TEXT PRIMARY KEY REFERENCES business_identities(id), user_name TEXT NOT NULL, user_name_key TEXT NOT NULL UNIQUE,
        external_id TEXT, display_name TEXT, given_name TEXT, family_name TEXT, email TEXT, active INTEGER NOT NULL CHECK(active IN (0,1)), created_at TEXT NOT NULL, modified_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_scim_groups (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, external_id TEXT, created_at TEXT NOT NULL, modified_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS business_scim_group_members (group_id TEXT NOT NULL REFERENCES business_scim_groups(id) ON DELETE CASCADE, identity_id TEXT NOT NULL REFERENCES business_scim_users(identity_id) ON DELETE CASCADE, PRIMARY KEY(group_id,identity_id));`);
    this.#sso.setProvisionedLookup(email => {
      const key = email.toLowerCase();
      const row = this.#control.database.prepare('SELECT identity_id FROM business_scim_users WHERE user_name_key=? OR lower(email)=? ORDER BY user_name_key=? DESC LIMIT 1').get(key, key, key);
      return row ? String(row.identity_id) : undefined;
    });
  }

  get baseUrl(): string { return `${this.#origin}/scim/v2`; }
  #enabled(): boolean { return !!this.#control.database.prepare("SELECT 1 FROM business_meta WHERE key='scim_enabled' AND value='1'").get(); }
  #tokenHash(): string | undefined {
    return existsSync(join(this.#profile.businessDir, 'operator', 'secrets.enc')) ? operatorVault(this.#profile).get(TOKEN) : undefined;
  }
  view(principal: BusinessPrincipal) {
    this.#control.policy.requireOrganizationAdmin(principal);
    const users = Number(this.#control.database.prepare('SELECT count(*) AS n FROM business_scim_users').get()!.n);
    const groups = Number(this.#control.database.prepare('SELECT count(*) AS n FROM business_scim_groups').get()!.n);
    return { enabled: this.#enabled(), tokenSet: !!this.#tokenHash(), baseUrl: this.baseUrl, users, groups };
  }
  save(principal: BusinessPrincipal, input: unknown) {
    exactFields(input, ['enabled']);
    if (typeof input.enabled !== 'boolean') throw new BusinessAccessError(400);
    this.#control.transaction(() => {
      this.#control.policy.requireOrganizationAdmin(principal);
      this.#control.database.prepare("INSERT INTO business_meta(key,value) VALUES ('scim_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.enabled ? '1' : '0');
      appendAudit(this.#control.database, { action: 'scim.configure', actorId: principal.identityId });
    });
    return this.view(principal);
  }
  /** A new token, shown once. The old one stops working at once. */
  rotateToken(principal: BusinessPrincipal, input: unknown): { token: string; baseUrl: string } {
    exactFields(input, []);
    this.#control.policy.requireOrganizationAdmin(principal);
    const token = randomBytes(32).toString('base64url');
    operatorVault(this.#profile).set(TOKEN, sha(token));
    this.#control.transaction(() => appendAudit(this.#control.database, { action: 'scim.token', actorId: principal.identityId }));
    return { token, baseUrl: this.baseUrl };
  }
  /** Tests: clear the per-minute counters and lower the request ceiling. */
  resetLimits(): void { this.#badTokens = new LoginLimiter(20, 60_000); this.#requests = new LoginLimiter(1000, 60_000); }
  setRequestLimit(n: number): void { this.#requests = new LoginLimiter(n, 60_000); }

  // ---- HTTP ----
  async handle(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    const send = (status: number, value?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/scim+json; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const fail = (error: ScimError, headers: Record<string, string> = {}) => send(error.status, { schemas: [ERROR], status: String(error.status), ...(error.scimType ? { scimType: error.scimType } : {}), detail: error.message }, headers);
    if (!this.#enabled()) return fail(new ScimError(404, 'Not found.'));
    if (this.#badTokens.blocked(ip)) return fail(new ScimError(429, 'Too many requests.'), { 'retry-after': '60' });
    const header = req.headers.authorization ?? '';
    const presented = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header)?.[1];
    const want = this.#tokenHash();
    if (!presented || !want || !timingSafeEqual(Buffer.from(sha(presented), 'hex'), Buffer.from(want, 'hex'))) {
      this.#badTokens.fail(ip);
      try { this.#control.transaction(() => appendAudit(this.#control.database, { action: 'scim.refused' })); } catch { /* The refusal stands without its row. */ }
      return fail(new ScimError(401, 'Authorization failure.'), { 'www-authenticate': 'Bearer' });
    }
    if (this.#requests.blocked('all')) return fail(new ScimError(429, 'Too many requests.'), { 'retry-after': '60' });
    this.#requests.fail('all');
    try {
      const url = new URL(req.url ?? '/', this.#origin);
      const rest = path.slice('/scim/v2'.length).replace(/\/+$/, '');
      const [, resource = '', id, extra] = rest.split('/');
      if (extra !== undefined) throw new ScimError(404, 'Not found.');
      const method = req.method ?? 'GET';
      if (method === 'GET' && !id && resource === 'ServiceProviderConfig') return send(200, this.#serviceProviderConfig());
      if (method === 'GET' && !id && resource === 'ResourceTypes') return send(200, this.#list(this.#resourceTypes(), 1));
      if (method === 'GET' && !id && resource === 'Schemas') return send(200, this.#list(this.#schemas(), 1));
      if (resource !== 'Users' && resource !== 'Groups') throw new ScimError(404, 'Not found.');
      const users = resource === 'Users';
      if (method === 'GET') {
        if (id) return send(200, users ? this.#user(this.#userRow(id)) : this.#group(this.#groupRow(id), url.searchParams));
        return send(200, users ? this.#listUsers(url.searchParams) : this.#listGroups(url.searchParams));
      }
      if (method === 'DELETE' && id) { if (users) this.#deleteUser(id); else this.#deleteGroup(id); return send(204); }
      if (!['POST', 'PUT', 'PATCH'].includes(method) || (method === 'POST') === !!id) throw new ScimError(404, 'Not found.');
      const body = await this.#body(req);
      if (method === 'POST') { const made = users ? this.#createUser(body) : this.#createGroup(body); return send(201, made, { location: made.meta.location }); }
      if (method === 'PUT') return send(200, users ? this.#replaceUser(id, body) : this.#replaceGroup(id, body));
      return send(200, users ? this.#patchUser(id, body) : this.#patchGroup(id, body, url.searchParams));
    } catch (error) {
      if (error instanceof ScimError) return fail(error);
      if (error instanceof BusinessAccessError) return fail(new ScimError(error.status, error.status === 409 ? error.message : error.status === 404 ? 'Not found.' : 'Invalid request.', error.status === 409 ? 'mutability' : undefined));
      return fail(new ScimError(400, 'Invalid request.'));
    }
  }

  async #body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const type = String(req.headers['content-type'] ?? '');
    if (!/^application\/(scim\+)?json\b/i.test(type)) throw new ScimError(415, 'Use application/scim+json.');
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) throw new ScimError(413, 'Request too large.'); chunks.push(chunk as Buffer); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw bad('Invalid JSON.', 'invalidSyntax'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad('Invalid JSON.', 'invalidSyntax');
    return value as Record<string, unknown>;
  }

  // ---- discovery ----
  #serviceProviderConfig() {
    return { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], documentationUri: 'https://github.com/farena-ai/sara/blob/main/docs/SCIM.md',
      patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: SCIM_LIMITS.filter },
      changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The token from Organization administration > Provisioning (SCIM).', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${this.baseUrl}/ServiceProviderConfig` } };
  }
  #resourceTypes() {
    return [['User', 'Users', USER], ['Group', 'Groups', GROUP]].map(([name, endpoint, schema]) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: name, name, endpoint: `/${endpoint}`, schema, meta: { resourceType: 'ResourceType', location: `${this.baseUrl}/ResourceTypes/${name}` } }));
  }
  #schemas() {
    const attr = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });
    return [
      { id: USER, name: 'User', description: 'A person in this organization.', attributes: [attr('userName', 'string', { required: true, uniqueness: 'server' }), attr('externalId', 'string', { caseExact: true }), attr('displayName'),
        attr('name', 'complex', { subAttributes: [attr('givenName'), attr('familyName'), attr('formatted')] }), attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', 'boolean')] }), attr('active', 'boolean'),
        attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' })], meta: { resourceType: 'Schema', location: `${this.baseUrl}/Schemas/${USER}` } },
      { id: GROUP, name: 'Group', description: 'A group; its name can map to a Sara role.', attributes: [attr('displayName', 'string', { required: true }), attr('externalId', 'string', { caseExact: true }),
        attr('members', 'complex', { multiValued: true, subAttributes: [attr('value'), attr('display')] })], meta: { resourceType: 'Schema', location: `${this.baseUrl}/Schemas/${GROUP}` } },
    ];
  }
  #list(resources: unknown[], startIndex: number, total = resources.length) {
    return { schemas: [LIST], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources };
  }
  #page(params: URLSearchParams): { start: number; count: number } {
    const start = params.has('startIndex') ? Number(params.get('startIndex')) : 1;
    const count = params.has('count') ? Number(params.get('count')) : SCIM_LIMITS.filter;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 0) throw bad('Invalid paging.');
    return { start: Math.max(1, start), count: Math.min(count, SCIM_LIMITS.filter) };
  }
  /** Only `attr eq "value"` on the attributes providers filter by (Entra and Okta send nothing else). */
  #filter(params: URLSearchParams, allowed: string[]): { attr: string; value: string } | undefined {
    const raw = params.get('filter');
    if (raw === null) return undefined;
    const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
    const attr = m && allowed.find(a => a.toLowerCase() === m[1].toLowerCase());
    if (!m || !attr) throw new ScimError(400, 'Unsupported filter.', 'invalidFilter');
    return { attr, value: m[2].replace(/\\(.)/g, '$1') };
  }

  // ---- users ----
  #userRow(id: string): UserRow {
    const row = this.#control.database.prepare('SELECT * FROM business_scim_users WHERE identity_id=?').get(id) as UserRow | undefined;
    if (!row) throw new ScimError(404, 'Not found.');
    return row;
  }
  #user(row: UserRow) {
    const groups = this.#control.database.prepare('SELECT g.id,g.display_name FROM business_scim_group_members m JOIN business_scim_groups g ON g.id=m.group_id WHERE m.identity_id=? ORDER BY g.created_at,g.id').all(row.identity_id);
    const name: Record<string, string> = {};
    if (row.given_name) name.givenName = row.given_name;
    if (row.family_name) name.familyName = row.family_name;
    if (row.given_name || row.family_name) name.formatted = [row.given_name, row.family_name].filter(Boolean).join(' ');
    return { schemas: [USER], id: row.identity_id, ...(row.external_id ? { externalId: row.external_id } : {}), userName: row.user_name, name, ...(row.display_name ? { displayName: row.display_name } : {}),
      emails: row.email ? [{ value: row.email, type: 'work', primary: true }] : [], active: row.active === 1, groups: groups.map(g => ({ value: String(g.id), display: String(g.display_name), $ref: `${this.baseUrl}/Groups/${g.id}` })),
      meta: { resourceType: 'User', created: row.created_at, lastModified: row.modified_at, location: `${this.baseUrl}/Users/${row.identity_id}` } };
  }
  #listUsers(params: URLSearchParams) {
    const filter = this.#filter(params, ['userName', 'externalId']); const { start, count } = this.#page(params);
    const where = !filter ? '' : filter.attr === 'userName' ? 'WHERE user_name_key=?' : 'WHERE external_id=?';
    const args = filter ? [filter.attr === 'userName' ? filter.value.toLowerCase() : filter.value] : [];
    const total = Number(this.#control.database.prepare(`SELECT count(*) AS n FROM business_scim_users ${where}`).get(...args)!.n);
    const rows = this.#control.database.prepare(`SELECT * FROM business_scim_users ${where} ORDER BY created_at,identity_id LIMIT ? OFFSET ?`).all(...args, count, start - 1) as unknown as UserRow[];
    return this.#list(rows.map(row => this.#user(row)), start, total);
  }
  #fields(body: Record<string, unknown>, base?: UserFields): UserFields {
    const name = body.name && typeof body.name === 'object' && !Array.isArray(body.name) ? body.name as Record<string, unknown> : undefined;
    const emails = Array.isArray(body.emails) ? body.emails as Record<string, unknown>[] : undefined;
    const email = emails ? (emails.find(e => e && e.primary === true) ?? emails.find(e => e && e.type === 'work') ?? emails[0])?.value : undefined;
    return {
      userName: text(body.userName ?? base?.userName, 256, 'userName'),
      externalId: body.externalId !== undefined ? optional(body.externalId, 256, 'externalId') : base?.externalId ?? null,
      displayName: body.displayName !== undefined ? optional(body.displayName, 256, 'displayName') : base?.displayName ?? null,
      givenName: name && name.givenName !== undefined ? optional(name.givenName, 128, 'name') : base?.givenName ?? null,
      familyName: name && name.familyName !== undefined ? optional(name.familyName, 128, 'name') : base?.familyName ?? null,
      email: emails ? optional(email, 256, 'email') : base?.email ?? null,
      active: body.active !== undefined ? bool(body.active) : base?.active ?? true,
    };
  }
  #rowFields(row: UserRow): UserFields {
    return { userName: row.user_name, externalId: row.external_id, displayName: row.display_name, givenName: row.given_name, familyName: row.family_name, email: row.email, active: row.active === 1 };
  }
  #display(f: UserFields): string {
    return (f.displayName ?? ([f.givenName, f.familyName].filter(Boolean).join(' ') || f.userName.split('@')[0])).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || 'Business user';
  }
  #write(identityId: string | undefined, f: UserFields, remove = false): string {
    const key = f.userName.toLowerCase();
    const taken = this.#control.database.prepare('SELECT identity_id FROM business_scim_users WHERE user_name_key=?').get(key);
    if (taken && taken.identity_id !== identityId) throw new ScimError(409, 'userName is already in use.', 'uniqueness');
    if (!identityId && Number(this.#control.database.prepare('SELECT count(*) AS n FROM business_scim_users').get()!.n) >= SCIM_LIMITS.users) throw new ScimError(409, 'Too many provisioned users.', 'tooMany');
    const before = identityId ? this.#userRow(identityId) : undefined;
    const now = new Date().toISOString();
    const result = this.#control.scimProvision({ ...(identityId ? { identityId } : {}), name: this.#display(f), active: f.active, remove }, id => {
      if (remove) { this.#control.database.prepare('DELETE FROM business_scim_users WHERE identity_id=?').run(id); this.#control.database.prepare('DELETE FROM business_sso_links WHERE identity_id=?').run(id); }
      else this.#control.database.prepare(`INSERT INTO business_scim_users(identity_id,user_name,user_name_key,external_id,display_name,given_name,family_name,email,active,created_at,modified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(identity_id) DO UPDATE SET user_name=excluded.user_name,user_name_key=excluded.user_name_key,external_id=excluded.external_id,display_name=excluded.display_name,given_name=excluded.given_name,family_name=excluded.family_name,email=excluded.email,active=excluded.active,modified_at=excluded.modified_at`)
        .run(id, f.userName, key, f.externalId, f.displayName, f.givenName, f.familyName, f.email, f.active ? 1 : 0, now, now);
      const action = remove ? 'scim.user.delete' : !before ? 'scim.user.create' : before.active === 1 && !f.active ? 'scim.user.deactivate' : 'scim.user.update';
      appendAudit(this.#control.database, { action, subjectId: id });
    });
    if (result.ended || remove || !f.active) this.#sso.endIdentity(result.identityId);
    return result.identityId;
  }
  #createUser(body: Record<string, unknown>) { return this.#user(this.#userRow(this.#write(undefined, this.#fields(body)))); }
  #replaceUser(id: string, body: Record<string, unknown>) { this.#userRow(id); return this.#user(this.#userRow(this.#write(id, this.#fields(body)))); }
  #deleteUser(id: string): void { this.#write(id, this.#rowFields(this.#userRow(id)), true); }
  #ops(body: Record<string, unknown>): { op: 'add' | 'replace' | 'remove'; path?: string; value?: unknown }[] {
    const ops = body.Operations;
    if ((Array.isArray(body.schemas) && !body.schemas.includes(PATCH_OP)) || !Array.isArray(ops) || !ops.length || ops.length > 100) throw bad('Send a PatchOp with Operations.', 'invalidSyntax');
    return ops.map(o => {
      const op = typeof o?.op === 'string' ? o.op.toLowerCase() : '';
      if (!['add', 'replace', 'remove'].includes(op) || (o.path !== undefined && typeof o.path !== 'string')) throw bad('Unsupported operation.', 'invalidSyntax');
      return { op: op as 'add' | 'replace' | 'remove', ...(o.path !== undefined ? { path: o.path as string } : {}), ...(o.value !== undefined ? { value: o.value } : {}) };
    });
  }
  #patchUser(id: string, body: Record<string, unknown>) {
    const f = this.#rowFields(this.#userRow(id));
    const set = (path: string, value: unknown, remove: boolean) => {
      const p = path.toLowerCase();
      if (p === 'active') { if (!remove) f.active = bool(value); }
      else if (p === 'username') { if (remove) throw bad('userName is required.', 'mutability'); f.userName = text(value, 256, 'userName'); }
      else if (p === 'displayname') f.displayName = remove ? null : optional(value, 256, 'displayName');
      else if (p === 'externalid') f.externalId = remove ? null : optional(value, 256, 'externalId');
      else if (p === 'name.givenname') f.givenName = remove ? null : optional(value, 128, 'name');
      else if (p === 'name.familyname') f.familyName = remove ? null : optional(value, 128, 'name');
      else if (p === 'name' && value && typeof value === 'object') { const n = value as Record<string, unknown>; if (n.givenName !== undefined) f.givenName = optional(n.givenName, 128, 'name'); if (n.familyName !== undefined) f.familyName = optional(n.familyName, 128, 'name'); }
      else if (/^emails(\[type eq "work"\]|\[primary eq true\])?\.value$/.test(p)) f.email = remove ? null : optional(value, 256, 'email');
      else if (p === 'emails') { if (remove) f.email = null; else if (Array.isArray(value)) f.email = this.#fields({ userName: f.userName, emails: value }).email; }
      // Anything else (enterprise extension, roles, locale, title) is not kept here: accepted, ignored.
    };
    for (const o of this.#ops(body)) {
      if (o.path) set(o.path, o.value, o.op === 'remove');
      else if (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) set(k, v, o.op === 'remove');
      else throw bad('An operation needs a path or a value object.', 'noTarget');
    }
    return this.#user(this.#userRow(this.#write(id, f)));
  }

  // ---- groups ----
  #groupRow(id: string): GroupRow {
    const row = this.#control.database.prepare('SELECT * FROM business_scim_groups WHERE id=?').get(id) as GroupRow | undefined;
    if (!row) throw new ScimError(404, 'Not found.');
    return row;
  }
  #group(row: GroupRow, params?: URLSearchParams) {
    const omit = (params?.get('excludedAttributes') ?? '').split(',').map(s => s.trim().toLowerCase()).includes('members');
    const members = omit ? [] : this.#control.database.prepare('SELECT u.identity_id,u.user_name FROM business_scim_group_members m JOIN business_scim_users u ON u.identity_id=m.identity_id WHERE m.group_id=? ORDER BY u.created_at,u.identity_id').all(row.id);
    return { schemas: [GROUP], id: row.id, ...(row.external_id ? { externalId: row.external_id } : {}), displayName: row.display_name,
      ...(omit ? {} : { members: members.map(m => ({ value: String(m.identity_id), display: String(m.user_name), $ref: `${this.baseUrl}/Users/${m.identity_id}` })) }),
      meta: { resourceType: 'Group', created: row.created_at, lastModified: row.modified_at, location: `${this.baseUrl}/Groups/${row.id}` } };
  }
  #listGroups(params: URLSearchParams) {
    const filter = this.#filter(params, ['displayName', 'externalId']); const { start, count } = this.#page(params);
    const where = !filter ? '' : filter.attr === 'displayName' ? 'WHERE lower(display_name)=?' : 'WHERE external_id=?';
    const args = filter ? [filter.attr === 'displayName' ? filter.value.toLowerCase() : filter.value] : [];
    const total = Number(this.#control.database.prepare(`SELECT count(*) AS n FROM business_scim_groups ${where}`).get(...args)!.n);
    const rows = this.#control.database.prepare(`SELECT * FROM business_scim_groups ${where} ORDER BY created_at,id LIMIT ? OFFSET ?`).all(...args, count, start - 1) as unknown as GroupRow[];
    return this.#list(rows.map(row => this.#group(row, params)), start, total);
  }
  #memberIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > SCIM_LIMITS.members) throw bad('members must be a list.');
    const ids = value.map(m => typeof m?.value === 'string' ? m.value : '');
    for (const id of ids) if (!this.#control.database.prepare('SELECT 1 FROM business_scim_users WHERE identity_id=?').get(id)) throw bad('A member is not a provisioned user.');
    return [...new Set(ids)];
  }
  /** Writes a group and its members in one transaction, then brings the affected people's roles in line. */
  #saveGroup(id: string | undefined, displayName: string, externalId: string | null, members: string[] | undefined, touched: Set<string>): string {
    const groupId = id ?? randomUUID(); const now = new Date().toISOString();
    this.#control.transaction(() => {
      if (!id && Number(this.#control.database.prepare('SELECT count(*) AS n FROM business_scim_groups').get()!.n) >= SCIM_LIMITS.groups) throw new ScimError(409, 'Too many groups.', 'tooMany');
      this.#control.database.prepare('INSERT INTO business_scim_groups(id,display_name,external_id,created_at,modified_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,external_id=excluded.external_id,modified_at=excluded.modified_at').run(groupId, displayName, externalId, now, now);
      for (const row of this.#control.database.prepare('SELECT identity_id FROM business_scim_group_members WHERE group_id=?').all(groupId)) touched.add(String(row.identity_id));
      if (members) {
        this.#control.database.prepare('DELETE FROM business_scim_group_members WHERE group_id=?').run(groupId);
        for (const member of members) { this.#control.database.prepare('INSERT INTO business_scim_group_members(group_id,identity_id) VALUES (?,?)').run(groupId, member); touched.add(member); }
      }
      appendAudit(this.#control.database, { action: 'scim.group', subjectId: groupId });
    });
    this.#syncRoles(touched);
    return groupId;
  }
  /** EC2's group mapping: in an Administrator group → orgadmin, otherwise user (only SCIM-managed people). */
  #syncRoles(ids: Set<string>): void {
    const config = this.#sso.config();
    const admin = new Set(config.adminGroups.map(g => g.toLowerCase()));
    if (!admin.size && !config.memberGroups.length) return;
    for (const id of ids) {
      if (!this.#control.database.prepare('SELECT 1 FROM business_scim_users WHERE identity_id=? AND active=1').get(id)) continue;
      const groups = this.#control.database.prepare('SELECT g.id,g.display_name,g.external_id FROM business_scim_group_members m JOIN business_scim_groups g ON g.id=m.group_id WHERE m.identity_id=?').all(id);
      const isAdmin = groups.some(g => [g.id, g.display_name, g.external_id].some(v => typeof v === 'string' && admin.has(v.toLowerCase())));
      this.#control.ssoSyncRole(id, isAdmin ? 'orgadmin' : 'user');
    }
  }
  #createGroup(body: Record<string, unknown>) {
    const members = body.members === undefined ? [] : this.#memberIds(body.members);
    return this.#group(this.#groupRow(this.#saveGroup(undefined, text(body.displayName, 256, 'displayName'), optional(body.externalId, 256, 'externalId'), members, new Set())));
  }
  #replaceGroup(id: string, body: Record<string, unknown>) {
    const row = this.#groupRow(id);
    const members = body.members === undefined ? [] : this.#memberIds(body.members);
    return this.#group(this.#groupRow(this.#saveGroup(id, text(body.displayName ?? row.display_name, 256, 'displayName'), body.externalId !== undefined ? optional(body.externalId, 256, 'externalId') : row.external_id, members, new Set())));
  }
  #patchGroup(id: string, body: Record<string, unknown>, params: URLSearchParams) {
    const row = this.#groupRow(id);
    let displayName = row.display_name; let externalId = row.external_id;
    const current = new Set(this.#control.database.prepare('SELECT identity_id FROM business_scim_group_members WHERE group_id=?').all(id).map(r => String(r.identity_id)));
    const touched = new Set<string>(current);
    for (const o of this.#ops(body)) {
      const path = o.path?.trim();
      const one = path ? /^members\[value eq "([^"]+)"\]$/i.exec(path) : null;
      if (one && o.op === 'remove') { current.delete(one[1]); continue; }
      if (path?.toLowerCase() === 'members') {
        const ids = o.op === 'remove' && o.value === undefined ? [...current] : this.#memberIds(o.value);
        if (o.op === 'add') ids.forEach(m => current.add(m));
        else if (o.op === 'remove') ids.forEach(m => current.delete(m));
        else { current.clear(); ids.forEach(m => current.add(m)); }
        continue;
      }
      const apply = (key: string, value: unknown) => {
        const k = key.toLowerCase();
        if (k === 'displayname') displayName = text(value, 256, 'displayName');
        else if (k === 'externalid') externalId = o.op === 'remove' ? null : optional(value, 256, 'externalId');
        else if (k === 'members') { const ids = this.#memberIds(value); if (o.op === 'replace') current.clear(); ids.forEach(m => current.add(m)); }
        // id and other read-only or unknown attributes are ignored.
      };
      if (path) apply(path, o.value);
      else if (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) for (const [k, v] of Object.entries(o.value as Record<string, unknown>)) apply(k, v);
      else throw bad('An operation needs a path or a value object.', 'noTarget');
    }
    if (current.size > SCIM_LIMITS.members) throw new ScimError(409, 'Too many members.', 'tooMany');
    this.#saveGroup(id, displayName, externalId, [...current], touched);
    return this.#group(this.#groupRow(id), params);
  }
  #deleteGroup(id: string): void {
    this.#groupRow(id);
    const touched = new Set(this.#control.database.prepare('SELECT identity_id FROM business_scim_group_members WHERE group_id=?').all(id).map(r => String(r.identity_id)));
    this.#control.transaction(() => {
      this.#control.database.prepare('DELETE FROM business_scim_groups WHERE id=?').run(id);
      appendAudit(this.#control.database, { action: 'scim.group', subjectId: id });
    });
    this.#syncRoles(touched);
  }
}
