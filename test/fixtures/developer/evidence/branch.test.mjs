import test from 'node:test';
import assert from 'node:assert/strict';
import {classify} from './branch.mjs';
test('positive only leaves a genuinely untested branch',()=>assert.equal(classify(1),'positive'));
