import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { McpManager, mcpToolName, MCP_PROTOCOL_VERSION } from '../src/tools/mcp.ts';
import { ToolRegistry } from '../src/tools/registry.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Permission } from '../src/tools/types.ts';

const reads = ['git_status','git_diff_unstaged','git_diff_staged','git_diff','git_log','git_show','git_branch','git_remote'];
const writes = ['git_add','git_commit','git_reset','git_create_branch','git_checkout','git_merge'];
const output = resolve('outputs/developer-addons/local-git');
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

test('real pinned Local Git: protocol, Sara registration, saved policy, fixture reads and confinement', { skip: process.env.LOCAL_GIT_QUALIFY !== '1', timeout: 90_000 }, async () => {
  assert.match(tmpdir().replaceAll('\\','/'), /hermes\/cache\/scratch\/local-git/i);
  const root = mkdtempSync(join(tmpdir(), 'fixture-'));
  const data = join(root, 'data');
  const repo = join(data, 'mcp', 'local-git', 'repo');
  const outside = join(root, 'outside');
  mkdirSync(repo, {recursive:true}); mkdirSync(outside);
  const python = join(output,'venv','Scripts','python.exe');
  const identity = join(root,'identity.json');
  const gitEnv = { ...process.env, HOME:root, USERPROFILE:root, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:join(root,'empty-config'), GIT_OPTIONAL_LOCKS:'0', GIT_TERMINAL_PROMPT:'0', GIT_NO_LAZY_FETCH:'1', GIT_CONFIG_COUNT:'5', GIT_CONFIG_KEY_0:'core.fsmonitor', GIT_CONFIG_VALUE_0:'false', GIT_CONFIG_KEY_1:'core.hooksPath', GIT_CONFIG_VALUE_1:join(root,'no-hooks'), GIT_CONFIG_KEY_2:'core.pager', GIT_CONFIG_VALUE_2:'cat', GIT_CONFIG_KEY_3:'credential.helper', GIT_CONFIG_VALUE_3:'', GIT_CONFIG_KEY_4:'protocol.allow', GIT_CONFIG_VALUE_4:'never' };
  writeFileSync(join(root,'empty-config'),'');
  const git = (cwd: string, ...args: string[]) => { const r=spawnSync('git',args,{cwd,env:gitEnv,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
  for(const r of [repo,outside]) {
    git(r,'init','--initial-branch=fixture'); git(r,'config','user.name','Fixture Author'); git(r,'config','user.email','fixture@example.invalid');
    git(r,'config','core.autocrlf','false'); writeFileSync(join(r,'story.txt'),'baseline-local-git\n'); git(r,'add','story.txt'); git(r,'commit','-m','synthetic baseline');
  }
  writeFileSync(join(repo,'story.txt'),'working-local-git\n');
  writeFileSync(join(repo,'staged.txt'),'staged-local-git\n'); git(repo,'add','staged.txt');
  const baseline=git(repo,'rev-parse','HEAD');
  const snapshot=()=>({head:git(repo,'rev-parse','HEAD'),index:hash(readFileSync(join(repo,'.git','index'))),story:hash(readFileSync(join(repo,'story.txt'))),staged:hash(readFileSync(join(repo,'staged.txt'))),refs:git(repo,'show-ref'),remotes:git(repo,'remote','-v')});
  const before=snapshot();
  const env = Object.fromEntries(Object.entries(gitEnv).filter(([k,v])=> typeof v==='string' && (/^GIT_/.test(k)||['TEMP','TMP','TMPDIR','USERPROFILE'].includes(k)))) as Record<string,string>;
  env.LOCAL_GIT_IDENTITY=identity;
  const registry = new ToolRegistry([]);
  const manager = new McpManager(registry,{dataDir:data,sandbox:{mode:'none',network:false,detail:'Windows fixture only, no OS fence'},secrets:()=>({env})});
  const receipt: Record<string,any>={runtime:process.version,hostProtocol:MCP_PROTOCOL_VERSION,before,results:{},scope:'Windows node fallback; not an OS fence; direct registered calls, not chat approval',account:'none'};
  try {
    // Exact legacy initialize receipt, separate from host's opaque handshake.
    const child=spawn(python,['-m','mcp_server_git','--repository',repo],{env:{...gitEnv,LOCAL_GIT_IDENTITY:identity},cwd:root,stdio:'pipe'});
    let buf=''; let err=''; child.stderr.on('data',d=>err+=d);
    const init=new Promise<any>((ok,no)=>{const timer=setTimeout(()=>no(new Error('initialize timeout '+err)),15000); child.stdout.on('data',d=>{buf+=d;for(const line of buf.split('\n').slice(0,-1)){try{const v=JSON.parse(line);if(v.id===1){clearTimeout(timer);ok(v);}}catch{}}}); child.on('error',no);});
    try {child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'sara-qualification',version:'1'}}})+'\n'); receipt.initialize=await init; assert.equal(receipt.initialize.result.serverInfo.version,'2026.11.4');} finally {child.kill();await once(child,'exit');}
    const config={name:'local-git',enabled:true,transport:'stdio' as const,command:python,args:[resolve('test/fixtures/developer/local-git/launch.py'),'--repository',repo]};
    const expected=Object.fromEntries([...reads.map(n=>[mcpToolName('local-git',n),'ask']),...writes.map(n=>[mcpToolName('local-git',n),'never'])]) as Record<string,Permission>;
    new SettingsStore(data).update({mcpServers:[config],toolPermissions:expected});
    const saved=new SettingsStore(data).get(); assert.deepEqual(saved.toolPermissions,expected);
    const conn=await manager.start(saved.mcpServers![0]); assert.equal(conn.status,'ready',conn.error);
    assert.deepEqual(conn.tools.map(t=>t.name).sort(),[...reads,...writes].sort());
    const snapshotTools=JSON.parse(readFileSync(new URL('./fixtures/developer/local-git/tools.json',import.meta.url),'utf8')).tools;
    assert.deepEqual(conn.tools,snapshotTools);
    assert.equal(receipt.initialize.result.protocolVersion,MCP_PROTOCOL_VERSION);
    assert.equal(new Set(registry.list().map(t=>t.spec.name)).size,14);
    receipt.schemas=conn.tools; receipt.policy=Object.fromEntries(registry.list().map(t=>[t.spec.name,registry.permission(t.spec.name,saved.toolPermissions)]));
    assert.deepEqual(receipt.policy,expected);
    assert.deepEqual(registry.enabled(saved.toolPermissions).map(t=>t.spec.name).sort(),reads.map(n=>mcpToolName('local-git',n)).sort());
    writeFileSync(join(output,'policy-before-features.json'),JSON.stringify(receipt.policy,null,2));
    const call=async(name:string,args:Record<string,unknown>={})=>{const tool=registry.get(mcpToolName('local-git',name))!; assert.equal(registry.permission(tool.spec.name,saved.toolPermissions),'ask'); const value=await tool.run({repo_path:repo,...args},{workspaceDir:repo,signal:AbortSignal.timeout(10000),sandbox:{mode:'none',network:false,detail:'Windows fixture only, no OS fence'}}); assert.ok(value.length<16000);receipt.results[name]=value;return value;};
    assert.match(await call('git_status'),/modified:\s+story\.txt/);
    assert.match(await call('git_diff_unstaged'),/-baseline-local-git\n\+working-local-git/);
    assert.match(await call('git_diff_staged'),/\+staged-local-git/);
    const log=await call('git_log',{max_count:1});assert.ok(log.includes(baseline));assert.match(log,/synthetic baseline/);assert.equal((log.match(/Commit:/g)||[]).length,1);
    assert.equal(await call('git_show',{revision:'HEAD:story.txt'}),'baseline-local-git\n');
    assert.match(await call('git_show',{revision:baseline}),/synthetic baseline/);
    assert.match(await call('git_diff',{target:'HEAD'}),/working-local-git/);
    assert.match(await call('git_branch',{branch_type:'local'}),/fixture/);
    assert.equal(await call('git_remote'),'No remotes configured');
    for(const p of [outside,join(repo,'..','..'),'-C',repo+'-sibling']) await assert.rejects(call('git_status',{repo_path:p}),/outside|Invalid|allowed/i);
    const link=join(repo,'escape'); symlinkSync(outside,link,'junction');
    await assert.rejects(call('git_status',{repo_path:link}),/outside/i);
    mkdirSync(join(repo,'linked')); writeFileSync(join(repo,'linked','.git'),'gitdir: '+join(outside,'.git').replaceAll('\\','/')+'\n');
    await assert.rejects(call('git_status',{repo_path:join(repo,'linked')}),/outside/i);
    await assert.rejects(call('git_show',{revision:'--output=escape'}),/cannot start/);
    await assert.rejects(call('git_diff',{target:'--ext-diff'}),/cannot start/);
    await assert.rejects(call('git_log',{start_timestamp:'--all'}),/cannot start/);
    receipt.after=snapshot(); assert.deepEqual(receipt.after,before);
    // Harmless adversarial canaries: repo config is executable, even for reads.
    const marker=join(root,'canary.txt');
    const script=join(root,'canary.sh').replaceAll('\\','/');
    writeFileSync(script, '#!/bin/sh\nprintf canary >> "'+marker.replaceAll('\\','/')+'"\nprintf "canary-output\\n"\n');
    git(repo,'config','alias.status','!sh "'+script+'"');
    await call('git_status'); assert.equal(existsSync(marker),false);
    git(repo,'config','core.fsmonitor','sh "'+script+'"');
    await call('git_status'); assert.equal(existsSync(marker),false);
    git(repo,'config','diff.external','sh "'+script+'"');
    assert.match(await call('git_diff_unstaged'),/canary-output/);
    assert.equal(readFileSync(marker,'utf8'),'canary');
    git(repo,'config','--unset','diff.external'); rmSync(marker);
    git(repo,'config','diff.fixture.textconv','sh "'+script+'"');
    writeFileSync(join(repo,'.gitattributes'),'story.txt diff=fixture\n');
    await call('git_diff_unstaged'); assert.equal(readFileSync(marker,'utf8'),'canarycanary');
    git(repo,'config','--unset','diff.fixture.textconv'); rmSync(marker); rmSync(join(repo,'.gitattributes'));
    git(repo,'config','filter.fixture.smudge','sh "'+script+'"');
    git(repo,'config','filter.fixture.clean','sh "'+script+'"');
    writeFileSync(join(repo,'.gitattributes'),'story.txt filter=fixture\n');
    await call('git_show',{revision:'HEAD:story.txt'}); assert.equal(existsSync(marker),false);
    rmSync(join(repo,'.gitattributes'));
    const included=join(outside,'included-config');writeFileSync(included,'[status]\n showUntrackedFiles = no\n');
    writeFileSync(join(repo,'untracked.txt'),'synthetic');
    git(repo,'config','include.path',included.replaceAll('\\','/'));
    assert.doesNotMatch(await call('git_status'),/untracked.txt/);
    git(repo,'config','--unset','include.path');
    assert.match(await call('git_status'),/untracked.txt/);rmSync(join(repo,'untracked.txt'));
    receipt.adversarial={builtinAliasNotExecuted:true,fsmonitorEnvironmentOverride:true,externalDiffExecuted:true,textconvExecuted:true,showBlobDidNotRunSmudgeOrClean:true,outsideConfigIncludeRead:true,warning:'Selected repository confinement is not filesystem or process confinement. Never admit hostile repositories unfenced.'};
    assert.deepEqual(snapshot(),before);
    const stale=registry.get(mcpToolName('local-git','git_status'))!;
    const pid=JSON.parse(readFileSync(identity,'utf8')).pid;
    manager.stopAll(); assert.equal(registry.list().length,0);
    await assert.rejects(stale.run({repo_path:repo},{workspaceDir:repo,signal:AbortSignal.timeout(1000),sandbox:{mode:'none',network:false,detail:'Windows fixture only, no OS fence'}}),/not connected/);
    for(let i=0;i<30;i++){try{process.kill(pid,0);await pause(100);}catch{break;}}
    assert.throws(()=>process.kill(pid,0));receipt.cleanup={pid,exited:true,registryEmpty:true,postDisconnectRefused:true};
    writeFileSync(join(output,'host-receipt.json'),JSON.stringify(receipt,null,2));
  } finally {manager.stopAll();await pause(2100);rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false);}
});

test('Local Git packaging stays an unpublished policy-blocked preview', () => {
  assert.equal(existsSync(new URL('../store/mcp/local-git.json', import.meta.url)), false, 'Policy-blocked preview must not enter the recipe inventory.');
  const recipe = JSON.parse(readFileSync(new URL('./fixtures/developer/local-git/recipe-preview.json', import.meta.url), 'utf8'));
  assert.equal(recipe.id, 'local-git');
  assert.deepEqual(recipe.tested, []);
  assert.match(recipe.reviewNotes, /preview/i);
  assert.match(recipe.reviewNotes, /H1.*H2.*H3.*H4.*H5/);
  assert.deepEqual(recipe.mcp.tools.readOnly, []);
  assert.deepEqual(recipe.mcp.tools.ask, ['git_status', 'git_diff_unstaged', 'git_diff_staged', 'git_diff', 'git_log', 'git_show', 'git_branch', 'git_remote']);
  assert.match(recipe.mcp.guide.join(' '), /Off/);
  assert.match(recipe.mcp.guide.join(' '), /readback/);
  assert.equal(recipe.mcp.args.includes('mcp-server-git==2026.11.4'), true);
  assert.deepEqual(Object.keys(recipe.mcp).sort(), ['args','command','fields','guide','name','needs','reaches','secrets','tools','transport'].sort());
});
