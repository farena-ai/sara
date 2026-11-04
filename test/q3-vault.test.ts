import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/vault.ts';
test('sealed recovery values authenticate context, version and key without becoming secrets', () => {
 const dir=mkdtempSync(join(tmpdir(),'q3-vault-'));
 try { const v=new Vault(dir); v.set('token','synthetic-secret');
 const a=v.seal('private draft','row:a'); const b=v.seal('private draft','row:a');
 assert.notEqual(a,b); assert.equal(v.unseal(a,'row:a'),'private draft');
 assert.throws(()=>v.unseal(a,'row:b')); assert.throws(()=>v.unseal('v2.'+a.slice(3),'row:a'));
 assert.throws(()=>v.unseal(a.slice(0,-4)+'AAAA','row:a'));
 const otherDir=mkdtempSync(join(tmpdir(),'q3-other-')); const other=new Vault(otherDir,Buffer.alloc(32,7).toString('base64')); rmSync(otherDir,{recursive:true,force:true});
 assert.throws(()=>other.unseal(a,'row:a')); assert.deepEqual(v.values(),['synthetic-secret']);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
