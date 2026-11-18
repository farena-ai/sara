// V1.4: a stand-in "agent CLI" for checking the harness pipeline of scripts/bench-compare.ts without
// any real agent. It is only ever run by that script's self-test (--mode verify) and its tests.
//   node scripts/bench-fake-harness.ts solve   <workspace> <solution> <promptFile>   lays the reference solution over the workspace
//   node scripts/bench-fake-harness.ts nothing <workspace> <solution> <promptFile>   reads the task and changes nothing
//   node scripts/bench-fake-harness.ts hang    <workspace> <solution> <promptFile>   never finishes (timeout check)
import { cpSync, existsSync, readFileSync } from 'node:fs';

const [how, workspace, solution, promptFile] = process.argv.slice(2);
if (!workspace || !existsSync(workspace)) {
  console.error('fake harness: no workspace');
  process.exit(2);
}
const task = promptFile && existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '';
if (!task.trim()) {
  console.error('fake harness: no task text');
  process.exit(2);
}
if (how === 'solve') {
  if (!solution || !existsSync(solution)) process.exit(3);
  cpSync(solution, workspace, { recursive: true });
  console.log('Applied the fix.');
} else if (how === 'hang') {
  setInterval(() => {}, 1000);
} else {
  console.log('Looked at it; changed nothing.');
}
