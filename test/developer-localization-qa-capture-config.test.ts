import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('capture requires operator module and browser paths before importing or launching anything',()=>{
 for(const missing of ['SARA_LOCALIZATION_PLAYWRIGHT_MODULE','PLAYWRIGHT_BROWSERS_PATH']){
  const env={...process.env,SARA_LOCALIZATION_BROWSER:'1',SARA_LOCALIZATION_PLAYWRIGHT_MODULE:'operator-missing-module',PLAYWRIGHT_BROWSERS_PATH:'operator-missing-browser'};delete (env as Record<string,string|undefined>)[missing];
  const result=spawnSync(process.execPath,['--input-type=module','-e',"import {capture} from './tools/developer-localization-qa/capture.mjs';await capture();"],{encoding:'utf8',env,windowsHide:true});
  assert.notEqual(result.status,0);assert.ok(result.stderr.includes('Operator must set '+missing),result.stderr);
 }
});
