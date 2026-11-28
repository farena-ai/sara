export const ITEMS = [
  { id: 1, sku: 'BOLT-M6', name: 'Hex bolt M6', tags: ['metal', 'fastener'], stock: 500 },
  { id: 2, sku: 'NUT-M6', name: 'Hex nut M6', tags: ['metal', 'fastener'], stock: 800 },
  { id: 3, sku: 'GLUE-50', name: 'Wood glue 50 ml', tags: ['wood'], stock: 40 },
  { id: 4, sku: 'TAPE-25', name: 'Masking tape 25 mm', tags: ['paper'], stock: 0 },
  { id: 5, sku: 'DOWEL-8', name: 'Beech dowel 8 mm', tags: ['wood', 'round'], stock: 120 },
  { id: 7, sku: 'HOOK-S', name: 'S hook', tags: ['metal'], stock: 30 },
];

export const skus = (res) => res.body.items.map((i) => i.sku);
