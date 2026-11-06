import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
if(process.env.VISUAL_REGRESSION_OWN_BROWSER!=='1')throw Error('Owned fixture capture requires VISUAL_REGRESSION_OWN_BROWSER=1');
const modulePath=process.env.SARA_PLAYWRIGHT_MODULE;
if(!modulePath||!process.env.PLAYWRIGHT_BROWSERS_PATH)throw Error('Owned fixture capture requires explicit SARA_PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH');
const {chromium}=await import(pathToFileURL(modulePath).href);
const dir=fileURLToPath(new URL('../../test/fixtures/developer/visual-regression/',import.meta.url));mkdirSync(dir,{recursive:true});
const html=readFileSync(new URL('../../test/fixtures/developer/visual-regression/owned.html',import.meta.url),'utf8');
const browser=await chromium.launch({headless:true,chromiumSandbox:true});const records=[];let requests=0;
try{for(const [viewport,width,height] of [['desktop',1200,800],['phone',390,844]]){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:'light',locale:'en-US',timezoneId:'UTC',serviceWorkers:'block'});
 await context.route('**/*',route=>{requests++;return route.abort();});const page=await context.newPage();await page.setContent(html,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);
 for(const variant of ['baseline','candidate','control']){await page.evaluate(v=>document.documentElement.dataset.variant=v,variant);const bytes=await page.screenshot({type:'png',animations:'disabled',caret:'hide',scale:'css'});if(bytes.length>10000)throw Error('fixture outside plugin bound');writeFileSync(dir+viewport+'-'+variant+'.png',bytes);records.push({viewport,variant,width,height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
 await context.close();
}if(requests!==0)throw Error('Unexpected fixture network');
}finally{await browser.close();}
const evidence={playwrightVersion:JSON.parse(readFileSync(modulePath.replace('index.mjs','package.json'),'utf8')).version,browserVersion:browser.version(),sandbox:true,ownedHTMLSha256:createHash('sha256').update(html).digest('hex'),DPR:1,networkRequests:requests,contextsClosed:true,browserClosed:!browser.isConnected(),noPersonalProfile:true,records};
writeFileSync(new URL('../../outputs/developer-addons/visual-regression/browser-capture.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
