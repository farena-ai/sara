// C3 browser check (run by hand; needs Playwright): a real Chrome opens the web chat with an MCP App,
// checks the sandbox from inside the app (no cookies, no parent DOM, no storage, no Sara API, opaque
// origin), presses the app's button, sees the approval card in the chat, allows it, sees the app
// update, and saves desktop and phone screenshots to outputs/c3/.
//   PLAYWRIGHT=<path to playwright/index.mjs> node test/fixtures/c3-mcp-apps-browser.ts
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnerAuth } from '../../src/auth.ts';
import { runTurn } from '../../src/chat.ts';
import { createSaraServer } from '../../src/server.ts';
import { McpManager } from '../../src/tools/mcp.ts';
import { call, makeApp, ROOT, tempDir, text } from '../helpers.ts';

const PW = process.env.PLAYWRIGHT;
if (!PW) throw new Error('Set PLAYWRIGHT to the path of playwright/index.mjs (and CHROME to a Chrome binary if needed).');
const OUT = join(ROOT, 'outputs', 'c3');
mkdirSync(OUT, { recursive: true });
// Playwright is not a dependency of Sara: loaded from a path, so it is untyped here.
const { chromium } = (await import(pathToFileURL(PW).href)) as { chromium: any };

const { dir, cleanup } = tempDir();
const clock = { now: new Date() };
const app = makeApp(dir, clock);
app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', disclosureAcceptedAt: clock.now.toISOString() });
const mgr = new McpManager(app.tools, { dataDir: dir, sandbox: app.sandbox, secrets: () => ({ env: { MCP_ERA: 'modern' } }) });
app.mcp = mgr;
const auth = new OwnerAuth(dir, () => clock.now);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
const results: Record<string, unknown> = {};
let failed = false;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results[name] = ok ? 'ok' : `FAIL ${JSON.stringify(detail)}`;
  if (!ok) failed = true;
};
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}) });
try {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c = await mgr.start({ name: 'counter', enabled: true, transport: 'stdio', command: process.execPath, args: [join(ROOT, 'test', 'fixtures', 'mcp-app-server.mjs')] });
  if (c.status !== 'ready') throw new Error(c.error);
  const conv = app.store.createConversation({ title: 'Counter app' });
  app.script.push([call('c1', 'mcp_counter_show_counter', {})], text('Here is the counter. Press Bump to add one.'));
  for await (const _ of runTurn(app, conv.id, 'Show me the counter app')) void _;

  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: label === 'phone' ? 2 : 1 });
    await ctx.request.post(`${origin}/api/login`, { data: { token } });
    await ctx.route('**/*', (route: any) => (!route.request().url().startsWith(origin) || /\/api\/update/.test(route.request().url()) ? route.abort() : route.continue()));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.goto(`${origin}/#c=${conv.id}`);
    const frameEl = await page.waitForSelector('iframe.mcp-app-frame', { timeout: 15_000 });
    check(`${label}: iframe sandbox is allow-scripts only`, (await frameEl.getAttribute('sandbox')) === 'allow-scripts');
    const frame = (await frameEl.contentFrame())!;
    await frame.waitForFunction(() => /^Count: [0-9]+$/.test(document.getElementById('n')?.textContent ?? '') && document.getElementById('probe')?.textContent, undefined, { timeout: 10_000 });
    const probe = JSON.parse((await frame.textContent('#probe')) ?? '{}') as Record<string, string>;
    const cookies = await ctx.cookies();
    check(`${label}: Sara has a session cookie`, cookies.length > 0, cookies.map((x: { name: string }) => x.name));
    check(`${label}: app can't read cookies`, /^blocked/.test(probe.cookie ?? '') || probe.cookie === '', probe.cookie);
    check(`${label}: app can't read the chat page`, /^blocked/.test(probe.parent ?? ''), probe.parent);
    check(`${label}: app can't use storage`, /^blocked/.test(probe.storage ?? ''), probe.storage);
    check(`${label}: app can't reach Sara's API`, /^blocked/.test(probe.fetch ?? ''), probe.fetch);
    check(`${label}: app origin is opaque`, probe.origin === 'null', probe.origin);
    await page.evaluate(() => document.querySelector('.rcard-mcp-app')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `mcp-app-${label}.png`) });
    if (label === 'desktop') {
      await frame.click('#bump');
      const card = await page.waitForSelector('.approval', { timeout: 10_000 });
      check('desktop: Bump waits for an approval card', Boolean(card));
      check('desktop: nothing ran before the OK', app.store.messages(conv.id).every((m) => !/counter app: bump/.test(m.content)));
      await card.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, 'mcp-app-approval-desktop.png') });
      await card.$eval('button', (b: HTMLButtonElement) => b.click());
      // The chat redraws when the wait ends, so the app may be a fresh frame showing the latest result.
      await page.waitForTimeout(1500);
      const after = (await (await page.waitForSelector('iframe.mcp-app-frame')).contentFrame())!;
      await after.waitForFunction(() => document.getElementById('n')?.textContent === 'Count: 1', undefined, { timeout: 10_000 });
      check('desktop: after Allow the app shows the new count', true);
      await page.evaluate(() => document.querySelector('.rcard-mcp-app')?.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, 'mcp-app-after-desktop.png') });
    }
    check(`${label}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }
} finally {
  await browser.close();
  mgr.stopAll();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  app.store.close();
  cleanup();
}
console.log(JSON.stringify(results, null, 2));
process.exitCode = failed ? 1 : 0;
