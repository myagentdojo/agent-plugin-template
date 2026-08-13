# Maintain, resume, or repair release state

Use this runbook to update the standing release PR, resume a proven candidate stranded before its tag, or repair an incomplete publication at an existing immutable tag.

Manual dispatch accepts three operation values. `maintenance` is the default; it only updates the standing release PR and never publishes. `resume` requires `candidate_sha` and publishes a merged, proven candidate whose tag was never created. `repair` requires `release_tag` set to the exact existing `vX.Y.Z` tag; it repairs an incomplete publication and does not create a new release.

Choose by tag state: no tag yet means `resume`; an existing tag means `repair`.

## Maintain the release PR

```sh
gh workflow run Release \
  --repo OWNER/REPOSITORY \
  --ref main \
  -f operation=maintenance
```

Maintenance completes when the standing release PR reflects the current releasable commits and its generated version projection.

## Resume a candidate stranded before its tag

A release PR can merge and pass full proof, then lose its publication job to a cancellation before the immutable tag exists. The candidate is proven but untagged, so Release Please refuses to open the next release PR and reports `There are untagged, merged release PRs outstanding - aborting`. Repair cannot help, because repair requires an existing tag.

Maintenance detects this state and fails with the exact command, including the candidate SHA. Run it:

```sh
gh workflow run Release \
  --repo OWNER/REPOSITORY \
  --ref main \
  -f operation=resume \
  -f candidate_sha=SHA
```

Resume never mints a fresh admission. It recovers the publication-candidate record the original run persisted before proof, revalidates Release Please PR identity, base branch, merge-commit binding, commit topology, projection digest, and manifest version against that record, and requires the target tag to be absent. It then repeats packaging, four-platform compatibility, and candidate proof before entering the same protected `release` environment as a normal publication.

Resume fails closed and creates nothing when:

- The persisted candidate record is missing or its 90-day retention expired.
- The target tag already exists — use repair instead.
- The record is rebound to another candidate, version, or pull request.
- The pull request is not a merged Release Please PR on the release base branch.

An expired record cannot be reconstructed, because rebuilding it would admit a candidate no run ever proved. Recover by rerunning the original release run while its candidate artifact is still retained.

Resume completes when the immutable tag targets the admitted candidate, the GitHub Release and assets match the proven package, the attestation exists, and the release PR carries `autorelease: tagged` so the next maintenance run creates the following release PR.

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
