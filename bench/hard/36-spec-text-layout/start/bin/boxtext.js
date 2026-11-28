#!/usr/bin/env node
import { main } from '../src/cli.js';

process.exitCode = main(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
