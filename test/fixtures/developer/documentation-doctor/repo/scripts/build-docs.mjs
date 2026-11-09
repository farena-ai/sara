// Builds docs/site.html from docs/index.json (which this fixture deliberately lacks).
import { readFileSync, writeFileSync } from 'node:fs';
let index;
try {
  index = JSON.parse(readFileSync('docs/index.json', 'utf8'));
} catch {
  console.error('build-docs: docs/index.json is missing; nothing was built.');
  process.exit(1);
}
writeFileSync('docs/site.html', `<h1>${index.title}</h1>\n`);
console.log('build-docs: wrote docs/site.html');
