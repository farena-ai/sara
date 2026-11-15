// R7: the owner's tool rules for household members (src/member-tools.ts). Owner only: a member's
// space never reaches this family (MEMBER_ROUTES in src/household.ts), nor does an app with a
// device code (DEVICE_TOKEN_DENIED in src/server.ts).
import { HttpError, readJson, send } from '../http.ts';
import { FAMILY_CHOICES, MEMBER_FAMILIES, memberTools, NEVER_FAMILIES, TOOL_SPEND_CHOICES } from '../member-tools.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createMemberToolsRoutes(ctx: RouteCtx): RouteHandler {
  const { opts, app } = ctx;
  return async (req, res, method, parts) => {
    if (parts[0] !== 'member-tools') return NEXT;
    if (opts.member || app.member || opts.demo || app.demo) throw new HttpError(403, 'Only the owner of this server can use this.', { ownerOnly: true });
    const store = memberTools();
    if (!store) throw new HttpError(404, 'Not available');
    const people = () => (opts.household?.store.members() ?? []).filter((m) => m.status !== 'leaving').map((m) => ({ id: m.id, name: m.name }));
    const view = () => {
      const list = people();
      return { rules: store.get(), people: list.map((p) => ({ ...p, effective: store.effective(p.id) })), families: MEMBER_FAMILIES, never: NEVER_FAMILIES, choices: FAMILY_CHOICES, spendChoices: TOOL_SPEND_CHOICES };
    };
    if (!parts[1] && method === 'GET') return send(res, 200, view());
    if (!parts[1] && method === 'PUT') {
      const body = await readJson(req);
      const known = new Set(people().map((p) => p.id));
      store.set(body, (id) => known.has(id));
      return send(res, 200, view());
    }
    throw new HttpError(404, 'Not found');
  };
}
