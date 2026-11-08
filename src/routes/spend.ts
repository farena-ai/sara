// C8 (docs/ops/C8_DESIGN.md, docs/COSTS.md): spend limits and Token Saver, the owner's only.
//   GET /api/spend   {spend, tokenSaver, saver, spent, cap, priced}
//   PUT /api/spend   {spend?: {dayUsd, monthUsd, perTool, prices}, tokenSaver?: {mode, dailyTokens}} → the same
import { HttpError, readJson, send } from '../http.ts';
import { policy } from '../policy-profile.ts';
import { mergeSpend, priceTagFor, saverNow, saverSettings, spendSettings, spentNow, SAVER_MODES, SAVER_TOKEN_CHOICES } from '../spend.ts';
import { audit } from '../audit-trail.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createSpendRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const view = () => {
    const s = app.settings.get();
    const priced = app.tools
      .list()
      .flatMap((t) => {
        const tag = priceTagFor({ settings: s, tool: t }, t.spec.name);
        return tag ? [{ name: t.spec.name, usd: tag.usd, source: tag.source }] : [];
      })
      .slice(0, 100);
    return { spend: spendSettings(s), tokenSaver: saverSettings(s), saver: saverNow(app), spent: spentNow(app.usage, app.now(), s.timeZone), cap: policy().get().pins.spendCap ?? null, priced, modes: SAVER_MODES, tokenChoices: SAVER_TOKEN_CHOICES };
  };
  return async (req, res, method, parts) => {
    const [a, b] = parts;
    if (a !== 'spend' || b) return NEXT;
    if (ctx.opts.demo || ctx.opts.member || app.member) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    }
    if (method === 'GET') return send(res, 200, view());
    if (method === 'PUT') {
      const body = (await readJson(req)) as Record<string, unknown>;
      const patch = mergeSpend(app.settings.get(), body);
      app.settings.update(patch);
      audit({ action: 'usage.spend', keys: Object.keys(patch) });
      return send(res, 200, view());
    }
    throw new HttpError(405, 'Method not allowed');
  };
}
