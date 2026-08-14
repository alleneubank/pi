#!/usr/bin/env bash
#
# Fork release for alleneubank/pi: build the pi binaries and cut a prerelease
# tarball set consumed via mise's github: backend and Nix overlays.
#
# Mirrors the upstream archive layout (pi-<platform>.tar.gz) produced by
# scripts/build-binaries.sh. Minimum fleet matrix: darwin/arm64 (dogfood host)
# plus linux/x64 (required — never ship host-only).
#
# Dry-run by default; the tag push + gh release are the deliberate publish,
# gated behind --publish.
set -euo pipefail

REPO="alleneubank/pi"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PUBLISH=false
[[ "${1:-}" == "--publish" ]] && PUBLISH=true

BASE="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1 | sed 's/^v//')"
VERSION="${BASE}-fork.$(date -u +%Y%m%d).g$(git rev-parse --short=9 HEAD)"
TAG="v${VERSION}"

# Refuse a dirty tree so the tag always reproduces the artifact.
[[ -z "$(git status --porcelain)" ]] || { echo "dirty tree — commit or stash first" >&2; exit 1; }

DIST="$ROOT/dist/fork-release"
rm -rf "$DIST"
mkdir -p "$DIST/stage-darwin-arm64" "$DIST/stage-linux-x64" "$DIST/binaries"

# Full deps + build on the first platform; binary-only compile on the second
# (the cross-platform clipboard bindings are already materialized by the first).
scripts/build-binaries.sh --skip-install --platform darwin-arm64 --out "$DIST/stage-darwin-arm64"
scripts/build-binaries.sh --skip-install --skip-deps --skip-build --platform linux-x64 --out "$DIST/stage-linux-x64"

# Re-tar the extracted platform dirs WITHOUT the pi/ wrapper: binary + assets at
# the archive root, matching the flattened layout the other forks (hunk, grok)
# use — mise's github backend shims exe= at the tarball root, and a wrapper dir
# collides with the exe name.
for platform in darwin-arm64 linux-x64; do
	tar -czf "$DIST/binaries/pi-$platform.tar.gz" -C "$DIST/stage-$platform/$platform" .
done
( cd "$DIST/binaries" && shasum -a 256 pi-*.tar.gz | sed 's/  /  /' > checksums.txt )

# Required-platform gate: never publish a host-only release.
ls "$DIST/binaries"/pi-*linux*.tar.gz >/dev/null 2>&1 \
	|| { echo "missing required linux archive — fleet cannot install" >&2; exit 1; }

if [[ "$PUBLISH" != true ]]; then
	echo "dry run — re-run with --publish to cut the release"
	echo "version: $VERSION"
	ls -lh "$DIST/binaries"
	exit 0
fi

# BOUNDARY: deliberate publish only.
git tag -a "$TAG" -m "fork release $VERSION"
git push fork "$TAG"
gh release create "$TAG" --repo "$REPO" --prerelease --title "$VERSION" \
	"$DIST/binaries"/pi-*.tar.gz "$DIST/binaries"/checksums.txt
