// Narrow PNG subset: RGB/RGBA 8-bit, noninterlaced, IHDR/IDAT/IEND only.
// No upstream decoder: zlib is capped at the preflighted exact scanline length.
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const fail=()=>{throw Error('unsupported or excessive PNG input');};
const hash=b=>createHash('sha256').update(b).digest('hex');
export function crc32(b){let c=0xffffffff;for(const x of b){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function shape(o,keys){if(!o||Object.getPrototypeOf(o)!==Object.prototype)fail();const own=Reflect.ownKeys(o);if(own.length!==keys.length||own.some(k=>!keys.includes(k)))fail();for(const k of keys){const d=Object.getOwnPropertyDescriptor(o,k);if(!d||!('value'in d)||!d.enumerable)fail();}}
function list(a){if(!Array.isArray(a)||a.length<1||a.length>2)fail();const keys=Reflect.ownKeys(a);if(keys.length!==a.length+1||keys.some(k=>k!=='length'&&!/^(0|1)$/.test(String(k))))fail();for(let i=0;i<a.length;i++){const d=Object.getOwnPropertyDescriptor(a,String(i));if(!d||!('value'in d)||!d.enumerable)fail();}}
function preflight(s){
 if(typeof s!=='string'||s.length>13336||s.length<60||s.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s))fail();
 const b=Buffer.from(s,'base64');if(b.length>10000||b.toString('base64')!==s||!b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail();
 let pos=8,n=0,w=0,h=0,bpp=0,ended=false,idat=false;const parts=[];
 while(pos<b.length){if(++n>64||pos+12>b.length)fail();const len=b.readUInt32BE(pos);if(len>b.length-pos-12)fail();const t=b.toString('latin1',pos+4,pos+8);const data=b.subarray(pos+8,pos+8+len);if(crc32(b.subarray(pos+4,pos+8+len))!==b.readUInt32BE(pos+8+len))fail();
  if(n===1){if(t!=='IHDR'||len!==13)fail();w=data.readUInt32BE(0);h=data.readUInt32BE(4);if(!w||!h||w>1280||h>960||w*h>1000000||data[8]!==8||![2,6].includes(data[9])||data[10]||data[11]||data[12])fail();bpp=data[9]===2?3:4;}
  else if(t==='IDAT'){if(ended||!len)fail();idat=true;parts.push(data);}
  else if(t==='IEND'){if(len||!idat||pos+12!==b.length)fail();ended=true;}
  else fail();pos+=12+len;
 }
 if(!ended)fail();return {b,w,h,bpp,parts,rawBytes:(w*bpp+1)*h};
}
function decode(p){
 const compressed=Buffer.concat(p.parts);const result=inflateSync(compressed,{maxOutputLength:p.rawBytes,info:true});const raw=result.buffer;
 if(raw.length!==p.rawBytes||result.engine.bytesWritten!==compressed.length)fail();
 const stride=p.w*p.bpp,out=Buffer.alloc(stride*p.h);
 for(let y=0;y<p.h;y++){const filter=raw[y*(stride+1)];if(filter>4)fail();for(let x=0;x<stride;x++){
 const a=x>=p.bpp?out[y*stride+x-p.bpp]:0,b=y?out[(y-1)*stride+x]:0,c=y&&x>=p.bpp?out[(y-1)*stride+x-p.bpp]:0;
 let v=0;if(filter===1)v=a;else if(filter===2)v=b;else if(filter===3)v=Math.floor((a+b)/2);else if(filter===4){const z=a+b-c,pa=Math.abs(z-a),pb=Math.abs(z-b),pc=Math.abs(z-c);v=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
 out[y*stride+x]=(raw[y*(stride+1)+1+x]+v)&255;
 }}return out;
}
export function compare(input){
 shape(input,['pairs']);list(input.pairs);const seen=new Set();for(const p of input.pairs){shape(p,['viewport','baseline','candidate']);if(!['desktop','phone'].includes(p.viewport)||seen.has(p.viewport))fail();seen.add(p.viewport);for(const k of ['baseline','candidate'])if(typeof p[k]!=='string'||p[k].length>13336)fail();}
 if(Buffer.byteLength(JSON.stringify(input))>60000)fail();
 const prepared=input.pairs.map(p=>({viewport:p.viewport,a:preflight(p.baseline),b:preflight(p.candidate)}));
 if(prepared.reduce((n,p)=>n+p.a.w*p.a.h+p.b.w*p.b.h,0)>4000000)fail();
 const pairs=prepared.map(({viewport,a,b},index)=>{
  if(a.w!==b.w||a.h!==b.h)fail();const x=decode(a),y=decode(b);let count=0,minX=a.w,minY=a.h,maxX=-1,maxY=-1;
  for(let i=0;i<a.w*a.h;i++){let changed=false;for(let c=0;c<4;c++){const av=c===3&&a.bpp===3?255:x[i*a.bpp+c],bv=c===3&&b.bpp===3?255:y[i*b.bpp+c];if(av!==bv)changed=true;}
   if(changed){count++;const xx=i%a.w,yy=Math.floor(i/a.w);minX=Math.min(minX,xx);minY=Math.min(minY,yy);maxX=Math.max(maxX,xx);maxY=Math.max(maxY,yy);}}
  return {index,viewport,width:a.w,height:a.h,status:count?'changed':'unchanged',changedPixels:count,totalPixels:a.w*a.h,baselineSha256:hash(a.b),candidateSha256:hash(b.b),rect:count?{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1}:null};
 });return {version:1,method:'exact-rgba8',pairs};
}
