// Secret scrubbing for anything a tool returns: known vault secrets (exact values) and
// key-shaped strings. Applied before tool output is shown, stored or sent to a model.

// Phase 62: source code such as `const token = bearer(req.headers.authorization)` is left alone
// (the benchmark showed models writing "[REDACTED]" back into files). Only code style counts:
// a space after `=` or `:`, no quotes, and a function call; `PASSWORD=Abc(1)` (env files) and
// `"password": "Abc(1)"` (JSON, YAML with quotes) are still scrubbed.
function isCodeCall(sep: string, value: string): boolean {
  return !/["']/.test(sep) && /[:=]\s/.test(sep) && /^[A-Za-z_$][\w$.]*\(/.test(value);
}

type Replacement = string | ((match: string, ...groups: string[]) => string);

const PATTERNS: [RegExp, Replacement][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bxai-[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED]'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\bhf_[A-Za-z0-9]{30,}/g, '[REDACTED]'],
  // Phase 122 (WHATSAPP §7.1): Meta access tokens (System User and user tokens start EAA).
  [/\bEAA[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  // Phase 122 part 2 (BRIDGES4 §9.1): Matrix access tokens (Synapse `syt_…`, MAS `mct_…`/`mat_…`).
  [/\b(?:syt|mct|mat)_[A-Za-z0-9_-]{20,}/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g, '$1 [REDACTED]'],
  // NAME=value / "name": "value" where the name says it's secret.
  [
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    (m: string, name: string, sep: string, value: string) => (isCodeCall(sep, value) ? m : `${name}${sep}[REDACTED]`),
  ],
];

/**
 * Phase 81: the key-shaped patterns above (private key blocks, provider keys, cloud and chat
 * tokens), as plain detectors for the security pass's secret check (src/security/rules.ts). The
 * same list scrubs output and finds secrets written into code, so the two never disagree.
 */
export const KEY_SHAPED: readonly RegExp[] = PATTERNS.filter(([, rep]) => typeof rep === 'string').map(([re]) => new RegExp(re.source, re.flags.replace('g', '')));

export class Redactor {
  readonly #secrets: () => string[];

  constructor(secrets: () => string[] = () => []) {
    this.#secrets = secrets;
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    // Longest first so a secret containing another is fully removed.
    const known = this.#secrets()
      .filter((s) => typeof s === 'string' && s.length >= 8)
      .sort((a, b) => b.length - a.length);
    for (const s of known) out = out.split(s).join('[REDACTED]');
    for (const [re, rep] of PATTERNS) out = typeof rep === 'string' ? out.replace(re, rep) : out.replace(re, rep);
    return out;
  }

  /** Redacts every string inside a JSON-like value. */
  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.redactValue(v)])) as T;
    }
    return value;
  }
}

/** All secret strings in the vault, including values nested in JSON (MCP env/headers). */
export function vaultSecretValues(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    out.push(v);
    if (v.startsWith('{')) {
      try {
        const walk = (x: unknown): void => {
          if (typeof x === 'string') out.push(x);
          else if (x && typeof x === 'object') Object.values(x as Record<string, unknown>).forEach(walk);
        };
        walk(JSON.parse(v));
      } catch {
        // not JSON
      }
    }
  }
  return out;
}
