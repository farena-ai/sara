// LINKAWARE: one way to find a linked friend by name (import-free; used by every friend tool).
export const foldName = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * One way to find a linked friend by what the owner said: the whole name, the first name, or the
 * start of the name, any case and accents. `many` when it fits more than one (ask which).
 */
export function matchFriend<T extends { name: string; aliases?: readonly string[] }>(list: readonly T[], said: unknown): { hit?: T; many?: T[] } {
  const want = foldName(String(said ?? '').replace(/['’]s$/i, ''));
  if (!want) return list.length === 1 ? { hit: list[0] } : {};
  for (const test of [(n: string) => n === want, (n: string) => n.split(' ')[0] === want, (n: string) => n.startsWith(want)]) {
    // Any of their names: the Messages name, their companion's, the one before a rename (30 days).
    const hits = list.filter((x) => [x.name, ...(x.aliases ?? [])].some((n) => test(foldName(n))));
    if (hits.length === 1) return { hit: hits[0] };
    if (hits.length > 1) return { many: hits };
  }
  return {};
}
