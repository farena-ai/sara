#!/usr/bin/env node
// Manual regression suite: actual browser + actual app + fresh synthetic data only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startBrowserFixture } from '../test/fixtures/q4-browser.ts';

const args = process.argv.slice(2);
let output = resolve('outputs/q4/browser');
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--output' || !args[i + 1]) throw new Error('Usage: node scripts/check-browser.mjs [--output path]');
  output = resolve(args[++i]);
}
await mkdir(output, { recursive: true });
const report = { suite: 'Q1-Q4 synthetic actual-browser regression', passed: false, journeys: [], layouts: [], unexpectedNetwork: [], pageErrors: [], limits: 'Synthetic loopback fixture; no real model, bot delivery, owner data, screen reader or physical-device acceptance.' };
let fixture, browser, page;
try {
  let modulePath = process.env.SARA_PLAYWRIGHT_MODULE;
  if (!modulePath) {
    try { modulePath = createRequire(import.meta.url).resolve('playwright'); }
    catch { throw new Error('Existing Playwright module required. Set SARA_PLAYWRIGHT_MODULE to an installed playwright/index.mjs absolute path; no dependency is installed by this script.'); }
  }
  const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
  fixture = await startBrowserFixture();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow', reducedMotion: 'reduce' });
  const login = await context.request.post(`${fixture.origin}/api/login`, { data: { token: fixture.token } });
  assert.equal(login.status(), 200, 'synthetic owner login');
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== fixture.origin) { report.unexpectedNetwork.push('blocked-nonfixture-origin'); await route.abort(); }
    else await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.stack ?? error.message));
  const writes = [];
  page.on('request', request => { if (request.method() === 'POST') writes.push(new URL(request.url()).pathname); });
  await page.goto(fixture.origin);
  await page.locator('#disclosure-accept').click();
  await page.locator('#su-skip').click();
  await page.locator('#setup').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#setup').evaluate(el => el.open), false, 'setup closes after skipped save');
  await page.locator('#settings[open]').waitFor();
  await page.keyboard.press('Escape');
  // Q1: skipped setup is recoverable and compact sidebar remains keyboard-operable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#bb-more').click();
  await page.locator('#close-sidebar').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('sidebar-open')), false, 'keyboard close collapses sidebar');
  report.journeys.push('Q1 skipped setup and keyboard sidebar');
  async function openSettings(name, id) {
    if (!(await page.locator('#settings').evaluate(el => el.open))) await page.keyboard.press('Control+,');
    await page.locator('#settings[open]').waitFor();
    if (await page.locator('#settings').evaluate(el => el.classList.contains('page-open'))) await page.locator('#settings-back').click();
    await page.locator('#settings-search').fill(name);
    await page.locator(`#settings-results a[data-result="${id}"]`).click();
  }
  await openSettings('operations', 'dh-operations');
  await page.locator('#operations-content').getByText('Measurement window', { exact: true }).waitFor();
  assert.match(await page.locator('#operations-content').innerText(), /HTTP response measurements/);
  await page.locator('#settings-back').click();
  assert.equal(await page.locator('#settings').evaluate(el => el.classList.contains('page-open')), false);
  report.journeys.push('Q2 focused Settings search and Back');
  await page.locator('#settings-search').fill('recovery');
  await page.locator('#settings-results a[data-result="dh-recovery"]').click();
  await page.locator('#recovery-content').getByRole('button', { name: 'Review restart', exact: true }).click();
  const dialog = page.locator('.recovery-dialog[open]');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  const beforeRequests = fixture.providerRequests();
  await page.keyboard.press('Escape');
  await page.goto(`${fixture.origin}/#c=${encodeURIComponent(fixture.conversationId)}`);
  await page.locator('#bb-chat').click();
  // Set a draft through the real editor; review must keep it verbatim.
  await page.locator('#input').fill('Synthetic unsent draft');
  await openSettings('recovery', 'dh-recovery');
  await page.locator('#recovery-content').getByRole('button', { name: 'Review restart', exact: true }).click();
  assert.equal(await dialog.getByRole('button', { name: 'Use in chat', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  assert.equal(await page.locator('#input').inputValue(), 'Synthetic unsent draft');
  assert.equal(fixture.providerRequests(), beforeRequests);
  report.journeys.push('Q3 review preserves draft and never sends');
  const recovery = page.locator('#recovery-content');
  assert.equal(await recovery.locator('#archive-before').inputValue(), '');
  await recovery.getByRole('button', { name: 'Preview archive', exact: true }).click();
  await recovery.getByText('Enter a valid UTC cutoff in the past before previewing.', { exact: true }).waitFor();
  const cutoff = '2026-01-01T00:00:00.000Z';
  await recovery.locator('#archive-before').fill(cutoff);
  const archiveWrites = () => writes.filter(path => path === '/api/deliveries/archive').length;
  const writesBefore = archiveWrites();
  await recovery.getByRole('button', { name: 'Preview archive', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm archive batch', exact: true }).waitFor();
  assert.equal(archiveWrites(), writesBefore, 'preview never archives');
  await dialog.getByRole('button', { name: 'Confirm archive batch', exact: true }).click();
  await recovery.getByText('Archived: 1. Remaining eligible: 0.', { exact: true }).waitFor();
  assert.equal(archiveWrites(), writesBefore + 1);
  assert.equal(await recovery.locator('#archive-before').inputValue(), cutoff);
  await recovery.getByRole('button', { name: 'Archived', exact: true }).click();
  await recovery.getByText('Platform acknowledged — not proof of reading', { exact: false }).waitFor();
  assert.equal(await recovery.getByRole('button', { name: 'Review message', exact: true }).count(), 0);
  await recovery.getByRole('button', { name: 'Unresolved', exact: true }).click();
  await recovery.getByText('Outcome unknown — check before trying again', { exact: false }).waitFor();
  // Error response exercises actual operations handler recovery, not synthetic DOM assertions.
  await page.route('**/api/operations', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic unavailable"}' }));
  await openSettings('operations', 'dh-operations');
  await page.getByText('Operations unavailable. Refresh and try again.', { exact: true }).waitFor();
  await page.unroute('**/api/operations');
  await page.getByRole('button', { name: 'Refresh operations', exact: true }).click();
  await page.getByText('Measurement window', { exact: true }).waitFor();
  report.journeys.push('Q4 operations error/refresh and explicit archive/unknown preservation');
  for (const theme of ['dark', 'light']) for (const width of [390, 720, 1440]) {
    await page.evaluate(theme => { localStorage.setItem('sara.theme', theme); document.documentElement.dataset.theme = theme; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${theme}/${width} document must fit`);
    await page.screenshot({ path: join(output, `operations-${theme}-${width}.png`), fullPage: true });
    report.layouts.push({ theme, width, overflow });
  }
  assert.equal(fixture.providerRequests(), 0, 'no automatic chat/model requests');
  assert.deepEqual(report.unexpectedNetwork, []);
  assert.deepEqual(fixture.unexpectedOutbound, []);
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => browser?.close()),
    Promise.resolve().then(() => fixture?.close()),
  ]);
  const failedCleanup = cleanup.filter(result => result.status === 'rejected');
  if (failedCleanup.length) {
    report.passed = false;
    report.cleanupErrors = failedCleanup.map(result => String(result.reason));
    process.exitCode = 1;
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ passed: report.passed, journeys: report.journeys, output }));
