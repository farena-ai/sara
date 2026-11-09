import test from 'node:test';
import assert from 'node:assert/strict';
test('coverage refuses invalid contradictory hostile and out-of-source records; missing is not covered',async()=>{
 const {analyzeCoverage}=await import('../tools/developer-evidence/coverage.mjs');
 const base={sources:[{path:'a.js',text:'if (x) yes();\nelse no();'}],changes:[{path:'a.js',start:1,end:2}]};
 const missing=analyzeCoverage({...base,lcov:'SF:a.js\nDA:1,1\nend_of_record'});assert.equal(missing.files[0].branchStatus,'missing');assert.equal(missing.complete,false);
 for(const lcov of ['SF:../a.js\nend_of_record','BRDA:1,0,0,1','SF:a.js\nBRDA:9,0,0,0\nend_of_record','SF:a.js\nBRDA:1,0,0,-2\nend_of_record','SF:a.js\nBRDA:1,0,0,0\nBRDA:1,0,0,1\nend_of_record','SF:a.js\nBRDA:1,0,0,0\nBRF:2\nend_of_record','SF:a.js\nDA:1,1'])assert.throws(()=>analyzeCoverage({...base,lcov}),/Invalid supplied coverage/);
 assert.throws(()=>analyzeCoverage({...base,lcov:'SF:a.js\nend_of_record',changes:[{path:'a.js',start:2,end:1}]}),/Invalid supplied coverage/);
});
