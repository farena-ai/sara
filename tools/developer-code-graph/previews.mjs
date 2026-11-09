// Real bounded handler results, rendered as clearly labelled synthetic previews.
import {readFileSync,writeFileSync} from 'node:fs';import {dirname,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'../..'),previews=[];
for(const [i,id] of ['change-impact-analyzer','architecture-guard'].entries()){
 const args=JSON.parse(readFileSync(join(root,'test/fixtures/developer/code-graph',i?'architecture.json':'impact.json'),'utf8'));const {handle}=await import(pathToFileURL(join(root,'store/plugins',id,'workflow.mjs')));const result=await handle(args);previews.push({id,...result.card,report:JSON.parse(result.content)});
}
writeFileSync(join(root,'outputs/developer-addons/code-graph/previews.json'),JSON.stringify(previews,null,2)+'\n');
