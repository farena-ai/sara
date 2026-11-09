#!/usr/bin/env node
// Manual browser qualification against the actual isolated application and PluginManager.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startAddonsBrowserFixture } from '../test/fixtures/addons-browser.ts';

const args = process.argv.slice(2);
let output = resolve('outputs/a1/browser');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--output' || !args[i + 1]) throw new Error('Usage: node scripts/check-addons-browser.mjs [--output path]');
  output = resolve(args[++i]);
}
await mkdir(output, { recursive: true });
const report = { suite: 'A1 actual Settings browser', passed: false, journeys: [], layouts: [], pageErrors: [], unexpectedNetwork: [], limits: 'Synthetic loopback owner fixture using the real default-root PluginManager, public discovery APIs and actual UI. No owner data, accounts, paid calls, real model, screen reader, physical device, production deployment or store publication.' };
let fixture, browser, page;
try {
  let modulePath = process.env.SARA_PLAYWRIGHT_MODULE;
  if (!modulePath) {
    try { modulePath = createRequire(import.meta.url).resolve('playwright'); }
    catch { throw new Error('Set SARA_PLAYWRIGHT_MODULE to an existing Playwright index.mjs; this script installs nothing.'); }
  }
  const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
  fixture = await startAddonsBrowserFixture();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  assert.equal((await context.request.post(`${fixture.origin}/api/login`, { data: { token: fixture.token } })).status(), 200);
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== fixture.origin) { report.unexpectedNetwork.push('blocked-nonfixture-origin'); await route.abort(); }
    else await route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
  const writes = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) writes.push({ path: new URL(request.url()).pathname, method: request.method() }); });
  page.on('dialog', dialog => void dialog.accept());
  await page.goto(fixture.origin);
  await page.locator('#disclosure-accept').click();
  await page.locator('#su-skip').click();
  await page.locator('#setup').waitFor({ state: 'hidden' });
  async function openSettings(name, id) {
    if (!(await page.locator('#settings').evaluate(node => node.open))) await page.keyboard.press('Control+,');
    if (await page.locator('#settings-back').isVisible()) await page.locator('#settings-back').click();
    await page.locator('#settings-search').fill(name);
    await page.locator(`#settings-results a[data-result="${id}"]`).click();
  }
  await openSettings('plugins', 'ab-plugins');
  await page.locator('#plg-discovery [data-discovery-id="home-dashboard"]').waitFor();
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 31);
  assert.equal(await page.locator('#plg-builtin .plg-card').count(), 5);
  assert.equal(await page.locator('#plg-discovery .addon-card details[open]').count(), 0);
  const beforeFilters = writes.length;
  await page.locator('#native-discovery-search').fill('image');
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 1);
  await page.locator('#native-discovery-status').selectOption('blocked');
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 0);
  await page.locator('#native-discovery-status').selectOption('');
  await page.locator('#native-discovery-search').fill('');
  assert.equal(writes.length, beforeFilters, 'discovery filters never write settings');
  // Presentation-only translation fixture. Actual dictionaries supply every other key.
  await context.route('**/i18n/es.json', async route => {
    const response = await route.fetch();
    const dictionary = await response.json();
    dictionary['Daily briefing'] = 'Síntesis matinal';
    dictionary['Assemble a source-labelled agenda and priority briefing from supplied context.'] = 'Organiza una agenda con referencias singulares.';
    await route.fulfill({ response, json: dictionary });
  });
  await page.evaluate(async () => { await (await import('/naming.js')).setLanguage('es'); await (await import('/plugins.js')).loadPlugins(); });
  assert.match(await page.locator('[data-discovery-id="daily-briefing"]').innerText(), /Síntesis matinal/);
  await page.locator('#native-discovery-search').fill('matinal');
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 1, 'search matches the translated displayed name');
  await page.locator('#native-discovery-search').fill('singulares');
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 1, 'search matches the translated displayed summary');
  await page.locator('#native-discovery-search').fill('daily-briefing');
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 1, 'stable IDs remain searchable');
  await page.locator('#native-discovery-search').fill('');
  await page.evaluate(async () => { await (await import('/naming.js')).setLanguage('en'); await (await import('/plugins.js')).loadPlugins(); });
  await context.unroute('**/i18n/es.json');
  report.journeys.push('Translated displayed name and summary plus stable ID search using a presentation-only Spanish dictionary fixture');
  await page.locator('[data-howto="ab-plugins"] > summary').click();
  await page.locator('[data-howto="ab-plugins"] [data-q="candidates"] > summary').click();
  await page.locator('[data-howto="ab-plugins"] [data-q="candidates"]').getByRole('button', { name: 'Show me', exact: true }).click();
  assert.equal(await page.locator('#plg-discovery').evaluate(node => node.classList.contains('howto-pulse')), true);
  await page.locator('[data-howto="ab-plugins"] > summary').click();
  report.journeys.push('31 native candidates (12 A1 + 19 A2), 5 unchanged builtins, collapsed details and inert filters');
  await page.locator('[data-discovery-id="daily-briefing"]').evaluate(node => node.scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: join(output, 'plugins-desktop.png') });
  for (const id of ['daily-briefing', 'meeting-assistant', 'document-desk', 'research-notebook', 'project-handoff', 'weekly-review', 'inbox-triage', 'content-studio', 'image-workshop', 'spreadsheet-assistant', 'travel-planner', 'home-dashboard']) {
    await page.locator(`[data-discovery-id="${id}"]`).getByRole('button', { name: 'Review local candidate', exact: true }).click();
    const review = page.locator('#pla-review');
    await review.getByRole('button', { name: 'Install', exact: true }).waitFor();
    assert.equal(await page.locator('#pla-trust').count(), 1, `${id}: trust required`);
    assert.match(await review.innerText(), /not fenced|Not fenced|sandbox|Sandbox/);
    if (id === 'daily-briefing') await page.screenshot({ path: join(output, 'candidate-review.png') });
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('#plugin-add').waitFor({ state: 'hidden' });
    assert.equal(fixture.pm.list().length, 0, `${id}: cancellation leaves no installation`);
  }
  report.journeys.push('All 31 default-root packages stage through actual review and cancel with trust/fencing warnings; no installation');
  const daily = page.locator('[data-discovery-id="daily-briefing"]');
  await daily.getByRole('button', { name: 'Review local candidate', exact: true }).click();
  await page.locator('#pla-review').getByRole('button', { name: 'Install', exact: true }).click();
  await page.locator('#pla-status').getByText('Tick "I trust this plugin\'s author" first.', { exact: true }).waitFor();
  assert.equal(fixture.pm.list().length, 0);
  await page.locator('#pla-trust').check();
  await page.locator('#pla-review').getByRole('button', { name: 'Install', exact: true }).click();
  await page.locator('#plugin-add').waitFor({ state: 'hidden' });
  const installed = page.locator('[data-installed-plugin="daily-briefing"]');
  await installed.waitFor();
  assert.equal(await installed.getByRole('checkbox').isChecked(), false);
  assert.equal(fixture.pm.list()[0].origin, 'candidate');
  await daily.getByRole('button', { name: 'Show installed card', exact: true }).click();
  assert.equal(await installed.evaluate(node => node === document.activeElement), true);
  const association = fixture.installs.get('daily-briefing');
  assert.ok(association, 'exact signed association recorded without changing candidate origin');
  await openSettings('Get more', 'ab-store');
  const shelfCandidate = page.locator('.sto-card[data-item="daily-briefing"]');
  await shelfCandidate.getByRole('button', { name: 'Installation held', exact: true }).waitFor();
  assert.equal(await shelfCandidate.getByRole('button', { name: 'Get', exact: true }).count(), 0);
  assert.equal(await shelfCandidate.getByRole('button', { name: 'Update', exact: true }).count(), 0);
  await shelfCandidate.getByRole('button', { name: 'Open Daily briefing', exact: true }).click();
  const storePanel = page.locator('#store-panel');
  await storePanel.getByRole('button', { name: 'Open installed plugin card', exact: true }).waitFor();
  assert.match(await storePanel.innerText(), /Local workflow candidate/);
  assert.equal(await storePanel.getByRole('button', { name: 'Get', exact: true }).count(), 0);
  assert.equal(await storePanel.getByRole('button', { name: 'Update', exact: true }).count(), 0);
  await page.screenshot({ path: join(output, 'store-candidate-held.png') });
  await storePanel.getByRole('button', { name: 'Open installed plugin card', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.dataset.installedPlugin === 'daily-briefing');
  await openSettings('Get more', 'ab-store');
  await page.locator('#sto-mine-open').click();
  const mine = page.locator('#sto-view .stp-addon').filter({ hasText: 'Daily briefing' });
  await mine.waitFor();
  assert.match(await mine.innerText(), /Local workflow candidate/);
  assert.equal(await mine.getByRole('button', { name: 'Remove', exact: true }).count(), 0);
  assert.equal(await mine.getByRole('button', { name: /^Update/ }).count(), 0);
  await mine.getByRole('button', { name: 'Settings and log', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.dataset.installedPlugin === 'daily-briefing');
  report.journeys.push('Actual TEST-key verified StoreClient exact association keeps candidate origin; shelf/detail/My add-ons suppress Get/Update and focus actual Plugins card');
  async function toggleInstalled(on) {
    const response = page.waitForResponse(response => response.url().endsWith('/daily-briefing/enable') && response.request().method() === 'POST');
    await page.locator('[data-installed-plugin="daily-briefing"]').getByRole('checkbox').focus();
    await page.keyboard.press('Space');
    assert.equal((await response).status(), 200);
    await page.waitForFunction(expected => {
      const input = document.querySelector('[data-installed-plugin="daily-briefing"] input');
      return input?.checked === expected && !input.disabled;
    }, on);
  }
  await toggleInstalled(true);
  await toggleInstalled(false);
  await page.locator('[data-installed-plugin="daily-briefing"]').getByRole('button', { name: 'More for Daily briefing', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  await installed.waitFor({ state: 'detached' });
  assert.equal(fixture.pm.list().length, 0);
  report.journeys.push('Trust refusal, explicit approval, candidate origin, installed-card focus, explicit per-companion enable/off and actual removal');
  fixture.installs.upsert(association);
  await openSettings('Get more', 'ab-store');
  await page.locator('#sto-browse-open').click();
  await page.locator('.sto-card[data-item="daily-briefing"]').getByRole('button', { name: 'Open Daily briefing', exact: true }).click();
  await storePanel.getByRole('button', { name: 'Forget stale store record', exact: true }).click();
  await storePanel.getByRole('button', { name: 'Get', exact: true }).waitFor();
  assert.equal(fixture.installs.get('daily-briefing'), undefined);
  assert.equal(fixture.pm.list().length, 0);
  await page.locator('#stp-close').click();
  await openSettings('plugins', 'ab-plugins');
  report.journeys.push('Stale association hold offers explicit Forget stale store record through the actual remove route; no installation');
  const guides = page.locator('#plg-starter-guides');
  await guides.locator(':scope > summary').click();
  assert.equal(await guides.locator('[data-guide-id]').count(), 6);
  await guides.locator('[data-guide-id="private-local"] > summary').click();
  assert.match(await guides.innerText(), /Held: no verified listing/);
  assert.match(await guides.innerText(), /Verified store listing; review in Get more/);
  assert.equal(await guides.getByRole('button').count(), 0);
  await page.screenshot({ path: join(output, 'guides-desktop.png') });
  report.journeys.push('6 collapsed read-only guides, honest absent signed members and existing Settings links');
  await openSettings('MCP', 'ab-mcp');
  await page.locator('#mcp-discovery [data-discovery-id="gitlab"]').waitFor();
  assert.equal(await page.locator('#mcp-preset option').count(), 3, 'Blank and existing two presets');
  assert.equal(await page.locator('#mcp-discovery .addon-card').count(), 21);
  assert.equal(await page.locator('#mcp-discovery summary').getByText('View recipe preview', { exact: true }).count(), 7);
  assert.equal(await page.locator('#mcp-discovery summary').getByText('Why blocked', { exact: true }).count(), 14);
  await page.locator('#mcp-add > summary').click();
  await page.locator('#mcp-name').fill('synthetic-unsaved');
  await page.locator('#mcp-command').fill('synthetic-preserved');
  await page.locator('#mcp-secrets').fill('SYNTHETIC_TOKEN=unsaved-test-only');
  const beforePreview = writes.length;
  await page.locator('[data-discovery-id="linear"] summary').click();
  const linear = page.locator('[data-discovery-id="linear"]');
  assert.match(await linear.innerText(), /https:\/\/mcp.linear.app\/mcp/);
  assert.match(await linear.innerText(), /Authorization/);
  assert.equal(await linear.locator('input,select,textarea').count(), 0);
  assert.equal(await linear.getByRole('button').count(), 0);
  await page.locator('#mcp-discovery-status').selectOption('blocked');
  assert.equal(await page.locator('#mcp-discovery .addon-card').count(), 14);
  await page.locator('#mcp-discovery-status').selectOption('');
  assert.equal(writes.length, beforePreview);
  assert.equal(await page.locator('#mcp-name').inputValue(), 'synthetic-unsaved');
  assert.equal(await page.locator('#mcp-command').inputValue(), 'synthetic-preserved');
  assert.equal(await page.locator('#mcp-secrets').inputValue(), 'SYNTHETIC_TOKEN=unsaved-test-only');
  report.journeys.push('21 MCP entries / 7 previews / 14 blocked; HTTP header recipe remains inert and preserves unsaved manual form');
  // Adversarial presentation-only transport negative, starting with the genuine API payload.
  const hostileName = '<img src=x onerror="window.discoveryExecuted=true">';
  const hostileSummary = '<svg onload="window.discoveryExecuted=true">literal</svg>';
  const hostileDescription = '<script>window.discoveryExecuted=true</script>';
  await context.route('**/api/mcp/discovery/previews', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    const item = payload.investigations.find(item => item.id === 'markitdown');
    Object.assign(item, { name: hostileName, summary: hostileSummary, description: hostileDescription, source: 'javascript:window.discoveryExecuted=true', documentation: 'https://fixture-user:fixture-pass@example.com/private' });
    item.prerequisites.push('<button onclick="window.discoveryExecuted=true">literal prerequisite</button>');
    await route.fulfill({ response, json: payload });
  });
  const beforeHostile = writes.length;
  await page.evaluate(async () => { await (await import('/addons-discovery.js')).loadMcpDiscovery(); });
  const hostile = page.locator('[data-discovery-id="markitdown"]');
  await hostile.locator('summary').click();
  const hostileText = await hostile.innerText();
  assert.ok(hostileText.includes(hostileName));
  assert.ok(hostileText.includes(hostileSummary));
  assert.ok(hostileText.includes(hostileDescription));
  assert.equal(await hostile.locator('img,svg,script,button').count(), 0, 'hostile strings create no executable elements');
  assert.equal(await hostile.getByRole('link', { name: 'Source information', exact: true }).count(), 0, 'javascript source is not clickable');
  assert.equal(await hostile.getByRole('link', { name: 'Documentation', exact: true }).count(), 0, 'credential-bearing HTTPS documentation is not clickable');
  assert.equal(await page.evaluate(() => window.discoveryExecuted), undefined);
  assert.equal(writes.length, beforeHostile);
  assert.equal(await page.locator('#mcp-secrets').inputValue(), 'SYNTHETIC_TOKEN=unsaved-test-only');
  await page.screenshot({ path: join(output, 'hostile-presenter-literal.png') });
  await context.unroute('**/api/mcp/discovery/previews');
  await page.evaluate(async () => { await (await import('/addons-discovery.js')).loadMcpDiscovery(); });
  report.journeys.push('Presenter-only hostile API strings stay literal; javascript and credential-bearing HTTPS links are not clickable; no elements/execution/writes or form changes');
  // One contained discovery failure, using the actual app for every other request.
  await context.route('**/api/mcp/discovery/previews', route => route.fulfill({ status: 503, json: { error: 'Synthetic discovery failure' } }));
  await page.evaluate(async () => { const module = await import('/addons-discovery.js'); await module.loadMcpDiscovery(); });
  await page.locator('#mcp-discovery').getByRole('button', { name: 'Retry discovery' }).waitFor();
  assert.equal(await page.locator('#mcp-command').inputValue(), 'synthetic-preserved');
  await context.unroute('**/api/mcp/discovery/previews');
  await page.locator('#mcp-discovery').getByRole('button', { name: 'Retry discovery' }).click();
  await page.locator('#mcp-discovery [data-discovery-id="gitlab"]').waitFor();
  assert.equal(await page.locator('#mcp-secrets').inputValue(), 'SYNTHETIC_TOKEN=unsaved-test-only');
  report.journeys.push('Contained discovery failure and retry preserve existing MCP form and secrets draft');
  await page.locator('#mcp-add > summary').click();
  await page.screenshot({ path: join(output, 'mcp-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-discovery-id="dbhub"] summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-discovery-id="dbhub"] details').evaluate(node => node.open), true);
  await page.locator('[data-discovery-id="dbhub"]').scrollIntoViewIfNeeded();
  const width = await page.locator('.settings-page[data-page="ab-mcp"]').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  assert.ok(width.scroll <= width.client + 1, `mobile MCP overflow ${JSON.stringify(width)}`);
  await page.screenshot({ path: join(output, 'mcp-mobile.png') });
  report.layouts.push({ width: 390, ...width });
  report.journeys.push('390px layout, keyboard disclosure and visible focus');
  const mobileCandidates = page.waitForResponse(response => response.url().endsWith('/api/plugins/candidates') && response.request().method() === 'GET');
  await openSettings('plugins', 'ab-plugins');
  await mobileCandidates;
  await page.locator('[data-discovery-id="home-dashboard"]').waitFor();
  await page.locator('[data-discovery-id="daily-briefing"]').getByRole('button', { name: 'Review local candidate', exact: true }).scrollIntoViewIfNeeded();
  const phone = await page.locator('.settings-page[data-page="ab-plugins"]').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
  assert.ok(phone.scroll <= phone.client + 1, `mobile Plugins overflow ${JSON.stringify(phone)}`);
  await page.screenshot({ path: join(output, 'plugins-mobile.png') });
  await page.locator('[data-discovery-id="daily-briefing"]').getByRole('button', { name: 'Review local candidate', exact: true }).click();
  await page.locator('#pla-review').getByRole('button', { name: 'Install', exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'review-mobile.png') });
  await page.locator('#pla-review').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(fixture.pm.list().length, 0);
  report.layouts.push({ width: 390, page: 'plugins', ...phone });
  report.journeys.push('Mobile candidate review and Cancel; Plugins How do I and Show me use the real discovery region');
  assert.equal(fixture.app.providerCalls, 0);
  assert.deepEqual(fixture.unexpectedOutbound, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.unexpectedNetwork, []);
  await context.close();
  await fixture.close();
  fixture = await startAddonsBrowserFixture({ runtimeCopy: true });
  const negativeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  assert.equal((await negativeContext.request.post(`${fixture.origin}/api/login`, { data: { token: fixture.token } })).status(), 200);
  await negativeContext.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== fixture.origin) { report.unexpectedNetwork.push('blocked-nonfixture-origin'); await route.abort(); }
    else await route.continue();
  });
  const staged = await negativeContext.request.post(`${fixture.origin}/api/plugins/install`, { data: { candidate: 'daily-briefing' } });
  assert.equal(staged.status(), 200);
  const review = await staged.json();
  assert.equal((await negativeContext.request.post(`${fixture.origin}/api/plugins/daily-briefing/approve`, { data: { review: review.id, trust: true } })).status(), 200);
  fixture.damageCopiedPayloads();
  const heldPayload = await (await negativeContext.request.get(`${fixture.origin}/api/plugins/candidates`)).json();
  assert.equal(heldPayload.candidates.length, 31);
  for (const id of ['meeting-assistant', 'document-desk']) {
    const candidate = heldPayload.candidates.find(item => item.id === id);
    assert.equal(candidate.availability, 'held');
    assert.match(candidate.heldReason, /missing or changed/);
  }
  page = await negativeContext.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
  page.on('dialog', dialog => void dialog.accept());
  const negativeWrites = [];
  page.on('request', request => { if (!['GET', 'HEAD'].includes(request.method())) negativeWrites.push(new URL(request.url()).pathname); });
  await page.goto(fixture.origin);
  await page.locator('#disclosure-accept').click();
  await page.locator('#su-skip').click();
  await page.locator('#setup').waitFor({ state: 'hidden' });
  await openSettings('plugins', 'ab-plugins');
  await page.locator('[data-discovery-id="home-dashboard"]').waitFor();
  assert.equal(await page.locator('#plg-discovery .addon-card').count(), 31);
  assert.equal(await page.locator('#plg-builtin .plg-card').count(), 5);
  const beforeHeld = negativeWrites.filter(path => path === '/api/plugins/install').length;
  for (const id of ['meeting-assistant', 'document-desk']) {
    const candidate = page.locator(`[data-discovery-id="${id}"]`);
    assert.match(await candidate.innerText(), /missing or changed/);
    const action = candidate.getByRole('button', { name: 'Review local candidate', exact: true });
    assert.equal(await action.isDisabled(), true);
    await action.evaluate(node => node.click());
  }
  assert.equal(negativeWrites.filter(path => path === '/api/plugins/install').length, beforeHeld, 'held native cards cannot stage installation');
  const goodCandidate = page.locator('[data-discovery-id="home-dashboard"]');
  assert.equal(await goodCandidate.getByRole('button', { name: 'Review local candidate', exact: true }).isEnabled(), true);
  await goodCandidate.getByRole('button', { name: 'Review local candidate', exact: true }).click();
  await page.locator('#pla-review').getByRole('button', { name: 'Install', exact: true }).waitFor();
  await page.locator('#pla-review').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('[data-installed-plugin="daily-briefing"]').getByRole('checkbox').isChecked(), false);
  await page.locator('[data-discovery-id="meeting-assistant"]').getByRole('button', { name: 'Review local candidate', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'runtime-copy-held-native.png') });
  await openSettings('MCP', 'ab-mcp');
  await page.locator('#mcp-add > summary').click();
  await page.locator('#mcp-name').fill('runtime-copy-unsaved');
  await page.locator('#mcp-command').fill('runtime-copy-preserved');
  await page.locator('#mcp-secrets').fill('SYNTHETIC_TOKEN=runtime-copy-only');
  await page.evaluate(async () => { await (await import('/plugins.js')).loadPlugins(); });
  assert.equal(await page.locator('#mcp-name').inputValue(), 'runtime-copy-unsaved');
  assert.equal(await page.locator('#mcp-command').inputValue(), 'runtime-copy-preserved');
  assert.equal(await page.locator('#mcp-secrets').inputValue(), 'SYNTHETIC_TOKEN=runtime-copy-only');
  assert.equal(fixture.pm.list().length, 1);
  assert.equal(fixture.app.providerCalls, 0);
  assert.deepEqual(fixture.unexpectedOutbound, []);
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.unexpectedNetwork, []);
  report.journeys.push('Runtime-copy negative: manager imported from copied src with default roots, one missing manifest and one tampered entrypoint stay visible/held with disabled Review; intact candidate reviews, installed plugin and MCP draft remain intact');
  report.limits += ' The missing/tampered-payload negative copies only src, package.json, 5 builtins and 31 candidates into a fresh synthetic tree; it is runtime-copy/default-root qualification, not a whole Linux/native artifact qualification.';
  report.passed = true;
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
finally {
  if (!report.passed && page) {
    try { await page.screenshot({ path: join(output, 'failure.png') }); }
    catch { /* Keep the original failure when the browser has already closed. */ }
  }
  try { await browser?.close(); await fixture?.close(); }
  catch (error) { report.cleanupError = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
