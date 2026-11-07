#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startSessionContinuityBrowserFixture } from '../test/fixtures/session-continuity-browser.ts';
const args = process.argv.slice(2);
const output = args.length === 0 ? resolve('outputs/r1a/task-3-browser') : args.length === 2 && args[0] === '--output' ? resolve(args[1]) : (() => { throw Error('Usage: node scripts/check-session-continuity-browser.mjs [--output path]'); })();
await mkdir(output, { recursive: true });
const report = { passed: false, journeys: [], layouts: [], pageErrors: [], unexpectedNetwork: [], limits: 'Synthetic loopback actual app and real Chromium only; no owner data, paid inference, production, physical novice or screen-reader acceptance.' };
const fixture = await startSessionContinuityBrowserFixture(); let browser; let page;
try {
  const modulePath = process.env.SARA_PLAYWRIGHT_MODULE ?? createRequire(import.meta.url).resolve('playwright');
  report.playwrightModule = modulePath;
  const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
  report.browserExecutable = chromium.executablePath(); browser = await chromium.launch({ headless: true });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin !== fixture.origin) { report.unexpectedNetwork.push('blocked-nonfixture-origin'); await route.abort(); } else await route.continue();
  });
  assert.equal((await context.request.post(`${fixture.origin}/api/login`, { data: { token: fixture.token } })).status(), 200);
  page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(fixture.origin); await page.locator('#disclosure-accept').click(); await page.locator('#su-skip').click(); await page.locator('#setup').waitFor({ state: 'hidden' });
  if (!(await page.locator('#settings').evaluate(el => el.open))) await page.keyboard.press('Control+,');
  const chatApps = page.locator('#settings-nav-list .settings-nav-group[data-group="Chat apps"]');
  const chatAppsHeading = chatApps.locator('.settings-nav-head');
  if ((await chatAppsHeading.getAttribute('aria-expanded')) !== 'true') await chatAppsHeading.click();
  assert.deepEqual(await chatApps.locator('.settings-nav-item').evaluateAll(items => items.map(item => item.dataset.page)), ['co-telegram', 'co-discord', 'co-signal', 'co-email', 'co-whatsapp', 'co-matrix', 'co-imessage', 'co-slack', 'co-pickup', 'co-continuity']);
  await chatApps.locator('[data-page="co-continuity"]').click();
  const toggle = page.getByLabel('Use context across my sessions', { exact: true });
  await toggle.waitFor(); assert.equal(await toggle.isChecked(), true);
  assert.ok((await page.locator('#settings-help-text').textContent()).trim().length > 0);
  assert.equal(await page.locator('#settings-help-link').getAttribute('href'), '/help#session-continuity');
  const howto = page.locator('#settings-howto details[data-howto="co-continuity"]');
  await howto.locator(':scope > summary').click();
  const toggleHelp = howto.locator('[data-q="toggle"]');
  await toggleHelp.locator(':scope > summary').click();
  await toggleHelp.getByRole('button', { name: 'Show me', exact: true }).click();
  assert.equal(await toggle.evaluate(el => el === document.activeElement), true, 'Show me focuses the actual continuity checkbox');
  const helpSteps = {};
  for (const id of ['toggle', 'inspect', 'clear']) {
    const question = howto.locator(`[data-q="${id}"]`);
    if (!(await question.evaluate(el => el.open))) await question.locator(':scope > summary').click();
    await question.locator('li').first().waitFor(); helpSteps[id] = await question.locator('li').allTextContents();
  }
  report.howtoSteps = helpSteps;
  await howto.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, 'continuity-howto-1440.png'), fullPage: true });
  await howto.locator(':scope > summary').click();
  report.journeys.push('ordinary Chat apps navigation preserves all previous pages and opens continuity with real page help, How do I steps and Show me checkbox focus');
  await toggle.uncheck();
  await page.getByRole('status').filter({ hasText: 'Session continuity is off. Saved notes stay available to inspect or clear.' }).waitFor();
  assert.deepEqual(fixture.chats(), { ...fixture.preservedChats, continuity: { enabled: false } });
  await page.reload(); await page.locator('#settings').waitFor({ state: 'attached' }); if (!(await page.locator('#settings').evaluate(el => el.open))) await page.keyboard.press('Control+,');
  await page.locator('#settings-search').fill('session continuity'); await page.locator('#settings-results a[data-result="co-continuity"]').click();
  assert.equal(await toggle.isChecked(), false); await toggle.check();
  await page.getByRole('status').filter({ hasText: 'Session continuity is on.' }).waitFor();
  assert.deepEqual(fixture.chats(), { ...fixture.preservedChats, continuity: { enabled: true } });
  report.journeys.push('toggle persists through reload and preserves pickup/while-busy settings');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await toggle.uncheck();
    await page.getByRole('status').filter({ hasText: 'Session continuity is off. Saved notes stay available to inspect or clear.' }).waitFor();
    assert.deepEqual(fixture.chats(), { ...fixture.preservedChats, continuity: { enabled: false } });
    await toggle.check(); await page.getByRole('status').filter({ hasText: 'Session continuity is on.' }).waitFor();
    await toggle.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(output, `continuity-settings-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  report.journeys.push('desktop and 390px mobile settings toggle through actual persisted API');
  await page.keyboard.press('Escape');
  await page.locator(`#conversations [data-id="${fixture.targetId}"]`).click();
  await page.locator('#conv-settings-btn').click();
  const inspector = page.locator('#cs-continuity');
  await inspector.getByRole('button', { name: 'Show saved session context', exact: true }).click();
  await inspector.getByText(fixture.raw, { exact: true }).waitFor();
  assert.equal(await inspector.locator('img,b').count(), 0); assert.equal(await page.evaluate(() => window.__continuityPwned), undefined);
  await inspector.getByText('<b>Source session</b>', { exact: true }).waitFor();
  report.journeys.push('inspector source/title/time/expiry and malicious note stay literal text');
  let deletes = 0; page.on('request', request => { if (request.method() === 'DELETE' && request.url().endsWith('/continuity')) deletes++; });
  const clear = inspector.getByRole('button', { name: 'Clear saved context', exact: true });
  const confirm = inspector.getByRole('button', { name: 'Confirm clear', exact: true });
  const regressions = [];
  const expectFocus = async (name, control) => {
    try {
      assert.equal(await control.isEnabled(), true, `${name}: destination is enabled`);
      assert.equal(await control.evaluate(el => el === document.activeElement), true, `${name}: destination owns activeElement`);
    } catch (error) { regressions.push({ name, error: error.stack ?? String(error) }); }
  };
  await clear.click(); await inspector.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(deletes, 0); assert.equal(fixture.inspect().handoffs.length, 1);
  await expectFocus('cancel restores Clear focus', clear);
  await clear.click(); await page.keyboard.press('Escape');
  assert.equal(await confirm.count(), 0); assert.equal(await page.locator('#conv-settings').evaluate(el => el.open), true); assert.equal(deletes, 0);
  await expectFocus('Escape restores Clear focus', clear);
  report.journeys.push('Cancel and Escape make no delete request and keep conversation dialog open');
  let reject = true;
  await page.route('**/api/conversations/*/continuity', async route => {
    if (reject && route.request().method() === 'DELETE') { reject = false; await route.fulfill({ status: 500, json: { error: 'Synthetic failure' } }); } else await route.continue();
  });
  await clear.click(); await confirm.click(); await inspector.getByRole('status').filter({ hasText: 'Could not clear saved context. Your view is kept; try again.' }).waitFor();
  await inspector.getByText(fixture.raw, { exact: true }).waitFor(); assert.equal(fixture.inspect().handoffs.length, 1);
  await expectFocus('retryable failure restores enabled Clear focus', clear);
  report.journeys.push('server failure retains context view and permits retry');
  fixture.write('Concurrent saved context');
  await clear.click(); await confirm.click();
  await inspector.getByRole('status').filter({ hasText: 'Saved context changed elsewhere. Your view is kept. Reload before clearing.' }).waitFor();
  await inspector.getByText(fixture.raw, { exact: true }).waitFor(); assert.equal(await clear.isDisabled(), true); assert.equal(fixture.inspect().handoffs[0].text, 'Concurrent saved context');
  await expectFocus('conflict restores enabled Reload focus', inspector.getByRole('button', { name: 'Reload saved context', exact: true }));
  report.journeys.push('real concurrent service write yields actual HTTP409 and retains stale view until reload');
  await inspector.getByRole('button', { name: 'Reload saved context', exact: true }).click();
  await inspector.getByText('Concurrent saved context', { exact: true }).waitFor();
  await inspector.getByText('Earlier note (history only)', { exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 }); await inspector.scrollIntoViewIfNeeded();
    const size = await inspector.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
    assert.ok(size.scroll <= size.client + 1 && size.left >= 0 && size.right <= width, `inspector fits ${width}: ${JSON.stringify(size)}`);
    report.layouts.push({ width, ...size }); await page.screenshot({ path: resolve(output, `continuity-${width}.png`), fullPage: true });
  }
  await clear.focus(); await page.keyboard.press('Enter'); await confirm.focus(); await page.keyboard.press('Enter');
  await inspector.getByRole('status').filter({ hasText: 'Saved context cleared for this session.' }).waitFor();
  assert.equal(fixture.inspect().handoffs.length, 0); assert.equal(fixture.inspect(fixture.otherId).handoffs.length, 1);
  await expectFocus('success restores enabled Reload focus', inspector.getByRole('button', { name: 'Reload saved context', exact: true }));
  report.journeys.push('keyboard confirmed clear removes only selected target context');
  await page.screenshot({ path: resolve(output, 'continuity-cleared-390.png'), fullPage: true });
  try {
    fixture.write('Expired synthetic context must remain erasable');
    fixture.advancePastExpiry();
    assert.equal((await context.request.put(`${fixture.origin}/api/chats/continuity`, { data: { enabled: false } })).status(), 200);
    const view = await (await context.request.get(`${fixture.origin}/api/conversations/${fixture.targetId}/continuity`)).json();
    assert.equal(view.currentId, 0); assert.deepEqual(view.handoffs, []);
    assert.equal(fixture.retained(), 1); assert.equal(fixture.retained(fixture.otherId), 1);
    const reload = inspector.getByRole('button', { name: 'Reload saved context', exact: true });
    await reload.click(); await inspector.getByRole('status').filter({ hasText: 'Saved session context loaded.' }).waitFor();
    assert.equal(await inspector.locator('.continuity-note').count(), 0, 'Expired context stays hidden');
    assert.equal(await clear.isVisible(), true, 'Zero eligible revision must keep explicit clear available');
    assert.equal(await clear.isEnabled(), true, 'Zero eligible revision permits confirmation');
    await clear.click();
    const mutation = page.waitForRequest(request => request.method() === 'DELETE' && new URL(request.url()).pathname === `/api/conversations/${fixture.targetId}/continuity`);
    await confirm.click(); assert.deepEqual((await mutation).postDataJSON(), { expectedId: 0 });
    await inspector.getByRole('status').filter({ hasText: 'Saved context cleared for this session.' }).waitFor();
    assert.equal(fixture.retained(), 0); assert.equal(fixture.retained(fixture.otherId), 1);
    assert.equal(fixture.chats().continuity.enabled, false);
    await expectFocus('expired zero-CAS success restores enabled Reload focus', reload);
    report.journeys.push('feature-off zero-CAS clear removes expired retained rows only for selected target');
    await page.screenshot({ path: resolve(output, 'continuity-expired-cleared-390.png'), fullPage: true });
  } catch (error) { regressions.push({ name: 'expired retained target clear while disabled', error: error.stack ?? String(error) }); }
  report.regressions = regressions;
  assert.deepEqual(regressions, [], 'actual expiry-clear and enabled focus regressions');
  report.journeys.push('enabled post-result focus after success, retryable failure and stale conflict; Cancel/Escape retain focus');
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.unexpectedNetwork, []); assert.deepEqual(fixture.unexpectedOutbound, []); assert.equal(fixture.providerRequests(), 0);
  report.syntheticUpdateChecks = fixture.syntheticUpdateChecks();
  report.passed = true;
} catch (error) { await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); fixture.preserve(); report.fixtureData = fixture.dataDir; report.error = error.stack ?? String(error); throw error; }
finally { await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await fixture.close(); }
console.log(JSON.stringify(report, null, 2));
