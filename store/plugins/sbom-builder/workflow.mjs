import { build as analyze } from './engine.mjs';
import { validate } from './validation.mjs';
import labels from './labels.json' with {type:'json'};
import parameters from './schema.json' with {type:'json'};
export { labels, parameters };
export async function handle(args,lang='en') {
 const l=labels[lang]??labels.en;
 try {
  validate(args,parameters);
  const report=analyze(args); report.message=l.message; report.scope=l.scope;
  const n=report.findings?.length??report.packages?.length??report.bom?.components?.length??Number(report.verified);
  const content=JSON.stringify(report);
  const card={title:l.title,lines:[l.summary.replace('{n}',String(n)).replace('{status}',report.status),l.scope.slice(0,200)]};
  if(Buffer.byteLength(content)>48000||Buffer.byteLength(JSON.stringify({v:1,type:'result',id:'r'.repeat(64),content,card}))>60000) throw new Error('limit');
  return {content,card};
 } catch { throw new Error(l.error); }
}
