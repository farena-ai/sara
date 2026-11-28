// Exact rational numbers on BigInt. Every amount inside the engine is one of these; floating point
// numbers never appear in a calculation.

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export class Rational {
  constructor(n, d = 1n) {
    if (typeof n !== 'bigint' || typeof d !== 'bigint') throw new TypeError('Rational needs BigInt parts');
    if (d === 0n) throw new RangeError('division by zero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d) || 1n;
    this.n = n / g;
    this.d = d / g;
    Object.freeze(this);
  }

  /** A Rational from a BigInt, a safe integer Number or another Rational. */
  static of(x) {
    if (x instanceof Rational) return x;
    if (typeof x === 'bigint') return new Rational(x);
    if (typeof x === 'number' && Number.isSafeInteger(x)) return new Rational(BigInt(x));
    throw new TypeError(`cannot make a Rational from ${typeof x}`);
  }

  /** Parses a plain decimal string such as "12", "-0.125" or "3.50". */
  static parse(s) {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!m) throw new SyntaxError(`not a decimal: ${s}`);
    const frac = m[3] ?? '';
    const n = BigInt(m[2] + frac) * (m[1] ? -1n : 1n);
    return new Rational(n, 10n ** BigInt(frac.length));
  }

  add(o) {
    o = Rational.of(o);
    return new Rational(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o) {
    o = Rational.of(o);
    return new Rational(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o) {
    o = Rational.of(o);
    return new Rational(this.n * o.n, this.d * o.d);
  }

  div(o) {
    o = Rational.of(o);
    if (o.n === 0n) throw new RangeError('division by zero');
    return new Rational(this.n * o.d, this.d * o.n);
  }

  neg() {
    return new Rational(-this.n, this.d);
  }

  abs() {
    return this.n < 0n ? this.neg() : this;
  }

  sign() {
    return this.n > 0n ? 1 : this.n < 0n ? -1 : 0;
  }

  isZero() {
    return this.n === 0n;
  }

  cmp(o) {
    o = Rational.of(o);
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  eq(o) {
    return this.cmp(o) === 0;
  }

  lt(o) {
    return this.cmp(o) < 0;
  }

  gt(o) {
    return this.cmp(o) > 0;
  }

  /** The largest integer not above this value. */
  floor() {
    const q = this.n / this.d;
    return this.n < 0n && q * this.d !== this.n ? q - 1n : q;
  }

  isInteger() {
    return this.d === 1n;
  }

  static min(a, b) {
    return a.cmp(b) <= 0 ? a : b;
  }

  static max(a, b) {
    return a.cmp(b) >= 0 ? a : b;
  }

  static sum(list) {
    return list.reduce((acc, x) => acc.add(x), ZERO);
  }

  toString() {
    return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`;
  }
}

export const ZERO = new Rational(0n);
export const ONE = new Rational(1n);
export const HUNDRED = new Rational(100n);
