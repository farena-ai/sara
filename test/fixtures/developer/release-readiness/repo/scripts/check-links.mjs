// Release gate: every relative link in the project's Markdown files must point at a file.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const docs = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) docs.push(p);
  }
};
walk('.');
let broken = 0;
for (const f of docs) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)#\s]+)[^)]*\)/g)) {
      if (/^[a-z]+:/i.test(m[1]) || existsSync(join(dirname(f), m[1]))) continue;
      broken++;
      console.error(`${f.split('\\').join('/')}:${i + 1} broken link ${m[1]}`);
    }
  });
}
console.log(`links: ${docs.length} file(s), ${broken} broken`);
process.exit(broken ? 1 : 0);
