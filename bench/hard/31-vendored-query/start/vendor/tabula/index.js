// tabula: a tiny in-memory table store with immutable queries and explicit transactions.
// See README.md for an overview and docs/API.md for the full reference.
import { Store } from './src/store.js';

export { TabulaError } from './src/errors.js';
export { OPERATORS } from './src/ops.js';
export { Query } from './src/query.js';
export { Store } from './src/store.js';
export { Transaction } from './src/transaction.js';

export const VERSION = '2.3.1';

/** A new, empty store. */
export function createStore() {
  return new Store();
}
