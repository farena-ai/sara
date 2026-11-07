// Release gate: every TypeScript file under src/ must survive Node's type stripping (erasable
// syntax only, no parse errors). This is a syntax gate, not a full type check.
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) files.push(p);
  }
};
walk('src');
let bad = 0;
for (const f of files) {
  try {
    stripTypeScriptTypes(readFileSync(f, 'utf8'));
  } catch (err) {
    bad++;
    console.error(`${f.split('\\').join('/')}: ${String(err.message).split('\n')[0]}`);
  }
}
console.log(`typecheck: ${files.length} file(s), ${bad} failed`);
process.exit(bad ? 1 : 0);
