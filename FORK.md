# Fork: alleneubank/pi

A personal fork of [earendil-works/pi](https://github.com/earendil-works/pi)
(the upstream, tracked as the `origin` remote here), consumed via mise's
`github:` backend and Nix overlays from GitHub release tarballs. Releasing a
fork means reproducing the upstream release shape so existing tooling — mise
`exe=`, overlay `fetchurl`, update scripts — consumes it without modification.

This procedure adopts the operator's [fork release instructions](https://gist.github.com/alleneubank/bf7d25542a49b136671db0e4bb65226d).
For this personal fork, it takes precedence over upstream-only Git and release
rules in `AGENTS.md` and `.pi/skills/release.md`.

Remote roles in this checkout: `origin` = source project, `fork` = personal
publishing repository (`alleneubank/pi`). Inspect `git remote -v` before acting;
remote names and historical upstream URLs are not proof of their current role.

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
- **Fork-only commits retain Conventional Commits after `[fork]`.** Use
  `[fork] <type>(<scope>): <imperative summary>`. Distribution plumbing and the
  fork's own standing law — `scripts/release-fork.sh`, `FORK.md`, `SPEC.md`,
  the `.hunk/` review ignore — are `[fork]` commits on `main` with everything
  else.

The test: *would this commit go in an upstream PR?* yes → no tag; no → `[fork]`.
Split mixed work at that boundary: generic APIs and tests are unmarked; fork
adoption, distribution, and dogfood policy remain `[fork]`. Keep an integrated
fork feature together when its parts jointly provide one guarantee.

Commit-type discipline:

- **Amend, don't accrete.** Iterating on an unmerged feature (review feedback,
  dogfood fixes, rebase resolution) rewrites the existing `feat` commit with
  `git commit --amend` / a history rewrite — never stack `fix:` commits for your
  own work-in-progress, even when the personal fork has published the old shape.
  Local rewrite authorization does not itself authorize publishing the rewritten
  branch. Preserve existing release tags and assets; cut a new release from the
  rewritten tip instead of replacing an old release.
- **`fix` is for a real patch to upstream** — a genuine defect in already-merged
  upstream code — not for iterating on your own unreviewed feature.
- **`main` is mostly `feat`.** New capability → `feat`; a real upstream bug fix
  → `fix`; everything else (release plumbing, fork docs) is `[fork]`.

## History rewrite safety

Before a requested amend or rebase, preserve unrelated work, create an annotated
recovery tag at the old tip, and record the current fork remote SHA. Afterward,
compare against that recovery point: only the intended feature and doctrine
changes may differ. Keep fork-only doctrine in a separate `[fork]` commit rather
than folding it into an upstream-bound feature. Do not expand a feature amend
into an unrelated upstream rebase.

Publication of rewritten history requires explicit operator authorization for
the named fork ref. Restate the repository, branch, old SHA, and new SHA, then
push with an explicit lease. Never use plain `--force`, rewrite upstream/shared
branches, bypass checks, or refresh the expected SHA just to overcome a rejected
lease. Investigate remote movement instead.

## Sync loop

Maintaining the fork is a repeatable loop an agent can run unattended, from the
repo root:

1. **Inspect, classify, back up, and rebase.** Verify the remote URLs and roles
   before fetching both. Inspect upstream changes since the previous merge base.
   Classify each fork commit as drop (superseded), adopt (upstream implementation
   with fork policy), or adapt (retain against current upstream contracts).
   ```bash
   git checkout main
   git fetch fork
   git fetch origin
   git tag -a "main-rebase-backup-$(date +%Y%m%d-%H%M%S)" -m "pre-rebase backup" HEAD
   git rebase --update-refs origin/main
   ```
   Resolve conflicts only in files the fork changed; a conflict in an untouched
   file means abort and report, not guess.
2. **Publish the rewritten ref only with explicit operator authorization.**
   Preserve the annotated backup locally and verify the intended final tree.
   Use the recorded remote SHA as the lease (single-author fork only):
   ```bash
   git push --force-with-lease=refs/heads/main:<expected-old-sha> fork HEAD:refs/heads/main
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

`scripts/release-fork.sh` builds the binaries and cuts a prerelease. Do not run
`npm run release:patch` or `npm run release:minor` for this flow: fork releases
do not bump workspace versions, publish npm packages, require the upstream
`/cl` gate, or announce on pi.dev. Audit affected unreleased changelog entries
directly when appropriate; released sections remain immutable. A release
request authorizes the builds needed for that release.

The inherited Build Binaries and Publish Model Catalog workflows are restricted to
`earendil-works/pi`; fork activity must not start upstream publication or compete
with the fork archives. The contract:

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
- **Ship committed resources only.** Docs and examples come from Git, not a
  recursive worktree copy. Local prompt captures and other ignored files stay
  local. The release checks each archive's resource list against the commit.
- **Build from validated offline model data.** Refresh catalogs before the
  release and commit any tracked changes. The release build validates the
  prepared data without regenerating tracked sources after the clean-tree gate.
- **Version is stamped, not source-edited.** For Bun-compiled binaries the
  runtime reads `package.json` from beside the executable; the script rewrites
  the `version` field of the shipped `package.json` before archiving, so
  `pi --version` reports the fork tag while the source tree stays clean.
- **Dry-run by default; `--publish` is the boundary.** Tag push + `gh release`
  are the deliberate publish.

### Verification

Run the affected tests and `npm run check`, reusing passing evidence while its
inputs are unchanged. Require a clean committed tree before the dry build.
Verify both archive platform identities, checksums, and committed resource
manifests. Smoke-test the packaged binary outside the repository: version,
help, model listing, interactive startup, and a real prompt with the intended
provider. Follow [.pi/skills/interactive-testing.md](.pi/skills/interactive-testing.md)
for terminal checks. Report the exact platform coverage; failed required checks
block publication unless the operator explicitly accepts the risk.

### Publish the verified archives

`--publish` rebuilds before uploading. When smoke evidence must bind to the exact
published bytes, run the default dry build, smoke its archives, then execute the
tag-push and `gh release create` boundary against those same archives instead.
Use the version printed by that build, not a newly computed date. Before pushing,
verify the clean source revision still matches its `g<sha>` suffix, the `fork`
remote targets `alleneubank/pi`, and `shasum -a 256 -c checksums.txt` passes in
`dist/fork-release/binaries`. Publish both platform archives and that checksum
file as a GitHub prerelease; retain their digests with the smoke evidence.
Verify the published tag's commit and freshly downloaded asset checksums.
Branch publication is separate from tag/release publication. Inspect remote
state before recovering a partial failure; never overwrite an existing release.

## Consumption

Pin the exact tag in mise (`github:alleneubank/pi`, `exe = "pi"`), generate a
cross-platform lock, and install locked. For `../dotfiles`, read its repository
instructions and `docs/fleet-operations.md`: only its enrolled lock-author host
may resolve the shared lock. Commit the exact version pin and matching lock
together. Re-vendor `pi/extensions/questionnaire.ts` byte-for-byte from the
published release's example when it changes; never patch that copy separately.
Run the focused release/link checks and required offline repository gate, then
publish through the authorized `deploy.sh` workflow. Verify installed versions
and extension source identity on the hosts actually updated; publication alone
does not prove fleet convergence. Restart Pi after a binary upgrade.

Keep the fork out of any competing manager — a stray `npm:`/brew shim precedes
`~/.local/bin` on PATH and shadows it.

Nix overlay consumers point their overlay's update script at this repo
(repo-targeting) and pin `pi-<platform>.tar.gz` + sha256 per platform.

## Publishing is the boundary

The release script builds and packages freely, but tag push + `gh release` is a
deliberate human action — dry-run by default, gate the publish behind
`--publish`, restate the concrete tag + repo before publishing, and refuse to
release from a dirty tree so the tag always reproduces the artifact.
