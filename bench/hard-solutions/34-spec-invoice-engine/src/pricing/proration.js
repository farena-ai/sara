// Proration of a line by its period (SPEC rules 21 and 22). The factor itself is worked out when
// the invoice is read (model/validate.js) and kept on the line as `prorate`.

export function prorate(extended, line) {
  return extended.mul(line.prorate);
}
