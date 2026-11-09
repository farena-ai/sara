#!/usr/bin/env node
// R1B1-R1B3 real-browser journeys for Settings → Chat apps → Session continuity → Shared scenes.
//   node scripts/check-scenes-browser.mjs [--output dir]                      in-process synthetic fixture
//   node scripts/check-scenes-browser.mjs --origin URL --token-file F [--output dir]   a throwaway server you started
// Uses an existing Playwright (SARA_PLAYWRIGHT_MODULE); installs nothing; never calls a model.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const output = resolve(opt('--output') ?? 'outputs/r1b1');
await mkdir(output, { recursive: true });
const report = { passed: false, mode: opt('--origin') ? 'external-throwaway-server' : 'fixture', journeys: [], screenshots: [], pageErrors: [], unexpectedNetwork: [], chatRequests: 0 };
let fixture; let origin; let token;
if (opt('--origin')) { origin = opt('--origin'); token = (await readFile(opt('--token-file'), 'utf8')).trim(); }
else { const { startScenesBrowserFixture } = await import('../test/fixtures/shared-scenes-browser.ts'); fixture = await startScenesBrowserFixture(); origin = fixture.origin; token = fixture.token; }
let browser; let page;
try {
  const modulePath = process.env.SARA_PLAYWRIGHT_MODULE ?? createRequire(import.meta.url).resolve('playwright');
  const { chromium } = await import(isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { report.unexpectedNetwork.push(url.origin); await route.abort(); return; }
    if (/^\/api\/(chat|conversations\/[^/]+\/messages)/.test(url.pathname) && route.request().method() === 'POST') report.chatRequests++;
    await route.continue();
  });
  assert.equal((await context.request.post(`${origin}/api/login`, { data: { token } })).status(), 200);
  const api = async (path, method = 'GET', data) => { const r = await context.request.fetch(`${origin}/api${path}`, { method, ...(data === undefined ? {} : { data }) }); return { status: r.status(), body: await r.json().catch(() => ({})) }; };
  const web = (await api('/conversations', 'POST', {})).body;
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(origin);
  await page.locator('#disclosure-accept').click();
  const skip = page.locator('#su-skip');
  await skip.waitFor({ state: 'visible', timeout: 5000 }).then(() => skip.click(), () => {});
  await page.locator('#setup').waitFor({ state: 'hidden' });
  // First run may open Settings by itself a moment after setup closes; only click when it stays closed.
  const opened = await page.waitForFunction(() => document.querySelector('#settings')?.open === true, null, { timeout: 3000 }).then(() => true, () => false);
  if (!opened) await page.locator('#open-settings').click();
  await page.waitForFunction(() => document.querySelector('#settings')?.open === true);
  await page.locator('#settings-search').fill('session continuity');
  await page.locator('#settings-results a[data-result="co-continuity"]').click();
  const card = page.locator('#scenes-settings'); await card.waitFor();
  /** Viewport screenshots (the Settings dialog scrolls inside), from the top of the scenes card or a part of it. */
  const shot = async (name, part = card) => {
    await part.evaluate(el => el.scrollIntoView({ block: 'start' }));
    const path = resolve(output, name); await page.screenshot({ path }); report.screenshots.push(path);
  };
  assert.equal(await page.getByLabel('Use shared scenes in linked chats', { exact: true }).isChecked(), true);
  // Create (the adult checkbox is hidden while Adult mode is off).
  await card.getByRole('button', { name: 'New scene', exact: true }).click();
  assert.equal(await card.locator('input[name="scene-adult"]').count(), 0, 'adult checkbox hidden while adult mode is off');
  await card.locator('input[name="scene-title"]').fill('The Ember Road');
  await card.locator('textarea[name="scene-premise"]').fill('A caravan crosses the glass dunes toward the salt city.');
  await shot('scenes-new-1440.png');
  await card.getByRole('button', { name: 'Create scene', exact: true }).click();
  await card.locator('.scene-detail').waitFor();
  report.journeys.push('create a scene; adult checkbox hidden while adult mode is off');
  const sceneId = (await api('/scenes')).body.scenes[0].id;
  // Link with confirmation; Cancel changes nothing.
  const pick = card.locator('select[name="scene-link"]');
  await pick.locator(`option[value="${web.id}"]`).waitFor({ state: 'attached' });
  await pick.selectOption(web.id);
  await card.getByText('Who will experience this scene: Only you, in your web chat.', { exact: false }).waitFor();
  await card.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  assert.equal((await api(`/scenes/${sceneId}`)).body.seats.length, 0, 'cancel links nothing');
  await pick.selectOption(web.id);
  await card.getByRole('button', { name: 'Confirm link', exact: true }).click();
  await card.locator('.scene-seat').first().waitFor();
  assert.equal((await api(`/scenes/${sceneId}`)).body.seats.length, 1);
  report.journeys.push('link a web chat with the audience sentence and Confirm; Cancel links nothing');
  // R1B3 (fixture only: it has a synthetic Discord room): the exact room audience, Cancel, Confirm.
  if (fixture) {
    await pick.locator(`option[value="${fixture.roomId}"]`).waitFor({ state: 'attached' });
    await pick.selectOption(fixture.roomId);
    const roomConfirm = card.locator('.scene-room-confirm');
    await roomConfirm.waitFor();
    await card.getByText('Everyone who can read #tavern · Moonlight Guild on Discord will experience', { exact: false }).first().waitFor();
    await roomConfirm.getByText('Room: #tavern · Moonlight Guild (Discord channel)', { exact: true }).waitFor();
    await roomConfirm.getByText('Guests will see the effects of this scene in her replies, never the canon list itself.', { exact: true }).waitFor();
    await shot('scenes-room-confirm-1440.png', card.locator('select[name="scene-link"]'));
    await card.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    assert.equal(await roomConfirm.isHidden(), true);
    assert.equal((await api(`/scenes/${sceneId}`)).body.seats.length, 1, 'cancel links no room');
    await pick.selectOption(fixture.roomId);
    await card.getByRole('button', { name: 'Confirm link', exact: true }).click();
    await card.locator('.scene-seat', { hasText: 'Shared room' }).waitFor();
    const seats = (await api(`/scenes/${sceneId}`)).body.seats;
    assert.deepEqual(seats.map(s => s.audience).sort(), ['owner', 'room']);
    report.journeys.push('link a fixture Discord room: exact room and guest audience shown, Cancel links nothing, Confirm links it');
    await shot('scenes-room-seat-1440.png', card.locator('.scene-seat', { hasText: 'Shared room' }));
    // The "In scene" chip and Add to scene on a guest line, in the room's own transcript.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#settings')?.open !== true);
    await page.evaluate(id => { location.hash = `c=${id}`; }, fixture.roomId);
    const chip = page.locator('#chat-head #scene-chip');
    await chip.waitFor();
    assert.equal(await chip.textContent(), 'In scene: The Ember Road');
    await shot('scenes-chip-1440.png', page.locator('#chat-head'));
    const guest = page.locator('#messages .msg', { hasText: "Priya's ranger Ash joins the caravan" }).first();
    await guest.waitFor();
    await guest.hover();
    const more = guest.locator(':scope > .msg-more');
    if (await more.isVisible()) await more.click();
    await guest.getByRole('button', { name: 'Add to scene', exact: true }).click();
    const dialog = page.locator('#scene-add');
    await dialog.waitFor();
    await dialog.getByText("[Priya]: Priya's ranger Ash joins the caravan at the well.", { exact: true }).waitFor();
    await shot('scenes-add-to-scene-1440.png', page.locator('#chat-head'));
    // Cancel changes nothing.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const before = (await api(`/scenes/${sceneId}`)).body.canon.length;
    await guest.hover();
    if (await more.isVisible()) await more.click();
    await guest.getByRole('button', { name: 'Add to scene', exact: true }).click();
    await dialog.waitFor();
    await dialog.locator('select[name="scene-add-key"]').selectOption('');
    await dialog.locator('input[name="scene-add-new-key"]').fill('ash');
    await dialog.getByRole('button', { name: 'Add to scene', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const after = (await api(`/scenes/${sceneId}`)).body;
    assert.equal(after.canon.length, before + 1);
    const ash = after.canon.find(c => c.key === 'ash');
    assert.equal(ash.source.audience, 'room');
    assert.match(ash.text, /ranger Ash/);
    report.journeys.push('In scene chip in the room transcript; Add to scene on a guest line with Cancel, then Add');
    // Phone width: chip and dialog.
    await page.setViewportSize({ width: 390, height: 844 });
    await chip.waitFor();
    await shot('scenes-chip-390.png', page.locator('#chat-head'));
    await guest.click();
    if (await more.isVisible()) await more.click();
    await guest.getByRole('button', { name: 'Add to scene', exact: true }).click();
    await dialog.waitFor();
    await shot('scenes-add-to-scene-390.png', dialog);
    const dialogOverflow = await dialog.evaluate(el => el.scrollWidth - el.clientWidth);
    assert.ok(dialogOverflow <= 1, `no horizontal overflow in the dialog at 390 px (${dialogOverflow})`);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    report.journeys.push('chip and Add to scene dialog at 390x844 without horizontal overflow');
    // Back to the scenes card for the rest of the journeys.
    await page.locator('#open-settings').click();
    await page.waitForFunction(() => document.querySelector('#settings')?.open === true);
    await page.locator('#settings-search').fill('session continuity');
    await page.locator('#settings-results a[data-result="co-continuity"]').click();
    await card.waitFor();
    await card.getByRole('button', { name: 'Open scene', exact: true }).first().click();
    await card.locator('.scene-detail').waitFor();
    await card.locator('.scene-canon', { hasText: 'ranger Ash' }).getByText('From a line in the shared room', { exact: true }).waitFor();
    report.journeys.push('canon picked from a guest line is labelled From a line in the shared room');
  }
  // Typed canon, hostile text stays text.
  const hostile = '<img src=x onerror="window.__scenePwned=1">';
  const composer = card.locator('.scene-detail section').filter({ has: page.locator('h4', { hasText: 'Canon' }) }).locator('[role="group"]').last();
  await composer.locator('input[name="scene-canon-key"]').fill('inn');
  await composer.locator('textarea[name="scene-canon-text"]').fill(hostile);
  await composer.getByRole('button', { name: 'Save canon', exact: true }).click();
  await card.locator('.scene-canon .scene-text', { hasText: hostile }).waitFor();
  assert.equal(await card.locator('.scene-canon img').count(), 0);
  assert.equal(await page.evaluate(() => window.__scenePwned), undefined);
  report.journeys.push('typed canon; hostile <img onerror> canon shows as literal text');
  // Stale write: 409 keeps the draft and Reload works.
  const current = (await api(`/scenes/${sceneId}`)).body.scene.revision;
  assert.equal((await api(`/scenes/${sceneId}`, 'PATCH', { expectedRevision: current, premise: 'Changed elsewhere.' })).status, 200);
  // R1B2 (fixture only: it needs the host capability): a fact she saved with scene_canon meanwhile.
  if (fixture) fixture.herCanon(sceneId, web.id, 'caravan', 'The caravan turns north at dawn.');
  const composer2 = card.locator('.scene-detail section').filter({ has: page.locator('h4', { hasText: 'Canon' }) }).locator('[role="group"]').last();
  await composer2.locator('input[name="scene-canon-key"]').fill('road');
  await composer2.locator('textarea[name="scene-canon-text"]').fill('The north road is flooded.');
  await composer2.getByRole('button', { name: 'Save canon', exact: true }).click();
  await page.locator('#scenes-status', { hasText: 'This scene changed. Reload it to see the current canon.' }).waitFor();
  assert.equal(await composer2.locator('textarea[name="scene-canon-text"]').inputValue(), 'The north road is flooded.', 'draft kept on 409');
  await shot('scenes-conflict-1440.png');
  await card.getByRole('button', { name: 'Reload', exact: true }).click();
  await card.locator('.scene-premise', { hasText: 'Changed elsewhere.' }).waitFor();
  report.journeys.push('stale 409 keeps the draft and Reload shows the current scene');
  if (fixture) {
    const hers = card.locator('.scene-canon', { hasText: 'caravan turns north' });
    await hers.getByText('Written by her in a linked chat', { exact: true }).waitFor();
    assert.equal(await card.locator('.scene-canon', { hasText: hostile }).getByText('You typed this', { exact: true }).count(), 1, 'typed canon keeps its own label');
    report.journeys.push('canon she saved with scene_canon is labelled "Written by her", apart from typed canon');
  }
  // Add one more fact, then screenshots at desktop and phone width.
  const composer3 = card.locator('.scene-detail section').filter({ has: page.locator('h4', { hasText: 'Canon' }) }).locator('[role="group"]').last();
  await composer3.locator('input[name="scene-canon-key"]').fill('road');
  await composer3.locator('textarea[name="scene-canon-text"]').fill('The north road is flooded.');
  await composer3.getByRole('button', { name: 'Save canon', exact: true }).click();
  await card.locator('.scene-canon', { hasText: 'north road' }).waitFor();
  await shot('scenes-detail-1440.png');
  await shot('scenes-canon-1440.png', card.locator('.scene-canon').first());
  const facts = (await api(`/scenes/${sceneId}`)).body.canon.length;
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('scenes-detail-390.png');
  await shot('scenes-seats-390.png', card.locator('.scene-seat').first());
  await shot('scenes-canon-390.png', card.locator('.scene-canon').first());
  const overflow = await card.evaluate(el => el.scrollWidth - el.clientWidth);
  assert.ok(overflow <= 1, `no horizontal overflow at 390 px (${overflow})`);
  await page.setViewportSize({ width: 1440, height: 900 });
  report.journeys.push('detail at 1440x900 and 390x844 without horizontal overflow');
  // Retire: Cancel keeps it, Confirm retires it.
  const inn = card.locator('.scene-canon', { hasText: hostile });
  await inn.getByRole('button', { name: 'Retire', exact: true }).click();
  await inn.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await api(`/scenes/${sceneId}`)).body.canon.length, facts);
  await inn.getByRole('button', { name: 'Retire', exact: true }).click();
  await inn.getByRole('button', { name: 'Confirm retire', exact: true }).click();
  await card.locator('.scene-canon', { hasText: hostile }).waitFor({ state: 'detached' });
  assert.equal((await api(`/scenes/${sceneId}`)).body.canon.length, facts - 1);
  report.journeys.push('retire with Cancel and Confirm');
  // Reset and Delete under Danger, each with Cancel first.
  const danger = () => card.locator('.scene-danger');
  await danger().locator('summary').click();
  await danger().getByRole('button', { name: 'Reset canon', exact: true }).click();
  await danger().getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await api(`/scenes/${sceneId}`)).body.canon.length, facts - 1);
  await danger().getByRole('button', { name: 'Reset canon', exact: true }).click();
  await shot('scenes-reset-confirm-1440.png');
  await danger().getByRole('button', { name: 'Confirm reset', exact: true }).click();
  await card.getByText('No canon yet. Add the facts the story should keep.').waitFor();
  assert.equal((await api(`/scenes/${sceneId}`)).body.canon.length, 0);
  assert.equal((await api(`/scenes/${sceneId}`)).body.seats.length, fixture ? 2 : 1, 'reset keeps seats');
  await danger().locator('summary').click();
  await danger().getByRole('button', { name: 'Delete scene', exact: true }).click();
  await danger().getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await api(`/scenes/${sceneId}`)).status, 200);
  await danger().getByRole('button', { name: 'Delete scene', exact: true }).click();
  await danger().getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await card.getByText('No scenes yet. Start one and link the chats where you play it.').waitFor();
  assert.equal((await api(`/scenes/${sceneId}`)).status, 404);
  await shot('scenes-empty-390.png'.replace('390', '1440'));
  report.journeys.push('reset and delete with Cancel and Confirm');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.unexpectedNetwork, []);
  assert.equal(report.chatRequests, 0);
  if (fixture) { assert.equal(fixture.providerRequests(), 0); assert.deepEqual(fixture.unexpectedOutbound, []); }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await fixture?.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, journeys: report.journeys.length, screenshots: report.screenshots.length, error: report.error?.split('\n')[0] }));
}
