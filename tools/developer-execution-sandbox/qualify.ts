/** Fixture-only experiment; never a host execution API or an unsandboxed fallback. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
const executeFile = promisify(execFile); // Structured argv, shell:false (execFile default).
const repo = fileURLToPath(new URL('../../', import.meta.url));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function regular(file: string) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error('Linked/nonregular source refused');
  for (let dir = path.dirname(file);;) {
    if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('Linked ancestor refused');
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return fs.readFile(file);
}
export async function qualify(options: { optIn?: string, mode?: 'boundary' | 'tree' | 'timeout' | 'memory', fault?: 'enumerate' | 'open-first' | 'open-later' | 'birth' | 'assignment-observer' | 'terminate' | 'wait' | 'close-middle' | 'unknown' | 'terminate-wait-close' } = {}): Promise<any> {
  if (options.optIn !== '1' || process.env.DEV_SANDBOX_QUALIFY !== '1') return { status: 'blocked', reason: 'DEV_SANDBOX_QUALIFY=1 required', nativeStarted: false };
  if (process.platform !== 'win32') return { status: 'blocked', reason: 'Windows required', nativeStarted: false };
  const base = path.join(process.env.LOCALAPPDATA!, 'hermes', 'cache', 'scratch', 'execution-sandbox');
  const id = randomUUID().replaceAll('-', '');
  const root = path.join(base, `run-${id}`);
  const evidence = path.join(repo, 'outputs/developer-addons/execution-sandbox', id);
  const compiler = path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const nativeSource = path.join(repo, 'tools/developer-execution-sandbox/NativeSandbox.cs');
  let listener: net.Server | undefined; let cleaned = false; let connections = 0; let nativeAttempted = false;
  const receipt: any = { status: 'blocked', nativeStarted: false, fixtureId: id, nodeVersion: process.version };
  try {
    const mode = options.mode ?? 'boundary';
    if (options.fault && (process.env.DEV_SANDBOX_FAULT_TEST !== '1' || !['enumerate','open-first','open-later','birth','assignment-observer','terminate','wait','close-middle','unknown','terminate-wait-close'].includes(options.fault))) throw new Error('Explicit fixed qualification fault opt-in required');
    receipt.fault = options.fault; receipt.fixtureRoot = root;
    if (!['boundary','tree','timeout','memory'].includes(mode)) throw new Error('Unknown fixed operation');
    await fs.access(compiler);
    await fs.mkdir(base, { recursive: true });
    for (let p = base;;) { if ((await fs.lstat(p)).isSymbolicLink()) throw new Error('Linked scratch refused'); const q = path.dirname(p); if (p === q) break; p=q; }
    await fs.mkdir(root); await fs.mkdir(evidence, { recursive: true });
    for (const dir of ['bin','source','output','outside']) await fs.mkdir(path.join(root, dir));
    await fs.writeFile(path.join(root, 'owned.marker'), 'sara-execution-fixture-v1');
    const node = await regular(process.execPath);
    const source = await regular(nativeSource);
    const probe = await regular(path.join(repo, 'test/fixtures/developer/execution-sandbox/probe.cjs'));
    receipt.hashes = { node: hash(node), nativeSource: hash(source), probe: hash(probe) };
    await fs.writeFile(path.join(root, 'bin/node.exe'), node, { flag: 'wx' });
    await fs.writeFile(path.join(root, 'source/probe.cjs'), probe, { flag: 'wx' });
    await fs.writeFile(path.join(root, 'source/canary.txt'), 'synthetic-source');
    await fs.writeFile(path.join(root, 'outside/canary.txt'), 'synthetic-outside');
    await fs.writeFile(path.join(root, 'NativeSandbox.cs'), source);
    const executable = path.join(root, 'NativeSandbox.exe');
    const compilation = await executeFile(compiler, ['/nologo','/target:exe','/platform:x64', '/reference:System.Web.Extensions.dll', `/out:${executable}`, path.join(root, 'NativeSandbox.cs')], { windowsHide: true, timeout: 30_000 });
    receipt.compilation = compilation.stdout;
    receipt.hashes.nativeExe = hash(await regular(executable));
    listener = net.createServer(socket => { connections++; socket.destroy(); });
    await new Promise<void>((resolve, reject) => { listener!.once('error', reject); listener!.listen(0, '127.0.0.1', resolve); });
    const port = (listener.address() as net.AddressInfo).port;
    const control = () => new Promise<void>((resolve, reject) => {
      const socket = net.connect({host:'127.0.0.1', port});
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject); socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Loopback control timeout')); });
    });
    await control(); receipt.loopbackControlBefore = true; connections = 0;
    let nativeOutput = ''; nativeAttempted = true;
    try { nativeOutput = (await executeFile(executable, [root, mode, String(port)], { windowsHide: true, timeout: 30_000, maxBuffer: 65536, env: { ...process.env, DEV_SANDBOX_FAULT: options.fault ?? '' } })).stdout; }
    catch (e: any) { nativeOutput = e.stdout || ''; receipt.launchError = e.message; }
    await fs.writeFile(path.join(evidence, 'native-stdout.txt'), nativeOutput);
    const native = JSON.parse(nativeOutput.trim()); receipt.native = native; receipt.nativeStarted = native.nativeStarted === true;
    try { receipt.boundary = JSON.parse(await fs.readFile(path.join(root, 'output/done.json'), 'utf8')); } catch { try { receipt.fixtureError = await fs.readFile(path.join(root, 'output/error.txt'), 'utf8'); } catch {} }
    try { receipt.nativeLog = await fs.readFile(path.join(root, 'output/native-log.txt'), 'utf8'); } catch {}
    receipt.outsideUnchanged = await fs.readFile(path.join(root, 'outside/canary.txt'), 'utf8') === 'synthetic-outside';
    receipt.sourceUnchanged = await fs.readFile(path.join(root, 'source/canary.txt'), 'utf8') === 'synthetic-source' && hash(await regular(path.join(root, 'source/probe.cjs'))) === receipt.hashes.probe;
    receipt.noOutsideWrite = !(await fs.readdir(path.join(root, 'outside'))).includes('write.txt');
    receipt.listenerConnections = connections; await control(); receipt.loopbackControlAfter = true;
    const b = receipt.boundary;
    const operationPassed = mode === 'memory' ? b?.memoryRefused === true : mode === 'timeout' ? native.timedOut && native.allObservedExited : mode === 'tree' ? b?.processLimitRefused === true && b.fixturePids?.length === 3 && b.fixturePids.every((pid: number) => native.identities.some((i: any) => i.pid === pid)) && native.allObservedExited : b && ['sourceReadAllowed','outsideReadDenied','outsideWriteDenied','sourceWriteDenied','outputWriteAllowed','loopbackDenied'].every(k => b[k] === true);
    if ((native.status === 'executed' || mode === 'timeout' && native.timedOut) && native.cleaned && native.profileRegistry64Existed === true && native.profileFolderExisted === true && native.profileRegistryView === 'Registry64' && native.quiescenceVerified === true && receipt.outsideUnchanged && receipt.sourceUnchanged && receipt.noOutsideWrite && receipt.listenerConnections === 0 && operationPassed) receipt.status = 'qualified';
  } catch (e: any) { receipt.error = e.message; }
  finally {
    if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()));
    // Only our unique owned fixture tree, after native quiescence; never the repository or system Node.
    if (!nativeAttempted || receipt.native?.resourcesReleased === true) {
      try { await fs.rm(root, { recursive: true, force: true }); cleaned = true; } catch (e: any) { receipt.cleanupError = e.message; }
    }
    receipt.cleaned = cleaned && (!receipt.native || receipt.native.cleaned === true);
    if (!receipt.cleaned) receipt.status = 'blocked';
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2));
    receipt.evidence = path.relative(repo, evidence);
  }
  return receipt;
}
