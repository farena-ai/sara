// Pipeline settings. See docs/CONFIG.md for what each one means.

export const DEFAULTS = Object.freeze({
  batchSize: 10,
  maxAttempts: 5,
  backoffBaseMs: 100,
  backoffMaxMs: 10_000,
  jitterMs: 0,
  dedupeWindowMs: 60_000,
  segmentSize: 64,
  tickMs: 50,
});

const POSITIVE = ['batchSize', 'maxAttempts', 'backoffBaseMs', 'backoffMaxMs', 'segmentSize', 'tickMs'];
const NON_NEGATIVE = ['jitterMs', 'dedupeWindowMs'];

export class ConfigError extends Error {}

export function resolveConfig(options = {}) {
  const config = { ...DEFAULTS };
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!(name in DEFAULTS)) throw new ConfigError(`unknown setting "${name}"`);
    config[name] = value;
  }
  for (const name of POSITIVE) {
    if (!Number.isInteger(config[name]) || config[name] < 1) throw new ConfigError(`${name} must be a whole number of at least 1 (got ${config[name]})`);
  }
  for (const name of NON_NEGATIVE) {
    if (!Number.isInteger(config[name]) || config[name] < 0) throw new ConfigError(`${name} must be a whole number of at least 0 (got ${config[name]})`);
  }
  if (config.backoffMaxMs < config.backoffBaseMs) throw new ConfigError('backoffMaxMs must not be below backoffBaseMs');
  return Object.freeze(config);
}
