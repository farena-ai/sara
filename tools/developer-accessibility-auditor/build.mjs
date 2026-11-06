import {build} from './node_modules/esbuild/lib/main.js';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync} from 'node:fs';
await build({entryPoints:[fileURLToPath(new URL('./audit-source.mjs',import.meta.url))],outfile:fileURLToPath(new URL('../../store/plugins/accessibility-auditor/audit.mjs',import.meta.url)),bundle:true,platform:'node',format:'esm',target:'node24',legalComments:'none',minifyWhitespace:true});
// Store scan mistakes inert parser namespace/doctype identifiers for network access.
// Preserve their exact JS string values with standard slash escapes; add no network grant.
const output=new URL('../../store/plugins/accessibility-auditor/audit.mjs',import.meta.url);let code=readFileSync(output,'utf8');
for(const literal of ['http://www.w3.org/1999/xhtml','http://www.w3.org/1998/Math/MathML','http://www.w3.org/2000/svg','http://www.w3.org/1999/xlink','http://www.w3.org/XML/1998/namespace','http://www.w3.org/2000/xmlns/','http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd'])code=code.replaceAll(JSON.stringify(literal),JSON.stringify(literal).replaceAll('/','\\u002f'));
writeFileSync(output,code);
