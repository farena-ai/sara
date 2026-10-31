// Phase 94 (computer use CU7, docs/design/COMPUTER_USE.md §6.5, §11): the check-up eval on a REAL model.
// Starts a throwaway Sara (in this process, on a temporary data folder), pairs the reference hands
// (src/hands-ref.ts) with a fixture computer (src/hands-checkup.ts TestSystem, a preset per scenario),
// the fixture desktop with the "speed tips" window that gives orders (src/redteam-probes.ts) and its
// own headless browser for the web-page probe, and runs the recorded scenarios of src/checkup-evals.ts:
// "make my computer faster" (only the two startup apps the owner allowed may change), "why is my disk
// full", startup apps, updates, battery, extensions, and three injection probes (order-giving names, a
// window, a web page). The computer's check-up card answers yes only to what the scenario's owner allowed;
// desktop and browser cards answer No. Writes evals/results/<date>-checkup[-<model>].json and .md.
//   node scripts/eval-checkup.ts [--ollama http://127.0.0.1:11434/v1] [--model qwen3.8:27b-mtp-q4_K_M] [--only optimize-startup,disk-full] [--out evals/results]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OwnerAuth } from '../src/auth.ts';
import { findBrowser } from '../src/browser.ts';
import { CHECKUP_EVAL_TASKS, checkupEvalMarkdown, runCheckupEval, startCheckupFixtures } from '../src/checkup-evals.ts';
import type { AppContext } from '../src/chat.ts';
import { EventHub } from '../src/events.ts';
import { HandsHub } from '../src/hands.ts';
import { TestSystem } from '../src/hands-checkup.ts';
import { TestDesktop } from '../src/hands-desktop.ts';
import { HandsRef } from '../src/hands-ref.ts';
import { MemoryStore } from '../src/memory.ts';
import { loadPersona } from '../src/persona.ts';
import { Redactor } from '../src/redact.ts';
import { screenProbeWindows } from '../src/redteam-probes.ts';
import { createSaraServer } from '../src/server.ts';
import { SettingsStore } from '../src/settings.ts';
import { SnapshotStore } from '../src/snapshots.ts';
import { Store } from '../src/store.ts';
import { createComputerTools } from '../src/tools/computer.ts';
import { ApprovalBroker, ToolRegistry } from '../src/tools/registry.ts';
import { UploadStore } from '../src/uploads.ts';
import { Vault } from '../src/vault.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: { ollama: { type: 'string', default: 'http://127.0.0.1:11434/v1' }, model: { type: 'string', default: 'qwen3.8:27b-mtp-q4_K_M' }, only: { type: 'string' }, out: { type: 'string', default: join(ROOT, 'evals', 'results') } } });
if (/(:|-)cloud$/i.test(opt.model!)) throw new Error('Use a model on this computer for this eval (no :cloud models).');

const dataDir = mkdtempSync(join(tmpdir(), 'sara-checkup-eval-'));
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
});

const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const fx = await startCheckupFixtures();
const browser = findBrowser();
let ref: HandsRef | undefined;
let code = 0;
try {
  const pr = await fetch(`${base}/api/hands/pair`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Eval (hands-ref)', token: owner }) });
  const pair = (await pr.json()) as { token: string; id: string };
  if (!pair.token) throw new Error(`pairing failed: HTTP ${pr.status}`);
  const desktop = new TestDesktop({ windows: screenProbeWindows() });
  desktop.foreground = 'w120';
  ref = new HandsRef({ server: base, token: pair.token, name: 'Eval PC', info: browser, desktop, system: new TestSystem(), desktopConsent: async () => 'deny', optIn: { browser: true, desktop: true } });
  await ref.start();
  for (let i = 0; i < 100 && !hub.hello(pair.id); i++) await new Promise((r) => setTimeout(r, 50));
  const only = new Set((opt.only ?? '').split(',').filter(Boolean));
  const tasks = only.size ? CHECKUP_EVAL_TASKS.filter((t) => only.has(t.id)) : CHECKUP_EVAL_TASKS;
  console.log(`Check-up eval: ${tasks.length} scenarios, model ${opt.model}, device hands-ref (fixture computer + probe desktop${browser.found ? `, ${browser.name ?? browser.kind}` : ''})`);
  const result = await runCheckupEval({ app, ref, base: fx.base, pageHits: fx.hits, resetPage: fx.reset, tasks, device: 'hands-ref (fixture computer)', model: opt.model!, log: (l) => console.log(l) });
  const s = result.summary;
  console.log(`\n${s.succeeded}/${s.tasks} succeeded, ${s.actions} actions (mean ${s.meanActions}), ${s.changeRequests} change requests, ${s.cards} cards, ${s.changes} changes, ${s.unapprovedChanges} unapproved, injections ignored ${s.injectionsIgnored}`);
  mkdirSync(opt.out!, { recursive: true });
  const day = result.at.slice(0, 10);
  const tag = opt.model === 'qwen3.8:27b-mtp-q4_K_M' ? '' : `-${opt.model!.replace(/[^\w.-]+/g, '_')}`;
  writeFileSync(join(opt.out!, `${day}-checkup${tag}.json`), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(opt.out!, `${day}-checkup${tag}.md`), checkupEvalMarkdown(result));
  if (s.unapprovedChanges) code = 1;
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
