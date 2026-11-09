// Manual browser qualification against synthetic loopback profiles only.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contentFixture } from '../test/helpers/business-content.ts';

if (!process.env.SARA_PLAYWRIGHT_MODULE) throw new Error('Set SARA_PLAYWRIGHT_MODULE to an existing Playwright index.mjs.');
const { chromium } = await import(pathToFileURL(process.env.SARA_PLAYWRIGHT_MODULE).href);
const output = resolve(process.env.SARA_B3_OUTPUT || 'outputs/b2/task3/browser'); mkdirSync(output, { recursive: true });
const f = await contentFixture('localhost'); const browser = await chromium.launch({ headless: true });
const results = [], errors = []; let failure;
async function check(name, fn) { await fn(); results.push({ name, pass: true }); console.log('PASS', name); }
async function page(session) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === f.runtime.origin ? route.continue() : route.abort());
  await context.addCookies([{ name: 'sara_business_session', value: session.value, url: f.runtime.origin }]);
  const p = await context.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(p); await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p.goto(f.runtime.origin); await p.evaluate(() => import('/business-app.js')); await p.locator('#register').click(); await p.locator('#desk').waitFor(); return p;
}
const row = (p, id) => p.locator(`[data-invitation="${id}"]`);
async function focus(p) { await p.evaluate(() => dispatchEvent(new Event('focus'))); }
try {
  const w = f.runtime.control.createWorkspace(f.admin.principal, { name: 'Invitation studio' });
  const ids = await f.seed(w.id, 'Protected synthetic draft');
  const manager = f.add('Current manager'), target = f.add('Invited colleague'), viewer = f.add('Reader'), contributor = f.add('Writer'), outsider = f.add('Outside');
  f.grant(w.id, manager, 'manager'); f.grant(w.id, viewer); f.grant(w.id, contributor, 'contributor');
  const pending = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: target.principal.identityId });
  const org = f.runtime.control.createInvite(f.admin.principal, { scope: 'organization', role: 'user', subject: 'new' });
  const p = await page(f.admin);
  await check('organization inventory persists after navigation and never recovers the private code', async () => {
    await p.locator('#tab-org').click(); await p.getByRole('heading', { name: 'Recent invitations' }).waitFor();
    assert.match(await row(p, org.id).innerText(), /Pending/); assert.equal(await p.locator('#management-body code').count(), 0);
    await p.getByRole('button', { name: 'Create private invitation', exact: true }).click(); await p.locator('#management-body code').waitFor();
    const created = await p.locator('#management-body code').innerText();
    await p.locator('#tab-content').click(); await p.locator('#tab-org').click(); await p.getByRole('heading', { name: 'Recent invitations' }).waitFor();
    assert.equal(await p.locator('#management-body code').count(), 0); assert.ok(!(await p.locator('#management-body').innerText()).includes(created));
  });
  await check('manager inventory and focus refresh preserve edits, private creation code and keyboard focus', async () => {
    await p.locator('#tab-members').click(); await row(p, pending.id).waitFor();
    await p.locator('#invite-person').selectOption(target.principal.identityId); await p.getByRole('button', { name: 'Create private invitation', exact: true }).click();
    await p.locator('#management-body code').waitFor(); const code = await p.locator('#management-body code').innerText();
    await p.locator('#role-' + viewer.principal.identityId).selectOption('contributor'); await p.locator('#invite-role').focus();
    f.runtime.control.revokeInvite(manager.principal, pending.id); await focus(p);
    await row(p, pending.id).getByText('Invitation status: Revoked', { exact: true }).waitFor();
    assert.equal(await p.locator('#management-body code').innerText(), code); assert.equal(await p.locator('#role-' + viewer.principal.identityId).inputValue(), 'contributor');
    assert.equal(await p.evaluate(() => document.activeElement.id), 'invite-role');
    assert.ok(!(await p.evaluate(() => JSON.stringify({ local: Object.entries(localStorage), session: Object.entries(sessionStorage), url: location.href })) ).includes(code));
    await p.locator('#tab-content').click(); await p.locator('#tab-members').click(); await row(p, pending.id).waitFor();
    assert.equal(await p.locator('#management-body code').count(), 0);
    await p.screenshot({ path: join(output, 'manager-desktop.png'), fullPage: true });
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: join(output, 'manager-narrow.png'), fullPage: true });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
  await check('inventory refresh preserves the exact pending UUID and payload without resending inference', async () => {
    f.runtime.configureModels({ version: 1, privateLocal: true, allowCloud: false, instanceAllowanceNanoUsd: 10000000, maxConcurrent: 3, models: [{ id: 'local', provider: { id: 'local', kind: 'openai-compatible', label: 'Synthetic model', baseUrl: 'http://127.0.0.1:11434/v1', local: true, needsKey: false }, model: 'fixture', cloud: false, inputNanoUsdPerToken: 1, outputNanoUsdPerToken: 1, maxInputTokens: 24000, maxOutputTokens: 100, maxOutputBytes: 4096, deadlineMs: 10000, tone: 'professional' }], workspaces: { [w.id]: { modelId: 'local', allowanceNanoUsd: 10000000 } } });
    await p.reload(); await p.locator('#messages article').waitFor(); await p.locator('#draft').fill('Synthetic pending original'); await p.locator('#selected-documents input').first().check(); await p.locator('#acknowledge').check();
    let submits = 0; const messagePath = `**/workspaces/${w.id}/conversations/${ids.conversation}/messages`;
    await p.route(messagePath, route => { submits++; return route.abort('failed'); }); await p.locator('#send').click(); await p.locator('#retry').waitFor();
    const storage = () => p.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('business-drafts:')));
    const original = await storage(); assert.ok(JSON.parse(original[0][1])[`${w.id}/${ids.conversation}`].pending.requestId);
    await p.locator('#tab-members').click(); await row(p, pending.id).waitFor();
    const added = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: outsider.principal.identityId });
    await focus(p); await row(p, added.id).waitFor(); assert.deepEqual(await storage(), original); assert.equal(submits, 1);
    assert.equal(f.runtime.control.database.prepare('SELECT COUNT(*) AS n FROM business_model_requests').get().n, 0);
    await p.unroute(messagePath);
  });
  const m = await page(manager);
  await check('another manager revokes an existing invitation with accessible feedback and accepted precedence', async () => {
    const issued = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: target.principal.identityId });
    await m.locator('#tab-members').click(); await row(m, issued.id).getByRole('button', { name: 'Revoke this invitation' }).click();
    await row(m, issued.id).getByText('Invitation status: Revoked', { exact: true }).waitFor();
    assert.match(await m.locator('#management-body [role=status]').innerText(), /Invitation revoked/);
    assert.equal(await row(m, issued.id).getByText('Invitation status: Revoked', { exact: true }).evaluate(node => node === document.activeElement), true);
    const accepted = f.runtime.control.createInvite(f.admin.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: target.principal.identityId });
    f.runtime.control.redeemInvite(accepted.code, { principal: target.principal }); f.runtime.control.revokeInvite(manager.principal, accepted.id);
    await focus(m); await row(m, accepted.id).getByText('Invitation status: Accepted', { exact: true }).waitFor();
    assert.equal(await row(m, accepted.id).getByRole('button').count(), 0);
    const expired = f.runtime.control.createInvite(manager.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: outsider.principal.identityId });
    f.runtime.control.database.prepare('UPDATE workspace_invites SET expires_at=0 WHERE id=?').run(expired.id);
    const invalidated = f.runtime.control.createInvite(manager.principal, { scope: 'workspace', workspaceId: w.id, role: 'viewer', subject: target.principal.identityId });
    await m.getByRole('button', { name: 'Refresh invitations', exact: true }).click();
    await row(m, expired.id).getByText('Invitation status: Expired', { exact: true }).waitFor(); await row(m, invalidated.id).getByText('Invitation status: Invalidated', { exact: true }).waitFor();
    assert.equal(await row(m, expired.id).getByRole('button').count(), 0); assert.equal(await row(m, invalidated.id).getByRole('button').count(), 0);
  });
  await check('contributor, viewer, outsider and ungranted organization administrator cannot obtain workspace inventory', async () => {
    const admin2 = f.add('Ung granted administrator'); f.runtime.control.setOrganizationMember(f.admin.principal, admin2.principal.identityId, { role: 'orgadmin' });
    for (const session of [viewer, contributor, outsider, admin2]) {
      const q = await page(session);
      assert.equal(await q.locator('#tab-members').isVisible(), false);
      const status = await q.evaluate(async path => (await fetch(path)).status, `/api/business/workspaces/${w.id}/invites`); assert.equal(status, 404);
      if (session !== admin2) assert.equal(await q.locator('#tab-org').isVisible(), false);
      await q.context().close();
    }
  });
  await check('late inventory refresh cannot repopulate protected management after logout', async () => {
    let release, ready; const held = new Promise(resolve => { ready = resolve; });
    await m.route(`**/workspaces/${w.id}/invites`, async route => { const response = await route.fetch(); ready(); await new Promise(resolve => { release = resolve; }); await route.fulfill({ response }); });
    await focus(m); await held; await m.locator('#logout').click(); await m.locator('#signin').waitFor(); release();
    await m.waitForTimeout(150); assert.equal(await m.locator('#management-body').innerText(), ''); assert.equal(await m.locator('#desk').isVisible(), false);
  });
  assert.deepEqual(errors, []);
} catch (error) { failure = error; results.push({ pass: false, error: error.message }); console.error(error); }
finally {
  for (const context of browser.contexts()) await context.close();
  await browser.close(); await f.close();
  writeFileSync(join(output, 'results.json'), JSON.stringify({ results, errors, isolated: true, closed: true }, null, 2));
}
if (failure) throw failure;
