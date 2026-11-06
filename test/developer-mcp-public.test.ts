import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTerraform, validateStorybook, validatePreviewUrl } from '../tools/developer-mcp-public/boundaries.mjs';
test('public MCP boundaries reject arbitrary tools, endpoints, namespaces and args',()=>{
 const ids=new Set(['123']);
 assert.doesNotThrow(()=>validateTerraform('search_provider_docs',{provider_namespace:'hashicorp',provider_name:'random',provider_version:'3.7.2',service_slug:'string',provider_document_type:'resources'},ids));
 for(const [name,args] of [['apply',{}],['search_provider_docs',{provider_namespace:'other'}],['get_provider_details',{provider_doc_id:'https://evil.invalid'}],['get_provider_details',{provider_doc_id:'999'}],['get_provider_details',{provider_doc_id:'123',url:'https://evil.invalid'}]] as const)assert.throws(()=>validateTerraform(name,args,ids));
 const stories=new Set(['owned-button--primary']);
 assert.doesNotThrow(()=>validateStorybook('stories-preview',{stories:[{storyId:'owned-button--primary'}]},stories,'C:/fixture/Button.js'));
 for(const args of [{stories:[{storyId:'foreign--story'}]},{stories:[{storyId:'owned-button--primary',props:{label:'override'}}]},{stories:[{absoluteStoryPath:'C:/other',exportName:'Primary'}]},{stories:[],url:'https://evil.invalid'}])assert.throws(()=>validateStorybook('stories-preview',args,stories,'C:/fixture/Button.js'));
 assert.throws(()=>validateStorybook('test-run',{},stories,'C:/fixture/Button.js'));
 assert.doesNotThrow(()=>validatePreviewUrl('http://localhost:6006/?path=/story/owned-button--primary',6006,stories));
 for(const url of ['https://evil.invalid/','http://localhost:6007/?path=/story/owned-button--primary','http://localhost:6006/?path=/story/foreign','http://localhost:6006/?path=/story/owned-button--primary&args=x','http://user@localhost:6006/?path=/story/owned-button--primary'])assert.throws(()=>validatePreviewUrl(url,6006,stories));
});
