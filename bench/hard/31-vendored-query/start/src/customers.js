/** Customer look-ups used across the app. */

export function findCustomer(db, id) {
  return db.lookup('customers', id);
}

/** Customers sorted by name, optionally only one region. */
export function listCustomers(db, { region } = {}) {
  const base = db.from('customers').orderBy(['name', 'id']);
  const query = region === undefined ? base : base.where('region', 'eq', region);
  return query.run().rows.map((c) => ({ id: c.id, name: c.name, region: c.region }));
}
