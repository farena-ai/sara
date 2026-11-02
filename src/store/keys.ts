// Phase 124 (2.57.0, SARA_STORE.md §4.5): the Sara Store's public keys. The store list
// (v1/index.json) is signed on the owner's PC with one of these (the owner's key script made
// them; the private halves never leave that PC). `store-2026a` signs now; `store-2026b` is the spare
// for a rotation: Sara accepts either, and a list signed by one may revoke the other
// (`revokedKeys`, remembered in <data>/store/state.json). Base64 of the raw 32-byte Ed25519 keys.
export const STORE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'store-2026a': '12xRyFunnp3hzXpKnWl2qXcOo623pIaB6pdfm1bz8Jg=',
  'store-2026b': 'kUtCmkAoD18ya+7vxnepR5e6VwDXwYuQnyGpGwIf5to=',
});

/** The Sara team's author key (first-party items carry it as `author.key`; it signs no index). */
export const TEAM_AUTHOR_KEY = 'ed25519:b6c85b3bc5d0bd6770f868338737fa4f64946483f9a27cc081d7bf36451fdab1';
