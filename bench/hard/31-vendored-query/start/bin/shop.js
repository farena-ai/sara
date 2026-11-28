#!/usr/bin/env node
// Prints the demo reports: node bin/shop.js [sales|customers|close YYYY-MM] [--from D] [--to D] [--page N]
import { parseArgs } from 'node:util';
import { closeMonth } from '../src/closing.js';
import { openShop } from '../src/db.js';
import { renderSales, renderSummary } from '../src/format.js';
import { customerSummary, salesReport } from '../src/reports.js';
import { demo } from '../src/seed.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: 'string' }, to: { type: 'string' }, page: { type: 'string' }, search: { type: 'string' } },
});
const db = openShop(demo);
const [command = 'sales', arg] = positionals;

if (command === 'sales') {
  console.log(renderSales(salesReport(db, { from: values.from, to: values.to, search: values.search, page: values.page ? Number(values.page) : 1 })));
} else if (command === 'customers') {
  console.log(renderSummary(customerSummary(db, { from: values.from, to: values.to })));
} else if (command === 'close') {
  console.log(JSON.stringify(closeMonth(db, arg)));
} else {
  console.error(`unknown command ${command}`);
  process.exitCode = 2;
}
