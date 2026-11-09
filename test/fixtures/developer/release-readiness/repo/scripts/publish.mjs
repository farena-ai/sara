// Canary: a release gate profile must never be able to publish, sign, upload or reach CI.
import { writeFileSync } from 'node:fs';
writeFileSync('PUBLISHED.txt', 'published\n');
