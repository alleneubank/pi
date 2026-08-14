# Fork: alleneubank/pi

This fork carries two kinds of commits, distinguished by the `[fork]` tag. The
tag exists so `git diff upstream/main..main` is precisely the upstream PR set
and nothing else.

## Commit tagging

- **Upstream-bound commits carry no tag.** Anything that belongs in a PR to
  `earendil-works/pi` — feature code, tests, changelog — is committed on `main`
  with a conventional subject (`feat(tui): ...`), no `[fork]` marker.
- **Fork-only commits are tagged `[fork]`.** Distribution plumbing and this
  fork's own standing law — the release script, fork docs, `SPEC.md`, the
  `.hunk/` review ignore — live on the `fork` branch and are tagged `[fork]`
  so they are visibly not upstream material.

The test is simple: *would this commit go in an upstream PR?* yes → no tag;
no → `[fork]`.

## Rebasing onto upstream

Sync the fork the same way you would any feature branch, from the repo root:

```bash
git checkout main
git fetch origin
git tag -a "main-rebase-backup-$(date +%Y%m%d-%H%M%S)" -m "pre-rebase backup" HEAD
git rebase --update-refs origin/main
```

- Resolve conflicts only in files this fork changed; a conflict in an untouched
  file means abort and ask.
- Replay the `fork` branch onto the new `main` so the release machinery tracks
  the clean tip:
  ```bash
  git checkout fork
  git rebase --onto main <old-main-tip> fork
  ```
- Push with `--force-with-lease` (the fork is single-author):
  ```bash
  git push fork main:main --force-with-lease
  git push fork fork:fork --force-with-lease
  ```

## Releasing

`scripts/release-fork.sh` builds the binaries and cuts a prerelease. See that
script for the mechanics; the contract is:

- **Version scheme** `<base>-fork.<date>.g<sha>` — `<base>` is the nearest
  plain upstream tag (`vX.Y.Z`, never another fork tag), `<date>` is
  `date -u +%Y%m%d`, and `g<sha>` pins the fork commit. It is a valid SemVer
  prerelease, so GitHub's `/releases/latest` never serves it and consumers pin
  the exact tag.
- **Prerelease is the isolation mechanism.** Tag with `gh release --prerelease`.
- **Flattened tarballs** — `pi-<platform>.tar.gz` with the `pi` binary at the
  archive root (no wrapper dir), plus a `checksums.txt`. `exe="pi"` in mise's
  `github:` backend must resolve to a file, not a directory.
- **Linux is required.** The minimum matrix is darwin/arm64 (dogfood) plus
  linux/x64 (fleet); the script refuses to publish without the linux archive.
- **Version is stamped, not source-edited.** `config.ts` reads `package.json`
  from beside the binary at runtime, so the script rewrites the `version` field
  of the shipped `package.json` to the fork version before archiving — the
  source tree is never dirtied and `pi --version` reports the fork tag.
- **Dry-run by default; `--publish` is the boundary.** Tag push + `gh release`
  are the deliberate publish.

Consumption: pin the exact tag in mise (`github:alleneubank/pi`), then
`mise lock --global -p macos-arm64,linux-x64` and `mise install`.
