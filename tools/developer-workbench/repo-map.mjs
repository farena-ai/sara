import { mkdir, readdir, lstat, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { digest, relativePath, excluded, noLinks, readBounded, checkAbort } from './paths.mjs';
import { closed, boundedJSON, boundedResult } from './validation.mjs';
export const MAP_LIMITS=Object.freeze({files:256,depth:12,fileBytes:262144,bytes:2097152});
export function mapOptions(options) {
 closed(options,['depth','maxFiles']);
 for(const [k,max] of [['depth',MAP_LIMITS.depth],['maxFiles',MAP_LIMITS.files]]) if(options[k]!==undefined && (!Number.isInteger(options[k]) || options[k]<1 || options[k]>max)) throw new Error('map-budget');
 return {depth:options.depth??MAP_LIMITS.depth,maxFiles:options.maxFiles??MAP_LIMITS.files};
}
// Administrator-only staging API: not an MCP method, no ambient source discovery.
// Source must be reviewed and quiescent. Destination must be a fresh owned server home.
export async function stageSnapshot(source,home) {
 await noLinks(source);await noLinks(home);const target=join(home,'snapshot');await mkdir(target);
 const files=[];let bytes=0,entries=0;
 try {
  async function copy(dir,prefix='',depth=0) {
   if(depth>MAP_LIMITS.depth) throw new Error('map-budget');
   for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
    if(++entries>1024) throw new Error('map-budget');const path=prefix?`${prefix}/${entry.name}`:entry.name;
    const actual=join(dir,entry.name);const st=await lstat(actual);if(st.isSymbolicLink()) throw new Error('linked-path');
    if(excluded(entry.name)) continue;relativePath(path);
    if(st.isDirectory()) {await mkdir(join(target,path),{recursive:true});await copy(actual,path,depth+1);}
    else {const data=await readBounded(actual,MAP_LIMITS.fileBytes);bytes+=data.length;if(bytes>MAP_LIMITS.bytes || files.length>=MAP_LIMITS.files) throw new Error('map-budget');await writeFile(join(target,path),data,{flag:'wx',mode:0o400});files.push({path,bytes:data.length,sha256:digest(data)});}
   }
  }
  await copy(source);files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const inventory={version:1,files};await writeFile(join(home,'snapshot-index.json'),JSON.stringify(inventory),{flag:'wx',mode:0o400});return inventory;
 } catch(e) {await rm(target,{recursive:true,force:true});throw e;}
}
export async function loadSnapshot(home,options={},signal) {
 const limits=mapOptions(options);checkAbort(signal);await noLinks(home);await noLinks(join(home,'snapshot'));
 let index;try {index=JSON.parse((await readBounded(join(home,'snapshot-index.json'),65536,signal)).toString('utf8'));} catch(e) {checkAbort(signal);throw new Error('snapshot-index-refused');}
 boundedJSON(index);closed(index,['version','files']);if(index.version!==1 || !Array.isArray(index.files) || index.files.length>MAP_LIMITS.files || index.files.length>limits.maxFiles) throw new Error('snapshot-budget');
 const paths=new Set();let total=0;const files=[];
 for(const f of index.files) {
  closed(f,['path','bytes','sha256']);relativePath(f.path);if(paths.has(f.path.toLowerCase()) || f.path.split('/').length-1>limits.depth || !Number.isInteger(f.bytes) || f.bytes<0 || f.bytes>MAP_LIMITS.fileBytes || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('snapshot-index-refused');paths.add(f.path.toLowerCase());
  total+=f.bytes;if(total>MAP_LIMITS.bytes) throw new Error('snapshot-budget');
  let data;try {data=await readBounded(join(home,'snapshot',f.path),MAP_LIMITS.fileBytes,signal);}catch(e){checkAbort(signal);throw new Error('snapshot-read-refused');}
  if(data.length!==f.bytes || digest(data)!==f.sha256) throw new Error('snapshot-changed');files.push({...f,data});
 }
 // Reject unindexed additions too, including links hidden in excluded directories.
 let count=0;async function verify(dir,prefix='',depth=0){if(depth>MAP_LIMITS.depth) throw new Error('snapshot-budget');for(const e of await readdir(dir,{withFileTypes:true})){if(++count>1024) throw new Error('snapshot-budget');checkAbort(signal);const p=prefix?`${prefix}/${e.name}`:e.name;const s=await lstat(join(dir,e.name));if(s.isSymbolicLink()) throw new Error('snapshot-linked-path');if(s.isDirectory()) await verify(join(dir,e.name),p,depth+1);else if(!paths.has(p.toLowerCase())) throw new Error('snapshot-unindexed-file');}}
 await verify(join(home,'snapshot'));return {files,total,snapshotSha256:digest(JSON.stringify(index))};
}
export async function repoMap(home,options={},signal) {
 const snapshot=await loadSnapshot(home,options,signal);
 return boundedResult({complete:true,scope:'staged-server-home-only',buildExecuted:false,snapshotSha256:snapshot.snapshotSha256,totalBytes:snapshot.total,files:snapshot.files.map(({data,...f})=>f)});
}
export async function snapshotDocument(home,path,signal) {
 relativePath(path);if(!path.endsWith('.json')) throw new Error('json-only');const snapshot=await loadSnapshot(home,{},signal);const file=snapshot.files.find(f=>f.path===path);if(!file) throw new Error('snapshot-file-not-found');
 let document;try{document=JSON.parse(file.data.toString('utf8'));}catch{throw new Error('invalid-json');}
 return {document,evidence:{file:path,sha256:file.sha256,snapshotSha256:snapshot.snapshotSha256}};
}
