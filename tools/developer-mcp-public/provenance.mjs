// Freeze the actually tested working bytes, not a clean-commit or installer claim.
import {readFileSync,writeFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const root=resolve('.'),out=resolve('outputs/developer-addons/mcp-public'),owned=resolve('tools/developer-mcp-public');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const lock=read(join(owned,'package-lock.json')),pins=read(join(owned,'pins.json')),inspection=read(join(out,'dependency-inspection.json'));
if(hash(join(owned,'package-lock.json'))!==pins.dependencyLockSha256||inspection.lockSha256!==pins.dependencyLockSha256)throw Error('Lock changed');
if(inspection.count!==Object.keys(lock.packages).length-1||inspection.missingLicense.length)throw Error('Incomplete dependency inspection');
const licenses=new Set(['0BSD','Apache-2.0','BSD-2-Clause','BSD-3-Clause','ISC','MIT']);
if(inspection.records.some(r=>!licenses.has(r.license)))throw Error('Unreviewed dependency license');
const semver=createRequire(join(owned,'package.json'))('semver');
const installed=[];for(const [path,pkg] of Object.entries(lock.packages)){
 if(!path)continue;if(pkg.engines?.node&&!semver.satisfies(process.versions.node,pkg.engines.node))throw Error('Engine incompatible: '+path);
 const file=join(owned,path,'package.json');if(!existsSync(file))continue;const actual=read(file);if(actual.version!==pkg.version)throw Error('Installed version differs: '+path);installed.push({path,version:actual.version,license:actual.license,sha256:hash(file)});
}
const files={};function scan(dir){for(const e of readdirSync(dir,{withFileTypes:true})){if(['node_modules','__pycache__','.cache'].includes(e.name))continue;const file=join(dir,e.name);if(e.isDirectory())scan(file);else if(e.isFile())files[relative(root,file).replaceAll('\\','/')]=hash(file);}}
scan(owned);scan(resolve('test/fixtures/developer/mcp-public'));
for(const file of ['test/developer-mcp-public.test.ts','test/developer-mcp-public-host.test.ts','docs/ops/DEVELOPER_MCP_PUBLIC_QUALIFICATION.md'])files[file]=hash(resolve(file));
const receipts={};for(const target of ['terraform','storybook']){const file=join(out,target+'-host-receipt.json');const r=read(file);if(r.featurePassed!==true||!r.cleanup.exited||!r.reconnect.persisted)throw Error('Incomplete runtime receipt '+target);receipts[target]={sha256:hash(file),tools:r.schemas.length,featureCalls:r.calls.length,cleanup:r.cleanup,scope:r.scope};}
const artifacts={};for(const file of ['terraform-bin/terraform-mcp-server.exe','terraform-SHA256SUMS','terraform-mcp-server_1.4.1_windows_amd64.zip','storybook-core.tgz','storybook-addon.tgz','storybook-framework.tgz','inspection/terraform/go.mod','inspection/terraform/go.sum','dependency-inspection.json','source-fetches.json'])artifacts[file]=hash(join(out,file));
if(artifacts['terraform-bin/terraform-mcp-server.exe']!==pins.terraform.binarySha256)throw Error('Binary changed');
const report={schemaVersion:1,claim:'Public fixture execution; not full target readiness, normal chat approval, OS sandbox, signed packaging or installability',node:process.version,platform:process.platform,arch:process.arch,installedCount:installed.length,lockedCount:inspection.count,inspectedArchiveBytes:inspection.bytes,installed,files,artifacts,receipts,installable:false};
writeFileSync(join(out,'provenance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({installed:installed.length,locked:inspection.count,sourceFiles:Object.keys(files).length,receipts:report.receipts,installable:false},null,2));
