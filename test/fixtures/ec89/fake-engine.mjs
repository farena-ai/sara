// EC8 tests: a stand-in for the podman/docker CLI (neither is installed on the build PC). Called as
// `node fake-engine.mjs <log> <engine args…>`. Logs each call (argv, env file, whether Sara's own
// secrets leaked into the CLI environment) and answers like the engine would.
import { appendFileSync, readFileSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
const entry = { args, leaked: Object.keys(process.env).filter((k) => k.startsWith('SARA_TEST_SECRET')) };
const ef = args.indexOf('--env-file');
if (ef >= 0) entry.envFile = readFileSync(args[ef + 1], 'utf8');
appendFileSync(log, `${JSON.stringify(entry)}\n`);
if (args[0] === 'logs') {
  console.log('SARA-EGRESS-READY 3128');
  console.log('SARA-EGRESS-REFUSED {"host":"blocked.example.org","port":443,"why":"not-listed"}');
} else if (args[0] === 'run' && args.includes('-d')) console.log('f00d');
else if (args[0] === 'run') {
  const image = args.findIndex((a) => /^node:/.test(a));
  console.log(`inside: ${JSON.stringify(args.slice(image + 1))}`);
  if (String(args.at(-1)).includes('sleep-forever')) setTimeout(() => {}, 60_000);
}
