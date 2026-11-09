// Q-ADDONS (docs/ops/Q_ADDONS_MCP.md): the acceptance run for MCP recipes on a real, throwaway Sara.
// Every step goes through the routes the Settings page calls; nothing here installs by itself:
//   add      POST /api/store/install {id} → POST /api/store/mcp/:review/approve   (signed Store recipe)
//            or PUT /api/mcp/:name with the recipe's command/args/url/env       (Developer connections
//            "Copy into the add form", recipe previews prepared by hand)
//   saved    GET /api/mcp: the edit form's saved values, status, tools; GET /api/tools: ask/auto advice
//   edit     PUT /api/mcp/:name {fields} (Store) or the same form again, switched off, then read back
//   call     the saved config and vault values started by Sara's own McpManager (same sandbox
//            detection as main.ts), one read-only call and at most one write the plan approves
//   remove   POST /api/store/remove {item} or DELETE /api/mcp/:name; then settings, vault and
//            My add-ons must no longer have it
//
//   node scripts/qualify-mcp-recipes.ts <plan.json> <results.json>
//   env: SARA_BASE (http://127.0.0.1:7881), SARA_DATA (the throwaway data folder), SARA_SRC (the
//        Sara checkout whose modules to use; default this one), SARA_SANDBOX (as the instance)
//
// plan.json: [{ id, route: 'store'|'form', values?, secrets?, expectRefusal?, edit?: {KEY: value}, pre?: [steps],
//              read?: { tool, args, expect }, write?: { tool, args, expect }, expectStart?: 'fail' }]
// `expect` is a regular expression the answer must match (for a no-key read, the plain failure).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [planPath, outPath] = process.argv.slice(2);
if (!planPath || !outPath) throw new Error('usage: qualify-mcp-recipes.ts <plan.json> <results.json>');
const base = (process.env.SARA_BASE ?? 'http://127.0.0.1:7881').replace(/\/+$/, '');
const data = resolve(process.env.SARA_DATA ?? '');
const src = resolve(process.env.SARA_SRC ?? '.');
const mod = (p: string) => import(pathToFileURL(join(src, p)).href);
const token = readFileSync(join(data, 'first-token.txt'), 'utf8').trim();

interface Step { tool: string; args: Record<string, unknown>; expect: string }
interface Plan { id: string; route: 'store' | 'form'; values?: Record<string, string>; secrets?: Record<string, string>; edit?: Record<string, string>; pre?: Step[]; read?: Step; write?: Step; expectStart?: 'fail'; expectRefusal?: string }
type Result = Record<string, unknown> & { id: string; steps: Record<string, string> };

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600_000) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, json };
}
const ok = (r: { status: number; json: any }, what: string) => {
  if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
  return r.json;
};
const short = (s: unknown, n = 300) => String(typeof s === 'string' ? s : JSON.stringify(s)).replace(/\s+/g, ' ').slice(0, n);

/** The form's config for a recipe the Store does not carry: what "Copy into the add form" fills in. */
function formBody(recipe: any, name: string, values: Record<string, string>, secrets: Record<string, string>): Record<string, unknown> {
  const m = recipe.mcp;
  // The preview's ${home} substitution: a folder of its own (the server's folder, as a Store install gets).
  const home = join(data, 'mcp', name);
  const env: Record<string, string> = {};
  for (const f of m.fields ?? []) if (values[f.key] ?? f.default) env[f.key] = values[f.key] ?? f.default;
  for (const f of m.secrets ?? []) if (secrets[f.key]) env[f.key] = secrets[f.key];
  const fill = (s: string) => s.replace(/\$\{setting:([^}]+)\}/g, (_m, k: string) => values[k] ?? '').replace(/\$\{home\}/g, home);
  return m.transport === 'http' ? { transport: 'http', url: fill(m.url), enabled: true } : { transport: 'stdio', command: m.command, args: (m.args ?? []).map(fill), env, enabled: true };
}

async function callThrough(name: string, steps: Step[]): Promise<{ tools: number; answers: { tool: string; pass: boolean; text: string }[]; schema: Record<string, string> }> {
  const { McpManager, mcpToolName } = await mod('src/tools/mcp.ts');
  const { ToolRegistry } = await mod('src/tools/registry.ts');
  const { Vault } = await mod('src/vault.ts');
  const { mcpSecrets } = await mod('src/integrations.ts');
  const { detectSandbox } = await mod('src/tools/sandbox.ts');
  const settings = JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8'));
  const cfg = (settings.mcpServers ?? []).find((s: any) => s.name === name);
  if (!cfg) throw new Error(`${name} is not in settings.json`);
  const vault = new Vault(data, process.env.SARA_MASTER_KEY);
  const sandbox = detectSandbox((process.env.SARA_SANDBOX ?? 'auto') as never, true, { dataDir: data });
  const reg = new ToolRegistry([]);
  const mgr = new McpManager(reg, { dataDir: data, sandbox, secrets: (n: string) => mcpSecrets(vault, n) });
  try {
    const conn = await mgr.start({ ...cfg, enabled: true });
    if (conn.status !== 'ready') throw new Error(`did not start: ${conn.error ?? conn.status}`);
    const answers = [];
    for (const s of steps) {
      const tool = reg.get(mcpToolName(name, s.tool));
      if (!tool) { answers.push({ tool: s.tool, pass: false, text: `no tool ${s.tool}` }); continue; }
      let text: string;
      try { const r = await tool.run(s.args, { workspaceDir: join(data, 'mcp', name), sandbox, signal: AbortSignal.timeout(300_000) }); text = typeof r === 'string' ? r : JSON.stringify(r); }
      catch (err) { text = `ERROR ${(err as Error).message}`; }
      answers.push({ tool: s.tool, pass: new RegExp(s.expect, 'is').test(text), text: short(text, 600) });
    }
    const schema = Object.fromEntries(conn.tools.map((t: any) => [t.name, Object.keys(t.inputSchema?.properties ?? {}).map((k) => ((t.inputSchema.required ?? []).includes(k) ? `${k}*` : k)).join(',')]));
    return { tools: conn.tools.length, answers, schema };
  } finally { mgr.stopAll(); }
}

async function one(p: Plan): Promise<Result> {
  const r: Result = { id: p.id, steps: {} };
  const recipe = JSON.parse(readFileSync(resolve('store/mcp', `${p.id}.json`), 'utf8'));
  let name = recipe.mcp.name ?? p.id;
  // 1. add
  if (p.route === 'store') {
    const got = ok(await api('POST', '/store/install', { id: p.id }), 'install');
    const review = got.review;
    r.review = { version: review.version, command: [review.command, ...(review.args ?? [])].join(' ') || review.url, needs: review.needs, fence: review.fence, fields: review.fields.map((f: any) => f.key), guideTip: short(review.fields.map((f: any) => f.tip).join(' | '), 200) };
    name = review.serverName;
    const t0 = Date.now();
    const res = await api('POST', `/store/mcp/${review.id}/approve`, { values: p.values ?? {}, secrets: p.secrets ?? {}, trust: true });
    // A recipe that needs the owner's key: the plain refusal is the result (nothing was saved).
    if (res.status >= 300 && p.expectRefusal && new RegExp(p.expectRefusal, 'i').test(JSON.stringify(res.json))) {
      await api('DELETE', `/store/mcp/${review.id}`);
      r.refusal = short(res.json.error ?? res.json);
      r.steps.add = 'needs-account';
      r.removed = { listed: ok(await api('GET', '/mcp'), 'list').some((s: any) => s.name === name) };
      return r;
    }
    const done = ok(res, 'approve');
    r.approve = { status: done.status, tools: done.tools.length, test: done.test.text, ms: Date.now() - t0 };
    r.steps.add = 'pass';
    r.steps.connect = done.test.ok ? 'pass' : p.expectStart === 'fail' ? 'expected-fail' : 'fail';
  } else {
    const t0 = Date.now();
    const view = ok(await api('PUT', `/mcp/${name}`, formBody(recipe, name, p.values ?? {}, p.secrets ?? {})), 'save');
    const me = view.find((s: any) => s.name === name);
    r.approve = { status: me?.status, tools: me?.tools.length, error: short(me?.error ?? ''), ms: Date.now() - t0 };
    r.steps.add = 'pass';
    r.steps.connect = me?.status === 'ready' ? 'pass' : p.expectStart === 'fail' ? 'expected-fail' : 'fail';
  }
  // 2. saved values on the edit form, and the advice
  const view = ok(await api('GET', '/mcp'), 'list');
  const me = view.find((s: any) => s.name === name);
  r.saved = me?.recipe ? me.recipe.fields.map((f: any) => `${f.key}=${f.secret ? (f.saved ? '(saved secret)' : '(none)') : f.value}`) : { envKeys: me?.envKeys, args: me?.args, url: me?.url };
  const wanted = Object.entries(p.values ?? {});
  r.steps.saved = !me ? 'fail' : me.recipe ? (wanted.every(([k, v]) => me.recipe.fields.some((f: any) => f.key === k && f.value === v)) ? 'pass' : 'fail') : 'pass';
  const tools = ok(await api('GET', '/tools'), 'tools').tools.filter((t: any) => String(t.source ?? '').endsWith(`: ${name}`));
  r.advice = { auto: tools.filter((t: any) => t.permission === 'auto').map((t: any) => t.name.split('__').pop()), ask: tools.filter((t: any) => t.permission === 'ask').length };
  // 3. edit (and switch off so the call below owns the only copy, e.g. qdrant's locked folder)
  if (p.route === 'store') {
    const fields = { ...(p.values ?? {}), ...(p.edit ?? {}) };
    const after = ok(await api('PUT', `/mcp/${name}`, { fields, enabled: false }), 'edit').find((s: any) => s.name === name);
    const editOk = Object.entries(p.edit ?? {}).every(([k, v]) => after?.recipe?.fields.some((f: any) => f.key === k && f.value === v)) && after?.transport === recipe.mcp.transport && after?.status === 'disabled';
    r.steps.edit = editOk ? 'pass' : 'fail';
    if (p.edit) ok(await api('PUT', `/mcp/${name}`, { fields: { ...(p.values ?? {}) }, enabled: false }), 'edit back');
  } else {
    const after = ok(await api('PUT', `/mcp/${name}`, { ...formBody(recipe, name, p.values ?? {}, {}), env: {}, enabled: false }), 'edit').find((s: any) => s.name === name);
    r.steps.edit = after?.status === 'disabled' && (me?.envKeys ?? []).every((k: string) => after.envKeys.includes(k)) ? 'pass' : 'fail';
  }
  // 4. calls
  const steps = [...(p.pre ?? []), p.read, p.write].filter(Boolean) as Step[];
  if (steps.length || process.env.SCHEMA) {
    try {
      const c = await callThrough(name, steps);
      r.calls = c;
      if (p.read) r.steps.read = c.answers[(p.pre ?? []).length].pass ? 'pass' : 'fail';
      if (p.write) r.steps.write = c.answers[c.answers.length - 1].pass ? 'pass' : 'fail';
    } catch (err) {
      r.calls = short((err as Error).message, 600);
      if (p.read) r.steps.read = p.expectStart === 'fail' ? 'expected-fail' : 'fail';
      if (p.write) r.steps.write = 'fail';
    }
  }
  // 5. remove
  if (p.route === 'store') ok(await api('POST', '/store/remove', { item: p.id }), 'remove');
  else ok(await api('DELETE', `/mcp/${name}`), 'remove');
  const left = ok(await api('GET', '/mcp'), 'list').some((s: any) => s.name === name);
  const mine = p.route === 'store' ? JSON.stringify(ok(await api('GET', '/store/mine'), 'mine')).includes(`"${p.id}"`) : false;
  const { Vault } = await mod('src/vault.ts');
  const inVault = Boolean(new Vault(data, process.env.SARA_MASTER_KEY).get(`mcp:${name}`));
  const toolsLeft = ok(await api('GET', '/tools'), 'tools').tools.some((t: any) => String(t.source ?? '').endsWith(`: ${name}`));
  r.removed = { listed: left, myAddons: mine, vault: inVault, tools: toolsLeft };
  r.steps.remove = !left && !mine && !inVault && !toolsLeft ? 'pass' : 'fail';
  return r;
}

const plans = JSON.parse(readFileSync(planPath, 'utf8')) as Plan[];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : undefined;
const results: Result[] = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : [];
for (const p of plans) {
  if (only && !only.has(p.id)) continue;
  let r: Result;
  try { r = await one(p); }
  catch (err) {
    r = { id: p.id, steps: { run: 'fail' }, error: short((err as Error).message, 800) };
    // Leave nothing behind after a failed step.
    await api('POST', '/store/remove', { item: p.id }).catch(() => undefined);
    await api('DELETE', `/mcp/${p.id}`).catch(() => undefined);
  }
  r.at = new Date().toISOString();
  const i = results.findIndex((x) => x.id === p.id);
  if (i >= 0) results[i] = r; else results.push(r);
  writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
  console.log(p.id, JSON.stringify(r.steps), r.error ?? '');
}
