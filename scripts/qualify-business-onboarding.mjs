// Manual browser onboarding/recovery against fresh, synthetic local profiles only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { createBusinessRuntime } from '../src/business/runtime.ts';
import { openBusinessProfile } from '../src/business/profile.ts';
import { issueBusinessReenrollment, reconcileBusinessRecovery } from '../src/business/recovery.ts';
import { restoreBusinessBackup } from '../src/business/backup.ts';

if (!process.env.SARA_PLAYWRIGHT_MODULE) throw new Error('Set SARA_PLAYWRIGHT_MODULE to an existing Playwright module.');
const { chromium } = await import(pathToFileURL(process.env.SARA_PLAYWRIGHT_MODULE).href);
const temporary = mkdtempSync(join(tmpdir(), 'sara-b1-browser-onboarding-'));
const profile = openBusinessProfile(join(temporary, 'source'));
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
const origin = `http://localhost:${port}`;
let runtime = createBusinessRuntime({ profile, origin }); await new Promise(r => runtime.server.listen(port, '127.0.0.1', r));
const external = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<a href="${origin}/">Open team workspace</a>`); });
await new Promise(r => external.listen(0, '127.0.0.1', r)); const externalOrigin = `http://127.0.0.1:${external.address().port}`;
const browser = await chromium.launch({ headless: true }); const results = [], errors = [];
const output = resolve(process.env.SARA_BUSINESS_BROWSER_OUTPUT || 'outputs/b1/browser'); mkdirSync(output, { recursive: true });
const pass = name => { results.push(name); console.log('PASS', name); };
async function open(beforeNavigate) {
  const context = await browser.newContext({ viewport: { width: 720, height: 1000 } });
  await context.route('**/*', route => [origin, externalOrigin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable'); await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  if (beforeNavigate) await beforeNavigate(context);
  const firstMe = page.waitForResponse(response => response.url() === origin + '/api/business/me');
  await page.goto(origin); return { context, page, firstMe };
}
async function codeForm(page, mode, code, name = '') {
  await page.locator('#auth details').evaluate(element => { element.open = true; });
  await page.locator('#auth-mode').selectOption(mode); await page.locator('#code').fill(code); await page.locator('#person-name').fill(name); await page.locator('#adult').check();
}
async function accept(page) { await page.locator('#preview-invite').click(); await page.locator('#invite-preview').filter({ hasText: 'Invited by' }).waitFor(); await page.locator('#auth-form button[type=submit]').click(); }
try {
  const initialFailures = [];
  for (const delayed of [false, true]) {
    let releaseMe, responseReady;
    const held = new Promise(resolve => { responseReady = resolve; });
    const fresh = await open(delayed ? async context => {
      await context.route('**/api/business/me', async route => {
        const response = await route.fetch();
        assert.equal(response.status(), 401);
        responseReady(); await new Promise(resolve => { releaseMe = resolve; });
        await route.fulfill({ response });
      });
    } : undefined);
    if (delayed) { await held; await codeForm(fresh.page, 'claim', 'typed-before-first-response', 'Taylor Fresh'); releaseMe(); }
    const response = await fresh.firstMe; assert.equal(response.status(), 401); await response.finished();
    // Await the same module's top-level boot, not merely the network event or initial HTML paint.
    await fresh.page.evaluate(() => import('/business-app.js'));
    await fresh.page.screenshot({ path: join(output, delayed ? 'anonymous-delayed-first-401.png' : 'anonymous-first-401.png'), fullPage: true });
    try {
      assert.equal(await fresh.page.locator('#notice').innerText(), '', 'expected anonymous first /me 401 must leave a quiet welcome');
      assert.equal(await fresh.page.locator('#auth').isVisible(), true);
      assert.equal(await fresh.page.locator('#logout').isVisible(), false);
      assert.equal(await fresh.page.locator('#join-team').isVisible(), false);
      if (delayed) {
        assert.equal(await fresh.page.locator('#person-name').inputValue(), 'Taylor Fresh', 'late anonymous boot must preserve typed name');
        assert.equal(await fresh.page.locator('#code').inputValue(), 'typed-before-first-response', 'late anonymous boot must preserve typed code');
      }
    } catch (error) { initialFailures.push({ delayed, message: error.message, name: await fresh.page.locator('#person-name').inputValue(), code: await fresh.page.locator('#code').inputValue() }); }
    await fresh.context.close();
  }
  writeFileSync(join(output, 'anonymous-first-401-results.json'), JSON.stringify({ initialFailures }, null, 2));
  assert.deepEqual(initialFailures, [], 'fresh anonymous boot must be quiet and preserve in-progress setup fields');
  pass('fresh anonymous first 401 is quiet; delayed initial 401 preserves typed setup name and code');
  const admin = await open();
  await admin.page.goto(externalOrigin); await admin.page.getByRole('link', { name: 'Open team workspace' }).click(); await admin.page.locator('#signin').waitFor();
  pass('cross-site top-level link reaches fixed sign-in shell');
  await codeForm(admin.page, 'claim', runtime.auth.claimCode, 'Alex Owner'); await admin.page.locator('#adult').uncheck(); await admin.page.locator('#auth-form button[type=submit]').click(); await admin.page.locator('#notice').filter({ hasText: '18 or older' }).waitFor(); assert.equal(runtime.identities.firstIdentityId(), undefined);
  await admin.page.locator('#adult').check(); await admin.page.locator('#auth-form button[type=submit]').click(); await admin.page.locator('#register').click(); await admin.page.locator('#org-name').waitFor();
  const adminId = runtime.identities.firstIdentityId();
  await admin.page.locator('#org-name').fill('Example Organization'); await admin.page.locator('#org-name').press('Enter'); await admin.page.locator('#organization').filter({ hasText: 'Example Organization' }).waitFor();
  await admin.page.locator('#new-workspace').fill('First shared desk'); await admin.page.locator('#new-workspace').press('Enter'); await admin.page.locator('#workspace-name').filter({ hasText: 'First shared desk' }).waitFor();
  const workspace = runtime.control.database.prepare('SELECT id FROM workspaces').get().id;
  await admin.page.locator('#tab-content').click(); assert.match(await admin.page.locator('#model-destination').innerText(), /No allowed model/); assert.equal(await admin.page.locator('#send').isDisabled(), true);
  pass('first claim enforces adult confirmation, actual passkey, organization naming, first workspace and honest unconfigured model');
  await admin.page.locator('#tab-org').click(); await admin.page.locator('#invite-role').selectOption('orgadmin'); await admin.page.getByRole('button', { name: 'Create private invitation' }).click(); await admin.page.locator('#management-body code').waitFor(); const organizationInvite = await admin.page.locator('#management-body code').innerText();
  const secondInvitation = await admin.page.evaluate(async () => (await fetch('/api/business/org/invites', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'user', subject: 'new' }) })).json());
  const colleague = await open(); await codeForm(colleague.page, 'join', organizationInvite, 'Jordan Colleague');
  let releasePreview;
  await colleague.context.route('**/invites/preview', async route => { if (route.request().postDataJSON().code === organizationInvite) await new Promise(resolve => { releasePreview = resolve; }); await route.continue(); });
  await colleague.page.locator('#preview-invite').click();
  const until = Date.now() + 5000; while (!releasePreview) { if (Date.now() > until) throw Error('Preview did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
  await colleague.page.locator('#code').fill(secondInvitation.code);
  const staleResponse = colleague.page.waitForResponse(response => response.url().endsWith('/invites/preview') && response.request().postDataJSON().code === organizationInvite);
  releasePreview(); await (await staleResponse).finished(); await colleague.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
  assert.equal(await colleague.page.locator('#invite-preview').innerText(), '');
  await colleague.page.locator('#auth-form button[type=submit]').click(); await colleague.page.locator('#invite-preview').filter({ hasText: 'User' }).waitFor();
  assert.equal(runtime.control.database.prepare('SELECT used_at FROM workspace_invites WHERE id=?').get(secondInvitation.id).used_at, null);
  assert.equal(runtime.control.database.prepare('SELECT COUNT(*) AS n FROM business_identities').get().n, 1);
  await colleague.page.locator('#auth-form button[type=submit]').click(); await colleague.page.locator('#register').click();
  pass('late preview for invitation A cannot paint over or authorize changed invitation B'); await colleague.page.locator('#desk').waitFor();
  const colleagueId = runtime.control.database.prepare("SELECT id FROM business_identities WHERE name='Jordan Colleague'").get().id;
  assert.match(await colleague.page.locator('#notice').innerText(), /No workspace access/);
  await admin.page.locator('#tab-members').click(); await admin.page.locator('#invite-person').selectOption(colleagueId); await admin.page.locator('#invite-role').selectOption('contributor'); await admin.page.getByRole('button', { name: 'Create private invitation' }).click(); await admin.page.locator('#management-body code').waitFor(); const workspaceInvite = await admin.page.locator('#management-body code').innerText();
  await colleague.page.locator('#join-team').click(); await codeForm(colleague.page, 'join', workspaceInvite, 'Jordan Colleague'); await accept(colleague.page); await colleague.page.locator('#workspace-name').filter({ hasText: 'First shared desk' }).waitFor(); assert.match(await colleague.page.locator('#audience').innerText(), /Contributor/);
  pass('organization invite creates individual account; manager existing-colleague invite previews role and joins exact workspace');
  await colleague.page.locator('#join-team').click(); await codeForm(colleague.page, 'join', workspaceInvite, 'Jordan Colleague'); await colleague.page.locator('#preview-invite').click(); await colleague.page.locator('#notice').filter({ hasText: 'unavailable' }).waitFor(); assert.equal(await colleague.page.locator('#invite-preview').innerText(), '');
  await colleague.page.reload(); await colleague.page.locator('#desk').waitFor();
  pass('consumed invitation gives safe refusal without automatic retry');
  await admin.page.goto('about:blank'); await colleague.page.goto('about:blank'); await runtime.close(); const recovery = issueBusinessReenrollment(profile, colleagueId);
  runtime = createBusinessRuntime({ profile, origin }); await new Promise(r => runtime.server.listen(port, '127.0.0.1', r));
  await colleague.page.goto(origin); await codeForm(colleague.page, 'reenroll', recovery.code); await colleague.page.locator('#auth-form button[type=submit]').click(); await colleague.page.locator('#register').click(); await colleague.page.locator('#workspace-name').filter({ hasText: 'First shared desk' }).waitFor();
  await admin.page.goto(origin); await admin.page.locator('#desk').waitFor();
  pass('offline targeted re-enrollment uses fresh real passkey and preserves coworker session and current grants');
  const archive = join(temporary, 'synthetic.enc'); await runtime.backup(archive, 'synthetic-browser-passphrase'); await admin.page.goto('about:blank'); await colleague.page.goto('about:blank'); await runtime.close();
  const restoredRoot = join(temporary, 'restored'); const restored = await restoreBusinessBackup(archive, restoredRoot, 'synthetic-browser-passphrase'); const restoredProfile = openBusinessProfile(restoredRoot);
  const enrollment = issueBusinessReenrollment(restoredProfile, adminId);
  reconcileBusinessRecovery(restoredProfile, { generation: restored.generation, organization: [{ identityId: adminId, role: 'orgadmin' }], workspaces: [{ workspaceId: workspace, identityId: adminId, role: 'manager' }], usage: 'keep-held', policy: 'disabled' });
  runtime = createBusinessRuntime({ profile: restoredProfile, origin }); await new Promise(r => runtime.server.listen(port, '127.0.0.1', r));
  await admin.page.goto(origin); await codeForm(admin.page, 'reenroll', enrollment.code); await admin.page.locator('#auth-form button[type=submit]').click(); await admin.page.locator('#register').click(); await admin.page.locator('#recovery').waitFor(); assert.equal(await admin.page.locator('#desk').isVisible(), false);
  assert.equal(await admin.page.evaluate(async () => (await fetch('/api/business/workspaces')).status), 503);
  await admin.page.screenshot({ path: join(output, 'restored-reconciliation.png'), fullPage: true });
  pass('real encrypted restore keeps UI and APIs closed after fresh passkey pending offline reconciliation completion');
  assert.deepEqual(errors, []); writeFileSync(join(output, 'onboarding-results.json'), JSON.stringify({ results, pageErrors: errors, limits: 'Virtual WebAuthn, isolated profiles and synthetic archive only; no real accounts, providers or deployment.' }, null, 2));
} finally { await browser.close(); await runtime.close(); await new Promise(r => external.close(r)); rmSync(temporary, { recursive: true, force: true }); }
