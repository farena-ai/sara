// N1 (docs/design/NEXT.md "Did it work?"): a read-back after every changing tool, one line in its
// result ("Verified: ..." / "Could not verify: ..."), none for read-only tools; "done / saved / sent /
// added / filled" claims need a verified receipt, else the gentle correction.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkClaims, correctionNote, type Receipt } from '../src/receipts.ts';
import { verifyAction, verifyState } from '../src/verify-action.ts';

const ws = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'n1v-'));
test.after(() => rmSync(ws, { recursive: true, force: true }));

test('write_file: read back with a hash; a different file on disk is not verified', async () => {
  writeFileSync(join(ws, 'a.txt'), 'hello');
  const good = await verifyAction('write_file', { path: 'a.txt', content: 'hello' }, 'Wrote 5 bytes to a.txt.', { wsDir: ws });
  assert.match(good!, /^Verified: read a\.txt back \(5 bytes, sha256 [0-9a-f]{12}\), the same as written\.$/);
  const bad = await verifyAction('write_file', { path: 'a.txt', content: 'other' }, 'Wrote 5 bytes to a.txt.', { wsDir: ws });
  assert.match(bad!, /^Could not verify: a\.txt reads back different/);
  const gone = await verifyAction('write_file', { path: 'missing.txt', content: 'x' }, 'Wrote 1 bytes.', { wsDir: ws });
  assert.match(gone!, /^Could not verify: the read-back failed/);
});

test('edit_file: the new text is there when read back', async () => {
  writeFileSync(join(ws, 'b.ts'), 'const x = 2;\n');
  assert.match((await verifyAction('edit_file', { path: 'b.ts', old_string: '1', new_string: 'x = 2' }, 'Edited b.ts (1 replacement).', { wsDir: ws }))!, /^Verified: read b\.ts back/);
  assert.match((await verifyAction('edit_file', { path: 'b.ts', old_string: '1', new_string: 'y = 3' }, 'Edited b.ts.', { wsDir: ws }))!, /^Could not verify: the new text is not in b\.ts/);
});

test('fill_document / make_document / invoice_make reuse their own report and the saved document', async () => {
  const all = 'Filled 5 of 5 fields.\nSaved the filled copy as “x.xlsx”, document #3; the original is unchanged. Tell them in a sentence that it is filled in.';
  assert.match((await verifyAction('fill_document', {}, all))!, /^Verified: the filled copy was read back/);
  const part = "Filled 3 of 5.\nSaved ..., document #4. Don't say the form is filled: say which fields are not filled";
  assert.match((await verifyAction('fill_document', {}, part))!, /^Could not verify: not every field is filled/);
  assert.match((await verifyAction('fill_document', {}, 'x\nNothing was filled, so no copy was made.'))!, /^Could not verify: nothing was filled/);
  const doc = (id: number) => (id === 7 ? { name: 'Plan.docx' } : undefined);
  assert.equal(await verifyAction('make_document', {}, 'Made “Plan” as a Word document (Plan.docx, 4 KB), document #7.', { madeDoc: doc }), 'Verified: document #7 is saved ("Plan.docx").');
  assert.match((await verifyAction('invoice_make', {}, 'Invoice 12 “inv.pdf” (PDF, document #8)', { madeDoc: doc }))!, /^Could not verify: document #8 is not in her documents/);
});

test('mail and calendar: their own read-back line is kept; none means not verified', async () => {
  assert.equal(await verifyAction('gmail_draft', {}, 'Saved as a draft in Gmail (draft r1).\nVerified: read the draft back from Gmail (id r1).'), undefined);
  assert.match((await verifyAction('mail_send', {}, 'Sent from a@x to b@y.'))!, /^Could not verify: the mail service gave no id/);
  assert.match((await verifyAction('calendar_add', {}, 'Added “Dentist” (event e1).'))!, /^Could not verify:/);
});

test('planner add, setting change, pc_run exit code, desktop fresh look', async () => {
  const task = (id: number) => (id === 12 ? { id: 12, title: 'Call the plumber', status: 'open' } : undefined);
  assert.equal(await verifyAction('todo', { action: 'add' }, 'Added task #12 [ ] Call the plumber.', { task }), 'Verified: read task #12 back from the planner ("Call the plumber", open).');
  assert.match((await verifyAction('todo', { action: 'add' }, 'Added task #13.', { task }))!, /^Could not verify: task #13 is not in the planner/);
  assert.equal(await verifyAction('todo', { action: 'list' }, 'No tasks.', { task }), undefined);
  assert.equal(await verifyAction('change_setting', { setting: 'name', value: 'Pat' }, 'Changed: Your name is now "Pat". Saved. From now on call them Pat.', { ownerName: () => 'Pat' }), 'Verified: the saved name reads "Pat".');
  assert.match((await verifyAction('change_setting', { setting: 'name' }, 'Changed: Your name is now "Pat". From now on call them Pat.', { ownerName: () => 'Alex' }))!, /^Could not verify/);
  assert.equal(await verifyAction('pc_run', {}, 'Ran on Desk (powershell, 1 s): exit code 0.\n...'), 'Verified: exit code 0.');
  assert.equal(await verifyAction('pc_run', {}, 'Ran on Desk (powershell, 1 s): exit code 2.'), 'Could not verify: exit code 2 (not 0).');
  assert.match((await verifyAction('pc_run', {}, 'Timed out after 60 s on Desk: stopped.'))!, /timed out/);
  assert.match((await verifyAction('pc_click', {}, 'Completed click on Desk. Fresh verification: b1 button "OK"'))!, /^Verified: looked at the window again/);
  assert.match((await verifyAction('pc_click', {}, 'Completed click on Desk. Fresh verification: (no accessible elements returned)'))!, /^Could not verify/);
});

test('read-only tools get no line', async () => {
  for (const name of ['read_file', 'list_dir', 'web_search', 'mail_read', 'calendar_events', 'pc_look']) assert.equal(await verifyAction(name, {}, 'some output'), undefined, name);
  assert.equal(verifyState('x\nVerified: ok'), 'verified');
  assert.equal(verifyState('x\nCould not verify: no'), 'unverified');
  assert.equal(verifyState('plain'), undefined);
});

const r = (name: string, output: string, args: Record<string, unknown> = {}): Receipt => ({ name, status: 'ok', args, output });

test('claims: "done/saved/sent/added/filled" need a verified receipt', () => {
  const filledBad = [r('fill_document', "Filled 3 of 5.\nCould not verify: not every field is filled (the report above says which).")];
  const c1 = checkClaims('Your time sheet is filled in and ready.', filledBad);
  assert.equal(c1.length, 1);
  assert.equal(c1[0].problem, 'unverified');
  assert.match(correctionNote(c1), /Could not verify/);
  assert.equal(checkClaims('Your time sheet is filled in and ready.', [r('fill_document', 'ok\nVerified: the filled copy was read back')]).length, 0);
  assert.equal(checkClaims("I've saved the file notes.md.", [r('write_file', 'Wrote 3 bytes.\nCould not verify: notes.md reads back different from what was written.', { path: 'notes.md' })])[0]?.problem, 'unverified');
  assert.equal(checkClaims("I've saved the file notes.md.", [r('write_file', 'Wrote 3 bytes.\nVerified: read notes.md back', { path: 'notes.md' })]).length, 0);
  assert.equal(checkClaims("I've sent the email to Sam.", [r('mail_send', 'Sent.\nCould not verify: the mail server gave no id for the sent email.')])[0]?.kind, 'send');
  assert.equal(checkClaims("I've added it to your calendar.", [r('calendar_add', 'Added.\nCould not verify: reading the calendar back failed (timeout).')])[0]?.kind, 'schedule');
  assert.equal(checkClaims('Done!', [r('pc_run', 'Ran: exit code 1.\nCould not verify: exit code 1 (not 0).')])[0]?.kind, 'action');
  assert.equal(checkClaims('Done!', [r('pc_run', 'Ran: exit code 0.\nVerified: exit code 0.')]).length, 0);
  // Old receipts without a read-back line, and honest replies, are not flagged.
  assert.equal(checkClaims("I've saved the file notes.md.", [r('write_file', 'Wrote 3 bytes.', { path: 'notes.md' })]).length, 0);
  assert.equal(checkClaims("I couldn't confirm the time sheet is filled in.", filledBad).length, 0);
});
