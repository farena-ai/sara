// Manual synthetic browser qualification; uses only an already installed Playwright and Chromium.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentFixture } from '../test/helpers/business-content.ts';

if (!process.env.SARA_PLAYWRIGHT_MODULE) throw new Error('Set SARA_PLAYWRIGHT_MODULE to an existing Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(process.env.SARA_PLAYWRIGHT_MODULE).href);
const output = resolve(process.env.SARA_B2_OUTPUT || 'outputs/b2/task1/browser');
mkdirSync(output, { recursive: true });
const f = await contentFixture('localhost');
const browser = await chromium.launch({ headless: true });
const results = [], errors = [];
const wait = async predicate => {
  const end = Date.now() + 8000;
  while (!await predicate()) {
    if (Date.now() > end) throw Error('Expected UI condition timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const test = async (name, fn) => {
  try { await fn(); results.push({ name, pass: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); }
};
async function context(session) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await c.route('**/*', route => new URL(route.request().url()).origin === f.runtime.origin ? route.continue() : route.abort());
  if (session) await c.addCookies([{ name: 'sara_business_session', value: session.value, url: f.runtime.origin }]);
  return c;
}
async function page(c) {
  const p = await c.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', error => errors.push(error.message));
  const cdp = await c.newCDPSession(p); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p.goto(f.runtime.origin); await p.evaluate(() => import('/business-app.js'));
  return p;
}
const drafts = p => p.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('business-drafts:')));
async function focusRefresh(p) {
  const response = p.waitForResponse(response => response.url().endsWith('/api/business/me'));
  await p.evaluate(() => dispatchEvent(new Event('focus'))); await (await response).finished();
  await p.waitForTimeout(100);
}
const config = workspace => ({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 10000000, maxConcurrent: 3, models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Synthetic model', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false }, model: 'fixture', cloud: false, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 10000, tone: 'professional' }], workspaces: { [workspace]: { modelId: 'local', allowanceNanoUsd: 10000000 } } });
try {
  const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Synthetic studio' });
  const ids = await f.seed(w.id, 'Protected synthetic conversation');
  const revocationAdmin = f.add('Synthetic secondary administrator');
  f.runtime.control.setOrganizationMember(f.admin.principal, revocationAdmin.principal.identityId, { role: 'orgadmin', status: 'active' });
  const accountCases = [false, true].map(revoke => {
    const user = f.add(revoke ? 'Synthetic revoked colleague' : 'Synthetic switched colleague');
    f.grant(w.id, user, 'contributor');
    const replacement = revoke ? undefined : f.add('Synthetic replacement identity');
    if (replacement) f.grant(w.id, replacement, 'contributor');
    return { revoke, user, replacement };
  });
  const deferredAccounts = ['register', 'login'].map(kind => {
    const user = f.add('Synthetic deferred ' + kind); f.grant(w.id, user, 'contributor'); return { kind, user };
  });
  const scopedAdmin = f.add('Synthetic scoped administrator');
  f.runtime.control.setOrganizationMember(f.admin.principal, scopedAdmin.principal.identityId, { role: 'orgadmin', status: 'active' });
  const anonymous = await context(); const a = await page(anonymous);
  await a.locator('#auth details').evaluate(element => { element.open = true; });
  await test('re-enrollment hides irrelevant name and invitation review; retains adult confirmation', async () => {
    await a.locator('#auth-mode').selectOption('reenroll');
    assert.equal(await a.locator('#person-name').isVisible(), false); assert.equal(await a.locator('#person-name').isDisabled(), true);
    assert.equal(await a.locator('#preview-invite').isVisible(), false); assert.equal(await a.locator('#adult').isVisible(), true);
    assert.equal(await a.locator('#adult').evaluate(input => input.required), true, 'required adult confirmation must be exposed to assistive technology');
  });
  await test('first-use name/code/adult validation is actionable and sends no invalid authentication requests', async () => {
    await a.locator('#auth-mode').selectOption('claim');
    let requests = 0; const watch = request => { if (request.url().endsWith('/claim')) requests++; }; a.on('request', watch);
    await a.locator('#code').fill('bad code'); await a.locator('#person-name').fill('   '); await a.locator('#adult').check();
    await a.locator('#auth-form button[type=submit]').click(); assert.match(await a.locator('#notice').innerText(), /code/i);
    await a.locator('#code').fill('ABCD-EFGH'); await a.locator('#auth-form button[type=submit]').click(); assert.match(await a.locator('#notice').innerText(), /name/i);
    await a.locator('#person-name').fill('Synthetic person'); await a.locator('#adult').uncheck();
    await a.locator('#auth-form button[type=submit]').click(); assert.match(await a.locator('#notice').innerText(), /18 or older/);
    a.off('request', watch); assert.equal(requests, 0);
  });
  await test('narrow first-use layout and keyboard skip link have no hidden focusable name control', async () => {
    await a.setViewportSize({ width: 390, height: 844 }); await a.locator('#auth-mode').selectOption('reenroll');
    await a.screenshot({ path: join(output, 'first-use-narrow.png'), fullPage: true });
    assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await a.reload(); await a.evaluate(() => import('/business-app.js')); await a.keyboard.press('Tab');
    assert.equal(await a.evaluate(() => document.activeElement.classList.contains('skip')), true);
    await a.keyboard.press('Enter'); assert.equal(await a.evaluate(() => document.activeElement.id), 'main');
    await a.screenshot({ path: join(output, 'keyboard-landmark.png'), fullPage: true });
  });
  const c = await context(f.admin); const sibling = await page(c); const p = await page(c);
  let releaseOldMe; let oldReady;
  const oldHeld = new Promise(resolve => { oldReady = resolve; });
  let intercept = true;
  await sibling.route('**/api/business/me', async route => {
    if (!intercept) return route.continue(); intercept = false;
    const response = await route.fetch(); oldReady(); await new Promise(resolve => { releaseOldMe = resolve; }); await route.fulfill({ response });
  });
  await sibling.evaluate(() => dispatchEvent(new Event('focus'))); await oldHeld;
  await p.locator('#register').click(); await p.locator('#messages article').waitFor();
  await test('sibling enrollment consumes fresh me and delayed older me cannot undo it', async () => {
    await wait(() => sibling.locator('#desk').isVisible()); releaseOldMe(); await sibling.waitForTimeout(150);
    assert.equal(await sibling.locator('#desk').isVisible(), true); assert.equal(await sibling.locator('#enroll').isVisible(), false);
    await sibling.unroute('**/api/business/me');
  });
  await p.locator('#draft').fill('Retain my same-session draft');
  await test('same-session authentication hint retains scoped draft and document selection', async () => {
    await p.locator('#selected-documents input').first().check();
    await sibling.evaluate(() => { const channel = new BroadcastChannel('sara-business-auth'); channel.postMessage('changed'); channel.close(); });
    await p.waitForTimeout(200); assert.equal(await p.locator('#draft').inputValue(), 'Retain my same-session draft');
    assert.equal(await p.locator('#selected-documents input').first().isChecked(), true);
  });
  await test('signed-in invitation acceptance hides and disables name/adult fields', async () => {
    await p.locator('#join-team').click();
    for (const id of ['person-name', 'adult']) { assert.equal(await p.locator('#' + id).isVisible(), false); assert.equal(await p.locator('#' + id).isDisabled(), true); assert.equal(await p.locator('#' + id).evaluate(input => input.required), false); }
  });
  await test('administration explains staged invitations and operator boundary; focus retains management view', async () => {
    await p.reload(); await p.locator('#messages article').waitFor(); await p.locator('#tab-org').click(); await p.locator('#org-name').waitFor();
    const text = await p.locator('#management-body').innerText(); assert.match(text, /Next steps/); assert.match(text, /organization invitation/i); assert.match(text, /operator/i);
    let posts = 0; const watch = request => { if (request.method() === 'POST' && request.url().endsWith('/org')) posts++; }; p.on('request', watch);
    await p.locator('#org-name').fill('   '); await p.getByRole('button', { name: 'Save organization name', exact: true }).click();
    assert.match(await p.locator('#org-name').evaluate(input => input.validationMessage), /1 to 120/); assert.equal(posts, 0); p.off('request', watch);
    await p.locator('#org-name').fill('Unsubmitted organization label');
    await p.getByRole('button', { name: 'Create private invitation', exact: true }).click(); await p.locator('#management-body code').waitFor();
    const privateCode = await p.locator('#management-body code').innerText();
    await focusRefresh(p); await p.locator('#org-name').waitFor(); assert.equal(await p.locator('#tab-org').getAttribute('aria-current'), 'page');
    assert.equal(await p.locator('#org-name').inputValue(), 'Unsubmitted organization label', 'unchanged focus must retain typed administration fields');
    assert.equal(await p.locator('#management-body code').innerText(), privateCode, 'unchanged focus must retain the only displayed invitation code');
    await sibling.evaluate(() => { const channel = new BroadcastChannel('sara-business-auth'); channel.postMessage('changed'); channel.close(); }); await p.waitForTimeout(200);
    assert.equal(await p.locator('#org-name').inputValue(), 'Unsubmitted organization label'); assert.equal(await p.locator('#management-body code').innerText(), privateCode);
    await p.screenshot({ path: join(output, 'administrator-desktop.png'), fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 }); assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.screenshot({ path: join(output, 'administrator-narrow.png'), fullPage: true }); await p.setViewportSize({ width: 1440, height: 1000 });
    await p.locator('#tab-members').click(); await p.locator('#invite-role').waitFor(); assert.match(await p.locator('#management-body').innerText(), /Next steps for workspace managers/);
  });
  await test('organization focus refresh adds a newly accepted colleague without losing edits or private invitation code', async () => {
    await p.locator('#tab-org').click(); await p.locator('#org-name').waitFor();
    await p.locator('#org-name').fill('Retain organization form edit'); await p.locator('#new-workspace').fill('Retain workspace form edit');
    await p.locator('#role-' + revocationAdmin.principal.identityId).selectOption('user');
    await p.getByRole('button', { name: 'Create private invitation', exact: true }).click(); await p.locator('#management-body code').waitFor();
    const privateCode = await p.locator('#management-body code').innerText(); const colleague = f.add('Synthetic newly accepted organization colleague');
    let mutations = 0; const watch = request => { if (request.method() === 'POST') mutations++; }; p.on('request', watch);
    await focusRefresh(p); await wait(() => p.locator('#role-' + colleague.principal.identityId).isVisible());
    assert.equal(await p.locator('#org-name').inputValue(), 'Retain organization form edit'); assert.equal(await p.locator('#new-workspace').inputValue(), 'Retain workspace form edit');
    assert.equal(await p.locator('#role-' + revocationAdmin.principal.identityId).inputValue(), 'user'); assert.equal(await p.locator('#management-body code').innerText(), privateCode);
    f.runtime.control.setOrganizationMember(f.admin.principal, colleague.principal.identityId, { role: 'orgadmin', status: 'disabled' });
    await focusRefresh(p); await wait(async () => await p.locator('#status-' + colleague.principal.identityId).inputValue() === 'disabled');
    assert.equal(await p.locator('#role-' + colleague.principal.identityId).inputValue(), 'orgadmin'); assert.equal(await p.locator('#management-body code').innerText(), privateCode);
    assert.equal(await p.locator('#org-name').inputValue(), 'Retain organization form edit'); assert.equal(mutations, 0); p.off('request', watch);
  });
  await test('workspace focus refresh adds newly active invitation candidates without losing selections or private code', async () => {
    await p.locator('#tab-members').click(); await p.locator('#invite-person').waitFor();
    const selected = await p.locator('#invite-person').inputValue(); await p.locator('#invite-role').selectOption('manager');
    const editedIdentity = accountCases[0].user.principal.identityId; await p.locator('#role-' + editedIdentity).selectOption('viewer');
    await p.getByRole('button', { name: 'Create private invitation', exact: true }).click(); await p.locator('#management-body code').waitFor();
    const privateCode = await p.locator('#management-body code').innerText(); const colleague = f.add('Synthetic newly active invitation candidate');
    let mutations = 0; const watch = request => { if (request.method() === 'POST') mutations++; }; p.on('request', watch);
    await focusRefresh(p); await wait(async () => await p.locator(`#invite-person option[value="${colleague.principal.identityId}"]`).count() === 1);
    assert.equal(await p.locator('#invite-person').inputValue(), selected); assert.equal(await p.locator('#invite-role').inputValue(), 'manager');
    assert.equal(await p.locator('#role-' + editedIdentity).inputValue(), 'viewer'); assert.equal(await p.locator('#management-body code').innerText(), privateCode);
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, editedIdentity, { role: 'contributor', status: 'removed' });
    await focusRefresh(p); await wait(async () => await p.locator('#status-' + editedIdentity).inputValue() === 'removed');
    assert.equal(await p.locator('#role-' + editedIdentity).inputValue(), 'viewer');
    assert.match(await p.locator('#role-' + editedIdentity).locator('xpath=ancestor::div[contains(@class, "row")]').innerText(), /Current access: Contributor · Removed/);
    f.grant(w.id, accountCases[0].user, 'contributor');
    f.runtime.control.setWorkspaceMember(f.admin.principal, w.id, selected, { role: 'contributor', status: 'active' });
    await focusRefresh(p); await wait(async () => await p.locator(`#invite-person option[value="${selected}"]`).count() === 0);
    assert.equal(await p.locator('#invite-person').inputValue(), '', 'an ineligible selection must not silently switch the intended recipient');
    assert.equal(await p.getByRole('button', { name: 'Create private invitation', exact: true }).isDisabled(), true);
    assert.equal(await p.locator('#management-body code').innerText(), privateCode); assert.equal(mutations, 0); p.off('request', watch);
  });
  await test('original pending UUID and payload survive same-session focus and sibling hints without replay', async () => {
    f.runtime.configureModels(config(w.id)); await p.reload(); await p.locator('#messages article').waitFor();
    await p.locator('#draft').fill('Synthetic uncertain original'); await p.locator('#selected-documents input').first().check(); await p.locator('#acknowledge').check();
    const messagePath = `**/workspaces/${w.id}/conversations/${ids.conversation}/messages`;
    let submits = 0; await p.route(messagePath, route => { submits++; return route.abort('failed'); });
    await p.locator('#send').click(); await p.locator('#retry').waitFor();
    await wait(async () => (await drafts(p)).some(([, value]) => JSON.stringify(JSON.parse(value)).includes('requestId')));
    const original = await drafts(p); const record = JSON.parse(original[0][1])[`${w.id}/${ids.conversation}`]; assert.ok(record.pending.requestId);
    await focusRefresh(p); await sibling.evaluate(() => { const channel = new BroadcastChannel('sara-business-auth'); channel.postMessage('changed'); channel.close(); }); await p.waitForTimeout(200);
    assert.deepEqual(await drafts(p), original); assert.equal(await p.locator('#draft').isDisabled(), true); assert.equal(await p.locator('#selected-documents input').first().isChecked(), true); assert.equal(submits, 1);
    const status = p.waitForRequest(request => request.url().endsWith('/requests/' + record.pending.requestId)); await p.locator('#retry').click(); await status;
    assert.equal(submits, 1); assert.equal(f.runtime.control.database.prepare('SELECT COUNT(*) AS n FROM business_model_requests').get().n, 0);
    await p.unroute(messagePath);
  });
  await test('focus consumes authoritative lost enrollment and hides protected content', async () => {
    f.runtime.control.database.prepare('DELETE FROM business_credential_refs WHERE identity_id=?').run(f.admin.principal.identityId);
    await focusRefresh(p); await p.locator('#enroll').waitFor(); assert.equal(await p.locator('#desk').isVisible(), false); assert.equal((await drafts(p)).length, 0);
  });
  await test('late successful me cannot repopulate protected UI after sign out', async () => {
    let release, ready; const held = new Promise(resolve => { ready = resolve; });
    await p.route('**/api/business/me', async route => { const response = await route.fetch(); ready(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ response }); });
    await p.evaluate(() => dispatchEvent(new Event('focus'))); await held; await p.locator('#logout').click(); await p.locator('#auth').waitFor();
    release(); await p.waitForTimeout(150); assert.equal(await p.locator('#enroll').isVisible(), false); assert.equal(await p.locator('#desk').isVisible(), false); assert.equal((await drafts(p)).length, 0);
    await p.unroute('**/api/business/me');
  });
  await c.close();
  for (const { revoke, user, replacement } of accountCases) {
    const other = await context(user); const q = await page(other); await q.locator('#register').click(); await q.locator('#messages article').waitFor();
    await q.locator('#draft').fill('Protected original identity draft');
    await test(revoke ? 'organization revocation clears protected content and session drafts' : 'cookie identity replacement is refused and clears the previous identity draft', async () => {
      if (revoke) f.runtime.control.setOrganizationMember(revocationAdmin.principal, user.principal.identityId, { role: 'user', status: 'disabled' });
      else {
        const replacementContext = await context(replacement); const replacementPage = await page(replacementContext);
        await replacementPage.locator('#register').click(); await replacementPage.locator('#messages article').waitFor(); await replacementContext.close();
        await other.addCookies([{ name: 'sara_business_session', value: replacement.value, url: f.runtime.origin }]);
      }
      await q.evaluate(() => dispatchEvent(new Event('focus'))); await wait(async () => !await q.locator('#desk').isVisible());
      assert.equal(await q.locator('#messages').innerText(), ''); assert.equal((await drafts(q)).length, 0); assert.equal(await q.locator('#draft').inputValue(), '');
      if (!revoke) {
        const sibling = await other.newPage(); await sibling.goto(f.runtime.origin); await sibling.locator('#desk').waitFor();
        await sibling.evaluate(() => { const channel = new BroadcastChannel('sara-business-auth'); channel.postMessage('changed'); channel.close(); });
        await q.waitForTimeout(250); assert.equal(await q.locator('#desk').isVisible(), false, 'later sibling hint must not reopen a closed account');
        assert.equal(await q.locator('#logout').isVisible(), false); await sibling.close();
      }
    });
    await other.close();
  }
  for (const { kind, user } of deferredAccounts) {
    const other = await context(user); const q = await page(other);
    if (kind === 'login') { await q.locator('#register').click(); await q.locator('#messages article').waitFor(); await q.locator('#join-team').click(); }
    await test(`deferred ${kind} completion started before logout cannot reopen the closed tab`, async () => {
      let release, ready; const held = new Promise(resolve => { ready = resolve; });
      await q.route(`**/passkeys/${kind}/finish`, async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200); ready(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ response });
      });
      await q.locator(kind === 'login' ? '#signin' : '#register').click(); await held;
      await q.locator('#logout').click(); await q.locator('#auth').waitFor(); release(); await q.waitForTimeout(150);
      const hint = await other.newPage(); await hint.goto(f.runtime.origin);
      await hint.evaluate(() => { const channel = new BroadcastChannel('sara-business-auth'); channel.postMessage('changed'); channel.close(); }); await q.waitForTimeout(150);
      assert.equal(await q.locator('#desk').isVisible(), false); assert.equal(await q.locator('#enroll').isVisible(), false); assert.equal(await q.locator('#logout').isVisible(), false); assert.equal((await drafts(q)).length, 0);
      await hint.close();
    });
    await other.close();
  }
  await test('fresh me demotion clears organization management before deferred workspace refresh completes', async () => {
    const other = await context(scopedAdmin); const q = await page(other); await q.locator('#register').click(); await q.locator('#desk').waitFor(); await q.locator('#tab-org').click(); await q.locator('#org-name').waitFor();
    await q.getByRole('button', { name: 'Create private invitation', exact: true }).click(); await q.locator('#management-body code').waitFor();
    f.runtime.control.setOrganizationMember(revocationAdmin.principal, scopedAdmin.principal.identityId, { role: 'user', status: 'active' });
    let release, ready; const held = new Promise(resolve => { ready = resolve; });
    await q.route('**/api/business/workspaces', async route => { const response = await route.fetch(); ready(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ response }); });
    await q.evaluate(() => dispatchEvent(new Event('focus'))); await held;
    const content = await q.locator('#management-body').innerText(); release(); await q.waitForTimeout(100); await other.close();
    assert.equal(content, '', 'fresh role loss must erase privileged administration immediately');
  });
  await anonymous.close();
} finally {
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, errors, limits: 'Isolated synthetic runtime, actual Chromium and virtual WebAuthn. Message POST transport aborted before admission; zero inference. No real accounts, owner data, physical screen reader or deployment.' }, null, 2));
  await browser.close(); await f.close();
}
if (results.some(result => !result.pass) || errors.length) process.exitCode = 1;
