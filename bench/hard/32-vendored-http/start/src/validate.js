const SKU = /^[A-Z0-9-]+$/;

export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The first invalid field of a new item (in the order of docs/API.md), or null when it is valid. */
export function checkNewItem(body) {
  if (!isObject(body)) return 'body';
  if (typeof body.sku !== 'string' || !SKU.test(body.sku)) return 'sku';
  if (typeof body.name !== 'string' || !body.name.trim()) return 'name';
  if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((t) => typeof t === 'string'))) return 'tags';
  if (!Number.isInteger(body.stock) || body.stock < 0) return 'stock';
  return null;
}
