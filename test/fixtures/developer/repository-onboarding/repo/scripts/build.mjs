// Builds dist/index.html and dist/cards.json from data/cities.json and templates/card.html.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { render } from '../src/cards.mjs';

const cities = JSON.parse(readFileSync('data/cities.json', 'utf8'));
const template = readFileSync('templates/card.html', 'utf8');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', `<main>\n${cities.map((c) => render(template, c)).join('\n')}\n</main>\n`);
writeFileSync('dist/cards.json', `${JSON.stringify(cities.map((c) => c.city))}\n`);
console.log(`built ${cities.length} cards`);
