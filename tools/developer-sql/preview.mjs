import {writeFileSync,mkdirSync} from 'node:fs';
import {handle} from '../../store/plugins/sql-migration-reviewer/workflow.mjs';
const args={baseline:{tables:[{name:'items',columns:[{name:'id',type:'INTEGER'},{name:'label',type:'TEXT'}],rows:3}]},sql:'CREATE TABLE archive (id INTEGER, label TEXT); CREATE INDEX items_id ON items (id);'};
const safe=await handle(args),unsafe=await handle({...args,sql:'DROP TABLE items;'});
mkdirSync('test/fixtures/developer/sql',{recursive:true});writeFileSync('test/fixtures/developer/sql/acceptance.json',JSON.stringify({synthetic:true,args,safe:JSON.parse(safe.content),unsafe:JSON.parse(unsafe.content)},null,2)+'\n');
mkdirSync('outputs/developer-addons/sql',{recursive:true});writeFileSync('outputs/developer-addons/sql/preview.json',JSON.stringify({safe,unsafe},null,2)+'\n');
