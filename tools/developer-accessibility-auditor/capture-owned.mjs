// Only this fixed owned fixture pair may be rendered. Not a runtime browser bridge.
import {recordedEvidence} from './recorded-evidence.mjs';
import assert from 'node:assert/strict';import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {createHash} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';import {join} from 'node:path';import {audit} from '../../store/plugins/accessibility-auditor/audit.mjs';
if(process.env.ACCESSIBILITY_OWN_BROWSER!=='1')throw Error('Explicit ACCESSIBILITY_OWN_BROWSER=1 required');
const modulePath=process.env.SARA_PLAYWRIGHT_MODULE;
for(const key of ['SARA_PLAYWRIGHT_MODULE','PLAYWRIGHT_BROWSERS_PATH'])if(!process.env[key])throw Error('Operator must set '+key);
assert.equal(JSON.parse(readFileSync(modulePath.replace('index.mjs','package.json'),'utf8')).version,'1.62.1');
const {chromium}=await import(pathToFileURL(modulePath).href);assert.ok(chromium.executablePath().replaceAll('\\','/').includes('/chromium-1234/'));
const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'outputs/developer-addons/accessibility-auditor'),fixtures=join(root,'test/fixtures/developer/accessibility-auditor');mkdirSync(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex'),axe=readFileSync(new URL('./node_modules/axe-core/axe.min.js',import.meta.url),'utf8');assert.equal(JSON.parse(readFileSync(new URL('./node_modules/axe-core/package.json',import.meta.url),'utf8')).version,'4.10.3');
const browser=await chromium.launch({headless:true,chromiumSandbox:true}),records=[],namingRecords=[];let requests=0,contextsClosed=0;
try{for(const [viewport,width,height] of [['desktop',1200,800],['phone',390,844]])for(const variant of ['candidate','control']){
 const html=readFileSync(join(fixtures,variant+'.html'),'utf8'),report=audit({html});const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,colorScheme:'light',reducedMotion:'reduce',locale:'en-US',timezoneId:'UTC',serviceWorkers:'block'});
 try{await context.route('**/*',r=>{requests++;return r.abort();});const page=await context.newPage();await page.setContent(html,{waitUntil:'load'});await page.evaluate(axe);
 const oracle=await page.evaluate(async()=>{const result=await window.axe.run(document,{runOnly:{type:'rule',values:['html-has-lang','image-alt','button-name','label']},resultTypes:['violations']});return {version:result.testEngine.version,violations:result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target}))}))};});
 assert.equal(oracle.version,'4.10.3');const map={'document-lang-missing':'html-has-lang','img-alt-missing':'image-alt','button-name-missing':'button-name','control-label-missing':'label'},matches=[];
 for(const f of report.findings){const v=oracle.violations.find(v=>v.id===map[f.rule]);assert.ok(v,'independent axe violation for '+f.rule);const match=await page.evaluate(({ordinal,tag,targets})=>{const el=document.querySelectorAll('*')[ordinal-1];if(!el||el.localName!==tag)return null;const r=el.getBoundingClientRect(),c=getComputedStyle(el);return {tag:el.localName,ordinal,rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:r.width>0&&r.height>0&&c.display!=='none'&&c.visibility==='visible'&&!el.closest('[hidden],[inert],[aria-hidden="true"]'),axeTargetVerified:targets.some(t=>t.length===1&&typeof t[0]==='string'&&document.querySelector(t[0])===el)};},{ordinal:f.element.ordinal,tag:f.element.tag,targets:v.nodes.map(n=>n.target)});
 assert.ok(match?.axeTargetVerified,'actual AST node is independent axe target');if(f.rule!=='document-lang-missing')assert.equal(match.visible,true);matches.push({rule:f.rule,axeRule:map[f.rule],...match});}
 assert.equal(matches.length,variant==='candidate'?4:0);assert.equal(oracle.violations.reduce((sum,v)=>sum+v.nodes.length,0),matches.length);
 const screenshot=await page.screenshot({type:'png',animations:'disabled',caret:'hide',scale:'css'});writeFileSync(join(out,viewport+'-'+variant+'.png'),screenshot);if(variant==='candidate'){const shotDir=join(root,'store/plugins/accessibility-auditor/shots');mkdirSync(shotDir,{recursive:true});writeFileSync(join(shotDir,viewport+'.png'),screenshot);}
 records.push({viewport,width,height,variant,sourceSha256:hash(html),structural:report.findings,oracle,matches,screenshotSha256:hash(screenshot)});
 }finally{await context.close();contextsClosed++;}
}
const casesSource=readFileSync(join(fixtures,'naming-cases.json'),'utf8'),cases=JSON.parse(casesSource);
for(const [viewport,width,height] of [['desktop',1200,800],['phone',390,844]])for(const c of cases){
 const html='<!doctype html><html lang="en"><title>Owned naming oracle</title><body>'+c.body+'</body></html>',report=audit({html});
 const context=await browser.newContext({viewport:{width,height},serviceWorkers:'block'});
 try{await context.route('**/*',r=>{requests++;return r.abort();});const page=await context.newPage();await page.setContent(html);await page.evaluate(axe);
 const oracle=await page.evaluate(async selector=>{window.axe.utils.getFlattenedTree(document);const accessibleText=window.axe.commons.text.accessibleText(document.querySelector(selector));const result=await window.axe.run(document,{runOnly:{type:'rule',values:['button-name','label','image-alt']}});return {accessibleText,violations:result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))};},c.selector);
 const ariaSnapshot=await page.locator(c.selector).ariaSnapshot();
 const screenshot=await page.screenshot({type:'png',animations:'disabled'});writeFileSync(join(out,viewport+'-naming-'+c.id+'.png'),screenshot);
 const record={id:c.id,viewport,sourceSha256:hash(html),html,structural:report,oracle,ariaSnapshot,screenshotSha256:hash(screenshot)};namingRecords.push(record);
 writeFileSync(join(out,'naming-progress.json'),JSON.stringify(namingRecords,null,2)+'\n');
 assert.equal(oracle.accessibleText,c.name,c.id+' independent axe accessible name');
 if(c.uncertain){assert.equal(report.coverage,'requires-browser');assert.ok(report.unsupported.includes('author-named-subtree'));assert.equal(report.findings.length,0);}else if(c.id==='emptyReference'||c.id==='hiddenDescendant'){assert.equal(report.findings.length,0);assert.ok(report.unsupported.includes('empty-name-reference'));}else assert.equal(report.findings.length,0);
 }finally{await context.close();contextsClosed++;}
}
assert.equal(requests,0);}finally{await browser.close();}
const evidence={playwright:'1.62.1',axe:'4.10.3',axeSourceSha256:hash(axe),browserVersion:browser.version(),revision:'1234',sandbox:true,noPersonalProfile:true,serviceWorkers:'block',requests,contextsClosed,browserClosed:!browser.isConnected(),captureSourceSha256:hash(readFileSync(fileURLToPath(import.meta.url))),projectionSourceSha256:hash(readFileSync(new URL('./recorded-evidence.mjs',import.meta.url))),namingCasesSha256:hash(readFileSync(join(fixtures,'naming-cases.json'))),namingRecords,records};writeFileSync(join(out,'browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');// Publish only after all real oracle assertions and owned browser/context closure succeeded.
const privateBytes=readFileSync(join(out,'browser-evidence.json'));
writeFileSync(join(fixtures,'recorded-browser-evidence.json'),JSON.stringify(recordedEvidence(privateBytes),null,2)+'\n');
console.log(JSON.stringify({browserVersion:evidence.browserVersion,records:records.length,confirmedElementMatches:records.reduce((sum,r)=>sum+r.matches.length,0),requests,contextsClosed,browserClosed:evidence.browserClosed}));
