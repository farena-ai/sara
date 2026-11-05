#!/usr/bin/env bash
# Collects the files for a GitHub Release into outputs/release/<version>/ (Phase 57). Publishes
# nothing: at the end it prints the `gh release create` command for the owner to run.
#
#   bash scripts/release-assets.sh [version] [--strict]
#
# version defaults to package.json's. It gathers (each must already be built):
#   outputs/windows/Sara-Setup-<v>.exe   desktop/windows/build-installer.sh
#   outputs/mac/Sara-<v>.dmg             desktop/mac/build.sh on the Mac, copied here
#   outputs/public-export/               node scripts/public-export.ts  -> sara-<v>.tar.gz
#   outputs/vscode/sara-vscode-*.vsix    node scripts/pack-vscode.ts (the extension's own version)
# then writes SHA256SUMS and notes.md (this version's CHANGELOG.md section). Missing files are
# listed and skipped; --strict stops instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STRICT=0 VERSION=""
for a in "$@"; do
  case "$a" in
    --strict) STRICT=1 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 2 ;;
    *) VERSION="$a" ;;
  esac
done
[[ -n "$VERSION" ]] || VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || { echo "Not a version: $VERSION" >&2; exit 2; }

node "$ROOT/scripts/check-release-presentation.ts" "$VERSION"

OUT="$ROOT/outputs/release/$VERSION"
rm -rf "$OUT"
mkdir -p "$OUT"
MISSING=()

take() { # take <source> <name in the release>
  if [[ -f "$1" ]]; then cp "$1" "$OUT/$2"; echo "  + $2"; else MISSING+=("$2 (expected at ${1#"$ROOT"/})"); fi
}

echo "Collecting Sara $VERSION release files into ${OUT#"$ROOT"/}/"
take "$ROOT/outputs/windows/Sara-Setup-$VERSION.exe" "Sara-Setup-$VERSION.exe"
take "$ROOT/outputs/mac/Sara-$VERSION.dmg" "Sara-$VERSION.dmg"
# The one-command installer, so its checksum is in SHA256SUMS (the Proxmox script checks it).
take "$ROOT/deploy/get-sara.sh" "get-sara.sh"

# Source tarball from the public export (no private notes, no git history), as sara-<v>/.
EXPORT="$ROOT/outputs/public-export"
if [[ -f "$EXPORT/package.json" ]]; then
  EXPORTED="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$EXPORT/package.json" | head -1)"
  if [[ "$EXPORTED" != "$VERSION" ]]; then
    MISSING+=("sara-$VERSION.tar.gz (the public export is $EXPORTED; run: node scripts/public-export.ts)")
  else
    STAGE="$(mktemp -d)"
    cp -R "$EXPORT" "$STAGE/sara-$VERSION"
    tar -C "$STAGE" -czf "$OUT/sara-$VERSION.tar.gz" "sara-$VERSION"
    rm -rf "$STAGE"
    echo "  + sara-$VERSION.tar.gz"
  fi
else
  MISSING+=("sara-$VERSION.tar.gz (no public export; run: node scripts/public-export.ts)")
fi

# The VS Code extension keeps its own version (clients/vscode/package.json).
VSIX_VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/clients/vscode/package.json" 2>/dev/null | head -1)"
take "$ROOT/outputs/vscode/sara-vscode-$VSIX_VERSION.vsix" "sara-vscode-$VSIX_VERSION.vsix"

# Checksums (the Homebrew cask and winget manifests are filled from this file).
(cd "$OUT" && files=(*) && [[ -e "${files[0]}" ]] && sha256sum -b "${files[@]}" | sed 's/ \*/  /' > SHA256SUMS || : > SHA256SUMS)

# Release notes: this version's section of CHANGELOG.md (from its "## <v>" heading to the next).
awk -v v="$VERSION" '
  /^## / { if (on) exit; split($2, h, /[ (:]/); if (h[1] == v) { on = 1; next } }
  on { print }
' "$ROOT/CHANGELOG.md" > "$OUT/notes.md"
if [[ ! -s "$OUT/notes.md" ]]; then
  echo "See CHANGELOG.md." > "$OUT/notes.md"
  MISSING+=("release notes (no \"## $VERSION\" section in CHANGELOG.md)")
fi
cat >> "$OUT/notes.md" <<EOF

---

**Install:** see [docs/INSTALL.md](https://github.com/farena-ai/sara/blob/v$VERSION/docs/INSTALL.md).
Docker: \`docker pull ghcr.io/farena-ai/sara:$VERSION\`. Check downloads against \`SHA256SUMS\`.
EOF

echo
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "Missing (not in this release folder):"
  printf '  - %s\n' "${MISSING[@]}"
  [[ $STRICT == 0 ]] || { echo "--strict: stopping." >&2; exit 1; }
  echo
fi
echo "SHA256SUMS:"
sed 's/^/  /' "$OUT/SHA256SUMS"
echo
echo "Nothing was published. When everything looks right, the owner runs (from $ROOT):"
ASSETS=""
for f in "$OUT"/*; do ASSETS+=" outputs/release/$VERSION/$(basename "$f")"; done
ASSETS="${ASSETS// outputs\/release\/$VERSION\/notes.md/}"
echo "  git tag -a v$VERSION -m \"Sara $VERSION\" && git push origin v$VERSION"
echo "  gh release create v$VERSION --repo farena-ai/sara --title \"Sara $VERSION\" --notes-file outputs/release/$VERSION/notes.md --verify-tag$ASSETS"
