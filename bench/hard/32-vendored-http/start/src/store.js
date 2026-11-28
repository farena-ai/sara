// The item store: plain in-memory data. Everything it returns is a copy.

const copy = (item) => ({ ...item, tags: [...item.tags] });

export function createStore(items = []) {
  const byId = new Map();
  let nextId = 1;
  for (const it of items) {
    byId.set(it.id, { id: it.id, sku: it.sku, name: it.name, tags: [...(it.tags ?? [])], stock: it.stock, reserved: it.reserved ?? 0 });
    nextId = Math.max(nextId, it.id + 1);
  }
  return {
    /** All items by id. */
    list: () => [...byId.values()].sort((a, b) => a.id - b.id).map(copy),
    /** One item by numeric id, or null. */
    get: (id) => (byId.has(id) ? copy(byId.get(id)) : null),
    bySku: (sku) => {
      for (const it of byId.values()) if (it.sku === sku) return copy(it);
      return null;
    },
    add({ sku, name, tags = [], stock }) {
      const item = { id: nextId++, sku, name, tags: [...tags], stock, reserved: 0 };
      byId.set(item.id, item);
      return copy(item);
    },
    remove: (id) => byId.delete(id),
    /** Adds qty to the reserved count of an item; returns the updated item (or null). */
    reserve(id, qty) {
      const it = byId.get(id);
      if (!it) return null;
      it.reserved += qty;
      return copy(it);
    },
  };
}

export const SAMPLE_ITEMS = [
  { id: 1, sku: 'BOLT-M6', name: 'Hex bolt M6', tags: ['metal', 'fastener'], stock: 500 },
  { id: 2, sku: 'NUT-M6', name: 'Hex nut M6', tags: ['metal', 'fastener'], stock: 800 },
  { id: 3, sku: 'GLUE-50', name: 'Wood glue 50 ml', tags: ['wood'], stock: 40 },
  { id: 4, sku: 'TAPE-25', name: 'Masking tape 25 mm', tags: ['paper'], stock: 0 },
];
