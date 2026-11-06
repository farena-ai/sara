import { closed } from './validation.mjs';
import { relativePath } from './paths.mjs';
import { mapOptions } from './repo-map.mjs';
import { labels, LOCALES } from './labels.mjs';
const path={type:'string',minLength:1,maxLength:240,description:'Relative .json file in the explicitly staged snapshot; no links or sensitive paths.'};
const locale={type:'string',enum:LOCALES};
export function tools(localeCode='en') {const l=labels(localeCode);return [
 {name:'contract_diff',description:l.diff,inputSchema:{type:'object',additionalProperties:false,required:['format','before','after'],properties:{format:{type:'string',const:'openapi3'},before:path,after:path,locale}},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},
 {name:'repo_map',description:l.map,inputSchema:{type:'object',additionalProperties:false,properties:{depth:{type:'integer',minimum:1,maximum:12},maxFiles:{type:'integer',minimum:1,maximum:256},locale}},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}
];}
export function validateArgs(name,args) {
 closed(args,name==='contract_diff'?['format','before','after','locale']:name==='repo_map'?['depth','maxFiles','locale']:[]);
 if(args.locale!==undefined && !LOCALES.includes(args.locale)) throw new Error('invalid-locale');
 if(name==='contract_diff') {if(args.format!=='openapi3') throw new Error('invalid-format');relativePath(args.before);relativePath(args.after);if(!args.before.endsWith('.json') || !args.after.endsWith('.json')) throw new Error('json-only');}
 else if(name==='repo_map') {const {locale:_,...options}=args;mapOptions(options);}else throw new Error('unknown-tool');
 return args;
}
