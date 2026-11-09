import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Deliberately synthetic stored API bytes, NOT a vendor service or MCP replacement.
export async function startFixtureApi(directory){
 const bytes=readFileSync(join(directory,'historical-build.json'));
 const requests=[];
 const base='/v2/organizations/synthetic-owned/pipelines/historical-viewer/builds/42';
 const routes=new Map([[base,bytes],[base+'?exclude_jobs=true&exclude_pipeline=true&include_test_engine=true',bytes],[base+'/annotations?omit_body=true&page=1&per_page=100&scope=all',readFileSync(join(directory,'historical-annotations.json'))]]);
 const server=createServer((req,res)=>{
  const allowed=req.method==='GET'&&routes.has(req.url);
  requests.push({method:req.method,path:req.url,allowed});
  res.writeHead(allowed?200:req.method==='GET'?403:405,{'content-type':'application/json','x-synthetic-fixture':'true'});
  res.end(allowed?routes.get(req.url):JSON.stringify({message:'Synthetic fixture boundary refused'}));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:`http://127.0.0.1:${server.address().port}`,requests,close:()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections();})};
}
