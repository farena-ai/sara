import {analyze} from './engine.mjs';
import parameters from './schema.json' with {type:'json'};
import labels from './labels.json' with {type:'json'};
export {parameters,labels};
export function handle(args,lang='en'){
 const l=labels[lang]??labels.en;
 try{const report=analyze(args);report.message=report.status==='findings'?l.findings:l.checked;report.layoutMessage=report.layout==='measured'?l.measured:l.unmeasured;
 const card={title:l.title,lines:[report.message,report.layoutMessage,l.description]},content=JSON.stringify(report);
 if(Buffer.byteLength(content)>46000||Buffer.byteLength(JSON.stringify({v:1,type:'result',id:'r'.repeat(64),content,card}))>60000)throw Error('Bounded result');
 return {content,card};
 }catch{throw Error(l.error);}
}
