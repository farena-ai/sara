import {readFileSync} from 'node:fs';
export const ids=['coverage-explorer','log-explorer','incident-workbench','environment-config-doctor'];
export function fixtureArgs(id){
 if(id==='coverage-explorer')return {lcov:readFileSync(new URL('../../test/fixtures/developer/evidence/instrumented.lcov',import.meta.url),'utf8'),sources:[{path:'branch.mjs',text:readFileSync(new URL('../../test/fixtures/developer/evidence/branch.mjs',import.meta.url),'utf8')}],changes:[{path:'branch.mjs',start:2,end:6}]};
 if(id==='log-explorer')return {files:[{path:'api.log',format:'line',text:'2026-11-05T10:00:00Z ERROR INC42 timeout password=synthetic'}],query:'INC42',sensitiveValues:[],limit:10};
 if(id==='incident-workbench')return {files:[{path:'deploy.jsonl',kind:'deployment',text:'{"timestamp":"2026-11-05T10:00:00Z","incident":"INC42","event":"deployed r2"}'}],incident:'INC42',sensitiveValues:[],limit:10};
 return {format:'dotenv',text:'PORT=not-a-number',rules:[{name:'PORT',type:'integer',required:true,secret:false,min:1,max:65535}]};
}
