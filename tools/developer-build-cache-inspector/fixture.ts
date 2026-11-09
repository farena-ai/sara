// Trusted qualification producer only. No arbitrary command or real-owner root option.
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,lstatSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../../',import.meta.url));
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
export function produce(){
 const home=mkdtempSync(join(tmpdir(),'build-cache-produced-')),source=join(home,'source.ts'),cache=join(home,'owned-caches-v1/typescript');mkdirSync(cache,{recursive:true});
 copyFileSync(join(root,'test/fixtures/developer/build-cache-inspector/source.ts'),source);
 const compiler=join(root,'node_modules/typescript/bin/tsc'),commands=[];
 for(const generation of ['build-a','build-b']){
  const args=[compiler,source,'--target','ES2022','--module','ES2022','--skipLibCheck','--declaration','--sourceMap','--outDir',join(cache,generation)];
  const p=spawnSync(process.execPath,args,{cwd:home,encoding:'utf8',timeout:10000,maxBuffer:65536});
  if(p.status!==0){rmSync(home,{recursive:true,force:true});throw new Error('Trusted fixed compiler fixture failed');}
  commands.push({generation,status:p.status,compilerSha:sha(compiler),fixedArguments:['source.ts','--target','ES2022','--module','ES2022','--skipLibCheck','--declaration','--sourceMap','--outDir','<owned-cache-generation>']});
 }
 return {home,cache,source,commands,sourceSha:sha(source),compilerVersion:JSON.parse(readFileSync(join(root,'node_modules/typescript/package.json'),'utf8')).version};
}
export function inventory(root:string){
 const files:{path:string;bytes:string;mtimeNs:string;sha256:string}[]=[];
 function walk(p:string,r:string){for(const name of readdirSync(p).sort()){const full=join(p,name),rel=r?r+'/'+name:name,s=lstatSync(full,{bigint:true});if(s.isDirectory())walk(full,rel);else{if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n)throw Error('Unsupported fixture');files.push({path:rel,bytes:String(s.size),mtimeNs:String(s.mtimeNs),sha256:sha(full)});}}}
 walk(root,'');return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
