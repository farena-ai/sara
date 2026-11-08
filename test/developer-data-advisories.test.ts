// Data Contract Validator 1.0.1: the shipped protobufjs/Ajv bundles carry the advisory fixes.
// Library probes run in a child Node with a timeout, so a vulnerable bundle fails the test instead
// of running injected code in, or hanging, the test process.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {analyze} from '../store/plugins/data-contract-validator/engine.mjs';

const dir = join(import.meta.dirname, '../store/plugins/data-contract-validator');
const protobuf = pathToFileURL(join(dir, 'protobuf.cjs')).href;
const probe = (body: string) => {
  const code = `import pb from ${JSON.stringify(protobuf)};globalThis.CANARY=0;try{${body}}catch(e){console.log('threw',String(e.message).slice(0,120))}console.log('canary',globalThis.CANARY);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {encoding: 'utf8', timeout: 10_000});
  return {timedOut: r.error !== undefined || r.signal !== null, out: r.stdout};
};

test('shipped bundles are protobufjs 7.6.6 and Ajv 8.18.0; the old versions are gone', () => {
  const pb = readFileSync(join(dir, 'protobuf.cjs'), 'utf8'), ajv = readFileSync(join(dir, 'validator.mjs'), 'utf8');
  assert.match(pb.slice(0, 200), /protobuf\.js v7\.6\.6/);
  assert.match(readFileSync(join(dir, 'THIRD_PARTY_LICENSES.md'), 'utf8'), /## ajv 8\.18\.0[\s\S]*## protobufjs 7\.6\.6/);
  for (const name of ['protobuf.cjs', 'validator.mjs', 'engine.mjs', 'proto.mjs', 'README.md', 'THIRD_PARTY_LICENSES.md', 'sara-plugin.json']) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.doesNotMatch(text, /\b7\.5\.4\b|\b8\.17\.1\b/, name);
  }
  // Ajv < 8.18.0 compiled $data patterns as an unguarded `(new RegExp(...)).test(...)` (CVE-2025-69873).
  assert.ok(!ajv.includes('`(new RegExp(${'), 'old Ajv $data pattern code');
  assert.equal(JSON.parse(readFileSync(join(dir, 'sara-plugin.json'), 'utf8')).version, '1.0.1');
});

test('CVE-2026-41242: a crafted descriptor type name does not reach generated code', () => {
  // On protobufjs 7.5.4 this encodes successfully and sets the canary to 1.
  const r = probe(`const n='a(){},globalThis.CANARY=1,function z';const root=pb.Root.fromJSON({nested:{[n]:{fields:{a:{type:'int32',id:1}}}}});const T=root.lookupType(n);T.encode({a:1}).finish();T.verify({a:1});`);
  assert.equal(r.timedOut, false);
  assert.match(r.out, /canary 0/);
});

test('GHSA-j3f2-48v5-ccww: a truncated .proto option ends instead of looping', () => {
  // protobufjs 7.5.0-7.6.4 never return here.
  for (const text of ['syntax = "proto3"; option foo', 'syntax = "proto3"; message M { int32 a = 1 [foo']) {
    const r = probe(`pb.parse(${JSON.stringify(text)});`);
    assert.equal(r.timedOut, false, text);
    assert.match(r.out, /threw illegal end of input/, text);
  }
  // The add-on itself refuses options before parsing.
  assert.throws(() => analyze({format: 'protobuf', before: 'syntax = "proto3"; message Item { int32 a = 1; } option (x', after: 'syntax = "proto3"; message Item { int32 a = 1; }', message: 'Item', payloads: ['{}']}), /unsupported proto construct/);
});

test('GHSA-f38q-mgvj-vph7: a field named hasOwnProperty is handled through the add-on', () => {
  // protobufjs 7.5.4 threw "duplicate name 'hasOwnProperty'" while parsing this schema.
  const proto = 'syntax = "proto3"; message Item { int32 hasOwnProperty = 1; string name = 2; }';
  const r = analyze({format: 'protobuf', before: proto, after: proto, message: 'Item', payloads: ['{"hasOwnProperty":1,"name":"a"}', '{"hasOwnProperty":"x"}']});
  assert.equal(r.compatible, true);
  assert.deepEqual(r.payloads.map((p: any) => p.valid), [true, false]);
  assert.equal(r.validator, 'protobufjs 7.6.6 / bounded flat scalar+enum subset');
});
