// Canonical JSON (docs/STORE.md, "Formats"): object keys sorted (JavaScript's default string order),
// recursively; arrays keep their order; no spaces.

export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

export function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

/** The manifest's form: canonical keys, two-space indent, final newline. */
export function pretty(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
