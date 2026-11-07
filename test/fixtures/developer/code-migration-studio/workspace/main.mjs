import { add } from './lib/math.mjs';
import { total, helpers } from './src/report.mjs';
import { three } from './src/alias.mjs';
import { product, five } from './src/shadow.mjs';
console.log(JSON.stringify({ add: add(1, 1), total: total([1, 2, 3]), helper: helpers.sum ? helpers.sum(4, 4) : helpers.add(4, 4), three, product: product(), five }));
