# Maintain or repair release state

Use this runbook to update the standing release PR or repair an incomplete publication at an existing immutable tag.

Manual dispatch accepts two operation values. `maintenance` is the default; it only updates the standing release PR and never publishes. `repair` requires `release_tag` set to the exact existing `vX.Y.Z` tag. This repairs an incomplete publication; it does not create a new release.

## Maintain the release PR

```sh
gh workflow run Release \
  --repo OWNER/REPOSITORY \
  --ref main \
  -f operation=maintenance
```

Maintenance completes when the standing release PR reflects the current releasable commits and its generated version projection.

## Repair an incomplete publication

Start with compare-before-write repair and mismatched replacement disabled:

```sh
gh workflow run Release \
  --repo OWNER/REPOSITORY \
  --ref main \
  -f operation=repair \
  -f release_tag=vX.Y.Z \
  -f replace_mismatched_assets=false
```

The workflow resolves the existing immutable annotated tag, recovers and validates its embedded publication admission, checks out its commit, validates any existing GitHub Release target, and repeats the complete proof. The admission does not depend on the 90-day workflow-artifact retention window. It compares each archive and checksums asset before writing:

- Leave matching assets untouched.
- Add missing assets.
- Fail closed on a mismatched asset.
- Never move or recreate the tag at another commit.

If a mismatched asset is confirmed as the incomplete publication defect, rerun the same exact tag with replacement enabled:

```sh
gh workflow run Release \
  --repo OWNER/REPOSITORY \
  --ref main \
  -f operation=repair \
  -f release_tag=vX.Y.Z \
  -f replace_mismatched_assets=true
```

Required reviewers on the protected `release` environment authorize that same-tag replacement. The workflow uses `--clobber` only in this approved repair state. A missing public attestation is added after the archive matches.

Repair completes when the immutable tag still targets the admitted candidate, the GitHub Release targets that commit, the archive and `*.checksums.json` match the rederived package bytes, and the required public attestation exists.

## Validate release metadata

Before the first release, `.github/.release-please-manifest.json` stays empty. The maintenance job detects that bootstrap state and passes `release-as: 0.1.0` for that run only. Once the first release PR records the root package version, later maintenance runs leave `release-as` empty and return to Conventional Commit versioning. After that release, the release configuration synchronizes:

- `package.json`
- `plugin.config.json`
- Claude marketplace metadata
- Claude native manifest
- Codex native manifest
- The version marker in generated portable JavaScript
- `.github/.release-please-manifest.json`

Validate the release contract locally:

```sh
bun run release:validate -- --json
```

For a public repository, verify the release archive attestation:

```sh
gh attestation verify dist/PLUGIN_NAME-X.Y.Z.tar.gz --repo OWNER/REPOSITORY
```

For a private user-owned repository, compare the downloaded archive with `archiveSha256` in the attached checksums JSON. This proves byte integrity against that file; it does not independently authenticate the publisher or builder.

Release machinery is based on [Release Please](https://github.com/googleapis/release-please), with a human-reviewed standing PR like Every's compound-engineering workflow. This single-plugin template additionally generates a committed changelog, validates every version surface, pins Actions to full commit SHAs, proves the payload before tagging, and attaches the deterministic package. See the [reviewed versioned release ADR](adr/0003-reviewed-versioned-releases.md) for the publication boundary.
