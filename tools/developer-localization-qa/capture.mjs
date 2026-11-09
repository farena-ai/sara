// Trusted developer-only capture of exactly the checked-in static synthetic fixture. Never a
// native host browser bridge. No input URL, script, catalog path or arbitrary page is accepted.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {sha,catalog} from '../../store/plugins/localization-qa/engine.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
export async function capture(){
 if(process.env.SARA_LOCALIZATION_BROWSER!=='1')throw Error('Owned browser qualification requires explicit opt-in');
 for(const key of ['SARA_LOCALIZATION_PLAYWRIGHT_MODULE','PLAYWRIGHT_BROWSERS_PATH'])if(!process.env[key])throw Error('Operator must set '+key+' to an existing installation; no defaults or downloads');
 const module=process.env.SARA_LOCALIZATION_PLAYWRIGHT_MODULE;
 if(!existsSync(module))throw Error('Preinstalled Playwright unavailable; no automatic installation');
 const {chromium}=await import(pathToFileURL(module).href);if(!existsSync(chromium.executablePath()))throw Error('Preinstalled Chromium unavailable');
 const dir=join(root,'test/fixtures/developer/localization-qa'),out=join(root,'outputs/developer-addons/localization-qa');mkdirSync(out,{recursive:true});
 const base=readFileSync(join(dir,'base.json'),'utf8'),target=readFileSync(join(dir,'target.json'),'utf8'),html=readFileSync(join(dir,'app.html'),'utf8');
 const bc=catalog(base),tc=catalog(target),keys=Object.keys(bc).sort(),common=keys.filter(k=>Object.hasOwn(tc,k));
 const evidence={fixture:'localization-owned-v1',htmlSha:sha(html),captureSha:sha(readFileSync(fileURLToPath(import.meta.url))),baseSha:sha(base),targetSha:sha(target),renderer:'chromium',browserVersion:'',dpr:1,font:'16px Arial',viewports:[390,900],rows:[]};
 let browser;let blockedRequests=0;const screenshots=[];
 try{
  // Do not disable Chromium's sandbox. Only this owned static page is rendered in fresh contexts.
  browser=await chromium.launch({headless:true,chromiumSandbox:true});evidence.browserVersion=browser.version();
  for(const viewport of evidence.viewports){
   const context=await browser.newContext({viewport:{width:viewport,height:720},deviceScaleFactor:1,locale:'en-US',timezoneId:'UTC',serviceWorkers:'block',reducedMotion:'reduce'});
   try{
    await context.route('**/*',r=>{blockedRequests++;return r.abort();});const page=await context.newPage();await page.setContent(html,{waitUntil:'load'});
    for(const side of ['base','target']){
     const values=common.map(k=>(side==='base'?bc:tc)[k]);
     const measured=await page.evaluate(async values=>{
      const main=document.querySelector('main');main.replaceChildren();
      for(const value of values){const cell=document.createElement('div');cell.className='cell';const span=document.createElement('span');span.textContent=value;cell.append(span);main.append(cell);}
      await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return [...main.children].map(cell=>{const box=cell.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(cell.firstChild);const text=range.getBoundingClientRect();return {x:box.x,y:box.y,width:cell.clientWidth,height:cell.clientHeight,scrollWidth:cell.scrollWidth,scrollHeight:cell.scrollHeight,textWidth:text.width,textHeight:text.height};});
     },values);
     for(let i=0;i<common.length;i++){
      const ref='k'+String(keys.indexOf(common[i])+1).padStart(3,'0');let row=evidence.rows.find(r=>r.ref===ref&&r.viewport===viewport);if(!row){row={ref,viewport};evidence.rows.push(row);}row[side==='base'?'b':'t']={...measured[i],textSha:sha(values[i])};
     }
     const name=`fixture-${viewport}-${side}.png`;await page.screenshot({path:join(out,name)});screenshots.push(name);
    }
   }finally{await context.close();}
  }
  const args={base,target,grammar:'named-v1',evidence};writeFileSync(join(out,'captured-input.json'),JSON.stringify(args,null,2)+'\n');
  writeFileSync(join(dir,'captured-input.json'),JSON.stringify(args,null,2)+'\n');
  writeFileSync(join(out,'capture-provenance.json'),JSON.stringify({fixture:evidence.fixture,htmlSha:evidence.htmlSha,captureSha:evidence.captureSha,browserVersion:evidence.browserVersion,playwrightVersion:JSON.parse(readFileSync(new URL('./package.json',pathToFileURL(module)),'utf8')).version,browserSha:sha(readFileSync(chromium.executablePath())),blockedRequests,screenshots,networkPolicy:'abort-all',sandboxEnabled:true},null,2)+'\n');
  return args;
 }finally{if(browser){await browser.close();writeFileSync(join(out,'browser-cleanup.json'),JSON.stringify({browserClosed:true,contextsClosed:true,listenersCreated:0})+'\n');}}
}
