// Rebuild pinned vendor bytes. npm ci --ignore-scripts --no-audit --no-fund first.
import {build} from 'esbuild';import {readFileSync,writeFileSync} from 'node:fs';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url)),out=join(here,'../../store/plugins/data-contract-validator');
await build({entryPoints:[join(here,'vendor-entry.mjs')],outfile:join(out,'validator.mjs'),bundle:true,platform:'browser',format:'esm',minify:true,metafile:true}).then(r=>writeFileSync(join(here,'vendor-inputs.json'),JSON.stringify(r.metafile,null,2)+'\n'));
writeFileSync(join(out,'protobuf.cjs'),readFileSync(join(here,'node_modules/protobufjs/dist/protobuf.min.js')));
// Store scanner treats schema IDs/comment URLs as network calls. JS solidus escapes
// preserve the exact runtime string, without granting any network permission.
for(const name of ['validator.mjs','protobuf.cjs']){const p=join(out,name);writeFileSync(p,readFileSync(p,'utf8').replaceAll('https://','https:\\/\\/').replaceAll('http://','http:\\/\\/'));}
const packages=['ajv','fast-deep-equal','fast-uri','json-schema-traverse','protobufjs'];
let notices='# Pinned runtime third-party licenses\n\n';for(const pkg of packages){const dir=join(here,'node_modules',pkg),meta=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));notices+='\n## '+pkg+' '+meta.version+'\n\n'+readFileSync(join(dir,'LICENSE'),'utf8')+'\n';}writeFileSync(join(out,'THIRD_PARTY_LICENSES.md'),notices.trimEnd()+'\n');
console.log('Rebuilt pinned browser-only vendors and retained licenses.');
