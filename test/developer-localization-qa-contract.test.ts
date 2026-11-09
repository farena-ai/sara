import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
test('published schema states combined host cap, distinct units and literal printf scope',()=>{
 const schema=JSON.parse(readFileSync('store/plugins/localization-qa/schema.json','utf8'));
 assert.match(schema.description,/65,536.*UTF-16/);assert.match(schema.description,/180,000.*UTF-8/);assert.match(schema.description,/escaping.*evidence/);
 assert.match(schema.properties.base.description,/24,000 UTF-8 bytes/);assert.match(schema.properties.base.description,/UTF-16/);assert.match(schema.properties.base.description,/Unicode code points/);
 assert.match(schema.properties.grammar.description,/%s.*%d.*literal.*not validated/);
});
