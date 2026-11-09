import {validate} from './validation.mjs';
import schema from './schema.json' with {type:'json'};
// Bounded synthetic SQLite fixture generator. No SQL parser, disk, network or DB connection.
export function generate(input) {
 validate(input,schema);
 const names=new Set();let total=0;
 for(const t of input.tables){if(names.has(t.name.toLowerCase())||/^sqlite_/i.test(t.name)||['__proto__','prototype','constructor'].includes(t.name))throw Error('duplicate or reserved table');names.add(t.name.toLowerCase());total+=t.rows;const columns=new Set();if(t.columns.filter(c=>c.primaryKey).length>1)throw Error('composite key unsupported');for(const c of t.columns){if(columns.has(c.name.toLowerCase())||['__proto__','prototype','constructor'].includes(c.name))throw Error('duplicate column');columns.add(c.name.toLowerCase());if(c.type==='text'&&(c.min!==undefined||c.max!==undefined||c.primaryKey))throw Error('unsupported text constraint');if(c.type==='integer'&&c.maxLength!==undefined)throw Error('unsupported integer constraint');if((c.min??1)>(c.max??1000000))throw Error('impossible range');if(c.references){const p=input.tables.find(t=>t.name===c.references.table),pc=p?.columns.find(x=>x.name===c.references.column);if(!pc||pc.type!==c.type||!(pc.primaryKey||pc.unique)||pc.references)throw Error('invalid key reference');}}}
 if(total>200)throw Error('row budget');
 let state=input.seed>>>0;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
 const q=s=>'"'+s.replaceAll('"','""')+'"',lit=v=>typeof v==='number'?String(v):"'"+v.replaceAll("'","''")+"'";
 const pending=[...input.tables],ordered=[];
 while(pending.length){const i=pending.findIndex(t=>t.columns.every(c=>!c.references||ordered.some(p=>p.name===c.references.table)));if(i<0)throw new Error('cyclic or missing reference');ordered.push(...pending.splice(i,1));}
 const data={};const sql=['PRAGMA foreign_keys=ON;','BEGIN;'];
 for(const table of ordered){
  const defs=table.columns.map(c=>{let d=q(c.name)+' '+(c.type==='integer'?'INTEGER':'TEXT');if(c.primaryKey)d+=' PRIMARY KEY';if(c.notNull)d+=' NOT NULL';if(c.unique)d+=' UNIQUE';if(c.min!==undefined)d+=' CHECK ('+q(c.name)+'>='+c.min+')';if(c.max!==undefined)d+=' CHECK ('+q(c.name)+'<='+c.max+')';if(c.maxLength!==undefined)d+=' CHECK (length('+q(c.name)+')<='+c.maxLength+')';if(c.references)d+=' REFERENCES '+q(c.references.table)+'('+q(c.references.column)+')';return d;});
  sql.push('CREATE TABLE '+q(table.name)+' ('+defs.join(', ')+');');data[table.name]=[];
  for(let i=0;i<table.rows;i++){
   const row={};for(const c of table.columns){let v;
    if(c.references){const parent=data[c.references.table];if((c.unique||c.primaryKey)&&table.rows>parent.length)throw Error('impossible unique reference');v=parent[c.unique||c.primaryKey?i:next()%parent.length]?.[c.references.column];if(v===undefined)throw new Error('impossible reference');}
    else if(c.type==='integer'){const lo=c.min??1,hi=c.max??1000000;v=c.primaryKey||c.unique?lo+i:lo+next()%(hi-lo+1);if(v>hi)throw new Error('impossible unique range');}
    else {v='s'+input.seed.toString(36)+'_'+next().toString(36)+'_'+i;if(v.length>(c.maxLength??64))throw new Error('impossible string bound');}
    if(c.type==='integer'&&(v<(c.min??-1000000)||v>(c.max??1000000)))throw Error('reference outside bounds');
    if((c.primaryKey||c.unique)&&data[table.name].some(r=>r[c.name]===v))throw Error('duplicate generated key');
    if(c.type==='text'&&v.length>(c.maxLength??80))throw Error('text bound');
    row[c.name]=v;
   }data[table.name].push(row);sql.push('INSERT INTO '+q(table.name)+' ('+table.columns.map(c=>q(c.name)).join(',')+') VALUES ('+table.columns.map(c=>lit(row[c.name])).join(',')+');');
  }
 }
 sql.push('COMMIT;');return {synthetic:true,dialect:'sqlite',seed:input.seed,tables:data,sql:sql.join('\n')};
}
