#!/usr/bin/env node
// Manual isolated actual-app browser journey; existing compatible Playwright only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startProjectCheckpointBrowserFixture } from '../test/fixtures/project-checkpoints-browser.ts';

const args = process.argv.slice(2);
let serve = false;
let output = resolve('outputs/expansion/ui-browser');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--serve') serve = true;
  else if (args[i] === '--output' && args[i + 1] && !args[i + 1].startsWith('--')) output = resolve(args[++i]);
  else throw Error('Usage: node scripts/check-project-checkpoints-browser.mjs [--serve] [--output path]');
}
await mkdir(output, { recursive: true });
const fixture = await startProjectCheckpointBrowserFixture({ preserveData: serve });
if (serve) {
  await writeFile(resolve(output, 'fixture.json'), JSON.stringify({ origin: fixture.origin, token: fixture.token, dataDir: fixture.dataDir, scope: 'invented temporary loopback owner fixture; retained after shutdown for review' }, null, 2));
  console.log(`Synthetic checkpoint fixture ready at ${fixture.origin}; local credentials in ${resolve(output, 'fixture.json')}`);
  const stop = async () => { await fixture.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await new Promise(() => {});
} else {
  const report = { passed: false, journeys: [], pageErrors: [], unexpectedNetwork: [], layouts: [], limits: 'Invented loopback data, real application and HTTP checkpoint API; no owner data, paid providers, production, physical device or screen-reader acceptance.' };
  let browser;
  try {
    const modulePath = process.env.SARA_PLAYWRIGHT_MODULE ?? createRequire(import.meta.url).resolve('playwright');
    const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin !== fixture.origin) { report.unexpectedNetwork.push('blocked-nonfixture-origin'); await route.abort(); }
      else await route.continue();
    });
    assert.equal((await context.request.post(`${fixture.origin}/api/login`, { data: { token: fixture.token } })).status(), 200);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(error.message));
    await page.goto(fixture.origin);
    await page.locator('#disclosure-accept').click(); await page.locator('#su-skip').click();
    await page.locator('#setup').waitFor({ state: 'hidden' });
    if (!(await page.locator('#settings').evaluate(el => el.open))) await page.keyboard.press('Control+,');
    await page.locator('#settings-search').fill('coding projects');
    await page.locator('#settings-results a[data-result="ab-projects"]').click();
    const editor = page.locator('.project-checkpoint').first();
    await editor.locator(':scope > summary').click();
    await editor.getByRole('status').filter({ hasText: 'Checkpoint loaded.' }).waitFor();
    const logic = editor.getByLabel('Current logic', { exact: true });
    const blockers = editor.getByLabel('Blockers (one per line)', { exact: true });
    const step = editor.getByLabel('Next step 1', { exact: true });
    const raw = '<img src=x onerror="window.__checkpointPwned=1">';
    await logic.fill(raw); await blockers.fill('Synthetic review'); await step.fill('Run isolated checks');
    await editor.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'Checkpoint saved.' }).waitFor();
    const view = async () => (await context.request.get(`${fixture.origin}/api/code-projects/checkpoints?workspace=main&path=.`)).json();
    assert.equal((await view()).current.logic, raw);
    assert.equal(await editor.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.__checkpointPwned), undefined);
    await editor.locator(':scope > div').first().locator('summary').click();
    await editor.getByText(raw, { exact: true }).first().waitFor();
    report.journeys.push('first save through actual API, saved source/time/history and literal markup');
    let rejectNext = true;
    await page.route('**/api/code-projects/checkpoints', async route => {
      if (rejectNext && route.request().method() === 'POST') { rejectNext = false; await route.fulfill({ status: 400, json: { error: 'Synthetic validation rejection' } }); }
      else await route.continue();
    });
    await logic.fill('Draft after validation');
    await editor.getByRole('button', { name: 'Replace checkpoint', exact: true }).click();
    await editor.getByRole('button', { name: 'Confirm replace', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'Checkpoint rejected.' }).waitFor();
    assert.equal(await logic.inputValue(), 'Draft after validation');
    await editor.getByRole('button', { name: 'Replace checkpoint', exact: true }).click();
    await editor.getByRole('button', { name: 'Confirm replace', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'Checkpoint saved.' }).waitFor();
    assert.equal((await view()).history.length, 2);
    report.journeys.push('400 keeps draft and corrected replacement retries without reload');
    const before = await view();
    assert.equal((await context.request.post(`${fixture.origin}/api/code-projects/checkpoints`, { data: { workspace: 'main', path: '.', logic: 'Another writer saved this', blockers: [], nextSteps: ['Review latest state'], expectedId: before.current.id } })).status(), 200);
    await logic.fill('Keep conflict draft');
    await editor.getByRole('button', { name: 'Replace checkpoint', exact: true }).click(); await editor.getByRole('button', { name: 'Confirm replace', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'changed elsewhere' }).waitFor();
    assert.equal(await logic.inputValue(), 'Keep conflict draft'); assert.equal(await editor.getByRole('button', { name: 'Replace checkpoint', exact: true }).isDisabled(), true);
    await editor.getByRole('button', { name: 'Reload saved checkpoint', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'Checkpoint loaded.' }).waitFor(); assert.equal(await logic.inputValue(), 'Another writer saved this');
    report.journeys.push('real concurrent HTTP writer produces 409; explicit reload reconciles');
    await editor.getByRole('button', { name: 'Replace checkpoint', exact: true }).click(); await page.keyboard.press('Escape');
    assert.equal(await editor.getByRole('button', { name: 'Confirm replace', exact: true }).count(), 0); assert.equal(await page.locator('#settings').evaluate(el => el.open), true);
    await logic.focus(); assert.equal(await logic.evaluate(el => el === document.activeElement), true);
    await editor.getByLabel('Help: Current logic', { exact: true }).focus(); await page.keyboard.press('Enter');
    await editor.getByText('Explain the current approach in 1–1500 characters. This is saved context, not a test result.', { exact: true }).waitFor();
    report.journeys.push('native labels, keyboard help and Escape cancels replacement without closing Settings');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 }); await editor.scrollIntoViewIfNeeded();
      const size = await editor.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }));
      assert.ok(size.scroll <= size.client + 1, `checkpoint fits width ${width}: ${JSON.stringify(size)}`);
      assert.ok(size.left >= 0 && size.right <= width, `checkpoint within viewport ${width}`);
      report.layouts.push({ width, ...size });
      await page.screenshot({ path: resolve(output, `checkpoint-${width}.png`), fullPage: true });
    }
    await editor.getByRole('button', { name: 'Clear checkpoint history', exact: true }).click();
    assert.equal((await view()).history.length, 3);
    await editor.getByRole('button', { name: 'Confirm clear', exact: true }).click();
    await editor.getByRole('status').filter({ hasText: 'history cleared' }).waitFor(); assert.equal((await view()).history.length, 0);
    assert.equal(await logic.inputValue(), 'Another writer saved this');
    report.journeys.push('clear requires confirmation, removes all saved history and keeps editor fields');
    const regressions = [];
    for (const [name, journey] of [
      ['note mutations preserve draft and reconciliation', async () => {
        const card = page.locator('#pj-list .pj-card').first();
        const noteInput = card.getByPlaceholder('e.g. Run npm run build before the tests');
        const addNote = card.getByRole('button', { name: 'Add note', exact: true });
        const originalEditor = await editor.elementHandle();
        await logic.fill('Unsent checkpoint beside notes'); await step.fill('Keep draft after note changes');
        await noteInput.fill('Synthetic adjacent note'); await addNote.click();
        await card.locator('.pj-notes li').filter({ hasText: 'Synthetic adjacent note' }).waitFor();
        assert.equal(await originalEditor.evaluate(el => el.isConnected), true, 'adding a note keeps the original checkpoint editor');
        assert.equal(await logic.inputValue(), 'Unsent checkpoint beside notes');
        await noteInput.fill('Synthetic adjacent note'); await addNote.click();
        await page.waitForFunction(() => document.querySelector('#pj-list .add-row input').value === '');
        assert.equal(await card.locator('.pj-notes li').count(), 1, 'duplicate confirmed note id appears once');
        const checkpointData = { workspace: 'main', path: '.', logic: 'Concurrent checkpoint', blockers: [], nextSteps: ['Review concurrent state'], expectedId: 0 };
        assert.equal((await context.request.post(`${fixture.origin}/api/code-projects/checkpoints`, { data: checkpointData })).status(), 200);
        await editor.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
        await editor.getByRole('status').filter({ hasText: 'changed elsewhere' }).waitFor();
        const conflictMessage = await editor.getByRole('status').textContent();
        await card.locator('.pj-notes button').click();
        await page.waitForFunction(() => document.querySelectorAll('#pj-list .pj-notes li').length === 0);
        assert.equal(await originalEditor.evaluate(el => el.isConnected), true, 'deleting a note keeps the original checkpoint editor');
        assert.equal(await logic.inputValue(), 'Unsent checkpoint beside notes');
        assert.equal(await editor.getByRole('status').textContent(), conflictMessage);
        assert.equal(await editor.getByRole('button', { name: 'Save checkpoint', exact: true }).isDisabled(), true);
        await noteInput.fill('Note during reconciliation'); await addNote.click();
        await card.locator('.pj-notes li').filter({ hasText: 'Note during reconciliation' }).waitFor();
        assert.equal(await logic.inputValue(), 'Unsent checkpoint beside notes');
        assert.equal(await editor.getByRole('status').textContent(), conflictMessage);
        assert.equal(await editor.getByRole('button', { name: 'Save checkpoint', exact: true }).isDisabled(), true);
        await editor.getByRole('button', { name: 'Reload saved checkpoint', exact: true }).click();
        await editor.getByRole('status').filter({ hasText: 'Checkpoint loaded.' }).waitFor();
      }],
      ['late workspace response cannot install another workspace writer', async () => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        const selected = page.locator('#pj-ws');
        const checkpointReads = [];
        const recordRead = request => {
          const url = new URL(request.url());
          if (url.pathname === '/api/code-projects/checkpoints' && request.method() === 'GET') checkpointReads.push(url.searchParams.get('workspace'));
        };
        page.on('request', recordRead);
        let releaseA;
        let receivedA;
        const aStarted = new Promise(resolve => { receivedA = resolve; });
        const aReleased = new Promise(resolve => { releaseA = resolve; });
        let heldA = false;
        const projectRoute = async route => {
          const url = new URL(route.request().url());
          if (url.pathname === '/api/code-projects' && url.searchParams.get('workspace') === 'main' && !heldA) {
            heldA = true;
            const response = await route.fetch();
            receivedA(); await aReleased; await route.fulfill({ response });
          } else await route.continue();
        };
        await page.route('**/api/code-projects?*', projectRoute);
        try {
          await page.locator('#pj-refresh').click(); await aStarted;
          await selected.selectOption('other');
          await page.locator('#pj-list h4').filter({ hasText: 'checkpoint-fixture-other' }).waitFor();
          const chosenEditor = await editor.elementHandle();
          releaseA();
          await page.waitForResponse(response => new URL(response.url()).pathname === '/api/code-projects' && new URL(response.url()).searchParams.get('workspace') === 'main');
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          assert.equal(await selected.inputValue(), 'other');
          assert.match(await page.locator('#pj-list h4').textContent(), /checkpoint-fixture-other/);
          assert.equal(await chosenEditor.evaluate(el => el.isConnected), true);
          assert.deepEqual(checkpointReads, ['other'], 'selected workspace alone creates a checkpoint reader');
          await editor.locator(':scope > summary').click();
          await editor.getByRole('status').filter({ hasText: 'Checkpoint loaded.' }).waitFor();
          await logic.fill('Selected other workspace'); await step.fill('Write only other');
          const mutation = page.waitForRequest(request => new URL(request.url()).pathname === '/api/code-projects/checkpoints' && request.method() === 'POST');
          await editor.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
          assert.equal((await mutation).postDataJSON().workspace, 'other');
          await editor.getByRole('status').filter({ hasText: 'Checkpoint saved.' }).waitFor();
          const other = await (await context.request.get(`${fixture.origin}/api/code-projects/checkpoints?workspace=other&path=.`)).json();
          assert.equal(other.current.logic, 'Selected other workspace');
          assert.notEqual((await view()).current?.logic, 'Selected other workspace');
        } finally { releaseA(); page.off('request', recordRead); await page.unroute('**/api/code-projects?*', projectRoute); }
      }],
    ]) {
      try { await journey(); report.journeys.push(name); }
      catch (error) { regressions.push({ name, error: error.stack ?? String(error) }); }
    }
    report.regressions = regressions;
    assert.deepEqual(regressions, [], 'actual parent integration regressions');
    assert.equal(fixture.providerRequests(), 0); assert.deepEqual(fixture.unexpectedOutbound, []); assert.deepEqual(report.unexpectedNetwork, []); assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) { fixture.preserve(); report.fixtureData = fixture.dataDir; report.error = error.stack ?? String(error); throw error; }
  finally { await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await browser?.close(); await fixture.close(); }
  console.log(JSON.stringify(report, null, 2));
}
