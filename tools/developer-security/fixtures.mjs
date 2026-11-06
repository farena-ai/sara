import {readFileSync} from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
export const ids=['secret-scanner','license-auditor','sbom-builder','artifact-provenance-verifier'];
export function fixtureArgs(id) {
 const lock=readFileSync(new URL('../../test/fixtures/developer/security/package-lock-v3.json',import.meta.url),'utf8');
 if(id==='secret-scanner') return {files:[{path:'synthetic/config.json',text:JSON.stringify({password:'small-synthetic',api_key:'quoted "synthetic" 界'})+'\r\n'+['gh','p_','Q'.repeat(36)].join('')},{path:'small-synthetic/source.env',text:'token=other-synthetic'}]};
 if(id==='license-auditor') return {lock,metadata:[],policy:{allow:['MIT','Apache-2.0'],deny:['GPL-3.0-only']}};
 if(id==='sbom-builder') return {lock};
 const {publicKey,privateKey}=generateKeyPairSync('ed25519'),artifact=Buffer.from('Synthetic release fixture; not a shipped binary.');
 const sha256=createHash('sha256').update(artifact).digest('hex'),identity='synthetic/release@1.0.0';
 const bytes=Buffer.from('sara-artifact-v1\n'+JSON.stringify([identity,sha256]));
 return {algorithm:'ed25519',artifactBase64:artifact.toString('base64'),sha256,identity,expectedIdentity:identity,publicKeyPem:publicKey.export({type:'spki',format:'pem'}).toString(),expectedKeySha256:createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex'),signatureBase64:sign(null,bytes,privateKey).toString('base64')};
}
