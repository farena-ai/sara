import {rehearse} from './engine.mjs';
import parameters from './schema.json' with {type:'json'};
import labels from './labels.json' with {type:'json'};
export {parameters,labels};
export async function handle(args,lang='en'){
 const l=labels[lang]??labels.en;
 try{
  const report=rehearse(args);report.message=l[report.status];
  const card={title:l.title,lines:[report.message,l.description]},content=JSON.stringify(report);
  if(Buffer.byteLength(content)>46000||Buffer.byteLength(JSON.stringify({v:1,type:'result',id:'r'.repeat(64),content,card}))>60000)throw Error('bounded output');
  return {content,card};
 }catch{throw Error(l.error);}
}
