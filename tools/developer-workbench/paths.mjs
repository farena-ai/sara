import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, parse, join } from 'node:path';
import { createHash } from 'node:crypto';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const excluded = n => /^(?:\..*|node_modules|vendor|dist|build|coverage|data|vault|secrets?|credentials?|.*\.(?:pem|key|pfx|p12|env|db|sqlite))$/i.test(n) || /(?:token|password|credential|secret)/i.test(n);
export function relativePath(p) {
 if(typeof p!=='string' || p.length>240 || !p || p.split('/').some(n=>!n || n==='.' || n==='..' || excluded(n) || !/^[a-zA-Z0-9_@][a-zA-Z0-9_.@ -]{0,79}$/.test(n) || /[. ]$/.test(n) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(n))) throw new Error('unsafe-path');
 return p;
}
export async function noLinks(path) {
 const absolute=resolve(path),base=parse(absolute).root;let at=base;
 for(const part of absolute.slice(base.length).split(/[\\/]/).filter(Boolean)) {at=join(at,part);const st=await lstat(at);if(st.isSymbolicLink()) throw new Error('linked-path');}
 if((await realpath(absolute)).toLowerCase()!==absolute.toLowerCase()) throw new Error('aliased-path');
 return absolute;
}
export function checkAbort(signal) {if(signal?.aborted) throw new Error('cancelled');}
export async function readBounded(path,max,signal) {
 checkAbort(signal);await noLinks(path);const a=await lstat(path);
 if(!a.isFile() || a.nlink!==1 || a.size>max) throw new Error('file-budget-or-link');
 const handle=await open(path,'r');
 try {const b=await handle.stat();if(a.ino!==b.ino || a.dev!==b.dev || a.size!==b.size) throw new Error('snapshot-changed');
 const buffer=Buffer.alloc(max+1);let length=0;
 while(length<buffer.length) {checkAbort(signal);const {bytesRead}=await handle.read(buffer,length,buffer.length-length,null);if(!bytesRead) break;length+=bytesRead;}
 const c=await handle.stat();await noLinks(path);
 if(length>max || b.size!==c.size || b.mtimeMs!==c.mtimeMs || b.ino!==c.ino) throw new Error('snapshot-changed');
 return buffer.subarray(0,length);
 }finally {await handle.close();}
}
