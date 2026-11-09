import { createHash } from 'node:crypto';
import { inventory } from './npm-lock.mjs';
function component(p,type) {
 const scoped=p.name.startsWith('@'), parts=p.name.split('/');
 const result={type,'bom-ref':'urn:sha256:'+createHash('sha256').update(JSON.stringify([p.path??'',p.name,p.version])).digest('hex'),...(scoped?{group:parts[0]}:{}),name:scoped?parts[1]:p.name,version:p.version,purl:'pkg:npm/'+(scoped?encodeURIComponent(parts[0])+'/':'')+encodeURIComponent(scoped?parts[1]:p.name)+'@'+encodeURIComponent(p.version)};
 if(p.path) result.properties=[{name:'npm:installPath',value:p.path}];
 if(p.integrity!==undefined) {
  if(typeof p.integrity!=='string'||p.integrity.length>1024) throw new Error('input');
  result.hashes=p.integrity.split(/\s+/).map(s=>{
    const m=/^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(s); if(!m) throw new Error('input');
    const bytes=Buffer.from(m[2],'base64'), len={sha1:20,sha256:32,sha384:48,sha512:64}[m[1]];
    if(bytes.length!==len||bytes.toString('base64')!==m[2]) throw new Error('input');
    return {alg:{sha1:'SHA-1',sha256:'SHA-256',sha384:'SHA-384',sha512:'SHA-512'}[m[1]],content:bytes.toString('hex')};
  });
 }
 return result;
}
export function build(args) {
 if(!args||Object.keys(args).some(k=>k!=='lock')) throw new Error('input');
 const data=inventory(args.lock);
 return {status:'completed',lockfileVersion:data.lockfileVersion,bom:{bomFormat:'CycloneDX',specVersion:'1.5',version:1,metadata:{component:component(data.project,'application')},components:data.packages.map(p=>component(p,'library'))}};
}
