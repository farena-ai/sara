// A small pricing module with one real bug: the discount is applied twice.
export function discounted(price, percent) {
  const once = price - (price * percent) / 100;
  return once - (once * percent) / 100;
}

export function total(items, percent) {
  return items.reduce((sum, item) => sum + discounted(item.price, percent), 0);
}
