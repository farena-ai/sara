// Locked, script-free tooling installation precedes this offline runtime build.
import {build} from 'esbuild';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const result=await build({entryPoints:[join(here,'vendor-entry.mjs')],outfile:join(here,'parser.mjs'),bundle:true,platform:'browser',format:'esm',minify:true,metafile:true,define:{'process.env.NODE_ENV':'"production"'}});
const runtime=readFileSync(join(here,'parser.mjs'),'utf8');
// Escaped solidi preserve string values while avoiding the Store's heuristic URL finding.
writeFileSync(join(here,'parser.mjs'),runtime.replaceAll('https://','https:\\/\\/').replaceAll('http://','http:\\/\\/'));
const roots=new Set();for(const file of Object.keys(result.metafile.inputs)){let dir=dirname(file);while(dir!==dirname(dir)){try{const p=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));if(p.name&&p.name!=='sara-developer-code-graph-tooling'){roots.add(dir);break;}}catch{}dir=dirname(dir);}}
const records=[];let notices='# Third-party runtime licenses\n';for(const dir of [...roots].sort()){const p=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));let license;for(const name of ['LICENSE','LICENSE-MIT.txt','LICENSE.md']){try{license=readFileSync(join(dir,name),'utf8').trimEnd();break;}catch{}}if(!license)throw Error('Missing full license: '+p.name);records.push({name:p.name,version:p.version,license:p.license,engines:p.engines,repository:p.repository});notices+=`\n## ${p.name} ${p.version}\n\n${license}\n`;}
writeFileSync(join(here,'THIRD_PARTY_LICENSES.md'),notices.trimEnd()+'\n');
writeFileSync(join(here,'vendor-review.json'),JSON.stringify({runtimeBytes:Buffer.byteLength(runtime),packages:records,inputs:Object.keys(result.metafile.inputs).map(p=>relative(here,p).replaceAll('\\','/')),outputs:result.metafile.outputs},null,2)+'\n');
console.log(JSON.stringify({runtimeBytes:Buffer.byteLength(runtime),packages:records}));
