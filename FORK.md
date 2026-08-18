# Fork: alleneubank/pi

A personal fork of [earendil-works/pi](https://github.com/earendil-works/pi)
(the upstream, tracked as the `origin` remote here), consumed via mise's
`github:` backend and Nix overlays from GitHub release tarballs. Releasing a
fork means reproducing the upstream release shape so existing tooling — mise
`exe=`, overlay `fetchurl`, update scripts — consumes it without modification.

Remotes: `origin` = upstream (`earendil-works/pi`), `fork` = this fork
(`alleneubank/pi`).

## One default branch

Everything lives on `main`: unmarked upstream-bound feats and `[fork]`-tagged
fork-only commits together. There is no second branch. The `[fork]` marker is
what keeps `git diff origin/main..main` from being the upstream PR set — not a
branch boundary.

- **Cut release tags from `main`.** The default branch is the dogfood tip.
- **Upstreamable work is a small branch against `origin/main`**, cherry-picking
  only the unmarked feat commits. Never open an upstream PR from `main` as-is,
  and never let a `[fork]` commit or a source edit made for build config leak
  into that branch.

## Commit tagging

Two commit kinds on `main`, distinguished by a `[fork]` prefix:

- **Upstream-bound commits carry no tag.** Feature code, tests, changelog — a
  conventional subject (`feat(tui): ...`), no marker.
- **Fork-only commits are tagged `[fork]`.** Distribution plumbing and the
  fork's own standing law — `scripts/release-fork.sh`, `FORK.md`, `SPEC.md`,
  the `.hunk/` review ignore — are `[fork]` commits on `main` with everything
  else.

The test: *would this commit go in an upstream PR?* yes → no tag; no → `[fork]`.

Commit-type discipline:

- **Amend, don't accrete.** Iterating on an unmerged feature (review feedback,
  dogfood fixes, rebase resolution) rewrites the existing `feat` commit with
  `git commit --amend` / a history rewrite — never stack `fix:` commits for your
  own work-in-progress.
- **`fix` is for a real patch to upstream** — a genuine defect in already-merged
  upstream code — not for iterating on your own unreviewed feature.
- **`main` is mostly `feat`.** New capability → `feat`; a real upstream bug fix
  → `fix`; everything else (release plumbing, fork docs) is `[fork]`.

## Sync loop

Maintaining the fork is a repeatable loop an agent can run unattended, from the
repo root:

1. **Back up and rebase.**
   ```bash
   git checkout main
   git fetch origin
   git tag -a "main-rebase-backup-$(date +%Y%m%d-%H%M%S)" -m "pre-rebase backup" HEAD
   git rebase --update-refs origin/main
   ```
   Resolve conflicts only in files the fork changed; a conflict in an untouched
   file means abort and report, not guess.
2. **Push with `--force-with-lease`** (single-author fork; never plain `--force`):
   ```bash
   git push fork main:main --force-with-lease
   ```
3. **Cut the release** from `main` with `scripts/release-fork.sh` (dry-run first;
   `--publish` is the boundary), then bump the pinned version, `mise lock`,
   `mise install`.
4. **Offer upstream** from a small branch:
   ```bash
   git switch -c feat/<name> origin/main
   # cherry-pick only the unmarked feat commits
   ```
   PR that branch against upstream. Never let a `[fork]` commit or a build-config
   source edit into it.

## Releasing

`scripts/release-fork.sh` builds the binaries and cuts a prerelease. The
contract:

- **Version scheme** `<base>-fork.<date>.g<sha>` — `<base>` is the nearest plain
  upstream tag (`vX.Y.Z`, never another fork tag), `<date>` is
  `date -u +%Y%m%d`, and `g<sha>` pins the fork commit. The `-fork` suffix makes
  it a SemVer prerelease, so the tag sorts before the base release
  (`0.84.2-fork.X` < `0.84.2` < `0.84.3`) and can never be mistaken for the
  upstream release it builds on. `<base>` is filtered to plain tags, not
  `git describe` — once
  `-fork` tags accumulate, `git describe --tags --abbrev=0` matches them too and
  the version doubles.
- **The GitHub prerelease flag hides the fork from `latest`.** Tag with
  `gh release --prerelease` — GitHub's `/releases/latest` and mise's default
  `latest`/`ls-remote` skip it. This is distinct from the `-fork` SemVer suffix
  above (that is version *sorting*). It is a choice, not a law: mise opts in
  per tool with `prerelease = true`. The fork pins exact tags instead for fleet
  reproducibility, not to avoid hijacking a separate-repo upstream.
- **Flattened tarballs** — `pi-<platform>.tar.gz` with the `pi` binary at the
  archive root (no wrapper dir), plus a `checksums.txt` in `sha256sum` format
  (generated with `shasum -a 256`; `sha256sum` is not on macOS by default).
  `exe="pi"` in mise's `github:` backend must resolve to a file, not a directory.
- **Linux is required — never ship host-only.** The minimum matrix is
  darwin/arm64 (dogfood) plus linux/x64 (fleet); the script refuses to publish
  without the linux archive. Host-only collapses `mise lock` to one platform and
  leaves Linux hosts with a 404.
- **Version is stamped, not source-edited.** For Bun-compiled binaries the
  runtime reads `package.json` from beside the executable; the script rewrites
  the `version` field of the shipped `package.json` before archiving, so
  `pi --version` reports the fork tag while the source tree stays clean.
- **Dry-run by default; `--publish` is the boundary.** Tag push + `gh release`
  are the deliberate publish.

## Consumption

Pin the exact tag in mise (`github:alleneubank/pi`, `exe = "pi"`), then
`mise lock --global -p macos-arm64,linux-x64` and `mise install`. Keep the fork
out of any competing manager — a stray `npm:`/brew shim precedes `~/.local/bin`
on PATH and shadows it.

Nix overlay consumers point their overlay's update script at this repo
(repo-targeting) and pin `pi-<platform>.tar.gz` + sha256 per platform.

## Publishing is the boundary

The release script builds and packages freely, but tag push + `gh release` is a
deliberate human action — dry-run by default, gate the publish behind
`--publish`, restate the concrete tag + repo before publishing, and refuse to
release from a dirty tree so the tag always reproduces the artifact.
