// EC4 + EC5 (docs/ops/EC45_DESIGN.md): the audit trail (view, check, retention, export) and the
// policy profile (read by everyone signed in; changed, imported and exported by the owner only).
// Household members only reach GET /api/policy (src/household.ts); apps with a device code reach
// neither (DEVICE_TOKEN_DENIED in src/server.ts).
import type { IncomingMessage } from 'node:http';
import { audit, auditTrail, type AuditFilter, RETENTION_CHOICES } from '../audit-trail.ts';
import { HttpError, readJson, SECURITY_HEADERS, send } from '../http.ts';
import { egressSettings, enforcementNote, isolation, isolationPatch, isolationSettings } from '../isolation.ts';
import { policy, PIN_KEYS, PROVIDER_KINDS } from '../policy-profile.ts';
import { secretSources } from '../secret-sources.ts';
import type { SecretSourceStatus } from '../vault.ts';
import { dataRights } from '../data-rights.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

function filters(req: IncomingMessage): AuditFilter & { content: boolean } {
  const q = new URL(req.url ?? '/', 'http://x').searchParams;
  const g = (k: string) => q.get(k)?.trim().slice(0, 80) || undefined;
  const limit = Number(q.get('limit'));
  return { who: g('who'), action: g('action'), channel: g('channel'), outcome: g('outcome'), from: g('from'), to: g('to'), ...(limit > 0 ? { limit } : {}), content: q.get('content') === '1' };
}

export function createGovernanceRoutes(ctx: RouteCtx): RouteHandler {
  const { opts, app } = ctx;
  const ownerOnly = () => {
    if (opts.member || app.member || opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
  };
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    // EC8 + EC9: the sandbox backend and the egress allowlist (server-wide; owner only).
    if (a === 'isolation') {
      ownerOnly();
      const svc = isolation();
      const view = () => {
        const s = app.settings.get();
        const e = egressSettings(s);
        const pins = policy().pins;
        return { ...(svc ? svc.status() : { ...isolationSettings(s), sandbox: { mode: app.sandbox.mode, detail: app.sandbox.detail, isolated: app.sandbox.mode !== 'none', refused: Boolean(app.sandbox.refuse) }, tried: [], image: '', checkedAt: null }), egress: { mode: pins.egressAllowlist ? 'allowlist' : e.mode, hosts: pins.egressAllowlist ?? e.hosts, ...enforcementNote(app.sandbox) }, pinned: { containerSandbox: Boolean(pins.containerSandbox), egressAllowlist: Boolean(pins.egressAllowlist) }, platform: process.platform };
      };
      if (!b && method === 'GET') return send(res, 200, view());
      if (!b && method === 'PUT') {
        const body = await readJson(req);
        const patch = isolationPatch(body, app.settings.get(), policy().pins, (k) => policy().refusal(k));
        app.settings.update(patch);
        if (patch.isolation) svc?.recheck();
        return send(res, 200, view());
      }
      if (b === 'recheck' && method === 'POST') {
        svc?.recheck();
        return send(res, 200, view());
      }
      throw new HttpError(404, 'Not found');
    }
    // EC10: where each server secret comes from (Settings → Data & health → Secret sources). Never a value.
    if (a === 'secrets') {
      ownerOnly();
      const env = process.env;
      const view = (sources: SecretSourceStatus[]) => ({ sources, pinned: Boolean(policy().pins.externalSecrets), ttlSeconds: Math.round(secretSources().ttlMs / 1000), commands: env.SARA_SECRET_COMMANDS === '1', configured: { vault: Boolean(env.VAULT_ADDR), onepassword: Boolean(env.OP_CONNECT_HOST && env.OP_CONNECT_TOKEN) }, platform: process.platform });
      if (!b && method === 'GET') return send(res, 200, view(app.vault.sources()));
      if (b === 'check' && method === 'POST') return send(res, 200, view(await app.vault.check()));
      throw new HttpError(404, 'Not found');
    }
    if (a === 'audit') {
      ownerOnly();
      const trail = auditTrail();
      if (!trail) throw new HttpError(404, 'Not available');
      const retention = () => ({ retentionDays: policy().pins.auditRetentionDays ?? trail.retentionDays, retentionPinned: policy().pinned('auditRetentionDays'), choices: RETENTION_CHOICES });
      if (!b && method === 'GET') {
        const { content, ...f } = filters(req);
        return send(res, 200, { rows: trail.list(f, { content }), verify: trail.verify(), ...retention() });
      }
      if (b === 'verify' && method === 'GET') return send(res, 200, trail.verify());
      if (b === 'settings' && method === 'PUT') {
        const body = await readJson(req);
        const days = Number(body.retentionDays);
        policy().guard('auditRetentionDays', true);
        if (!(RETENTION_CHOICES as readonly number[]).includes(days)) throw new HttpError(400, 'Pick 30, 90 or 365 days, or keep everything.');
        trail.setRetention(days);
        trail.prune(days);
        return send(res, 200, retention());
      }
      if (b === 'export' && method === 'GET') {
        const { content, ...f } = filters(req);
        const format = new URL(req.url ?? '/', 'http://x').searchParams.get('format') === 'csv' ? 'csv' : 'jsonl';
        // The export itself is on the record (what was asked for, never what it held).
        audit({ action: 'audit.export', target: format, keys: [...Object.keys(f).filter((k) => f[k as keyof AuditFilter] !== undefined), ...(content ? ['content'] : [])] });
        const { zip } = trail.exportZip(format, f, { content });
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="sara-audit-${new Date().toISOString().slice(0, 10)}.zip"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(zip);
      }
      throw new HttpError(404, 'Not found');
    }
    // EC17: retention, legal hold, per-person export and delete (owner only; docs/DATA_RIGHTS.md).
    if (a === 'data-rights') {
      ownerOnly();
      const d = dataRights();
      if (!d) throw new HttpError(404, 'Not available');
      if (!b && method === 'GET') return send(res, 200, { ...d.view(), auditRetentionDays: policy().pins.auditRetentionDays ?? auditTrail()?.retentionDays ?? 0 });
      if (b === 'retention' && method === 'PUT') return send(res, 200, { retention: d.setRetention(await readJson(req)) });
      if (b === 'holds' && method === 'PUT') return send(res, 200, { holds: d.setHolds(await readJson(req)) });
      if (b === 'export' && method === 'GET') {
        const { zip, name } = d.exportPerson(new URL(req.url ?? '/', 'http://x').searchParams.get('person'));
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(zip);
      }
      if (b === 'history' && method === 'GET') return send(res, 200, d.personEditHistory(new URL(req.url ?? '/', 'http://x').searchParams.get('person')));
      if (b === 'delete' && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { receipt: await d.deletePerson(body.person, body.confirm) });
      }
      throw new HttpError(404, 'Not found');
    }
    if (a === 'policy') {
      if (!b && method === 'GET') {
        const p = policy().get();
        return send(res, 200, { policy: p, pinned: PIN_KEYS.filter((k) => policy().pinned(k)), kinds: PROVIDER_KINDS, retentionChoices: RETENTION_CHOICES, canEdit: !opts.member && !app.member && !opts.demo });
      }
      ownerOnly();
      if (!b && method === 'PUT') return send(res, 200, { policy: policy().set(await readJson(req), { how: 'change' }) });
      if (b === 'import' && method === 'POST') return send(res, 200, { policy: policy().set(await readJson(req, 64 * 1024), { how: 'import' }) });
      if (b === 'export' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="sara-policy.json"', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(JSON.stringify(policy().exportFile(), null, 2) + '\n');
      }
      throw new HttpError(404, 'Not found');
    }
    return NEXT;
  };
}
