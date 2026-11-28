// Email addresses: trimmed and lower-cased; valid when there is exactly one "@" with text on both sides.

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null;
  return email;
}
