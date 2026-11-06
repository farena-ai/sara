// Reproduce the three inspected, locked SPDX sources as package-local files.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const here=dirname(fileURLToPath(import.meta.url));
const vendor=join(here,'../../store/plugins/license-auditor/vendor'); mkdirSync(vendor,{recursive:true});
const source=join(here,'node_modules');
for(const f of ['index','scan','parse']) {
 let text=readFileSync(join(source,'spdx-expression-parse',f+'.js'),'utf8');
 text=text.replace("require('./scan')","require('./scan.cjs')").replace("require('./parse')","require('./parse.cjs')").replace("require('spdx-license-ids')","require('./licenses.json')").replace("require('spdx-license-ids/deprecated')","require('./deprecated.json')").replace("require('spdx-exceptions')","require('./exceptions.json')");
 writeFileSync(join(vendor,f+'.cjs'),text);
}
for(const [pkg,file,target] of [['spdx-license-ids','index.json','licenses.json'],['spdx-license-ids','deprecated.json','deprecated.json'],['spdx-exceptions','index.json','exceptions.json'],['spdx-expression-parse','LICENSE','LICENSE-parser'],['spdx-expression-parse','AUTHORS','AUTHORS'],['spdx-exceptions','README.md','NOTICE-exceptions.md'],['spdx-license-ids','README.md','NOTICE-licenses.md']]) copyFileSync(join(source,pkg,file),join(vendor,target));
console.log('Vendored SPDX parser4.0.0 / IDs3.0.24 / exceptions2.5.0; only local require targets changed.');
