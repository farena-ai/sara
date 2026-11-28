// Every error tabula raises or returns is a TabulaError with a stable `code`.
//
// Codes:
//   unknown-table   the table was never defined
//   unknown-column  a column name that the table does not have
//   bad-definition  define() was given an invalid table definition
//   bad-op          where()/whereAny() got an unknown operator or a value of the wrong shape
//   bad-order       orderBy() got something other than one field spec or one array of them
//   bad-page        page() got an index or size that is not a valid integer
//   schema          a row does not fit the table's columns (missing, extra or wrong type)
//   conflict        commit() or load() found a duplicate key or a duplicate unique value
//   missing         commit() found that a row this transaction changed no longer exists
//   stale           commit() found that a row this transaction changed was changed by another commit
//   closed          the transaction was already committed or rolled back
export class TabulaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TabulaError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new TabulaError(code, message);
}
