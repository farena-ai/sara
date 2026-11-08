import { asyncAutoBackupTick, beginBackupShutdown } from './backup-async.ts';
// Entry point: `node src/main.ts`. Admin flags (the `sara` command on each system wraps them):
//   --version · --status · --doctor · --backup [file] · --restore <file> · --reset-token
//   --tailscale-status (JSON, for the installers' "How will you reach her?" question)
import { initialDeviceApproval } from './device-approval.ts';
import { netFetch } from './net-guard.ts';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StoryWorker } from './story.ts';
import { JobManager } from './jobs.ts';
import { deliveryFor } from './delivery.ts';
import { createCodingTools } from './tools/coding.ts';
import { createBrowserTools } from './tools/browser.ts';
import { PreviewManager } from './preview.ts';
import { BrowserManager } from './browser.ts';
import { GoogleAccount, googleApiBase } from './google.ts';
import { SpotifyAccount, spotifyApiBase } from './spotify.ts';
import { createSpotifyTools } from './tools/spotify.ts';
import { GmailOrganizer } from './gmail-organize.ts';
import { createGmailOrganizeTools } from './tools/gmail-organize.ts';
import { createGitHubTools } from './tools/github.ts';
import { createWorktreeTools } from './tools/worktrees.ts';
import { createLspTools } from './tools/lsp.ts';
import { gitRunner, Worktrees } from './worktrees.ts';
import { LspEngine } from './lsp.ts';
import { createHomeTools } from './tools/home.ts';
import { createGoogleTools } from './tools/google.ts';
import { WeeklyWorker } from './weekly.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyOffsite, offsiteTestDue, testOffsite } from './offsite-run.ts';
import { formatDoctor, runDoctor } from './doctor.ts';
import { createSafetyReportTool, sweepUndo, weeklySafetyTick, type SafetyDeps } from './safety-check.ts';
import { createSuggestRoutineTool } from './routines.ts';
import { decryptBackup, isEncrypted } from './offsite.ts';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OwnerAuth } from './auth.ts';
import { claimModeFrom, claimWindowMs, FirstClaim, formatClaimCode } from './claim.ts';
import { vaultKeyFor, type AppContext } from './chat.ts';
import { ApprovalBroker, ToolRegistry } from './tools/registry.ts';
import { SshManager } from './ssh.ts';
import { createSshTools } from './tools/ssh.ts';
import { Redactor, vaultSecretValues } from './redact.ts';
import { SnapshotStore } from './snapshots.ts';
import { MemoryStore } from './memory.ts';
import { PeopleStore } from './people.ts';
import { mentionToolDeps, wirePeople } from './mentions.ts';
import { createPeopleTools } from './people-tools.ts';
import { localDate, memorySettings, MemoryWorker } from './memory-worker.ts';
import { HistoryImporter } from './history-import/index.ts';
import { embedTarget, MemoryVectors } from './embeddings.ts';
import { createTeamTools, TeamManager } from './team.ts';
import { createBoardTools, setUpBoard } from './board-work.ts';
import { SharedBoardStore, type SharedBoardsAccess } from './shared-boards.ts';
import { priceTable, UsageStore } from './usage.ts';
import { RunStore, runSettings } from './runs.ts';
import { createStarterTool } from './starters.ts';
import { createProjectNoteTool, ProjectKnowledgeStore } from './projectknow.ts';
import { createProjectCheckpointTool } from './project-checkpoints.ts';
import { createSessionContinuityTools } from './session-continuity-tools.ts';
import { createSceneCanonTools } from './shared-scenes-tools.ts';
import { createSettingsGuideTool } from './settingsguide.ts';
import { findToolsTool } from './lean.ts';
import { createReviewTools } from './codereview.ts';
import { createIssueTool, IssueWatcher } from './issues.ts';
import { createPlannerTools, PlannerStore, type Reminder } from './planner.ts';
import { fileChannelChats } from './bridges/rooms.ts';
import { Goals } from './goals.ts';
import { Loops } from './loops.ts';
import { Watches } from './watch.ts';
import { Research } from './research.ts';
import { Learning } from './learn.ts';
import { runAutoUpdates } from './addon-autoupdate.ts';
import { storeAutoUpdateDeps } from './routes/store.ts';
import { Meetings } from './meetings.ts';
import { Crews } from './crews.ts';
import { Workers } from './workers.ts';
import { broadcastEvent, EventTriggers, mcpEventOf, registerTriggers, subscribeWanted } from './event-triggers.ts';
import { MemoryTidy } from './memory-tidy.ts';
import { WorkingStyle } from './working-style.ts';
import { ReminderScheduler } from './reminders.ts';
import { CompanionHub, EventHub } from './events.ts';
import { InnerStore } from './inner.ts';
import { LifeStore, LifeWorker } from './life.ts';
import { Agenda, createAgendaTools } from './agenda.ts';
import { LocalVoiceEngine } from './voice.ts';
import { TelegramBridge } from './bridges/telegram.ts';
import { ApnsSender } from './apns.ts';
import { PushService } from './push.ts';
import { ReportStore } from './reports.ts';
import { Subscriptions } from './subscriptions/index.ts';
import { BACKUPS_DIR, backupName, createBackup, DEFAULT_BACKUP, restoreBackup, assertPersonalRestoreArchive } from './backup.ts';
import { appInfo } from './health.ts';
import { DiscordBridge } from './bridges/discord.ts';
import { McpManager } from './tools/mcp.ts';
import { detectSandbox, lockDataDir, type SandboxInfo, type SandboxPreference } from './tools/sandbox.ts';
import { effectiveEgress, isolationSettings, IsolationService, setIsolation } from './isolation.ts';
import { setEgressSource } from './egress-run.ts';
import { FindingStore } from './security/findings.ts';
import { OsvClient } from './security/advisories.ts';
import { SecurityPass } from './security/pass.ts';
import { FixBranches, sweepFixDirs } from './security/fix.ts';
import { ThreatPass } from './security/threats.ts';
import { RedTeam } from './redteam.ts';
import { detectIsolation, SandboxGate, sandboxGateSettings, sweepSandboxRuns, type Isolation, type SandboxGateSettings } from './sandbox-run.ts';
import { accessInfo, adminHint, localVoiceMissing, setLocalVoiceDir } from './platform.ts';
import { statusReport } from './status.ts';
import { tailscaleStatus } from './tailscale.ts';
import { createWebSearchTool } from './tools/search.ts';
import { mcpSecrets, searchConfig } from './integrations.ts';
import { loadPersona } from './persona.ts';
import { createSaraServer, proxyTrust } from './server.ts';
import { setWakeLexiconDir } from './routes/wake.ts';
import { HandsHub } from './hands.ts';
import { createComputerTools } from './tools/computer.ts';
import { PhoneHelper } from './phone-helper.ts';
import { createPhoneTools } from './tools/phone.ts';
import { UploadStore } from './uploads.ts';
import { BriefingWorker } from './briefing.ts';
import { gmailTodayHook, todayChanged } from './today.ts';
import { LeaveByWorker } from './leaveby.ts';
import { ReviewWorker } from './review.ts';
import { createPhotoTools, DEFAULT_IMAGE_MODEL, photoSettings, xaiImageKey } from './photos.ts';
import { policyResolver } from './tool-policy.ts';
import { LookBuilder, PLACES } from './look.ts';
import { createWardrobeTool, WardrobeWorker } from './wardrobe.ts';
import { createSharedListTool, TogetherStore } from './together.ts';
import { ReadTogether } from './read-together.ts';
import { createScrapbookTool, Scrapbook } from './scrapbook.ts';
import { createMomentsTool, MomentsStore, MomentsWorker } from './moments.ts';
import { migrateProviderLabels, type Settings, SettingsStore, StartupError } from './settings.ts';
import { AuditTrail, setAuditTrail } from './audit-trail.ts';
import { PolicyStore, setPolicy } from './policy-profile.ts';
import { DataRights, dataRights, setDataRights } from './data-rights.ts';
import { assertDirNotHeld } from './legal-hold.ts';
import { setShares, shares, ShareStore } from './share.ts';
import { budgetAlerter, UsageBudgets, type ReportSource } from './usage-report.ts';
import { Store } from './store.ts';
import { Vault } from './vault.ts';
import { guard, Log, logOptions } from './log.ts';
import { PrivateLocalStore } from './private-local.ts';
import { ModelPuller } from './local-models.ts';
import { ModelCatalog } from './model-catalog.ts';
import { createProvider } from './providers/registry.ts';
import { HealthHistory } from './health-history.ts';
import { createRecallTool, sharedWithApps } from './recall.ts';
import { backfill, RecallIndex, recallMode } from './triggers.ts';
import { LibraryStore } from './library/store.ts';
import { LibraryWorker } from './library/worker.ts';
import { createSendFileTool } from './tools/send-file.ts';
import { sweepShared } from './bridges/media.ts';
import { PendingInputs } from './pending.ts';
import { createLibraryTool } from './library/use.ts';
import { CodeMaps } from './codemap/index.ts';
import { createCodeTools } from './codemap/tools.ts';
import { RecipeStore } from './recipes.ts';
import { SkillStore } from './skill-store.ts';
import { SkillLearner } from './skill-learning.ts';
import { PluginManager } from './plugins/manager.ts';
import { A2AServer } from './a2a.ts';
import { A2AClient } from './a2a-client.ts';
import { HookManager } from './webhooks.ts';
import { createSkillTools } from './skill-tools.ts';
import { workspaceDir } from './tools/workspace.ts';
import { createTuneTool } from './studio.ts';
import { DriftStore } from './drift.ts';
import { TitleKeeper } from './titles.ts';
import { RoomKeeper } from './bridges/keepup.ts';
import { paceFactor, tensionHalfLife } from './bond.ts';
import { CompanionManager, CompanionSettings, companionDirs, LinkedToolRegistry, MAIN_ID, type Companion } from './companions.ts';
import { pickCompanion, type HouseholdHooks, type MemberHooks } from './server.ts';
import { createServer, type IncomingMessage } from 'node:http';
import { DeviceFlow } from './device-flow.ts';
import { SESSION_COOKIE } from './auth.ts';
import { Evals } from './evals.ts';
import { cookieValue, HouseholdStore, MEMBER_TOKEN_PREFIX, MemberPolicy, MemberSettings, memberDirs, memberOfToken, memberUsage, memberVault, PairRegistry, peekJson, type MemberRecord, type ModelPick } from './household.ts';
import type { Vault as VaultT } from './vault.ts';
import { AlexaService } from './alexa.ts';
import { PresenceWorker } from './presence.ts';
import { applyIndex, localStore, storeBase, storeBlocked, StoreClient } from './store/client.ts';
import { StoreInstalls } from './store/installs.ts';
import { StoreInstaller } from './store/install.ts';
import { PackInstaller, PackInstalls } from './packs/install.ts';
import { fetchHeld } from './store/submit.ts';
import { storeSettings } from './routes/store.ts';
import { detectChannel, hubArch, hubBase, type HubOs, hubOs, HubPinger, HubState, localHub, modelKind, pingBlocked, scrubText, TicketStore, type HubFacts, type HubSpace } from './hub.ts';
import { appLanguage } from './i18n.ts';
import { homedir } from 'node:os';
import { assertPersonalProfile, runtimeProfile } from './business/profile.ts';

// A promise nobody waited for that failed: log it and carry on (a background job, a model call
// whose answer was no longer needed). A thrown error nothing caught: log it plainly and stop, so
// the service manager starts a clean server again.
process.on('unhandledRejection', (err) => console.warn(`Background task failed: ${(err as Error)?.stack ?? err}`));
process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (err instanceof StartupError || code === 'ENOTDIR' || code === 'EACCES' || code === 'ENOSPC' || code === 'EROFS') {
    console.error(`\nSara can't start: ${err instanceof StartupError ? err.message : err.message}`);
    if (code === 'ENOSPC') console.error('The disk is full. Free some space, then start her again.');
    const dir = resolve(process.env.SARA_DATA ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data'));
    let newest = '';
    try {
      newest = readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.tar.gz')).sort().at(-1) ?? '';
    } catch {
      newest = '';
    }
    if (newest) console.error(`Your newest backup is ${join(dir, 'backups', newest)}. To go back to it: ${adminHint(`restore ${join(dir, 'backups', newest)}`)}  (without the installer: node src/main.ts --restore <file>)`);
    else if (err instanceof StartupError) console.error(`There is no backup in the data folder yet. If you have one elsewhere: ${adminHint('restore <file>')}.`);
    process.exit(1);
  }
  console.error(`Sara stopped because of an unexpected error (she restarts by herself when run as a service):\n${err.stack ?? err}`);
  process.exit(1);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.SARA_DATA ?? join(root, 'data'));
const host = process.env.SARA_HOST ?? '127.0.0.1';
const port = Number(process.env.SARA_PORT ?? 7860);
const defaultPersonaPath = resolve(process.env.SARA_PERSONA ?? join(root, 'persona', 'sara.json'));

// EC27: `sara addons requalify --from <results.json> --index <index.json>` folds qualification runs
// into store/qualified.json (scripts/addons-requalify.ts). Touches no data folder.
if (process.argv[2] === 'addons' && process.argv[3] === 'requalify') {
  const { requalify } = await import('./store/requalify-cli.ts');
  try {
    for (const line of requalify(process.argv.slice(4))) console.log(line);
    process.exit(0);
  } catch (err) {
    console.error(`requalify: ${(err as Error).message}`);
    process.exit(1);
  }
}
// Dispatch before constructing owner auth, stores, tools, or background workers.
// EC14: `sara acp` is a client (the editor agent over stdio): it never opens the data folder.
if (process.argv[2] === 'acp') {
  const acpFile = join(root, 'clients', 'cli', 'acp.ts');
  if (!existsSync(acpFile)) {
    process.stderr.write('sara acp is part of sara-chat here: install sara-chat on the editor\'s computer and use "sara-chat acp" (docs/EDITORS.md).\n');
    process.exit(2);
  }
  const { runAcp } = (await import(pathToFileURL(acpFile).href)) as typeof import('../clients/cli/acp.ts');
  process.exit(await runAcp(process.argv.slice(3)));
}
if (process.argv[2]?.startsWith('--business-')) {
  try { const { runBusinessCli } = await import('./business/cli.ts'); const code = await runBusinessCli(process.argv.slice(2), process.env); if (typeof code === 'number') process.exitCode = code; }
  catch { process.stderr.write('Business operator command refused. Check isolated paths, writer ownership, generation and required reconciliation.\n'); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}

if (runtimeProfile(process.env) === 'business') {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--version') {
    const i = appInfo(root);
    console.log(`Sara ${i.version}${i.revision ? ` (${i.revision})` : ''}`);
    process.exit(0);
  }
  if (process.argv.slice(2).length) throw new Error('Personal CLI commands are unavailable in the business profile.');
  const { startBusinessFromEnv } = await import('./business/runtime.ts');
  await startBusinessFromEnv(process.env);
  await new Promise<never>(() => {});
}
assertPersonalProfile(dataDir);
const personalRestoreIndex = process.argv.indexOf('--restore');
if (personalRestoreIndex >= 0 && process.argv[personalRestoreIndex + 1]) assertPersonalRestoreArchive(process.argv[personalRestoreIndex + 1]);

// Flags that read only (nothing is created): the installers and the `sara` command use them.
if (process.argv.includes('--version')) {
  const i = appInfo(root);
  console.log(`Sara ${i.version}${i.revision ? ` (${i.revision})` : ''}`);
  process.exit(0);
}
if (process.argv.includes('--tailscale-status')) {
  console.log(JSON.stringify(tailscaleStatus(), null, 2));
  process.exit(0);
}
if (process.argv.includes('--status')) {
  const i = appInfo(root);
  const running = await netFetch(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.status < 500, () => false);
  console.log(statusReport({ version: i.version, dataDir, port, running, access: accessInfo() }));
  process.exit(0);
}

if (existsSync(dataDir) && !statSync(dataDir).isDirectory()) throw new StartupError(`Her data folder ${dataDir} (SARA_DATA) is a file, not a folder.`);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// C15: was this server set up before (an owner file already there)? Then new-device approval
// starts off with a one-time notice instead of locking anyone out; a new install starts with it on.
const existingInstall = existsSync(join(dataDir, 'owner.json'));
const auth = new OwnerAuth(dataDir, undefined, { resetIfDamaged: process.argv.includes('--reset-token') });

/** The newest owner token, kept only until it's used once (the installer shows it from here). */
export const FIRST_TOKEN_FILE = 'first-token.txt';
function banner(token: string): void {
  // Straight to the console, never into the log file (Phase 30).
  const reset = process.env.SARA_DATA === '/data' && !existsSync('/usr/local/bin/sara') ? 'docker compose exec sara node src/main.ts --reset-token (then restart it)' : adminHint('reset-token');
  process.stdout.write(`\n================================================================\n Sara owner token (shown once, store it in your password manager):\n   ${token}\n Reset it any time with: ${reset}\n================================================================\n\n`);
  // Also in a file only Sara's user can read, until the first sign-in with it (then it's deleted),
  // so the installer can show it without anyone digging through system logs.
  try {
    writeFileSync(join(dataDir, FIRST_TOKEN_FILE), `${token}\n`, { mode: 0o600 });
  } catch {
    // not fatal: the console line above has it
  }
}

if (process.argv.includes('--reset-token')) {
  // The server-side recovery: also turns off passkeys and two-step sign-in (lost phone).
  const had = auth.passkeys().length > 0 || auth.twoStepOn;
  banner(auth.resetToken({ clearSecurity: true }));
  if (had) console.log(' Passkeys and two-step sign-in were turned off. Set them up again in Settings → Devices and sign-in.');
  process.exit(0);
}

const info = appInfo(root);
const argAfter = (flag: string) => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
};
if (process.argv.includes('--backup')) {
  const out = resolve(argAfter('--backup') ?? join(dataDir, BACKUPS_DIR, backupName(new Date())));
  const m = createBackup(dataDir, out, { saraVersion: info.version, includeWorkspaces: !process.argv.includes('--no-workspaces') });
  console.log(`Backup written: ${out} (${m.files} files). It contains your keys: keep it private.`);
  process.exit(0);
}
if (process.argv.includes('--restore')) {
  const file = argAfter('--restore');
  if (!file) {
    console.error('Usage: node src/main.ts --restore <backup.tar.gz>');
    process.exit(2);
  }
  const running = await netFetch(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  if (running) {
    console.error(`Sara is running on port ${port}. Stop her first (${process.platform === 'linux' && existsSync('/usr/local/bin/sara') ? 'sudo systemctl stop sara' : adminHint('stop')}), then restore.`);
    process.exit(1);
  }
  let source = resolve(file);
  // An encrypted off-server copy: decrypt it first (passphrase from SARA_BACKUP_PASSPHRASE).
  if (isEncrypted(readFileSync(source).subarray(0, 8))) {
    const pass = process.env.SARA_BACKUP_PASSPHRASE;
    if (!pass) {
      console.error(`This backup is encrypted. Set SARA_BACKUP_PASSPHRASE (${adminHint('restore')} asks for it).`);
      process.exit(2);
    }
    try {
      const plain = decryptBackup(readFileSync(source), pass);
      // Beside (not inside) the data folder, which the restore moves aside; removed afterwards.
      source = `${dataDir.replace(/[\\/]+$/, '')}.decrypted-${process.pid}.tar.gz`;
      writeFileSync(source, plain, { mode: 0o600 });
      const tmp = source;
      process.on('exit', () => rmSync(tmp, { force: true }));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }
  try {
    const r = restoreBackup(source, dataDir);
    console.log(`Restored backup from ${r.manifest.createdAt} (Sara ${r.manifest.saraVersion}). Previous data kept in ${r.movedTo}.`);
    process.exit(0);
  } catch (err) {
    console.error(`Restore failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

const sandboxPref = (process.env.SARA_SANDBOX ?? 'auto') as SandboxPreference;
const settings = new SettingsStore(dataDir);
if (settings.get().deviceApproval === undefined) settings.update({ deviceApproval: initialDeviceApproval(existingInstall) });
{
  const renamed = migrateProviderLabels(settings.get());
  if (renamed) settings.update({ providers: renamed.providers });
  // Phase 16: adult content became a switch (off by default). Servers set up before it existed
  // had adult content available, so they ask the owner once.
  if (!settings.get().adultMode) settings.update({ adultMode: settings.get().disclosureAcceptedAt ? { on: false, ask: true } : { on: false } });
}
const vault = new Vault(dataDir, process.env.SARA_MASTER_KEY);
// EC10: references to external secret sources are read before anything uses them (10 s at most each).
await vault.ready();
// Phase 121: `sara doctor [--safety]` and `node src/main.ts doctor --safety` mean --doctor.
if (process.argv[2] === 'doctor' && !process.argv.includes('--doctor')) process.argv.push('--doctor');
if (process.argv.includes('--doctor')) {
  let sb: SandboxInfo;
  try {
    sb = detectSandbox(sandboxPref, true, { dataDir });
  } catch (err) {
    sb = { mode: 'none', network: true, detail: (err as Error).message };
  }
  // EC8: the doctor reports the sandbox commands really get (a container where one is used).
  new IsolationService({ native: { ...sb }, target: sb, settings: () => isolationSettings(settings.get()), image: () => sandboxGateSettings(settings.get()).dockerImage, required: () => new PolicyStore(dataDir).pins.containerSandbox === true }).recheck();
  const tools = new ToolRegistry();
  tools.unsandboxed = sb.mode === 'none';
  // Phase 121: the safety check-up (read-only here: nothing is fixed or written from the CLI).
  // The CLI has no live tool list, so the owner's own approval choices stand in for it.
  for (const [name, perm] of Object.entries(settings.get().toolPermissions ?? {})) if (perm === 'auto' && !tools.list().some((t) => t.spec.name === name)) tools.add({ spec: { name, description: name, parameters: { type: 'object', properties: {} } }, defaultPermission: 'ask', ...(/shell|command|job|ssh|terminal|exec|run_/.test(name) ? { runsCommands: true } : {}), summarize: () => name, run: async () => '' });
  const { runSafetyCheck, formatSafety, verdictLine, exitCodeOf } = await import('./safety-check.ts');
  const { Store } = await import('./store.ts');
  const { HookStore } = await import('./webhooks.ts');
  const { loadPersona } = await import('./persona.ts');
  const dbFile = join(dataDir, 'sara.db');
  const cliStore = existsSync(dbFile) ? new Store(dbFile) : undefined;
  const cliApp = { settings, vault, tools, sandbox: sb, now: () => new Date(), store: cliStore ?? { db: new DatabaseSync(':memory:') }, persona: loadPersona(join(root, 'persona', 'sara.json')), ...(cliStore ? { hooks: { store: new HookStore(cliStore.db) } } : {}) } as unknown as AppContext;
  const safety = await runSafetyCheck({ app: cliApp, auth, dataDir, sandbox: sb, version: appInfo(root).version }, 'cli', { log: false });
  if (process.argv.includes('--safety')) {
    console.log(formatSafety(safety, { fixes: true }));
    console.log(`\n${verdictLine(safety)}`);
    process.exit(exitCodeOf(safety.verdict));
  }
  const checks = await runDoctor({ dataDir, settings, vault, subscriptions: new Subscriptions(vault, dataDir), sandbox: sb, tools });
  console.log(formatDoctor(checks));
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  console.log(`\n${fails ? `${fails} problem(s)` : 'No problems'}${warns ? `, ${warns} thing(s) to look at` : ''}.`);
  console.log(`\nSafety\n${formatSafety(safety)}\n\n${verdictLine(safety)}`);
  process.exit(fails ? 1 : 0);
}
// Phase 125 (SARA_STORE.md §9.4): `sara submit <folder>` (deploy/sara runs it as the sara user, for
// the vault's author key). Private local mode refuses it; nothing is sent without "y".
// Phase 126 part C (WAKE.md §7): `sara voice install`: her own hearing and voices on Windows and macOS.
if (process.argv[2] === 'voice') {
  const { PrivateLocalStore: PL } = await import('./private-local.ts');
  new PL(dataDir);
  const { runVoiceCli, engineAfterInstall } = await import('./voice-install.ts');
  const dir = resolve(process.env.SARA_VOICE_DIR ?? (process.platform === 'linux' ? '/opt/sara-voice' : join(dataDir, 'voice')));
  const code = await runVoiceCli(process.argv.slice(3), {
    voiceDir: dir,
    afterInstall: () => {
      const v = settings.get().voice;
      const patch = engineAfterInstall({ stt: v?.stt ?? 'off', tts: v?.tts ?? 'off' });
      if (Object.keys(patch).length) settings.update({ voice: { ...(v ?? {}), ...patch } as never });
    },
  });
  process.exit(code);
}
if (process.argv[2] === 'submit') {
  const { PrivateLocalStore: PL } = await import('./private-local.ts');
  new PL(dataDir);
  const { privateLocalOn } = await import('./net-guard.ts');
  if (privateLocalOn()) {
    console.log('Private local mode is on, so nothing is sent. Switch it off first (Settings → Privacy).');
    process.exit(1);
  }
  const { runSubmit } = await import('./store/pack-cli.ts');
  const db = new DatabaseSync(join(dataDir, 'sara.db'));
  const code = await runSubmit(process.argv.slice(3), { saraVersion: appInfo(root).version, dataDir, vault, hubBase: hubBase(process.env), installId: new HubState(dataDir).get().id, db, os: hubOs() });
  db.close();
  process.exit(code);
}
// Phase 67: "Nothing leaves this computer" is applied before anything can reach out (the saved
// switch, or SARA_PRIVATE_LOCAL=1 / start). The guard itself is src/net-guard.ts.
const privateLocal = new PrivateLocalStore(dataDir);
const modelPuller = new ModelPuller();
const sandbox = detectSandbox(sandboxPref, true, { dataDir });
if (sandbox.mode === 'user') {
  // New files are private to the server (and the tools group inside workspaces); existing ones too.
  process.umask(0o007);
  lockDataDir(dataDir);
}
const redactor = new Redactor(() => vaultSecretValues(vault.values()));
// Phase 30: a copy of everything Sara prints goes to <data>/logs/sara.log (secrets hidden).
// Phase 63: SARA_LOG_FORMAT / SARA_LOG_LEVEL / SARA_LOG_FILE (+ _MAX_MB, _KEEP), see src/log.ts.
const log = new Log(dataDir, (s) => redactor.redact(s), undefined, logOptions());
// Settings → Data & health may save a level; SARA_LOG_LEVEL, when set, wins.
log.useSaved(settings.get().logLevel);
log.captureConsole();
const isDemo = process.env.SARA_DEMO === '1';
// C13: one language-server engine for the process (servers start on first use, stop when idle).
const lspEngine = new LspEngine();
// EC28: a restore drill boots a throwaway copy of a backup (src/restore-drill.ts): it answers
// /api/health and sign-in, but starts no workers, bridges, plugins, tool servers or backups.
const isDrill = process.env.SARA_RESTORE_DRILL === '1';
// EC5: the admin's policy profile (<data>/policy.json; none = no pins). EC4: the server's one audit trail.
const policyStore = new PolicyStore(isDemo ? undefined : dataDir);
setPolicy(policyStore);
const auditTrailMain = isDemo
  ? undefined
  : new AuditTrail(dataDir, {
      redact: (s) => redactor.redact(s),
      key: () => vault.get('audit:key') ?? (vault.set('audit:key', randomBytes(32).toString('hex')), vault.get('audit:key')!),
      policyRev: () => policyStore.get().rev,
    });
setAuditTrail(auditTrailMain);
// EC8 + EC9 (docs/ops/EC89_DESIGN.md): a container (Podman/Docker) where the owner chooses it, the
// admin requires it or nothing else isolates; `sandbox` is updated in place, so every holder sees it.
const sandboxListeners: ((s: SandboxInfo) => void)[] = [];
const isolationSvc = new IsolationService({
  native: { ...sandbox },
  target: sandbox,
  settings: () => (sandboxPref === 'none' ? { ...isolationSettings(settings.get()), backend: 'native' } : isolationSettings(settings.get())),
  image: () => sandboxGateSettings(settings.get()).dockerImage,
  required: () => policyStore.pins.containerSandbox === true,
  onChange: (s) => {
    for (const f of sandboxListeners) f(s);
  },
});
setIsolation(isolationSvc);
isolationSvc.recheck();
setEgressSource(() => effectiveEgress(settings.get(), policyStore.pins), (name) => vault.get(name));
// EC11: shared conversation links, one store per server (never on the demo).
if (!isDemo) setShares(new ShareStore(dataDir));
const pruneAudit = () => auditTrailMain?.prune(policyStore.pins.auditRetentionDays ?? auditTrailMain.retentionDays);
// The demo lets anyone in without signing in, so it must never run on a real owner's data.
if (isDemo && existsSync(join(dataDir, 'sara.db'))) {
  const db = new DatabaseSync(join(dataDir, 'sara.db'), { readOnly: true });
  try {
    const has = (table: string) => {
      try {
        return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n) > 0;
      } catch {
        return false; // no such table yet
      }
    };
    if (['conversations', 'memories', 'notes', 'tasks', 'reminders', 'library_docs'].some(has)) throw new StartupError(`SARA_DEMO=1 is set, but ${dataDir} holds someone's conversations or notes. The demo lets visitors in without signing in, so it only runs on its own empty data folder (deploy/install-demo.sh makes one).`);
  } finally {
    db.close();
  }
}
const webDir = join(root, 'web');

// ---- Shared by every companion (Phase 31) ----
// Add-on (MCP) tools run once, in the first companion's tool list; the others link to them.
const mainTools = new ToolRegistry();
// Phase 46: no sandbox (Windows, or none found): commands ask first unless the owner chose otherwise.
mainTools.unsandboxed = sandbox.mode === 'none';
sandboxListeners.push((s) => {
  mainTools.unsandboxed = s.mode === 'none';
  console.log(`Tool sandbox: ${s.mode} (${s.detail})`);
});
const mcp = new McpManager(mainTools, { dataDir, sandbox, secrets: (name) => mcpSecrets(vault, name) });
// C4: tool-server events reach the owner's triggers; watched resources are subscribed on connect.
mcp.onNotification = (server, method, params) => {
  const ev = mcpEventOf(server, method, params);
  if (ev) broadcastEvent(ev);
};
mcp.onReady = (conn) => subscribeWanted(conn);
// Phase 73: the owner's other servers over SSH (docs/SSH.md). Owner only: not in household members'
// spaces, and not on the demo server.
const sshManager = isDemo ? undefined : new SshManager({ dir: dataDir, vault });
if (sshManager) for (const t of createSshTools(() => sshManager)) mainTools.add(t);
const events = new EventHub();
const subscriptions = new Subscriptions(vault, dataDir);
// SARA_GOOGLE_API_BASE (loopback only) points the Google APIs at a local fake for tests.
const googleBase = googleApiBase();
const google = new GoogleAccount(vault, googleBase ? { apiBase: googleBase } : {});
// C14: Spotify (the owner's own Spotify app; off until he connects it).
const spotifyBase = spotifyApiBase();
const spotify = new SpotifyAccount(vault, spotifyBase ? { apiBase: spotifyBase } : {});
// Local voice tools are Linux only for now (deploy/install-voice.sh).
// Phase 126 part C: on Windows and macOS her voice lives in <data>/voice (`sara voice install`).
const voiceDir = resolve(process.env.SARA_VOICE_DIR ?? (process.platform === 'linux' ? '/opt/sara-voice' : join(dataDir, 'voice')));
setLocalVoiceDir(voiceDir);
// Phase 126: the English word list for custom Hey Sara phrases (one copy for every space on this server).
setWakeLexiconDir(join(dataDir, 'voice', 'wake-lexicon'));
const voice = new LocalVoiceEngine(voiceDir, dataDir);
const companions = new CompanionManager(dataDir);
// Phase 98 (ST3, docs/PLUGINS.md): the owner's plugins (one manager for the server; enabled per
// companion; never in household members' spaces, never on the demo). Its tables live in the owner's
// database; each enabled plugin runs in its own fenced process.
const pluginManager = isDemo || isDrill
  ? undefined
  : (() => {
      const pdb = new DatabaseSync(join(dataDir, 'sara.db'));
      pdb.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      return new PluginManager({ db: pdb, dataDir, vault, sandbox, events, scrub: (s) => redactor.redact(s) });
    })();

// Phase 124 (docs/store/SARA_STORE.md §6.2): the Sara Store's reader (the owner's server only; never
// the demo or a member's space). It downloads the one public list once a day through the network
// guard; SARA_STORE_URL points it at a local fake (tests, local checks), and only with such a local
// address may SARA_STORE_TEST_KEYS name a JSON file of test public keys (never in production).
const storeUrl = storeBase(process.env);
let storeOn: () => boolean = () => true;
const storeTestKeys = ((): Record<string, string> | undefined => {
  const f = process.env.SARA_STORE_TEST_KEYS;
  if (!f || !localStore(storeUrl)) return undefined;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Record<string, string>;
  } catch {
    return undefined;
  }
})();
// Phase 125 (§10.2): the hub's held list rides along with each check (an anonymous GET, no id; in
// tests only from a local hub).
const storeHub = hubBase(process.env);
const storeHeld = () => ((process.env.NODE_TEST_CONTEXT || process.env.SARA_TESTING === '1') && !localHub(storeHub) ? Promise.resolve([]) : fetchHeld(storeHub));
const storeClient = isDemo ? undefined : new StoreClient({ dataDir, base: storeUrl, blocked: () => storeBlocked({ demo: isDemo, on: storeOn(), base: storeUrl }), ...(storeTestKeys ? { keys: storeTestKeys } : {}), held: storeHeld, log: (l) => console.warn(l) });
/** Phase 125: the owner's main companion, for blocks on skills and tool servers (set once it exists). */
let storeOwnerApp: AppContext | undefined;
const storeInstalls = pluginManager ? new StoreInstalls(pluginManager.store.db) : undefined;
if (storeClient) {
  storeClient.onIndex = async (index) => {
    await applyIndex(index, {
      client: storeClient,
      ...(storeInstalls ? { installs: storeInstalls } : {}),
      ...(pluginManager ? { plugins: pluginManager } : {}),
      others: async (row, reason) => {
        // Phase 127: a pulled companion pack pauses her (the pack installer of src/packs/install.ts).
        const packs = storeOwnerApp && row.kind === 'companion' ? new PackInstaller({ app: storeOwnerApp, companions, rootDir: dataDir, installs: new PackInstalls(storeOwnerApp.store.db), client: storeClient, ...(storeInstalls ? { storeInstalls } : {}) }) : undefined;
        if (storeOwnerApp && storeInstalls) await new StoreInstaller({ app: storeOwnerApp, client: storeClient, installs: storeInstalls, ...(pluginManager ? { plugins: pluginManager } : {}), ...(packs ? { packs } : {}) }).blockOther(row, reason);
      },
    });
    // C8: add-on auto-update (off by default) after each look at the signed index.
    if (storeOwnerApp) {
      const owner = storeOwnerApp;
      const deps = storeAutoUpdateDeps(owner, (title, line) => void owner.push?.notifyOwner(title, line, '', 'addon-update').catch(() => {}));
      if (deps) await runAutoUpdates(deps).catch((err: Error) => console.warn(`auto-update: ${err.message}`));
    }
  };
  if (pluginManager) pluginManager.storeMatch = (sha) => storeClient.match(sha);
}

// Phase 100 (ST5, docs/A2A.md): A2A, the owner's only (never a member's space, never the demo). One
// server and one client for the owner's companions, on their own connection to the owner's sara.db;
// made with the main companion (who answers peers) in buildCompanion below.
const a2aDb = isDemo
  ? undefined
  : (() => {
      const d = new DatabaseSync(join(dataDir, 'sara.db'));
      d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      return d;
    })();
// Phase 102 (ST7, docs/WEBHOOKS.md): webhooks, the owner's only (never a member's space, never the
// demo). One manager on its own connection to the owner's sara.db, attached to his companions.
const hookManager = isDemo
  ? undefined
  : (() => {
      const d = new DatabaseSync(join(dataDir, 'sara.db'));
      d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
      return new HookManager({ db: d, vault, scrub: (s) => redactor.redact(s), allowLocalTargets: process.env.SARA_HOOKS_LOCAL_TARGETS === '1', keepDays: () => settings.get().hooks?.keepDays ?? 14, onAccepted: (d) => broadcastEvent({ source: 'webhook', hookId: d.hookId, event: d.event, text: d.text, ...(d.deliveryId ? { id: d.deliveryId } : {}) }) });
    })();
let a2aServer: A2AServer | undefined;
let a2aClient: A2AClient | undefined;

/**
 * Phase 71: a person's space (docs/HOUSEHOLD.md). The owner's is the data folder itself, exactly as
 * before; each household member's is members/<id>/ with its own sign-in, settings, event hub,
 * notifications and companions, built by the same buildCompanion below.
 */
interface Space {
  id: string;
  dir: string;
  auth: OwnerAuth;
  settings: SettingsStore;
  vault: VaultT;
  events: EventHub;
  companions: CompanionManager;
  push?: PushService;
  member?: MemberPolicy;
  /** Phase 87: this person's hands devices (computer use), shared by their companions. */
  hands?: HandsHub;
  /** EC24: the owner's helper devices (camera, location, screen on request); never a member's. */
  phoneHelper?: PhoneHelper;
}
/** Phase 87: one hands hub per person; a member's works only with the owner's switch on (never on the demo). */
function handsFor(sp: Space, member: boolean): HandsHub | undefined {
  if (isDemo) return undefined;
  return new HandsHub({
    events: sp.events,
    allowed: member ? () => settings.get().computerUse?.members === true : () => true,
    known: () => sp.auth.devices().filter((d) => d.kind === 'hands').map((d) => ({ id: d.id, label: d.label, lastSeen: d.lastSeen })),
    // Phase 89: the dev tunnel never reaches Sara's own port.
    tunnels: { ownPorts: () => [port] },
  });
}
const ownerSpace: Space = { id: 'owner', dir: dataDir, auth, settings, vault, events, companions };
ownerSpace.hands = handsFor(ownerSpace, false);
// EC24: only browser sign-ins that are still signed in count as helper devices.
if (!isDemo) {
  const browserSession = (id: string) => auth.devices().find((d) => d.id === id && d.kind === 'browser');
  ownerSpace.phoneHelper = new PhoneHelper({ dir: dataDir, events, alive: (id) => Boolean(browserSession(id)), label: (id) => browserSession(id)?.label });
}
const memberSpaces = new Map<string, Space>();
// EC5: a saved policy brings every companion's and member's settings in line (only ever tighter).
policyStore.onApply = (p) => {
  // EC8: a container pin (or its removal) takes effect at once.
  isolationSvc.recheck();
  // EC24: pinned off: every waiting phone prompt closes at once.
  if (p.pins.phoneHelper === false) ownerSpace.phoneHelper?.cancelAll();
  for (const sp of [ownerSpace, ...memberSpaces.values()]) {
    for (const c of sp.companions.all()) {
      const s = c.app.settings.get();
      const patch: Partial<Settings> = {};
      if (p.pins.adultMode === false && s.adultMode?.on) patch.adultMode = { ...s.adultMode, on: false };
      if (p.pins.shellNetwork === false && s.shellNetwork !== false) patch.shellNetwork = false;
      if (Object.keys(patch).length) c.app.settings.update(patch);
    }
  }
};
const household = new HouseholdStore(dataDir);
// EC15: usage reports read every person's companions (the owner's space only); budgets warn early.
const usageBudgets = new UsageBudgets(dataDir);
const usageSources = (): ReportSource[] => [
  ...companions.all().map((c) => ({ person: 'owner', personName: settings.get().ownerName || 'Owner', db: c.app.store.db })),
  ...[...memberSpaces.entries()].flatMap(([id, sp]) => sp.companions.all().map((c) => ({ person: id, personName: household.get(id)?.name ?? id, db: c.app.store.db }))),
];
// Phase 99 (ST4, docs/BOARD.md): household boards shared by choice, in one shared store (never on the
// demo). A change is pushed to the event hub of each of the board's people only.
const sharedBoards = isDemo ? undefined : new SharedBoardStore(join(dataDir, 'shared', 'boards.db'));
// EC17 (docs/DATA_RIGHTS.md): retention, legal hold and per-person export/delete (never on the demo).
setDataRights(
  isDemo
    ? undefined
    : new DataRights(dataDir, {
        spaces: () => [
          { person: 'owner', name: settings.get().ownerName || 'Owner', dir: dataDir, apps: () => ownerSpace.companions.all().map((c) => c.app) },
          ...[...memberSpaces.values()].map((sp) => ({ person: sp.id, name: household.get(sp.id)?.name ?? sp.id, dir: sp.dir, apps: () => sp.companions.all().map((c) => c.app) })),
        ],
        deleteMember: (id) => deleteMemberSpace(id),
      }),
);
const spaceOf = (person: string): Space | undefined => (person === 'owner' ? ownerSpace : memberSpaces.get(person));
sharedBoards?.listeners.add((ev) => {
  for (const p of ev.people) spaceOf(p)?.events.publish({ type: 'board', boardId: ev.boardId, what: ev.what });
});
function sharedAccess(space: Space): SharedBoardsAccess | undefined {
  if (!sharedBoards) return undefined;
  return {
    store: sharedBoards,
    person: space.id,
    people: () => [{ id: 'owner', name: settings.get().ownerName?.trim() || 'Owner' }, ...household.members().filter((m) => m.status === 'active').map((m) => ({ id: m.id, name: m.name }))],
    copyToPlanner: (person, card) => {
      try {
        spaceOf(person)?.companions.main.app.planner?.addTask({ title: card.title, notes: card.notes, dueAt: card.dueAt });
      } catch (err) {
        console.warn(`shared board copy: ${(err as Error).message}`);
      }
    },
  };
}
// Sign-in registries shared by every space (codes are made or approved by a signed-in person).
const deviceFlow = new DeviceFlow();
const pairs = new PairRegistry();
const challenges = new Map<string, { purpose: 'signin' | 'register' | 'confirm'; expires: number }>();
// Phase 49: preview links (one list for the whole server) and the testing browsers.
const previews = new PreviewManager({ ownPorts: () => [port] });
const browsers = new BrowserManager({ sandbox: () => sandbox, previews, sweep: true });
// Phase 50: the code maps of the workspaces (one per workspace, shared like the workspaces; a
// rebuildable cache, so backups leave it out). Meaning search uses the first companion's job.
const codemaps = new CodeMaps({ cacheDir: join(dataDir, 'cache', 'codemap'), target: () => embedTarget(companions.main.app) });
// Phase 80 (harness M5): risky commands try a throwaway copy first (src/sandbox-run.ts). Copies live
// in <data>/cache/sandbox-runs (left-overs from a restart are swept now); the isolation available
// (bubblewrap, the macOS sandbox, Docker or WSL2 on Windows, else the copy only) is looked up once,
// in the background, and shared by every companion.
const sandboxRunsDir = join(dataDir, 'cache', 'sandbox-runs');
try {
  const wsRoot = join(dataDir, 'workspaces');
  sweepSandboxRuns(sandboxRunsDir, existsSync(wsRoot) ? readdirSync(wsRoot).map((n) => join(wsRoot, n)) : []);
} catch (err) {
  console.warn(`sandbox: could not clear old tries: ${(err as Error).message}`);
}
const isolationCache = new Map<string, Isolation>();
const sharedIsolation = (base: SandboxInfo, g: SandboxGateSettings): Isolation => {
  const key = `${base.mode}|${g.dockerImage}`;
  if (!isolationCache.has(key)) isolationCache.set(key, detectIsolation(base, g));
  return isolationCache.get(key)!;
};
setTimeout(() => {
  try {
    const iso = sharedIsolation(sandbox, sandboxGateSettings(settings.get()));
    console.log(`Sandbox tries: ${iso.driver}${iso.isolated ? ' (isolated)' : ' (copy only, not isolated)'}`);
  } catch {
    /* looked up on first use */
  }
}, 2000).unref();
let healthHistory: HealthHistory | undefined;
let bridges: AppContext['bridges'];
// Phase 59: a new server nobody has signed in to can be set up in the browser for a while after
// each start (src/claim.ts): with the setup code printed below, or with no code behind a platform
// login (SARA_SETUP=browser, Umbrel). SARA_SETUP=off keeps the owner token as the only way in.
const claim = new FirstClaim({ pending: () => auth.setupPending, mode: claimModeFrom(process.env), windowMs: claimWindowMs(process.env) });
/** The setup code (or browser-setup note) for the start-up log, while setup is open. */
function claimBanner(): void {
  const st = claim.status();
  if (!st.open || !claim.code) return;
  const where = `http://${host === '0.0.0.0' || host === '::' ? '<this server>' : host}:${port}`;
  const lines =
    claim.mode === 'browser'
      ? [' Set Sara up in your browser: open her from your home screen (within', ` ${st.minutesLeft} minutes; restart her to open setup again).`]
      : [` Or set her up in the browser: open ${where} within ${st.minutesLeft} minutes`, ` and enter this setup code: ${formatClaimCode(claim.code)}`, ' (Restart her for a new code. It stops working once she has an owner.)'];
  process.stdout.write(`================================================================\n${lines.join('\n')}\n================================================================\n\n`);
}
// Phase 72: her Alexa skill, one for the server. A linked Alexa names a person's space and one of
// their companions; a paused, leaving or removed member's links answer nothing.
const alexa = new AlexaService({
  dir: dataDir,
  skillId: () => settings.get().alexa?.skillId,
  quick: () => settings.get().alexa?.quick === true,
  resolve: (link) => {
    const sp = link.space === 'owner' ? ownerSpace : memberSpaces.get(link.space);
    if (!sp || (sp.member && household.get(sp.id)?.status !== 'active')) return undefined;
    return sp.companions.get(link.companion)?.app;
  },
});
const serverOpts = {
  auth,
  alexa,
  claim,
  info,
  webDir,
  secureCookies: process.env.SARA_SECURE_COOKIES === '1',
  trustProxy: proxyTrust(process.env, dataDir),
  // Demo server for app review and trying Sara out (Phase 16).
  demo: isDemo,
  // This server is the app developer's report inbox (Phase 19).
  reportInbox: process.env.SARA_REPORT_INBOX === '1',
  ...(process.env.SARA_REPORT_TO ? { reportTo: process.env.SARA_REPORT_TO } : {}),
  ...(process.env.SARA_DEMO_DAILY ? { demoDaily: Number(process.env.SARA_DEMO_DAILY) } : {}),
  // Demo live calls for app review: only with this reviewer code (unset = no calls in the demo),
  // 5 minutes a call, and SARA_DEMO_CALL_MINUTES_PER_DAY minutes a day for everyone (default 30).
  ...(isDemo && process.env.SARA_DEMO_CALL_CODE?.trim() ? { demoCallCode: process.env.SARA_DEMO_CALL_CODE.trim() } : {}),
  ...(isDemo && process.env.SARA_DEMO_CALL_MINUTES_PER_DAY && Number.isFinite(Number(process.env.SARA_DEMO_CALL_MINUTES_PER_DAY)) ? { demoCallMinutesPerDay: Math.max(0, Number(process.env.SARA_DEMO_CALL_MINUTES_PER_DAY)) } : {}),
  companions,
  deviceFlow,
  pairs,
  challenges,
  anyPasskeys: () => auth.passkeys().length > 0 || [...memberSpaces.values()].some((sp) => sp.auth.passkeys().length > 0),
};

// ---- Phase 113: the hub (docs/SUPPORT.md): the daily check-in (the owner's server only, never the
// demo or a member's space) and every person's Report a problem / My reports ----
const hubState = new HubState(dataDir);
const hubUrl = hubBase(process.env);
/** Counts and on/off ids only (src/hub.ts buildPing checks every value against its lists). */
function hubFacts(): HubFacts {
  const s = settings.get();
  const on = (b: boolean, id: string) => (b ? [id] : []);
  const safe = (f: () => boolean) => {
    try {
      return f();
    } catch {
      return false;
    }
  };
  const bridgesOn = [
    ...on(safe(() => bridges?.telegram?.status().running === true), 'telegram'),
    ...on(safe(() => bridges?.discord?.status().running === true), 'discord'),
    ...on(Boolean(s.alexa?.skillId), 'alexa'),
    ...on(safe(() => auth.devices().some((d) => d.kind === 'home-assistant')), 'home_assistant'),
  ];
  const plugins = s.plugins ?? {};
  const features = [
    ...on(safe(() => auth.devices().some((d) => d.kind === 'hands')), 'computer_use'),
    ...on(Object.values(plugins).some((p) => p?.enabled), 'plugins'),
    ...on(safe(() => auth.devices().some((d) => d.kind === 'a2a')), 'a2a'),
    ...on(safe(() => (hookManager?.store.all().length ?? 0) > 0), 'webhooks'),
    ...on((s.mcpServers ?? []).some((m) => m.enabled), 'mcp'),
    ...on(Boolean(s.search?.provider) && String(s.search?.provider) !== 'none', 'web_search'),
    ...on(safe(() => google.status().connected === true), 'gmail'),
    ...on(Boolean(s.githubWatch), 'github'),
    ...on(safe(() => (sshManager?.list().length ?? 0) > 0), 'ssh'),
    ...on(s.agenda?.enabled === true, 'agenda'),
    ...on(voice.available.stt || voice.available.tts, 'voice_local'),
    ...on(Boolean(s.offsite?.kind) && s.offsite?.kind !== 'off', 'offsite_backup'),
    ...on(safe(() => household.members().some((m) => m.status === 'active')), 'household'),
    ...on(safe(() => auth.devices().some((d) => d.kind === 'api')), 'other_apps'),
    ...on(auth.twoStepOn, 'two_step'),
  ];
  return {
    version: info.version,
    channel: detectChannel({ root }),
    os: hubOs() as HubOs,
    arch: hubArch(),
    lang: appLanguage(s),
    companions: companions.all().length,
    members: household.members().filter((m) => m.status === 'active').length,
    bridges: bridgesOn,
    features,
    model: modelKind(s.providers),
  };
}
const hubBlocked = () => pingBlocked({ demo: isDemo, on: hubState.get().on, noticeShown: Boolean(hubState.get().noticeShownAt), base: hubUrl });
// SARA_HUB_FIRST_MS: a shorter first wait, honoured only for a hub on this computer (local checks).
const hubFirst = Number(process.env.SARA_HUB_FIRST_MS);
const hubPinger = isDemo ? undefined : new HubPinger({ state: hubState, facts: hubFacts, blocked: hubBlocked, base: hubUrl, log: (l) => console.warn(l), ...(Number.isFinite(hubFirst) && hubFirst > 0 ? { firstDelayMs: hubFirst } : {}) });
const hubSpaces = new Map<string, HubSpace>();
/** One hub per person's space: their own tickets (in their space's own sara.db, through its first companion's connection), the server's state. */
function hubFor(space: Space, db: DatabaseSync): HubSpace {
  const had = hubSpaces.get(space.id);
  if (had) return had;
  const member = Boolean(space.member);
  const h: HubSpace = {
    state: hubState,
    base: hubUrl,
    member,
    demo: isDemo,
    tickets: new TicketStore(db),
    facts: hubFacts,
    blocked: () => (member ? 'member' : hubBlocked()),
    ...(member ? {} : { pinger: hubPinger }),
    scrub: (x) => scrubText(x, (y) => redactor.redact(y), { homes: [homedir()], dirs: [dataDir, root] }),
    ...(member ? {} : { logLines: (n: number) => log.recent({ limit: n }).reverse().map((l) => `${l.t} ${l.level} ${l.msg}`).join('\n') }),
  };
  hubSpaces.set(space.id, h);
  return h;
}

/** Builds one companion: the first lives in the data folder itself, the others in companions/<id>/. */
// Phase 56: every provider's model list, kept current (one for the server; never on the demo).
const modelCatalog = isDemo
  ? undefined
  : new ModelCatalog(dataDir, {
      settings,
      providerFor: (config) => createProvider(config, vault.get(vaultKeyFor(config.id)), subscriptions),
      companions: () => companions.all().map((c) => ({ name: c.app.persona.name, settings: c.app.settings })),
    });

function buildCompanion(space: Space, id: string, dir: string): Companion {
  const main = id === MAIN_ID;
  // Phase 71: in a household member's space only the safe tools are added (docs/HOUSEHOLD.md).
  const isMember = Boolean(space.member);
  const spaceVault = space.vault;
  const settingsC = main ? space.settings : new CompanionSettings(dir, space.settings);
  const tools = isMember ? new ToolRegistry([]) : main ? mainTools : new LinkedToolRegistry(mainTools);
  if (!isMember) tools.add(createWebSearchTool(() => searchConfig(settingsC, vault)));
  // E7 (A2): a tool server's remembered choice covers its tools that have no setting of their own.
  if (!isMember) tools.policyFor = policyResolver(() => settingsC.get(), mcp);
  const store = new Store(join(dir, 'sara.db'));
  // Phase 116 (BR2 §5.3): messages that waited when Sara stopped become 'stale': shown, never run by themselves.
  const pending = new PendingInputs(store.db);
  const stale = pending.markStale();
  if (stale.length) console.log(`While she worked: ${stale.length} waiting message(s) from before the restart are kept for you to send again.`);
  const memory = new MemoryStore(store.db);
  // The planner: the first companion's, shared, unless the owner chose separate planners.
  const sharedPlanner = !main && space.settings.get().companionPlanner !== 'separate';
  const planner = sharedPlanner ? space.companions.main.app.planner! : new PlannerStore(store.db);
  for (const t of createPlannerTools({ planner, now: () => new Date(), timeZone: () => settingsC.get().timeZone, callsOn: () => settingsC.get().calls?.enabled === true, mentions: () => mentionToolDeps(app) })) tools.add(t);
  const uploads = new UploadStore(dir);
  const xaiProviderKeyOf = () => {
    const p = settingsC.get().providers.find((x) => /api\.x\.ai/.test(x.baseUrl));
    return p ? spaceVault.get(vaultKeyFor(p.id)) : undefined;
  };
  const scrapbook = new Scrapbook(store.db);
  tools.add(createScrapbookTool(scrapbook));
  // Phase 70: "Our moments", her album with captions (per companion).
  const moments = new MomentsStore(store.db);
  tools.add(createMomentsTool(() => app, moments));
  // Phase 32: she can look through her past conversations.
  tools.add(createRecallTool(() => app));
  // Phase 44: her library (documents she keeps), and the tool to look things up in it.
  tools.add(createLibraryTool(() => app));
  // Phase 115 (BR1): she can share a file in the chat (a chip in the app; a real file in chat apps).
  tools.add(createSendFileTool(() => app));
  // Phase 34: she can adjust her own dials when asked (the owner approves each change).
  tools.add(createTuneTool(() => app));
  // Phase 50: the code map tools and her recipes.
  if (!isMember) for (const t of createCodeTools(() => app.codemap)) tools.add(t);
  // Phase 96 (ST1): her skills replace the recipe tools (recipe_save stays as an alias of skill_save;
  // the recipes migrate to skills once, below). Members get text-only skills (no scripts); the demo
  // only the built-ins, to read.
  for (const t of createSkillTools(() => app, { member: isMember, demo: isDemo })) tools.add(t);
  for (const t0 of createPhotoTools({
    webDir,
    uploads,
    settings: settingsC,
    vault: spaceVault,
    xaiProviderKey: xaiProviderKeyOf,
    persona: () => app.persona,
    // Phase 43: shared channels (owner work in a Discord channel or Telegram group) stay non-explicit.
    channelOf: (id) => store.getConversation(id)?.channel,
    grokSignedIn: () => subscriptions.grokStatus().signedIn,
    grokToken: async () => subscriptions.grokAccessToken(),
    lookFile: (rel) => app.look?.fileFor(rel),
    wearing: () => {
      const meta = app.look?.custom ? app.look.currentMeta() : {};
      return { wear: meta.wear, place: meta.place ? (PLACES[meta.place]?.prompt ?? meta.place) : undefined, style: meta.style };
    },
    faceRef: () => app.look?.faceRef(),
    // E7 (B1): other picture engines (OpenAI images with the OpenAI provider's key; ComfyUI and image tools).
    engines: {
      tools: { get: (n) => tools.get(n), permission: (n) => tools.permission(n, settingsC.get().toolPermissions) },
      openaiKey: () => {
        const p = settingsC.get().providers.find((x) => /api\.openai\.com/.test(x.baseUrl) && x.kind === 'openai-compatible');
        return p ? spaceVault.get(vaultKeyFor(p.id)) : undefined;
      },
    },
    customPortrait: () => {
      // Phase 36: her current look (the outfit she's wearing now), then an uploaded picture.
      const lookFile = app.look?.fileFor('sara-portrait.jpg');
      if (lookFile) return readFileSync(lookFile);
      for (const ext of ['jpg', 'png', 'webp']) {
        const f = join(dir, `avatar.${ext}`);
        if (existsSync(f)) return readFileSync(f);
      }
      return undefined;
    },
  })) {
    // Phase 71: pictures from her follow the member's switch (the owner pays for them).
    const t = isMember ? { ...t0, isAvailable: () => (t0.isAvailable?.() ?? true) && space.member!.limits().pictures } : t0;
    tools.add(t);
  }
  const app: AppContext = {
    store,
    pending,
    log,
    uploads,
    settings: settingsC,
    vault: spaceVault,
    // Her edited character (Settings → Character) overrides the default sheet.
    persona: loadPersona(existsSync(join(dir, 'persona.json')) ? join(dir, 'persona.json') : defaultPersonaPath),
    defaultPersonaPath,
    now: () => new Date(),
    dataDir: dir,
    rootDir: space.dir,
    companionId: id,
    demo: isDemo,
    companions: space.companions,
    tools,
    approvals: new ApprovalBroker(),
    sandbox,
    sandboxGate: new SandboxGate(sandboxRunsDir, sandbox, () => sandboxGateSettings(settingsC.get()), sharedIsolation),
    ...(isMember ? {} : { mcp }),
    redactor,
    snapshots: new SnapshotStore(space.dir),
    memory,
    ...(isMember ? {} : { codemap: codemaps }),
    recipes: new RecipeStore(store.db),
    // Phase 96: skills (folders are the truth; the tables in this database are their index).
    skills: new SkillStore(store.db, {
      companionDir: join(dir, 'skills'),
      sharedDir: join(space.dir, 'skills-shared'),
      builtinDir: join(root, 'skills'),
      ...(isMember ? {} : { workspacesRoot: join(space.dir, 'workspaces'), trustFile: join(space.dir, 'skills-trust.json') }),
      scratchDir: join(dir, 'cache', 'skill-imports'),
      builtinOnly: isDemo,
    }),
    // Phase 44: her own library, or the first companion's when the owner shares one.
    library: !main && space.settings.get().companionLibrary === 'shared' ? space.companions.main.app.library : new LibraryStore(store.db, dir),
    drift: new DriftStore(store.db),
    planner,
    events: new CompanionHub(space.events, id),
    inner: new InnerStore(store.db, undefined, { tensionHalfLife: () => tensionHalfLife(app.persona.traits?.forgiveness), closenessRate: () => paceFactor(app.persona.traits?.pace) }),
    life: new LifeStore(store.db),
    scrapbook,
    moments,
    look: new LookBuilder({
      dataDir: dir,
      key: async () => (isMember && !space.member!.limits().pictures ? undefined : ((await xaiImageKey({ vault: spaceVault, xaiProviderKey: xaiProviderKeyOf, grokToken: async () => subscriptions.grokAccessToken() })) ?? undefined)),
      model: () => photoSettings(settingsC).model || DEFAULT_IMAGE_MODEL,
      faceLock: () => settingsC.get().faceLock !== false,
    }),
    voice,
    subscriptions,
    ...(isMember ? {} : { google }),
    ...(isMember || isDemo ? {} : { spotify }),
    ...(isMember || !sshManager ? {} : { ssh: sshManager }),
  };
  if (space.member) app.member = space.member;
  // Phase 101 (ST6): people cards from her memory (this companion's database; each person's own space; never the demo).
  if (!isDemo) {
    app.people = new PeopleStore(store.db, { photoDir: join(dir, 'people'), ownWords: () => [settingsC.get().ownerName ?? '', app.persona.name] });
    // Phase 119: his "when it comes up" reminders count as private texts for her outside gate.
    wirePeople(app);
    for (const t of createPeopleTools(() => app)) tools.add(t);
  }
  // Phase 103 (ST8): her own agenda (per companion, in each person's own space; off by default; never the demo).
  if (!isDemo) {
    app.agenda = new Agenda(app, store.db);
    for (const t of createAgendaTools(() => app)) tools.add(t);
  }
  // Phase 118 (PERSIST): chat goals and repeats, the owner's companions only (members get neither);
  // what was running before the restart comes back paused, one line each, nothing starts by itself.
  if (!isDemo && !isMember) {
    app.goals = new Goals(app, store.db);
    app.loops = new Loops(app, store.db);
    // E4: file/log watches (the owner's only); they come back paused after a restart.
    app.watches = new Watches(app, store.db);
    // EC6: research runs; one that was working before the restart becomes a stopped report.
    app.research = new Research(app, store.db);
    // C6: learn a topic; a run that was working before the restart starts again.
    app.learnTopics = new Learning(app, store.db);
    // EC19: meeting rooms and notes; a room live before the restart is ended (notes can be written).
    app.meetings = new Meetings(app, store.db);
    const g = app.goals.startupSweep();
    const l = app.loops.startupSweep();
    if (g || l) console.log(`Keep going and repeats: ${g} goal(s) and ${l} repeat(s) from before the restart are paused.`);
  }
  // The health history is the server's (the owner's); notifications are per space (each person's devices).
  if (!isMember) {
    healthHistory ??= new HealthHistory(store.db, { problems: () => log.problems, dataDir });
    app.healthHistory = healthHistory;
  }
  if (!space.push) {
    space.push = new PushService(store.db, vault, space.settings);
    space.push.apns = new ApnsSender(store.db, vault);
  }
  app.push = space.push;
  app.privateLocal = privateLocal;
  app.modelPuller = modelPuller;
  // Phase 52: the cost and token meter (the owner's prices win over the shipped ones).
  if (modelCatalog) app.modelCatalog = modelCatalog;
  app.usage = new UsageStore(store.db);
  app.usage.prices = () => priceTable(settingsC.get().prices);
  // Phase 78: run snapshots (every step of turns, jobs and team runs), with retention and a size cap.
  app.runs = new RunStore(store.db, app.now);
  app.runs.usage = app.usage;
  app.runs.settings = () => runSettings(app.settings.get());
  app.runs.prune(true);
  // Phase 81 (harness M6): the one findings table (every space), the security pass, live advisories
  // (OSV.dev, off until the owner switches them on) and the fix-branch loop (the owner's companions;
  // household members have no coding tools). Fix worktrees left by a restart were swept at start-up.
  app.findings = new FindingStore(store.db, app.now);
  app.findings.onChange = (x) => app.events?.publish({ type: 'findings', conversationId: x.conversationId, workspace: x.workspace });
  // Phase 85 (harness M10): run signatures, lessons and trigger weights (every space), and the
  // one-time bounded backfill over runs recorded before (a chunk every few seconds, off the turn).
  app.recall = new RecallIndex(store.db, app.now);
  {
    const recallIdx = app.recall;
    const step = () => {
      try {
        const mem = memorySettings(app);
        const r = backfill(
          recallIdx,
          app.runs!,
          (id) => {
            const c = app.store.getConversation(id);
            return c ? { workspace: c.workspace, private: Boolean(c.private), apps: sharedWithApps(c), partner: Boolean(c.partner) } : undefined;
          },
          { ...(app.memory && mem.enabled ? { memory: app.memory } : {}), today: () => localDate(app.now().toISOString(), app.settings.get().timeZone), lessons: mem.enabled && recallMode(mem) !== 'off' },
        );
        if (!r.done) setTimeout(step, 3000).unref?.();
      } catch (err) {
        console.warn(`recall backfill: ${(err as Error).message}`);
      }
    };
    if (recallIdx.meta('backfill_done') !== '1') setTimeout(step, 20_000).unref?.();
  }
  if (!isMember) {
    app.security = new SecurityPass(app, app.findings, new OsvClient(store.db));
    app.fixes = new FixBranches(app, join(dir, 'cache', 'fix-branches'));
    // Phase 82 (harness M7): the threat model after coding turns and its fix-only second pass.
    app.threats = new ThreatPass(app, app.findings);
    // Phase 86 (harness M11): red-team mode ("Red-team this", the ship gate, "Fix what broke").
    app.redteam = new RedTeam(app, app.findings, store.db);
    try {
      app.redteam.store.recover();
    } catch (err) {
      console.warn(`red team: ${(err as Error).message}`);
    }
    sweepFixDirs(join(dir, 'cache', 'fix-branches'));
    try {
      app.fixes.recover();
    } catch (err) {
      console.warn(`fix branches: ${(err as Error).message}`);
    }
  }
  // Phase 84 (harness M9): the eval loop (owner's companions; members have no coding history to replay).
  if (!isMember) app.evals = new Evals(app);
  // Phase 97 (ST2): skills she learns (offers after repeated asks or step chains, fixes, M9 checks).
  // Every person's own space learns from their own conversations only; the demo never learns.
  if (!isDemo) app.learning = new SkillLearner(app);
  // Phase 13: background jobs, git and delegating to Claude Code / Grok Build.
  app.jobs = new JobManager(app, store.db);
  app.reports = new ReportStore(store.db, app.now);
  // Phase 96 (STAPLES §4.7): her recipes become skills, once (a mark in memory_kv; the recipes table
  // stays as it was). Each of the owner's companions keeps its own recipes as its own skills.
  if (!isMember && !isDemo) {
    try {
      const m = app.skills!.migrateRecipes(app.recipes);
      if (m.migrated) console.log(`Skills: ${m.migrated} recipe(s) are now skills${main ? '' : ` (companion ${id})`}.`);
    } catch (err) {
      console.warn(`recipes → skills: ${(err as Error).message}`);
    }
  }
  if (!isMember) for (const t of createCodingTools(app)) tools.add(t);
  // Phase 49: previews of the web apps her jobs run, and her testing browser.
  if (!isMember) app.previews = previews;
  if (!isMember) app.browsers = browsers;
  // Phase 87: her hands on this person's computers (src/hands.ts, src/tools/computer.ts).
  if (space.hands) {
    app.hands = space.hands;
    for (const t of createComputerTools(app)) tools.add(t);
  }
  // EC24: her borrowed phone (the owner's space only; each use approved on the phone).
  if (space.phoneHelper && !isMember) {
    app.phoneHelper = space.phoneHelper;
    for (const t of createPhoneTools(app)) tools.add(t);
  }
  // Phase 113: Report a problem and My reports (each person's own); the check-in settings (the owner's).
  if (!isDemo) app.hub = hubFor(space, store.db);
  if (!isMember) app.jobs.onEnd = (job) => {
    // Phase 111: Today's Running now and Needs you follow.
    todayChanged(app, 'work');
    previews.jobEnded(job.id, app.jobs);
    // Phase 89: her dev tunnels to that job's port end with it.
    space.hands?.tunnels.jobEnded(job.id, app.jobs);
    // Phase 50: a finished job may have changed files: the code map looks again.
    try {
      codemaps.touch(workspaceDir(dataDir, job.workspace));
    } catch {
      /* not a workspace name */
    }
  };
  if (!isMember) {
    for (const t of createBrowserTools(app)) tools.add(t);
    for (const t of createGitHubTools(app)) tools.add(t);
    // C13: task worktrees and the pull-request helper; the language-server tools (read only).
    if (!isDemo) {
      app.worktrees = new Worktrees(store.db, () => app.now(), gitRunner(app.persona.name !== 'Sara' ? { GIT_AUTHOR_NAME: app.persona.name, GIT_COMMITTER_NAME: app.persona.name } : {}));
      app.lsp = lspEngine;
      for (const t of createWorktreeTools(app)) tools.add(t);
      for (const t of createLspTools(() => app.lsp)) tools.add(t);
    }
    // Phase 29: Home Assistant (off until the owner connects it).
    for (const t of createHomeTools(app)) tools.add(t);
    // Phase 14: Gmail and Google Calendar (the owner's own Google app; off until they sign in).
    for (const t of createGoogleTools(google, () => settingsC.get().timeZone)) tools.add(t);
    // C14: Spotify (search, what's playing, playlists; playback only when the owner allowed it). Never the demo.
    if (!isDemo) for (const t of createSpotifyTools(spotify)) tools.add(t);
    // Gmail organizing (archive, labels, trash…, with Undo): the owner's own Gmail only; never the demo.
    if (!isDemo) {
      app.gmail = new GmailOrganizer(google, store.db, { timeZone: () => settingsC.get().timeZone, now: () => app.now(), jobs: () => app.jobs, workspaceOf: (id) => store.getConversation(id)?.workspace, onChange: gmailTodayHook(app) });
      for (const t of createGmailOrganizeTools({ google, organizer: app.gmail })) tools.add(t);
    }
  }

  // Phase 38: meaning search (vectors made a few at a time while the embeddings job is set).
  app.vectors = new MemoryVectors(store.db, memory, () => embedTarget(app));
  let vectorTimer: NodeJS.Timeout | undefined;
  // Q-ADDONS: her delayed start-up work is cancelled by stop(), so a companion retired right after
  // she was added never runs it on a closed database (that stopped the whole server).
  const startupTimers: NodeJS.Timeout[] = [];
  const indexVectors = () => guard('embeddings', () => app.vectors!.index());
  const memoryWorker = new MemoryWorker(app, memory);
  app.memoryNudge = () => memoryWorker.nudge();
  // Phase 109 (CH3): titles that grow with the session (each space's own conversations and ledger; never the demo).
  if (!isDemo) app.titles = new TitleKeeper(app);
  // Phase 110 (CH4): keeping up with rooms (the owner's main companion only: bridges, rooms and
  // archives exist only there; never members, other companions or the demo).
  if (!isDemo && !isMember && main) app.roomKeeper = new RoomKeeper(app);
  // Phase 44: a shared library is read (and learned into memory) by the first companion's worker.
  const ownsLibrary = main || space.settings.get().companionLibrary !== 'shared';
  const libraryWorker = ownsLibrary ? new LibraryWorker(app, () => app.library) : undefined;
  app.libraryNudge = ownsLibrary ? () => libraryWorker!.nudge() : () => space.companions.main.app.libraryNudge?.();
  // With a shared planner, each companion delivers the reminders set in her own conversations;
  // the first one also takes those whose conversation is gone.
  const owns = sharedPlanner
    ? (r: Reminder) => Boolean(r.conversationId && store.getConversation(r.conversationId))
    : main
      ? (r: Reminder) => !r.conversationId || Boolean(store.getConversation(r.conversationId)) || !space.companions.byConversation(r.conversationId)
      : undefined;
  const reminders = new ReminderScheduler(app, planner, owns ? { owns } : {});
  app.reminders = reminders;
  const lifeWorker = new LifeWorker(app, app.life!, app.inner!);
  // Phase 12: weekly reflection and her life threads.
  const weeklyWorker = new WeeklyWorker(app, memory, app.life);
  app.weekly = weeklyWorker;
  app.briefing = new BriefingWorker(app);
  app.leaveBy = new LeaveByWorker(app);
  app.review = new ReviewWorker(app);
  // Phase 53: your story together (look backs, the optional yearly one).
  app.story = new StoryWorker(app);
  // Phase 70: the album keeps up with new photos and writes captions a few at a time.
  app.momentsWorker = new MomentsWorker(app, moments, {
    outfitNow: () => {
      const meta = app.look?.custom ? app.look.currentMeta() : {};
      return { wear: meta.wear, adult: meta.adult === true };
    },
    sceneOf: (image) => photoSettings(settingsC).taken?.find((x) => x.id === image)?.scene,
  });
  // Phase 72: smart-home presence through Home Assistant (the owner's companions; off until switched on).
  if (!isMember && !isDemo) app.presence = new PresenceWorker(app);
  // Phase 39: team tasks she leads (helpers with their own models, tools and approvals).
  if (!isMember) app.team = new TeamManager(app, store.db);
  // EC12: crews (standing helpers the lead hands board cards to; the owner's only, never the demo).
  if (!isMember && !isDemo) app.crews = new Crews(app, store.db);
  // C10: workers that stay (crew members or standalone helpers with their own queue and thread).
  if (!isMember && !isDemo) app.workers = new Workers(app, store.db);
  // C4: "When this happens" event triggers (the owner's only, never the demo or a member's space).
  if (!isMember && !isDemo) {
    app.eventTriggers = new EventTriggers(app, store.db);
    registerTriggers(app.eventTriggers);
  }
  // EC13: the overnight memory tidy (each space and companion tidies only its own notes; off until turned on).
  if (!isDemo) app.memoryTidy = new MemoryTidy(app, store.db);
  // C12: how he likes to work (each space and companion keeps its own beliefs; never the demo).
  if (!isDemo) app.workingStyle = new WorkingStyle(app, store.db);
  if (!isMember) for (const t of createTeamTools(() => app)) tools.add(t);
  // Phase 99 (ST4): the board over the planner, her card tools and the card worker (in the space that
  // owns the planner; companions sharing it use the main companion's worker).
  {
    const shared = sharedAccess(space);
    setUpBoard(app, { person: space.id, worker: !sharedPlanner, ...(shared ? { shared } : {}) });
    if (sharedPlanner) app.cardWork = space.companions.main.app.cardWork;
    for (const t of createBoardTools(() => app)) tools.add(t);
  }
  // Phase 52: new projects from tested starter templates.
  if (!isMember) tools.add(createStarterTool(() => app));
  // Phase 40: project knowledge, review mode, GitHub issues as tasks (watching is off by default).
  app.projects = new ProjectKnowledgeStore(app, store.db);
  if (!isMember) tools.add(createProjectNoteTool(() => app));
  if (!isMember && !isDemo) tools.add(createProjectCheckpointTool(() => app));
  if (!isMember && !isDemo) for (const t of createSessionContinuityTools()) tools.add(t);
  // R1B2: offered only where the host binds ToolContext.sceneCanon (an eligible owner scene seat).
  if (!isMember && !isDemo) for (const t of createSceneCanonTools()) tools.add(t);
  tools.add(createSettingsGuideTool());
  // Phase 123 (LEAN §4.7): she looks up and loads tools she wasn't sent (offered in lean turns only).
  tools.add(findToolsTool());
  // Phase 121: her read-only safety report and the routine card (she can't fix or turn on anything).
  if (!isMember && !isDemo) {
    tools.add(createSafetyReportTool(() => (app as AppContext & { safetyDeps?: () => SafetyDeps }).safetyDeps?.() ?? { app, auth, dataDir, sandbox: app.sandbox, version: info.version }));
    tools.add(createSuggestRoutineTool(() => app));
  }
  if (!isMember) for (const t of createReviewTools(() => app)) tools.add(t);
  if (!isMember) tools.add(createIssueTool(() => app));
  const issueWatcher = isMember ? undefined : new IssueWatcher(app);
  // Phase 37: things to do together and shared lists.
  app.together = new TogetherStore(store.db, () => app.now());
  // E5: read together (memory only; a restart ends sharing).
  app.readTogether = new ReadTogether(() => app.now());
  tools.add(createSharedListTool(() => app.together));
  // Phase 36: her closet (dresses for the scenario when the owner turns it on).
  const wardrobe = new WardrobeWorker(app);
  app.wardrobe = wardrobe;
  // Phase 51: bring your history (ChatGPT / Claude exports), learned from a few a minute (owner only in 2.0).
  if (!isMember) app.historyImport = new HistoryImporter(() => app);
  tools.add(createWardrobeTool(() => app));
  // Telegram and Discord: one bot each, for the first companion (shared with the others' settings).
  // Phase 107: SARA_TELEGRAM_API / SARA_DISCORD_API / SARA_DISCORD_GATEWAY point the bridges at stand-in
  // servers for live checks without a real bot (unset in normal use: the real Telegram and Discord).
  if (main && !isMember)
    bridges = {
      telegram: new TelegramBridge(app, process.env.SARA_TELEGRAM_API ? { apiBase: process.env.SARA_TELEGRAM_API } : {}),
      discord: new DiscordBridge(app, { ...(process.env.SARA_DISCORD_API ? { api: process.env.SARA_DISCORD_API } : {}), ...(process.env.SARA_DISCORD_GATEWAY ? { gateway: process.env.SARA_DISCORD_GATEWAY } : {}) }),
    };
  if (!isMember) app.bridges = bridges;
  // Phase 98: the owner's companions get the plugins switched on for them (members and the demo never).
  if (!isMember && pluginManager) {
    app.pluginManager = pluginManager;
    pluginManager.attach(id, app);
  }
  // Phase 124: the Sara Store (the owner's; its switch is in the main companion's owner settings).
  if (!isMember && storeClient) {
    app.storeClient = storeClient;
    if (storeInstalls) app.storeInstalls = storeInstalls;
    storeOwnerApp ??= app;
    if (id === 'main') storeOn = () => storeSettings(app.settings.get() as never).on;
  }
  // Phase 100: A2A for the owner's companions (the main one answers peers; her tools on each).
  if (!isMember && a2aDb) {
    if (!a2aServer && main) {
      a2aServer = new A2AServer({ db: a2aDb, auth: space.auth, app, version: info.version });
      const srv = a2aServer;
      a2aClient = new A2AClient({ store: srv.store, app, name: () => srv.cardName(), operator: () => srv.settings().operator, lanInPrivate: () => srv.settings().lanInPrivate });
    }
    if (a2aServer && a2aClient) {
      app.a2a = a2aServer;
      app.a2aClient = a2aClient;
      for (const t of a2aClient.tools()) tools.add(t);
    }
  }
  // Phase 102: the owner's companions get his webhooks (members and the demo never).
  if (!isMember && hookManager) {
    app.hooks = hookManager;
    hookManager.attach(id, app);
  }
  deliveryFor(app); // Recover delivery evidence once per store; never dispatch on boot.
  dataRights()?.apply([{ dir, app }]); // EC17: a held space's database refuses deletes from the start.
  const server = createSaraServer({ ...serverOpts, app, auth: space.auth, companions: space.companions, spaceId: space.id, ...(isMember ? { member: memberHooksFor(space) } : isDemo ? {} : { household: householdHooks, usageSources, usageBudgets }) });
  return {
    id,
    app,
    server,
    start() {
      // Phase 108 (CH2): the bridge chats from before 2.41.0 go into their channel projects, once (Undo on the project's page).
      if (main && !isMember && !isDemo) {
        try {
          fileChannelChats(app);
        } catch (err) {
          console.warn(`chats: filing into channel projects failed: ${(err as Error).message}`);
        }
      }
      memoryWorker.start();
      libraryWorker?.start();
      vectorTimer = setInterval(indexVectors, 60_000);
      if (!isDemo) issueWatcher?.start();
      // Interrupted team work stays held until an explicit recovery review.
      startupTimers.push(setTimeout(indexVectors, 5_000).unref());
      reminders.start();
      // C11: start() also checks hourly for questions parked over a day (a reminder outside quiet hours).
      if (!sharedPlanner) app.cardWork?.start({ remind: !isDemo });
      // Phase 100: open tasks she gave other agents are followed again (their board cards).
      if (main && !isMember) app.a2aClient?.start();
      lifeWorker.start();
      weeklyWorker.start();
      app.learning?.start();
      app.briefing!.start();
      app.leaveBy!.start();
      app.review!.start();
      if (!isDemo) app.story!.start();
      if (!isDemo) app.momentsWorker!.start();
      app.presence?.start();
      if (!isDemo) wardrobe.start();
      // Learning from imported history that was still going when the server stopped carries on.
      if (!isDemo) startupTimers.push(setTimeout(() => app.historyImport?.start(), 20_000).unref());
    },
    async stop() {
      // MNT2: wait (bounded) until stopped jobs have saved, so nothing writes after the store closes.
      const jobsStopped = app.jobs?.stopAll(5_000);
      // Running replies stop and save what they have (the app then offers Continue).
      await app.stopAllTurns?.().catch(() => {});
      memoryWorker.stop();
      libraryWorker?.stop();
      clearInterval(vectorTimer);
      for (const timer of startupTimers.splice(0)) clearTimeout(timer);
      issueWatcher?.stop();
      app.story?.stop();
      app.momentsWorker?.stop();
      app.presence?.stop();
      reminders.stop();
      lifeWorker.stop();
      app.agenda?.halt();
      weeklyWorker.stop();
      app.learning?.stop();
      app.briefing?.stop?.();
      app.leaveBy?.stop?.();
      app.review?.stop?.();
      wardrobe.stop();
      app.historyImport?.stop();
      app.companionImport?.stop();
      if (!isMember) await pluginManager?.detach(id).catch(() => undefined);
      if (main && !isMember) app.a2aClient?.stopAll();
      await jobsStopped?.catch(() => {});
    },
  };
}
// ---- Phase 71: household members' spaces (docs/HOUSEHOLD.md) ----
function memberHooksFor(space: Space): MemberHooks {
  return { record: () => household.get(space.id), apps: () => space.companions.all().map((c) => c.app), deleteSelf: () => deleteMemberSpace(space.id) };
}
/** The owner's chat models a member can be given (from each provider's kept list, or its default). */
function availableModels(): (ModelPick & { label: string })[] {
  const out: (ModelPick & { label: string })[] = [];
  for (const p of settings.get().providers) {
    const listed = modelCatalog?.view(p.id).models ?? [];
    const names = new Set([...(p.defaultModel ? [p.defaultModel] : []), ...(settings.get().defaultProviderId === p.id && settings.get().defaultModel ? [settings.get().defaultModel!] : []), ...listed]);
    for (const model of names) if (!/embed/i.test(model)) out.push({ providerId: p.id, model, label: p.label });
  }
  return out.slice(0, 400);
}
/** Notifications: a space's messages and calls go to that person's devices, named after the companion. */
function notifyFrom(space: Space): void {
  space.events.subscribe((ev) => {
    const c = space.companions.get(ev.companion) ?? space.companions.main;
    void space.push?.onEvent(ev, c.app.persona.name, (id) => Boolean(space.companions.byConversation(id)?.app.store.getConversation(id)?.partner), (s) => redactor.redact(s)).catch((err: Error) => console.warn(`push: ${err.message}`));
  });
}
function buildMemberSpace(member: MemberRecord, dir: string, givenAuth?: OwnerAuth): Space {
  const limits = () => household.get(member.id)?.limits ?? { models: [], messagesPerDay: 0, costPerDay: 0, voice: false, pictures: false };
  const space: Space = {
    id: member.id,
    dir,
    auth: givenAuth ?? new OwnerAuth(dir, undefined, { tokenPrefix: `${MEMBER_TOKEN_PREFIX}${member.id}.` }),
    settings: new MemberSettings(dir, settings, limits),
    vault: memberVault(vault, limits),
    events: new EventHub(),
    companions: new CompanionManager(dir),
  };
  space.member = new MemberPolicy(household, member.id, () => space.companions.all().map((c) => c.app));
  space.hands = handsFor(space, true);
  space.companions.build = (id, d) => buildCompanion(space, id, d);
  space.companions.add(buildCompanion(space, MAIN_ID, dir));
  for (const c of companionDirs(dir)) space.companions.add(buildCompanion(space, c.id, c.dir));
  notifyFrom(space);
  memberSpaces.set(member.id, space);
  return space;
}
/** Stops a member's space and deletes it for good (Delete now, Delete my account, or after removal). */
async function deleteMemberSpace(id: string): Promise<void> {
  assertDirNotHeld(household.dirOf(id)); // EC17: a legal hold keeps the space (and it keeps running).
  const sp = memberSpaces.get(id);
  memberSpaces.delete(id);
  hubSpaces.delete(id);
  pairs.clear(id);
  if (sp) {
    for (const c of sp.companions.all()) await c.stop().catch(() => {});
    for (const c of sp.companions.all()) c.app.store.close();
  }
  household.deleteMember(id);
  alexa.links.removeSpace(id);
  shares()?.revokeSpace(id); // EC11: their share links (snapshots of their chats) go with them.
  console.log('Household: a member\'s space was deleted.');
}
const householdHooks: HouseholdHooks = {
  store: household,
  models: availableModels,
  join: async (code, confirm18, label) => {
    const { member, dir } = household.redeem(code, confirm18);
    try {
      const mAuth = new OwnerAuth(dir, undefined, { tokenPrefix: `${MEMBER_TOKEN_PREFIX}${member.id}.` });
      const token = mAuth.newToken!;
      mAuth.markSignedIn();
      const sp = buildMemberSpace(member, dir, mAuth);
      for (const c of sp.companions.all()) c.start();
      console.log('Household: someone joined with an invite.');
      return { token, session: mAuth.createSession(label) };
    } catch (err) {
      await deleteMemberSpace(member.id).catch(() => {});
      throw err;
    }
  },
  usage: (id) => {
    const sp = memberSpaces.get(id);
    return sp ? memberUsage(sp.companions.all().map((c) => c.app), new Date()) : null;
  },
  deleteNow: deleteMemberSpace,
  signOutAll: (id) => void memberSpaces.get(id)?.auth.signOut('others'),
};

companions.build = (id, dir) => buildCompanion(ownerSpace, id, dir);
companions.add(buildCompanion(ownerSpace, MAIN_ID, dataDir));
// The other companions (not on the demo server).
if (!isDemo) for (const c of companionDirs(dataDir)) companions.add(buildCompanion(ownerSpace, c.id, c.dir));
// EC15: a budget that goes up a level this month tells the owner once (after model calls).
if (!isDemo) budgetAlerter({ budgets: usageBudgets, sources: usageSources, tz: () => settings.get().timeZone || 'UTC', lang: () => appLanguage(settings.get()), notify: (title, line) => void companions.all()[0]?.app.push?.notifyOwner(title, line, '', 'usage-budget').catch(() => {}) });
// Phase 71: household members' spaces (never on the demo server).
if (!isDemo) {
  for (const m of memberDirs(dataDir, household)) {
    try {
      buildMemberSpace(m.member, m.dir);
    } catch (err) {
      console.warn(`Household: a member's space could not start (${(err as Error).message}).`);
    }
  }
  if (memberSpaces.size) console.log(`Household: ${memberSpaces.size} member${memberSpaces.size === 1 ? '' : 's'} besides the owner.`);
}
const mainApp = companions.main.app;
console.log(`Tool sandbox: ${sandbox.mode} (${sandbox.detail})`);
{
  const b = browsers.status();
  console.log(`Testing browser: ${b.found ? `${b.name} (${b.path})` : `none (${b.how})`}`);
}
const va = voice.available;
console.log(`Local voice: ${va.stt || va.tts ? `speech-to-text ${va.stt ? 'yes' : 'no'}, voices ${voice.voices().length} (${voice.dir})` : localVoiceMissing()}`);
if (companions.all().length > 1) console.log(`Companions: ${companions.all().map((c) => c.app.persona.name).join(', ')}`);

// Notifications: every companion's messages and calls, named after the one who sent them.
notifyFrom(ownerSpace);

let backupTickRunning: Promise<void> | undefined;
function backupTick(): Promise<void> {
  if (isDrill) return Promise.resolve();
  if (isDemo || shuttingDown) return Promise.resolve();
  if (backupTickRunning) return backupTickRunning;
  backupTickRunning = (async () => {
    try {
      const name = await asyncAutoBackupTick(dataDir, { ...DEFAULT_BACKUP, ...settings.get().backup }, new Date(), info.version);
      if (name) {
        console.log(`Automatic backup: ${name}`);
        try {
          const copied = await copyOffsite(mainApp, join(dataDir, BACKUPS_DIR, name));
          if (copied) console.log(`Off-server copy: ${copied}`);
        } catch (err) { console.warn(`Off-server copy failed: ${(err as Error).message}`); }
      }
    } catch (err) { console.warn(`Automatic backup failed: ${(err as Error).message}`); }
    // Reuse the hourly maintenance tick; await offsite work so ticks never overlap it.
    try {
      if (offsiteTestDue(mainApp)) {
        const r = await testOffsite(mainApp);
        if (r.ok) console.log(`Off-server test restore: ok (${r.name}: ${r.detail})`);
        else console.warn(`Off-server test restore failed: ${r.error}`);
      }
      sweepUndo(mainApp);
      const deps = (mainApp as AppContext & { safetyDeps?: () => SafetyDeps }).safetyDeps?.();
      if (deps) await weeklySafetyTick(deps);
    } catch (err) { console.warn(`Backup maintenance failed: ${(err as Error).message}`); }
  })().finally(() => { backupTickRunning = undefined; });
  return backupTickRunning;
}
// Checked hourly (and 2 minutes after start); a backup is made when the last one is a day old.
const backupTimer = setInterval(() => void backupTick(), 3600_000);
backupTimer.unref();
setTimeout(() => void backupTick(), 120_000).unref();

// Phase 71: removed members' spaces are deleted when their download window is over.
function householdSweep(): void {
  household.sweepInvites();
  for (const m of household.due()) void deleteMemberSpace(m.id).catch((err: Error) => console.warn(`Household: ${err.message}`));
  // EC17: retention per data kind runs on the same hourly tick (held spaces are skipped).
  try {
    const r = dataRights()?.runRetention();
    if (r && (r.chats || r.memories || r.files)) console.log(`Retention: deleted ${r.chats} chats, ${r.memories} memories, ${r.files} files.`);
  } catch (err) {
    console.warn(`Retention: ${(err as Error).message}`);
  }
}
// Phase 84: "Re-check monthly" for evals. OFF by default (the owner's explicit yes in Settings);
// when on, it runs only when nobody has talked to her for 20 minutes, within its own token budget.
const evalTimer = setInterval(() => guard('evals', () => {
  for (const c of ownerSpace.companions.all()) c.app.evals?.tick();
}), 3600_000);
evalTimer.unref();

// Phase 110 (CH4, §7.7): the nightly fold of the rooms she keeps up with (04:00 local, or the next
// start after a missed night): archive into the Library, room memory, then delete the raw lines.
const foldTick = () => guard('rooms', () => void ownerSpace.companions.main.app.roomKeeper?.tick().then((rs) => rs.filter((r) => r.archived || r.memories.length).forEach((r) => console.log(`Rooms: folded room ${r.roomId} (${r.archived} lines archived, ${r.memories.length} weeks of room memory, ${r.deleted} raw lines deleted).`))));
const foldTimer = setInterval(foldTick, 15 * 60_000);
foldTimer.unref();
if (!isDemo) setTimeout(foldTick, 90_000).unref();

const householdTimer = setInterval(() => guard('household', householdSweep), 3600_000);
householdTimer.unref();

// Phase 115 (BR1 §4.10): the hourly sweep of pictures and files that crossed a chat app (other
// people's picture bytes after 7 days, copies of files she sent after 30, rows after a year).
const mediaSweep = () => guard('media', () => {
  const r = sweepShared(ownerSpace.companions.main.app);
  if (r.photos || r.files || r.rows) console.log(`Chat apps: removed ${r.photos} picture(s) from other people, ${r.files} shared file copy(ies), ${r.rows} old row(s).`);
});
const mediaTimer = setInterval(() => {
  mediaSweep();
  // EC4: the audit trail's retention (hourly; cheap when nothing is old enough).
  guard('audit', () => void pruneAudit());
  // Phase 116: finished steers and queued messages go after 7 days (every companion; members' spaces too).
  guard('pending', () => {
    for (const sp of [ownerSpace, ...memberSpaces.values()]) for (const c of sp.companions.all()) c.app.pending?.prune();
    // Phase 118: final goals after 90 days, ended repeats after 30.
    for (const c of ownerSpace.companions.all()) {
      c.app.goals?.prune();
      c.app.loops?.prune();
    }
  });
}, 3600_000);
mediaTimer.unref();
if (!isDemo) setTimeout(mediaSweep, 120_000).unref();
if (!isDemo) setTimeout(() => guard('household', householdSweep), 60_000).unref();

/**
 * Phase 71: whose space a request is for, from the credential it carries (a session cookie, a device
 * token or a member token that a member's own sign-in knows). Anything else is the owner's space, as
 * before. The space's own server checks the credential again: this only picks where to look.
 */
function spaceByCredential(req: IncomingMessage): Space | undefined {
  if (!memberSpaces.size) return undefined;
  const cookie = cookieValue(req, SESSION_COOKIE);
  if (cookie) {
    if (auth.sessionId(cookie)) return ownerSpace;
    for (const sp of memberSpaces.values()) if (sp.auth.sessionId(cookie)) return sp;
  }
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    const tok = h.slice(7).trim();
    const m = memberOfToken(tok);
    if (m) return memberSpaces.get(m);
    if (tok.startsWith('sara_dev.') || tok.startsWith('sara_hands.')) {
      const id = tok.slice(tok.indexOf('.') + 1).split('.')[0];
      for (const sp of memberSpaces.values()) if (sp.auth.hasDevice(id)) return sp;
    }
  }
  return undefined;
}
/** Sign-ins without a credential yet: the member token, a member's pairing code or passkey decides. */
async function spaceBySignIn(req: IncomingMessage): Promise<Space | undefined> {
  if (!memberSpaces.size || req.method !== 'POST') return undefined;
  const path = (req.url ?? '/').split('?')[0];
  if (path !== '/api/login' && path !== '/api/pair/redeem' && path !== '/api/passkey/signin') return undefined;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return undefined;
  const body = await peekJson(req);
  if (path === '/api/login') {
    const m = memberOfToken(body.token);
    return m ? memberSpaces.get(m) : undefined;
  }
  if (path === '/api/pair/redeem') {
    const id = pairs.spaceOf(String(body.code ?? ''));
    return id && id !== 'owner' ? memberSpaces.get(id) : undefined;
  }
  const pk = String(body.id ?? '');
  for (const sp of memberSpaces.values()) if (pk && sp.auth.passkey(pk)) return sp;
  return undefined;
}

// Phase 31: one front server; each request goes to the right companion (see pickCompanion).
// Phase 71: first the person's space, then the companion inside it.
const server = createServer((req, res) => {
  const known = spaceByCredential(req);
  if (known) return void pickCompanion(known.companions, req).server.emit('request', req, res);
  if (!memberSpaces.size) return void pickCompanion(companions, req).server.emit('request', req, res);
  void spaceBySignIn(req).then(
    (sp) => pickCompanion((sp ?? ownerSpace).companions, req).server.emit('request', req, res),
    () => {
      res.statusCode = 400;
      res.end();
    },
  );
});
server.on('upgrade', (req, socket, head) => {
  pickCompanion((spaceByCredential(req) ?? ownerSpace).companions, req).server.emit('upgrade', req, socket, head);
});

server.listen(port, host, () => {
  if (auth.newToken) banner(auth.newToken);
  // EC5: a policy file put in place by hand applies at start; EC4: the trail's retention (then hourly).
  if (policyStore.get().rev) policyStore.onApply?.(policyStore.get());
  pruneAudit();
  claimBanner();
  // Reachable from other machines without HTTPS: sign-in tokens and cookies would cross the
  // network readable by anyone on it.
  if (!/^(127\.|::1$|localhost$)/.test(host) && process.env.SARA_SECURE_COOKIES !== '1') {
    console.warn(`Warning: Sara is listening on ${host}:${port} without HTTPS. Anyone on that network can read the sign-in token and cookies. Put an HTTPS reverse proxy in front (docs/INSTALL.md, section 2) and set SARA_SECURE_COOKIES=1, or listen on 127.0.0.1.`);
  }
  console.log(`Sara is listening on http://${host}:${port} (data: ${dataDir})${isDemo ? ' [DEMO]' : ''}`);
  if (privateLocal.get().on) console.log(`Private local mode is on: nothing leaves this computer (only 127.0.0.1 / ::1 / localhost)${privateLocal.get().locked ? ' [SARA_PRIVATE_LOCAL=1]' : ''}.`);
  if (isDrill) {
    console.log('Restore drill: a throwaway copy; nothing is started.');
    return;
  }
  for (const c of companions.all()) c.start();
  for (const sp of memberSpaces.values()) for (const c of sp.companions.all()) c.start();
  codemaps.start();
  modelCatalog?.start(guard);
  if (!isDemo) healthHistory?.start();
  // Phase 113: the anonymous daily check-in (10–60 minutes after start, then about daily).
  hubPinger?.start();
  // Phase 124: blocks known from the cached store list apply at start; then the daily look.
  if (storeClient) {
    const cached = storeClient.current();
    if (cached) void storeClient.onIndex?.(cached.index);
    const first = Number(process.env.SARA_STORE_FIRST_MS);
    storeClient.startDaily(Number.isFinite(first) && first > 0 && localStore(storeUrl) ? { firstMs: first } : {});
  }
  void bridges?.discord?.restart().then(() => {
    const st = bridges!.discord!.status();
    if (st.running || st.error) console.log(`Discord: ${st.running ? `${st.bot} ${st.linked ? '(linked)' : '(not linked yet)'}` : `not running (${st.error})`}`);
  });
  void bridges?.telegram?.restart().then(() => {
    const st = bridges!.telegram!.status();
    if (st.running || st.error) console.log(`Telegram: ${st.running ? `@${st.bot} ${st.linked ? '(linked)' : '(not linked yet)'}` : `not running (${st.error})`}`);
  });
  void mcp.startAll(settings.get().mcpServers ?? []).then(() => {
    for (const c of settings.get().mcpServers ?? []) {
      const conn = mcp.get(c.name);
      if (conn && c.enabled) console.log(`MCP ${c.name}: ${conn.status}${conn.error ? ` (${conn.error})` : ` (${conn.tools.length} tools)`}`);
    }
  });
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  lspEngine.stopAll();
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of companions.all()) await c.stop();
  for (const sp of memberSpaces.values()) for (const c of sp.companions.all()) await c.stop().catch(() => {});
  // Phase 87: the computers' connections close (their apps reconnect when Sara is back).
  ownerSpace.hands?.closeAll();
  for (const sp of memberSpaces.values()) sp.hands?.closeAll();
  clearInterval(householdTimer);
  clearInterval(mediaTimer);
  await browsers.closeAll().catch(() => {});
  codemaps.stop();
  modelCatalog?.stop();
  healthHistory?.stop();
  hubPinger?.stop();
  clearInterval(backupTimer);
  await backupTickRunning;
  bridges?.telegram?.stop();
  bridges?.discord?.stop();
  mcp.stopAll();
  storeClient?.stop();
  await pluginManager?.stopAll().catch(() => {});
  await beginBackupShutdown();
  server.close(() => {
    for (const c of companions.all()) c.app.store.close();
    for (const sp of memberSpaces.values()) for (const c of sp.companions.all()) c.app.store.close();
    codemaps.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
// Phase 46c: Windows has no SIGTERM. Her service host (SaraService.exe) asks her to stop by closing
// her stdin, so she can finish writing and close the database cleanly.
if (process.env.SARA_STOP_ON_STDIN_END === '1') {
  process.stdin.on('end', () => void shutdown());
  process.stdin.on('error', () => void shutdown());
  process.stdin.resume();
}
