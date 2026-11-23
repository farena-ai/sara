// Z3: runToolCall (src/chat.ts) is the tool executor taken out of runTurnInner. It may use the turn's
// state only through `env` (ToolCallEnv). The compiler enforces that for every name except one kind: a
// turn variable whose name is ALSO a global (a browser or Node global), which compiles and then fails
// at run time. That happened once (`external`, found by the tests, never shipped). This test keeps
// that class out: no variable of runTurnInner that shares its name with a global is used bare in
// runToolCall. It reads the source because the thing it guards is how the source is written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const src = readFileSync(join(ROOT, 'src', 'chat.ts'), 'utf8');
const lines = src.split('\n');
const block = (head: string): string => {
  const a = lines.findIndex((l) => l.startsWith(head));
  assert.ok(a >= 0, `${head} exists`);
  const b = lines.findIndex((l, i) => i > a && l === '}');
  return lines.slice(a + 1, b).join('\n');
};

// Browser globals that are plain words someone might name a variable (lib.dom declares them), plus Node's.
const DOM_WORDS = ['external', 'name', 'status', 'event', 'origin', 'top', 'parent', 'self', 'length', 'closed', 'history', 'location', 'screen', 'opener', 'frames', 'focus', 'blur', 'close', 'stop', 'open', 'print', 'find', 'scroll', 'confirm', 'alert', 'prompt', 'caches', 'crypto', 'performance', 'navigator', 'document', 'window'];
const GLOBALS = new Set([...DOM_WORDS, ...Object.getOwnPropertyNames(globalThis)]);

test('Z3 tool call: no turn variable that is also a global is used bare in runToolCall', () => {
  const turn = block('async function* runTurnInner(');
  const call = block('async function* runToolCall(');
  const declared = new Set<string>();
  for (const m of turn.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]!);
  for (const m of turn.matchAll(/\bfunction\*?\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]!);
  const risky = [...declared].filter((n) => GLOBALS.has(n));
  assert.ok(risky.includes('external'), 'the known case is still a turn variable (if it was renamed, this list just gets shorter)');
  // Comments and strings are words, not code: leave them out before looking for bare uses.
  const code = call
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, (t) => t.replace(/[^${}]*?(?=\$\{|`$)/g, '').replace(/^`|`$/g, ''))
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''");
  const localIn = (n: string) => new RegExp(`\\b(?:const|let|var)\\s+${n}\\b|[(,]\\s*${n}\\s*[,):=]|\\b${n}\\s*=>`).test(code);
  const bare = risky.filter((n) => !localIn(n) && new RegExp(`(?<![.\\w$])${n}\\b(?!\\s*:(?!:))`).test(code));
  assert.deepEqual(bare, [], 'these read a global instead of the turn’s variable: route them through env');
});

test('Z3 tool call: the turn hands over its state through env, and only there', () => {
  assert.match(src, /^interface ToolCallEnv \{$/m);
  assert.match(src, /const oneCall = \(call: ToolCall, callIdx: number, parent\?: string\): AsyncGenerator<ChatEvent, CallEnd> => runToolCall\(env, call, callIdx, parent\);/);
  const call = block('async function* runToolCall(');
  assert.ok(call.split('\n').length > 500, 'the executor lives in runToolCall');
  const turn = block('async function* runTurnInner(');
  assert.ok(turn.split('\n').length < 1950, `runTurnInner stays split (${turn.split('\n').length} lines)`);
  // What a call may change is written down: the properties without readonly.
  const iface = block('interface ToolCallEnv {');
  const writable = [...iface.matchAll(/^  (?!readonly |\/\/|\/\*\*| \*)([A-Za-z]\w*)[?]?:/gm)].map((m) => m[1]).sort();
  assert.deepEqual(writable, ['attachedThisTurn', 'outsideWords', 'peerAnswered', 'projectRefDue', 'stopCmd', 'tools', 'toolsBeforePause', 'wsDir']);
});
