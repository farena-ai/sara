// A small option parser: --name value, --name=value, flags, and options that may repeat.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

/**
 * spec: { name: { type: 'string' | 'int' | 'flag', multiple?: true } }
 * Returns { values, positionals }.
 */
export function parseArgs(argv, spec) {
  const values = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const opt = spec[name];
    if (!opt) throw new UsageError(`unknown option --${name}`);
    let raw;
    if (opt.type === 'flag') {
      if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
      raw = true;
    } else if (eq !== -1) {
      raw = arg.slice(eq + 1);
    } else {
      if (i + 1 >= argv.length) throw new UsageError(`--${name} needs a value`);
      raw = argv[++i];
    }
    let value = raw;
    if (opt.type === 'int') {
      if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a whole number (got "${raw}")`);
      value = Number(raw);
    }
    if (opt.multiple) (values[name] ??= []).push(value);
    else values[name] = value;
  }
  return { values, positionals };
}
