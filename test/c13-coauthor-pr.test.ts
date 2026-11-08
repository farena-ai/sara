// C13 (docs/ops/C13_DESIGN.md): her commits carry a Co-authored-by trailer (configurable; default
// the companion's name with a noreply address), and the pull-request helper drafts a title and
// body from the branch's commits and diff stat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coAuthorOf, draftPullRequest, mergeCoAuthor, withCoAuthor } from '../src/coding-depth.ts';

test('the default co-author is the companion with a noreply address', () => {
  assert.deepEqual(coAuthorOf(undefined, 'Sara'), { on: true, name: 'Sara', email: 'sara@noreply.sara.invalid' });
  assert.deepEqual(coAuthorOf(undefined, 'Nova Bright'), { on: true, name: 'Nova Bright', email: 'nova-bright@noreply.sara.invalid' });
  assert.deepEqual(coAuthorOf({ on: true, name: 'Robo', email: 'robo@example.com' }, 'Sara'), { on: true, name: 'Robo', email: 'robo@example.com' });
  assert.equal(coAuthorOf({ on: false }, 'Sara').on, false);
});

test('mergeCoAuthor keeps only clean values', () => {
  const m = mergeCoAuthor({ on: true, name: '', email: '' }, { on: false, name: ' Ada\n<x> ', email: 'not an email' });
  assert.equal(m.on, false);
  assert.equal(m.name, 'Ada x');
  assert.equal(m.email, '');
  assert.equal(mergeCoAuthor(m, { email: 'ada@example.com' }).email, 'ada@example.com');
});

test('withCoAuthor appends one trailer, after a blank line, never twice', () => {
  const who = { on: true, name: 'Sara', email: 'sara@noreply.sara.invalid' };
  assert.equal(withCoAuthor('Fix the thing', who), 'Fix the thing\n\nCo-authored-by: Sara <sara@noreply.sara.invalid>');
  const once = withCoAuthor('Fix\n\nBody text\n', who);
  assert.equal(once, 'Fix\n\nBody text\n\nCo-authored-by: Sara <sara@noreply.sara.invalid>');
  assert.equal(withCoAuthor(once, who), once);
  assert.equal(withCoAuthor('Fix', { ...who, on: false }), 'Fix');
  // Another trailer already there: hers joins the trailer block.
  assert.equal(withCoAuthor('Fix\n\nSigned-off-by: Alex <alex@example.com>', who), 'Fix\n\nSigned-off-by: Alex <alex@example.com>\nCo-authored-by: Sara <sara@noreply.sara.invalid>');
});

test('draftPullRequest: title from one commit or the branch, body with commits and files', () => {
  const one = draftPullRequest({ branch: 'sara/add-greeting', base: 'main', commits: ['Add a greeting to the home page'], stat: ' web/home.js | 3 +++\n 1 file changed, 3 insertions(+)', task: 'Add a greeting', by: 'Sara' });
  assert.equal(one.title, 'Add a greeting to the home page');
  assert.match(one.body, /## Summary\n\nAdd a greeting/);
  assert.match(one.body, /- Add a greeting to the home page/);
  assert.match(one.body, /web\/home\.js \| 3 \+\+\+/);
  assert.match(one.body, /Drafted by Sara/);
  const many = draftPullRequest({ branch: 'sara/fix-login-flow', base: 'main', commits: ['Fix token check', 'Add test', 'Co-authored-by: X <x@y>'], stat: '', by: 'Sara' });
  assert.equal(many.title, 'Fix login flow');
  assert.ok(!/Co-authored-by: X/.test(many.body.split('## Commits')[1]?.split('\n').filter((l) => l.startsWith('- ')).join('\n') ?? ''));
  assert.ok(many.title.length <= 72);
  assert.ok(draftPullRequest({ branch: 'x', base: 'main', commits: ['y'.repeat(300)], stat: '', by: 'Sara' }).title.length <= 72);
});
