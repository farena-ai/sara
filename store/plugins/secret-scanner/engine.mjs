import { createHash } from 'node:crypto';
// Never include captured text, snippets, secret digests, or user errors in results.
const detectors = [
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['credential-assignment', /(?<![\w"'`])(?:(["'])(?:password|passwd|secret|token|api[_-]?key)\1|\b(?:password|passwd|secret|token|api[_-]?key))\s*[:=]\s*/gi],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+\/-]{8,512}=*/gi],
];
// Parse from the matched key's end, never by stripping a divergent key regex.
function assignment(line,start) {
  const quote=line[start];
  if(quote==='"'||quote==="'") {
    let value='',raw='';
    for(let i=start+1;i<line.length;i++) {
      const c=line[i];
      if(c===quote) {
        if(!value.length||raw.length>512||value.length>512) throw new Error('input');
        return {value,raw,escaped:raw.includes('\\'),end:i+1};
      }
      if(c<' '||raw.length>=512) throw new Error('input');
      raw+=c;
      if(c!=='\\') {value+=c;continue;}
      const e=line[++i];if(e===undefined) throw new Error('input');raw+=e;
      const escapes={'"':'"',"'":"'",'\\':'\\','/':'/',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'};
      if(e==='u') {
        const hex=line.slice(i+1,i+5);if(!/^[a-fA-F0-9]{4}$/.test(hex)) throw new Error('input');
        raw+=hex;value+=String.fromCharCode(parseInt(hex,16));i+=4;
      } else if(Object.hasOwn(escapes,e)&&(e!=="'"||quote==="'")) value+=escapes[e];
      else throw new Error('input');
    }
    throw new Error('input');
  }
  if(quote==='`') throw new Error('input');
  const value=line.slice(start).match(/^[^\s"'`,;\]})]+/)?.[0];
  if(!value||value.length>512) throw new Error('input');
  return {value,raw:value,escaped:false,end:start+value.length};
}
export function scan(args) {
  if (!args || Object.keys(args).some(k=>k!=='files') || !Array.isArray(args.files) || !args.files.length || args.files.length>12) throw new Error('input');
  let bytes=0,opaquePaths=false; const findings=[], values=new Set();
  args.files.forEach((file,index)=>{
    if (!file || Object.keys(file).some(k=>!['path','text'].includes(k)) || typeof file.path!=='string' || !file.path.length || file.path.length>160 || /[\x00-\x1f\x7f]/.test(file.path) || typeof file.text!=='string' || file.text.length>32768) throw new Error('input');
    bytes+=Buffer.byteLength(file.text); if(bytes>65536) throw new Error('input');
    const safePath = detectors.some(([,re])=> { re.lastIndex=0; return re.test(file.path); }) ? '[redacted-path]' : file.path;
    file.text.split(/\r\n|\n|\r/).forEach((line,i)=>{
      for(const [detector,re] of detectors) {
        re.lastIndex=0;
        let match;
        while((match=re.exec(line))) {
          if(findings.length>=120) throw new Error('limit');
          if(detector==='credential-assignment') {
            const extracted=assignment(line,re.lastIndex);re.lastIndex=extracted.end;
            values.add(extracted.value);values.add(extracted.raw);
            opaquePaths ||= extracted.escaped;
          } else {
            values.add(detector==='bearer-token'?match[0].replace(/^Bearer\s+/i,''):match[0]);
            opaquePaths ||= detector==='private-key';
          }
          // Coordinates only: not a hash of a low-entropy secret (nor of a possibly secret path).
          const id=createHash('sha256').update(`finding-v1:${index}:${i+1}:${match.index}:${detector}`).digest('hex');
          findings.push({id,detector,path:safePath,line:i+1,column:match.index+1});
        }
      }
    });
  });
  // Withhold encoded/escaped path spellings rather than guess lossy decoding.
  for(const finding of findings) if(opaquePaths||/[\\%]/.test(finding.path)||[...values].some(v=>finding.path.includes(v))) finding.path='[redacted-path]';
  values.clear();
  return {status:'completed',files:args.files.length,findings};
}
