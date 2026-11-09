import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../tools/developer-visual-regression/capture-owned.mjs',import.meta.url));
test('owned capture has no private user/cache path or implicit Playwright module fallback',()=>{
 const source=readFileSync(script,'utf8');
 assert.doesNotMatch(source,/[A-Z]:[\\/]Users[\\/]|npm-cache|_npx|AppData/i);
 assert.match(source,/process\.env\.SARA_PLAYWRIGHT_MODULE/);
 assert.match(source,/process\.env\.PLAYWRIGHT_BROWSERS_PATH/);
});
test('owned capture refuses missing operator configuration before importing or launching browser',()=>{
 for(const missing of ['SARA_PLAYWRIGHT_MODULE','PLAYWRIGHT_BROWSERS_PATH','both']){
  const env:NodeJS.ProcessEnv={...process.env,VISUAL_REGRESSION_OWN_BROWSER:'1',SARA_PLAYWRIGHT_MODULE:'MUST_NOT_IMPORT_PRIVATE_CANARY',PLAYWRIGHT_BROWSERS_PATH:'MUST_NOT_LAUNCH_PRIVATE_CANARY'};
  if(missing!=='PLAYWRIGHT_BROWSERS_PATH')delete env.SARA_PLAYWRIGHT_MODULE;
  if(missing!=='SARA_PLAYWRIGHT_MODULE')delete env.PLAYWRIGHT_BROWSERS_PATH;
  const result=spawnSync(process.execPath,[script],{env,encoding:'utf8',timeout:10000});
  assert.equal(result.error,undefined);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Owned fixture capture requires explicit SARA_PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH/);
  assert.doesNotMatch(result.stderr,/PRIVATE_CANARY|ERR_MODULE_NOT_FOUND|browserType\.launch/);
 }
});
