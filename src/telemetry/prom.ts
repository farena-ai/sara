// EC3 (docs/ops/EC3_DESIGN.md §2): a small Prometheus registry and the text exposition format 0.0.4.
// Labels are clipped to a safe alphabet and each metric caps its series, so nothing an owner or a
// chat typed can grow the output or carry text into it.

export type Labels = Record<string, string>;

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DEFAULT_MAX_SERIES = 200;

/** A label value: ids and names only ([A-Za-z0-9_.:/-]), at most 64 characters. */
export function safeLabel(v: unknown): string {
  const s = String(v ?? '').replace(/[^A-Za-z0-9_.:/-]/g, '_').slice(0, 64);
  return s || 'unknown';
}

const fmt = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1e9) / 1e9) : n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN');

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  protected readonly maxSeries: number;
  constructor(name: string, help: string, labelNames: readonly string[], maxSeries: number) {
    if (!NAME_RE.test(name)) throw new Error(`Bad metric name: ${name}`);
    for (const l of labelNames) if (!LABEL_RE.test(l) || l === 'le') throw new Error(`Bad label name: ${l}`);
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.maxSeries = maxSeries;
  }
  abstract readonly type: 'counter' | 'gauge' | 'histogram';
  /** The series key for a label set (unknown label names are a programming error). */
  protected key(labels: Labels, size: number, has: (k: string) => boolean): string {
    for (const k of Object.keys(labels)) if (!this.labelNames.includes(k)) throw new Error(`Unknown label ${k} on ${this.name}`);
    const k = JSON.stringify(this.labelNames.map((n) => safeLabel(labels[n])));
    if (has(k) || size < this.maxSeries - 1) return k;
    return JSON.stringify(this.labelNames.map(() => 'other'));
  }
  protected labelText(key: string, extra = ''): string {
    const values = JSON.parse(key) as string[];
    const parts = this.labelNames.map((n, i) => `${n}="${values[i]}"`);
    if (extra) parts.push(extra);
    return parts.length ? `{${parts.join(',')}}` : '';
  }
  head(): string {
    return `# HELP ${this.name} ${this.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}\n# TYPE ${this.name} ${this.type}\n`;
  }
  abstract lines(): string;
}

class Scalar extends Metric {
  readonly type: 'counter' | 'gauge';
  readonly #values = new Map<string, number>();
  constructor(type: 'counter' | 'gauge', name: string, help: string, labelNames: readonly string[], maxSeries: number) {
    super(name, help, labelNames, maxSeries);
    this.type = type;
  }
  protected add(labels: Labels, by: number): void {
    const k = this.key(labels, this.#values.size, (x) => this.#values.has(x));
    this.#values.set(k, (this.#values.get(k) ?? 0) + by);
  }
  protected put(labels: Labels, v: number): void {
    this.#values.set(this.key(labels, this.#values.size, (x) => this.#values.has(x)), v);
  }
  reset(): void {
    this.#values.clear();
  }
  lines(): string {
    let out = '';
    for (const [k, v] of this.#values) out += `${this.name}${this.labelText(k)} ${fmt(v)}\n`;
    return out;
  }
}

export class Counter extends Scalar {
  constructor(name: string, help: string, labelNames: readonly string[], maxSeries: number) {
    super('counter', name, help, labelNames, maxSeries);
  }
  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) throw new Error(`${this.name}: a counter only goes up`);
    this.add(labels, by);
  }
}

export class Gauge extends Scalar {
  constructor(name: string, help: string, labelNames: readonly string[], maxSeries: number) {
    super('gauge', name, help, labelNames, maxSeries);
  }
  set(labels: Labels, v: number): void {
    if (Number.isFinite(v)) this.put(labels, v);
  }
}

export class Histogram extends Metric {
  readonly type = 'histogram' as const;
  readonly buckets: readonly number[];
  readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(name: string, help: string, labelNames: readonly string[], buckets: readonly number[], maxSeries: number) {
    super(name, help, labelNames, maxSeries);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }
  observe(labels: Labels, v: number): void {
    if (!Number.isFinite(v) || v < 0) return;
    const k = this.key(labels, this.#series.size, (x) => this.#series.has(x));
    let s = this.#series.get(k);
    if (!s) this.#series.set(k, (s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }));
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]) s.counts[i]++;
    s.sum += v;
    s.count++;
  }
  lines(): string {
    let out = '';
    for (const [k, s] of this.#series) {
      this.buckets.forEach((b, i) => (out += `${this.name}_bucket${this.labelText(k, `le="${fmt(b)}"`)} ${s.counts[i]}\n`));
      out += `${this.name}_bucket${this.labelText(k, 'le="+Inf"')} ${s.count}\n`;
      out += `${this.name}_sum${this.labelText(k)} ${fmt(s.sum)}\n`;
      out += `${this.name}_count${this.labelText(k)} ${s.count}\n`;
    }
    return out;
  }
}

export class Registry {
  readonly #metrics = new Map<string, Metric>();
  readonly #max: number;
  constructor(o: { maxSeries?: number } = {}) {
    this.#max = o.maxSeries ?? DEFAULT_MAX_SERIES;
  }
  #add<M extends Metric>(m: M): M {
    if (this.#metrics.has(m.name)) throw new Error(`Metric ${m.name} already exists`);
    this.#metrics.set(m.name, m);
    return m;
  }
  counter(name: string, help: string, labels: readonly string[] = []): Counter {
    return this.#add(new Counter(name, help, labels, this.#max));
  }
  gauge(name: string, help: string, labels: readonly string[] = []): Gauge {
    return this.#add(new Gauge(name, help, labels, this.#max));
  }
  histogram(name: string, help: string, labels: readonly string[], buckets: readonly number[]): Histogram {
    return this.#add(new Histogram(name, help, labels, buckets, this.#max));
  }
  render(): string {
    let out = '';
    for (const m of this.#metrics.values()) out += m.head() + m.lines();
    return out;
  }
}
