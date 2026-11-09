// Synthetic review cases shared by permission-limited channels and real manager execution.
import {fixtureArgs} from './fixtures.mjs';
export function reviewCases(id){
 const base=()=>({...fixtureArgs(id),...(id==='log-explorer'?{query:'incident'}:{})}),cases=[];
 if(id==='log-explorer'){
  for(const [raw,decoded] of [[String.raw`prefix\"猫tail`,'prefix"猫tail'],[String.raw`folder\\secret`,'folder\\secret'],[String.raw`prefix\u732btail`,'prefix猫tail']])cases.push({args:{...base(),files:[{path:'setup',format:'line',text:'password="'+raw+'"'},{path:'event',format:'line',text:'2026-11-05T10:00:00Z incident '+decoded+' '+raw}]},absent:[raw,decoded]});
  cases.push({args:{...base(),files:[{path:'setup',format:'jsonl',text:'{"password":"private_path","message":"setup"}'},{path:'private_path.log',format:'line',text:'2026-11-05T10:00:00Z incident private_path'}]},absent:['private_path']});
  for(const text of ['{"password":"firstsecret","password":"secondsecret"}',String.raw`{"password":"firstsecret","pass\u0077ord":"secondsecret"}`,'password="bad\\q"','password="bad\\"'])cases.push({args:{...base(),files:[{path:'firstsecret.log',format:'line',text}]},refuse:true,absent:['firstsecret','secondsecret','bad']});
 }
 if(id==='incident-workbench'){
  const event=(event,timestamp)=>JSON.stringify({event,timestamp,incident:'i'});
  cases.push({args:{...base(),incident:'i',sensitiveValues:['11'],files:[{path:'b',kind:'alert',text:event('second','2026-11-05T11:00:00Z')},{path:'a',kind:'deployment',text:event('first','2026-11-05T11:00:00+01:00')}]},events:['first','second']});
  cases.push({args:{...base(),incident:'i',files:[{path:'a',kind:'operator-note',text:event('password="prefix\\\"猫tail"','2026-11-05T10:00:00Z')},{path:'b',kind:'alert',text:event('incident prefix"猫tail','2026-11-05T11:00:00Z')}]},absent:['prefix"猫tail',String.raw`prefix\"猫tail`]});
  cases.push({args:{...base(),files:[{path:'firstsecret.log',kind:'alert',text:'{"incident":"x","incident":"y","event":"firstsecret"}'}]},refuse:true,absent:['firstsecret']});
 }
 if(id==='environment-config-doctor'){
  for(const [format,text] of [['json','{"TOKEN":"x","TOKEN":"synthetic-good"}'],['json',String.raw`{"TOKEN":"x","T\u004fKEN":"synthetic-good"}`],['dotenv','TOKEN="bad"tail"'],['dotenv',String.raw`TOKEN="bad\"`]])cases.push({args:{format,text,rules:[{name:'TOKEN',type:'string',secret:true,required:true,minLength:4}]},refuse:true,absent:['synthetic-good','TOKEN','bad']});
 }
 if(id==='coverage-explorer'){const args=base();cases.push({args:{...args,lcov:args.lcov.replace(/FNF:\d+/,'FNF:0').replace(/FNH:\d+/,'FNH:99')},refuse:true});}
 return cases;
}
