import {analyzeCoverage} from './coverage.mjs';
import {validate} from './validate.mjs';
import labels from './labels.json' with {type:'json'};
import parameters from './parameters.json' with {type:'json'};
export {labels,parameters};
export async function handle(args,lang='en'){const l=labels[lang]??labels.en;try{validate(args,parameters);const report={scope:l.scope,summary:l.summary,...analyzeCoverage(args)};const result={content:JSON.stringify(report),card:{title:l.title,lines:[l.summary,l.scope,l.count+': '+(report.branches?.length??report.totalMatches??report.totalEvents??report.checked)]}};if(Buffer.byteLength(JSON.stringify(result),'utf8')>30000)throw Error();return result;}catch{throw new Error(l.error);}}
