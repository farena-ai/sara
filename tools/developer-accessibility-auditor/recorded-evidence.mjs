// Closed, recursive publication schema. Never spread private receipt/log objects.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const text='string',number='number',bool='boolean';
const element={tag:text,ordinal:number,line:number,column:number,offset:number,endOffset:number};
const finding={rule:text,status:text,element};
const report={mode:text,coverage:text,sourceSha256:text,sourceUnits:number,nodeCount:number,findings:[finding],unsupported:[text],limitations:[text]};
const match={rule:text,axeRule:text,tag:text,ordinal:number,rect:{x:number,y:number,width:number,height:number},visible:bool,axeTargetVerified:bool};
const baseline={viewport:text,width:number,height:number,variant:text,sourceSha256:text,structural:[finding],oracle:{version:text,violations:[{id:text,nodes:[{target:[text]}]}]},matches:[match],screenshotSha256:text};
const naming={id:text,viewport:text,sourceSha256:text,html:text,structural:report,oracle:{accessibleText:text,violations:[{id:text,targets:[[text]]}]},ariaSnapshot:text,screenshotSha256:text};
const schema={playwright:text,axe:text,axeSourceSha256:text,browserVersion:text,revision:text,sandbox:bool,noPersonalProfile:bool,serviceWorkers:text,requests:number,contextsClosed:number,browserClosed:bool,captureSourceSha256:text,projectionSourceSha256:text,namingCasesSha256:text,namingRecords:[naming],records:[baseline]};
function project(value,shape){
 if(typeof shape==='string'){assert.equal(typeof value,shape);if(shape==='number')assert.ok(Number.isFinite(value));return value;}
 if(Array.isArray(shape)){assert.ok(Array.isArray(value));return value.map(v=>project(v,shape[0]));}
 assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return Object.fromEntries(Object.entries(shape).map(([key,type])=>[key,project(value[key],type)]));
}
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function recordedEvidence(privateBytes){
 const privateEvidence=JSON.parse(privateBytes.toString()),evidence=project(privateEvidence,schema);
 assert.equal(evidence.sandbox,true);assert.equal(evidence.noPersonalProfile,true);assert.equal(evidence.requests,0);assert.equal(evidence.contextsClosed,22);assert.equal(evidence.browserClosed,true);assert.equal(evidence.records.length,4);assert.equal(evidence.namingRecords.length,18);
 return {schemaVersion:1,kind:'recorded-owned-browser-observations',freshCapture:false,provenance:{sourceEvidenceSha256:sha256(privateBytes),captureSourceSha256:evidence.captureSourceSha256,projectionSourceSha256:evidence.projectionSourceSha256},evidence};
}
