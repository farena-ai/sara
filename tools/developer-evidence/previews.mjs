import {ids,fixtureArgs} from './fixtures.mjs';
import {writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'../..');
const previews=[];
for(const id of ids) {
 const dir=join(root,'store/plugins',id); const {handle}=await import(pathToFileURL(join(dir,'workflow.mjs')));
 const result=await handle(fixtureArgs(id),'en');mkdirSync(join(dir,'shots'),{recursive:true});
 previews.push({id,output:join(dir,'shots/1.png'),...result.card});
}
writeFileSync(join(root,'outputs/developer-addons/evidence/previews.json'),JSON.stringify(previews,null,2));
