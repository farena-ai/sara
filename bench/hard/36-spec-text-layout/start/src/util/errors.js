/** Every invalid table, column, cell or option is reported with this error. */
export class LayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayoutError';
  }
}

export function fail(message) {
  throw new LayoutError(message);
}
