export const labels={
 en:['HTTP and Webhook Workbench','Send a loopback HTTP request and optionally replay once. Calls can have effects. Sensitive fields are redacted.','Request observations','Refused','Replay duplicates the approved method.'],
 es:['Banco HTTP y webhooks','Envía una solicitud HTTP local y puede repetirla una vez. Puede tener efectos. Se ocultan campos sensibles.','Observaciones de la solicitud','Rechazado','La repetición duplica el método aprobado.'],
 fr:['Atelier HTTP et webhooks','Envoie une requête HTTP locale et peut la répéter une fois. Elle peut avoir des effets. Les champs sensibles sont masqués.','Observations de la requête','Refusé','La répétition duplique la méthode approuvée.'],
 de:['HTTP- und Webhook-Werkbank','Sendet eine lokale HTTP-Anfrage und wiederholt sie optional einmal. Aufrufe können Änderungen bewirken. Vertrauliche Felder werden verdeckt.','Anfragebeobachtungen','Abgelehnt','Die Wiederholung führt die genehmigte Methode erneut aus.'],
 'pt-BR':['Bancada HTTP e webhooks','Envia uma solicitação HTTP local e pode repeti-la uma vez. Chamadas podem ter efeitos. Campos sensíveis são ocultados.','Observações da solicitação','Recusado','A repetição duplica o método aprovado.'],
 it:['Banco HTTP e webhook','Invia una richiesta HTTP locale e può ripeterla una volta. Le chiamate possono avere effetti. I campi sensibili sono oscurati.','Osservazioni della richiesta','Rifiutato','La ripetizione duplica il metodo approvato.']};
export const parameters={type:'object',additionalProperties:false,required:['method','path'],properties:{method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE','HEAD']},path:{type:'string',maxLength:512,description:'Origin-form path only; no query, fragment, escapes or URL.'},headers:{type:'object',maxProperties:12,additionalProperties:{type:'string',maxLength:512}},body:{type:'string',maxLength:4096,description:'Empty or JSON object/array text; at most 4096 UTF-8 bytes.'},replay:{type:'boolean',description:'Explicitly repeat the same method once in this invocation.'}}};
const sensitive=/authorization|cookie|token|secret|password|passwd|api.?key|credential|session/i;
const publicHeader=/^(content-type|accept|x-public)$/i;
const fail=()=>{throw Error('refused');};
function collect(v,secrets,depth=0){if(depth>12)fail();if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){if(sensitive.test(k)){if(!['string','number'].includes(typeof x))fail();if(String(x))secrets.add(String(x));}collect(x,secrets,depth+1);}}
function scrub(v,secrets){if(typeof v==='number'&&secrets.has(String(v)))return '[REDACTED]';if(typeof v==='string'){for(const s of [...secrets].sort((a,b)=>b.length-a.length))v=v.split(s).join('[REDACTED]');return v;}if(Array.isArray(v))return v.map(x=>scrub(x,secrets));if(v&&typeof v==='object'){const keys=new Set();return Object.fromEntries(Object.entries(v).map(([k,x])=>{const key=scrub(k,secrets);if(keys.has(key))fail();keys.add(key);return [key,sensitive.test(k)?'[REDACTED]':scrub(x,secrets)];}));}return v;}
function json(text,secrets){let v;try{v=JSON.parse(text);}catch{fail();}if(!v||typeof v!=='object')fail();const stack=[];for(let i=0;i<text.length;i++){const c=text[i];if(c==='{'||c==='[')stack.push(c==='{'?new Set():null);else if(c==='}'||c===']')stack.pop();else if(c==='"'){const start=i;for(i++;i<text.length;i++){if(text[i]==='\\'){i++;continue;}if(text[i]==='"')break;}const end=i+1;let next=end;while(/\s/.test(text[next]??'')&&next<text.length)next++;if(text[next]===':'){const key=JSON.parse(text.slice(start,end)),keys=stack.at(-1);if(!keys||keys.has(key))fail();keys.add(key);}}}collect(v,secrets);return v;}
async function exchange(sara,wire,method,deadline){
 let socket,expired=false,openTimer;
 const remaining=deadline-performance.now();if(remaining<=0)fail();
 // The broker has no cancellation API. Consume late settlements and close late sockets
 // without writing; bound opens and both exchanges by one monotonic invocation budget.
 const opening=Promise.resolve().then(()=>sara.net.open('fixture')).then(s=>{
  if(expired||performance.now()>=deadline){Promise.resolve().then(()=>s.close()).catch(()=>{});fail();}
  socket=s;return s;
 });
 try{
  await Promise.race([opening,new Promise((_,reject)=>{openTimer=setTimeout(()=>{expired=true;reject(Error('invocation deadline'));},remaining);})]);
  clearTimeout(openTimer);if(performance.now()>=deadline)fail();
  return await new Promise((resolve,reject)=>{
  let bytes=Buffer.alloc(0),done=false;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(Error('deadline')),Math.max(0,Math.min(2000,deadline-performance.now())));
  const parse=(closed=false)=>{try{
   const sep=bytes.indexOf('\r\n\r\n');if(sep<0){if(closed)fail();return;}if(sep>4096)fail();
   const lines=bytes.subarray(0,sep).toString('latin1').split('\r\n');const status=/^HTTP\/1\.[01] ([1-5]\d\d)(?: [\x20-\x7e]*)?$/.exec(lines.shift());if(!status)fail();
   const headers={};for(const line of lines){const m=/^([!#$%&'*+.^_`|~0-9a-z-]+):[ \t]*([^\r\n]*)$/i.exec(line);if(!m)fail();const k=m[1].toLowerCase();if(Object.hasOwn(headers,k))fail();Object.defineProperty(headers,k,{value:m[2],enumerable:true});}
   if(headers['transfer-encoding']||headers['content-encoding'])fail();const code=Number(status[1]);if(code<200||code>=300&&code<400)fail();
   const body=bytes.subarray(sep+4);if(method==='HEAD'||code===204)return finish(null,{status:code,headers,body:''});
   const len=headers['content-length'];if(body.length>8192)fail();if(len!==undefined&&(!/^\d{1,5}$/.test(len)||Number(len)>8192))fail();if(len!==undefined&&body.length>Number(len))fail();
   if(len!==undefined&&body.length===Number(len)||len===undefined&&closed)return finish(null,{status:code,headers,body:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body)});if(closed)fail();
  }catch{finish(Error('response refused'));}};
  socket.onData(chunk=>{if(done)return;if(performance.now()>=deadline)return finish(Error('deadline'));bytes=Buffer.concat([bytes,chunk]);if(bytes.length>12288)return finish(Error('response budget'));parse();});socket.onClose(()=>parse(true));if(performance.now()>=deadline)return finish(Error('deadline'));socket.write(wire).catch(()=>finish(Error('write refused')));
 });}finally{expired=true;clearTimeout(openTimer);if(socket)await socket.close();}
}
export async function run(args,sara){
 const deadline=performance.now()+20000;
 const l=labels[sara.lang]??labels.en;
 const result=r=>{const value={content:JSON.stringify(r),card:{title:l[0],lines:[r.ok?l[2]:l[3],l[4],JSON.stringify(r)]}};if(Buffer.byteLength(JSON.stringify(value))>=48000)fail();return value;};
 try{
  const endpoint=sara.settings.endpoint;if(!/^127\.0\.0\.1:([1-9]\d{0,4})$/.test(endpoint??'')||Number(endpoint.split(':')[1])>65535)fail();
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['method','path','headers','body','replay'].includes(k)))fail();
  const {method,path}=args;if(!parameters.properties.method.enum.includes(method)||typeof path!=='string'||path.length>512||!/^\/[a-zA-Z0-9/_~.:-]*$/.test(path)||path.startsWith('//'))fail();if(args.replay!==undefined&&typeof args.replay!=='boolean')fail();
  const secrets=new Set(),headers=args.headers??{},seen=new Set();if(!headers||typeof headers!=='object'||Array.isArray(headers)||Object.keys(headers).length>12)fail();
  for(const [k,v] of Object.entries(headers)){const lower=k.toLowerCase();if(seen.has(lower)||!/^[a-z][a-z0-9-]{0,40}$/i.test(k)||/^(host|connection|content-length|transfer-encoding|upgrade|expect|trailer|proxy-.*|te)$/i.test(k)||typeof v!=='string'||v.length>512||/[^\x20-\x7e]/.test(v))fail();seen.add(lower);if(!publicHeader.test(k)&&v)secrets.add(v);}
  const body=args.body??'';if(typeof body!=='string'||Buffer.byteLength(body)>4096||method==='HEAD'&&body)fail();const requestBody=body?json(body,secrets):null;
  const wire=Buffer.from(`${method} ${path} HTTP/1.1\r\nHost: ${endpoint}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n${body}`);
  const responses=[];for(let n=0;n<(args.replay?2:1);n++){const r=await exchange(sara,wire,method,deadline);for(const [k,v] of Object.entries(r.headers))if(!publicHeader.test(k)&&sensitive.test(k)&&v)secrets.add(v);responses.push({status:r.status,headers:Object.fromEntries(Object.entries(r.headers).filter(([k])=>publicHeader.test(k))),body:r.body?json(r.body,secrets):null});}
  return result(scrub({ok:true,request:{method,path,headers:Object.fromEntries(Object.entries(headers).map(([k,v])=>[k,publicHeader.test(k)?v:'[REDACTED]'])),body:requestBody},responses,replay:{performed:args.replay===true,count:responses.length,sameStatus:responses.length===2?responses[0].status===responses[1].status:null,sameBody:responses.length===2?JSON.stringify(responses[0].body)===JSON.stringify(responses[1].body):null}},secrets));
 }catch{return result({ok:false,reason:l[3]});}
}
