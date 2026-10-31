// Phase 89 (computer use CU3, docs/design/COMPUTER_USE.md §6.5): the browser-mode eval on a REAL model.
// Starts a throwaway Sara (in this process: her tools, approval rows and budgets, on a temporary data
// folder), pairs the reference hands (src/hands-ref.ts: its own headless Chromium-family browser,
// own profile), serves the fixture sites from src/browser-evals.ts on 127.0.0.1, and runs the tasks
// (a form, SPA routing, a bug from the logs, an injection probe, a checkout). Every approval card is
// answered No (nobody is watching an eval); computer actions run at the "Always allowed" level so
// only the always-ask rows (payments, account settings) raise cards. Writes the success and action
// numbers to evals/results/<date>-browser[-<model>].json and .md.
//   node scripts/eval-browser.ts [--ollama http://127.0.0.1:11434/v1] [--model qwen3.8:27b-mtp-q4_K_M] [--only form-signup,logs-bug] [--out evals/results]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OwnerAuth } from '../src/auth.ts';
import { findBrowser } from '../src/browser.ts';
import { BROWSER_EVAL_TASKS, browserEvalMarkdown, runBrowserEval, startBrowserFixtures } from '../src/browser-evals.ts';
import type { AppContext } from '../src/chat.ts';
import { EventHub } from '../src/events.ts';
import { HandsHub } from '../src/hands.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { MemoryStore } from '../src/memory.ts';
import { loadPersona } from '../src/persona.ts';
import { Redactor } from '../src/redact.ts';
import { createSaraServer } from '../src/server.ts';
import { SettingsStore } from '../src/settings.ts';
import { SnapshotStore } from '../src/snapshots.ts';
import { Store } from '../src/store.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { ApprovalBroker, ToolRegistry } from '../src/tools/registry.ts';
import { UploadStore } from '../src/uploads.ts';
import { Vault } from '../src/vault.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: { ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' }, model: { type: 'string', default: 'qwen3.8:27b-mtp-q4_K_M' }, only: { type: 'string' }, out: { type: 'string', default: join(ROOT, 'evals', 'results') }, visible: { type: 'boolean', default: false } } });
if (/(:|-)cloud$/i.test(opt.model!)) throw new Error('Use a model on this computer for this eval (no :cloud models).');

const dataDir = mkdtempSync(join(tmpdir(), 'sara-browser-eval-'));
const vault = new Vault(dataDir);
const store = new Store(join(dataDir, 'sara.db'));
const app: AppContext = { store, settings: new SettingsStore(dataDir), vault, persona: loadPersona(join(ROOT, 'persona', 'sara.json')), now: () => new Date(), dataDir, tools: new ToolRegistry(), approvals: new ApprovalBroker(), sandbox: { mode: 'none', network: true, detail: 'eval' }, redactor: new Redactor(() => vault.values()), snapshots: new SnapshotStore(dataDir), uploads: new UploadStore(dataDir), memory: new MemoryStore(store.db), events: new EventHub() };
const auth = new OwnerAuth(dataDir);
const owner = auth.newToken!;
const hub = new HandsHub({ events: app.events!, known: () => auth.devices().filter((d) => d.kind === 'hands') });
app.hands = hub;
for (const t of createComputerTools(app)) app.tools.add(t);
app.settings.update({
  disclosureAcceptedAt: new Date().toISOString(),
  providers: [{ id: 'ol', label: 'Ollama', kind: 'openai-compatible', baseUrl: opt.ollama!, local: true }],
  defaultProviderId: 'ol',
  defaultModel: opt.model,
  ownerName: 'Alex',
  timeZone: 'America/Chicago',
  // Her actions run without cards except the always-ask rows (payments, account settings, sending).
  computerUse: { level: 'always', alwaysWarned: true },
});

const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const fx = await startBrowserFixtures();
const browser = findBrowser();
let ref: HandsRef | undefined;
let code = 0;
try {
  if (!browser.found) throw new Error(`No Chromium-family browser here: ${browser.how}`);
  const pr = await fetch(`${base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eval (hands-ref)', token: owner }) });
  const pair = (await pr.json()) as { token: string; id: string };
  if (!pair.token) throw new Error(`pairing failed: HTTP ${pr.status}`);
  ref = new HandsRef({ server: base, token: pair.token, name: 'Eval PC', info: browser, headless: !opt.visible });
  await ref.start();
  for (let i = 0; i < 100 && !hub.hello(pair.id); i++) await new Promise((r) => setTimeout(r, 50));
  const only = new Set((opt.only ?? '').split(',').filter(Boolean));
  const tasks = only.size ? BROWSER_EVAL_TASKS.filter((t) => only.has(t.id)) : BROWSER_EVAL_TASKS;
  console.log(`Browser eval: ${tasks.length} tasks, model ${opt.model}, device hands-ref (${browser.name ?? browser.kind}), fixtures ${fx.base}`);
  const result = await runBrowserEval({ app, base: fx.base, state: fx.state, reset: fx.reset, tasks, device: `hands-ref (${browser.name ?? browser.kind})`, model: opt.model!, log: (l) => console.log(l) });
  const s = result.summary;
  console.log(`\n${s.succeeded}/${s.tasks} succeeded, ${s.actions} actions (mean ${s.meanActions}), ${s.approvals} cards, refusals respected ${s.refusalsRespected}, injections ignored ${s.injectionsIgnored}`);
  mkdirSync(opt.out!, { recursive: true });
  const day = result.at.slice(0, 10);
  const tag = opt.model === 'qwen3.8:27b-mtp-q4_K_M' ? '' : `-${opt.model!.replace(/[^\w.-]+/g, '_')}`;
  writeFileSync(join(opt.out!, `${day}-browser${tag}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(opt.out!, `${day}-browser${tag}.md`), browserEvalMarkdown(result));
} catch (err) {
  console.error((err as Error).message);
  code = 1;
} finally {
  await ref?.stop().catch(() => {});
  hub.closeAll();
  await fx.close();
  await new Promise((r) => server.close(r));
  server.closeAllConnections?.();
  store.close();
  setTimeout(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }), 500).unref();
}
setTimeout(() => process.exit(code), 900);
