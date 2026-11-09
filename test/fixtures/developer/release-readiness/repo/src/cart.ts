export interface Line {
  price: number;
  qty: number;
}

export function total(lines: Line[], percent: number): number {
  const sum = lines.reduce((s, l) => s + l.price * l.qty, 0);
  return Math.round(sum * (100 - percent)) / 100;
}
