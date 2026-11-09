# Build Cache Inspector

Measure **real files** from a trusted operator-staged cache in the plugin’s own native data home.
Tool `inspect` accepts only `cacheId: "typescript"` and `operation: "inspect"` or `"preview"`.
It does not accept roots, commands, URLs, content inventories, measured-size JSON or verdicts.
It never deletes, writes, touches mtimes or applies a preview. There is no apply operation.

## Staging and authority

With the plugin disabled, the trusted operator copies ordinary build outputs into
`<plugin-native-data-home>/owned-caches-v1/typescript`. Use the actual manager
`dataDirFor("build-cache-inspector", companion)` location, not an invented workspace grant.
The native runtime sets cwd and HOME to that directory (bubblewrap maps it to /workspace).
The implementation uses **process.cwd()**, not os.homedir(): Windows homedir need not honor HOME.
The existing native own-data read grant supports this useful first tier. The operator can stage
real owned TypeScript build artifacts here; the plugin does not run compilers or scan projects.
Do not stage secrets or shared/system caches. Keep staging quiescent throughout an invocation.
Selected-project and full-owner-cache inspection remain HELD on H2; this is not a workspace scanner.

## Measurement and preview

The runtime enumerates every admitted regular file, lstat/fstat checks identities, reads and
SHA256-hashes actual bytes with a bounded buffer, totals sizes with BigInt, and rechecks metadata.
It reports exact decimal bytes, actual **installed** nanosecond mtimes, ordinal f001 references and
source hashes. ZIP/copy does not promise preserved mtimes. Snapshot binds relative names, device,
inode, mode, nlink, size, ctime, mtime, directory/anchor metadata and content hashes. No caller measurement is trusted.
Preview requires the exact inspect snapshot, remeasures the cache, and refuses changed bytes or
metadata. `policy` is fully described in schema.json: referenceMs is explicit caller Unix wall time
within -5 minutes/+1 minute of runtime; minAgeMs is elapsed wall time, not cache-hit evidence.
Policy provenance is explicit-caller-policy-v1, not a backend recommendation. No hit-rate claims.
Always retain at least retainNewest files; additional preserve refs take precedence. Unknown or
duplicate refs refuse. Eligible files are ordered oldest mtime first, ties by ordinal ref. Newest
retention uses newest mtime first, ties by ordinal ref. Age uses inclusive >= cutoff. Selection
is an oldest-first prefix: stop at the first file exceeding maxPruneBytes, report cutoff=true;
do not skip it to fit younger files. estimatedBytes sums logical unnamed file bytes, not disk blocks
or guaranteed reclaimable physical storage. Inspect and preview return all admitted metadata.

## Privacy and actionability

No raw filenames, private absolute paths, content or underlying filesystem errors appear in results
or cards. The trusted operator retains a local sorted relative-path-to-ordinal mapping for this
snapshot; re-enumeration or cache change invalidates the mapping. Qualification produces such a
mapping for its public synthetic fixture only. File sizes, mtimes, counts and hashes **are metadata**
provided to Sara and potentially host logs/history/model; hashes may identify known content.
This is not secret detection or protection from host generic argument logging. Protocol IDs stay
literal; ready descriptions and cards support en/es/fr/de/pt-BR/it. Refusals use a fixed English
privacy-safe message. No model/network/broker calls are made; result.card is invocation-scoped.

## Bounds and limitations

128 files, 256 entries including directories, depth8, 16MiB total hash reads, 128-character names,
5-second cooperative deadline; no symlinks/junctions, multiply-linked files, devices, separators,
control names, colon/ADS paths, trailing dots/spaces or realpath escapes. Entire unsupported cache
refuses atomically, never reports partial complete. Only ordinary unnamed data streams are measured;
NTFS alternate-stream enumeration is unavailable in Node’s portable fs API. Trusted staging must
exclude alternate streams; this is not a forensic disk-usage scanner or race-proof hostile-filesystem
boundary. lstat/open/recheck detects observed changes, not all possible same-metadata races.
No global filesystem snapshot/lock is available. Directory enumeration uses bounded streaming
with a 32-entry native buffer and stops when the total entry limit is crossed; no unbounded
readdir list is allocated. Read access can update atime; bytes and mtime are not changed.

Inputs are descriptor-checked before serialization (hidden toJSON/accessors/exotic prototypes fail;
Proxies are not isolation). Serialized arguments must fit host 65,536 UTF16 units. Content cap49,152
UTF8 bytes is below host64KiB; max framed response remains below1MiB; host heap128MiB. Policy clock
is checked against live wall clock; clock accuracy and trusted/quiescent staging are prerequisites.
Ask default, explicit install trust and enablement. Qualification uses real permission-limited
PluginManager execution in the isolated2.67 authoring checkout and explicit2.68 pack/smoke target;
not the complete2.68 app, chat approval, OS fencing, signed release or full-target readiness.
