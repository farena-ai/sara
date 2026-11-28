/** The first value of a single-valued query parameter (relay gives arrays), or undefined. */
export const first = (query, name) => query[name]?.[0];

/** A whole number from a query value, or NaN. */
export const wholeNumber = (text) => (/^\d+$/.test(text) ? Number(text) : NaN);
