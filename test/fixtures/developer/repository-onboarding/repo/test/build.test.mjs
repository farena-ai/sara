import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from '../src/cards.mjs';

test('render fills the card', () => {
  assert.equal(render('<b>{{city}}</b>', { city: 'Oslo' }), '<b>Oslo</b>');
});
