import { readFileSync } from 'node:fs';
import { renderTable } from './render/table.js';
import { LayoutError } from './util/errors.js';

const USAGE = 'usage: boxtext <table.json> [--width N] [--style ascii|none] [--page-height N]\n';

function parseNumber(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new LayoutError(`${name} must be a positive integer`);
  return n;
}

/** Runs the command line; returns the exit code. */
export function main(argv, io) {
  let file;
  const overrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      io.stdout(USAGE);
      return 0;
    }
    if (arg === '--width') overrides.width = parseNumber(argv[++i], '--width');
    else if (arg === '--page-height') overrides.pageHeight = parseNumber(argv[++i], '--page-height');
    else if (arg === '--style') overrides.style = argv[++i];
    else if (file === undefined) file = arg;
    else {
      io.stderr(USAGE);
      return 2;
    }
  }
  if (file === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    const table = JSON.parse(readFileSync(file, 'utf8'));
    io.stdout(renderTable({ ...table, ...overrides }));
    return 0;
  } catch (err) {
    io.stderr(`boxtext: ${err.message}\n`);
    return err instanceof LayoutError ? 1 : 3;
  }
}
