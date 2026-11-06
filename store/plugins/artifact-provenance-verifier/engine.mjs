import { createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
// Local detached envelope v1, deliberately NOT Sigstore, DSSE, SLSA or certificate verification.
export function signingPayload(identity,sha256) { return Buffer.from('sara-artifact-v1\n'+JSON.stringify([identity,sha256]),'utf8'); }
const keys=['algorithm','artifactBase64','sha256','identity','expectedIdentity','publicKeyPem','expectedKeySha256','signatureBase64'];
function base64(value,max) { if(typeof value!=='string'||value.length>max||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('input'); const b=Buffer.from(value,'base64'); if(b.toString('base64')!==value) throw new Error('input'); return b; }
export function verifyArtifact(args) {
 if(!args||Object.keys(args).some(k=>!keys.includes(k))||keys.some(k=>typeof args[k]!=='string')||args.algorithm!=='ed25519') throw new Error('input');
 for(const key of ['sha256','expectedKeySha256']) if(!/^[a-f0-9]{64}$/.test(args[key])) throw new Error('input');
 for(const key of ['identity','expectedIdentity']) if(!args[key].length||args[key].length>160||!/^[A-Za-z0-9._/@:+-]+$/.test(args[key])) throw new Error('input');
 if(args.publicKeyPem.length>1024||!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/.test(args.publicKeyPem)) throw new Error('input');
 const artifact=base64(args.artifactBase64,43692),signature=base64(args.signatureBase64,88); if(signature.length!==64) throw new Error('input');
 let key; try { key=createPublicKey(args.publicKeyPem); } catch { throw new Error('input'); }
 if(key.asymmetricKeyType!=='ed25519') throw new Error('input');
 const actualHash=createHash('sha256').update(artifact).digest();
 const actualKey=createHash('sha256').update(key.export({type:'spki',format:'der'})).digest();
 const checks={hash:timingSafeEqual(actualHash,Buffer.from(args.sha256,'hex')),key:timingSafeEqual(actualKey,Buffer.from(args.expectedKeySha256,'hex')),identity:args.identity===args.expectedIdentity,signature:verify(null,signingPayload(args.identity,args.sha256),key,signature)};
 const verified=Object.values(checks).every(Boolean);
 return {status:verified?'verified':'rejected',verified,format:'sara-artifact-v1',algorithm:'ed25519',checks};
}
