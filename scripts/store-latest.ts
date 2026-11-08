// The version of a signed Store index item that Get more installs: the one its `latest` names. The
// publisher lists versions newest first, so the last one listed is the OLDEST; never pick by position.
export interface IndexVersionLike { version: string }
export interface IndexItemLike<V extends IndexVersionLike> { id: string; latest: string; versions: V[] }

export function latestVersion<V extends IndexVersionLike>(item: IndexItemLike<V> | undefined): V {
  if (!item) throw new Error('the item is not in the signed index');
  const v = item.versions.find((x) => x.version === item.latest);
  if (!v) throw new Error(`${item.id}: latest ${item.latest} is not in its versions`);
  return v;
}
