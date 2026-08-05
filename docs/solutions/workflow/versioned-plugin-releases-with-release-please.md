---
title: Versioned plugin releases with Release Please
date: 2026-08-05
category: workflow
module: agent-plugin-template
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - One Git repository distributes one versioned plugin to Claude Code and Codex
  - Normal pull requests should accumulate on main without publishing every merge
  - A reviewed release boundary must synchronize manifests runtime output changelog tag and GitHub Release
  - Release artifacts must pass macOS and Linux proof for arm64 and x86_64 before publication
  - Public and user-owned private repositories need explicit but different provenance guarantees
related_components:
  - tooling
  - testing_framework
  - documentation
tags:
  - release-please
  - release-pr
  - conventional-commits
  - version-sync
  - github-releases
  - artifact-attestation
  - deterministic-builds
  - no-npm
---

# Versioned plugin releases with Release Please

## Context

A Git-distributed Claude Code and Codex plugin needs a release boundary stricter than merging a normal pull request to `main`. The harnesses already install the repository payload, so npm would add a second registry and credential lifecycle without solving a consumer need.

The release must coordinate artifacts that would otherwise drift independently:

- One semantic version in `package.json`, `plugin.config.json`, both native manifests, Claude marketplace metadata, generated JavaScript, and the Release Please manifest.
- One generated `CHANGELOG.md` derived from reviewed Conventional Commit squash titles.
- One `vX.Y.Z` tag and GitHub Release.
- One deterministic archive plus SHA-256 provenance JSON.
- Native runtime proof on Linux x64, Linux arm64, macOS arm64, and macOS x64 before tagging.
- GitHub artifact attestation for public repositories and deterministic provenance for user-owned private repositories.

Prior session history contained runtime smoke evidence but no versioning or changelog design. It did expose a useful distinction: worktree reload proved development behavior, while an installed cache proved packaged behavior. Release verification therefore executes the packaged payload rather than treating a successful development reload as release evidence. (session history)

The chosen model is a standing, human-reviewed Release Please PR. Ordinary changes merge without publishing. Merging the generated release PR establishes the semantic version boundary; the resulting commit must pass the release matrix and distribution proof before Release Please can tag it.

## Guidance

### Keep one version owner and validate every projection

Use `plugin.config.json` as the plugin metadata owner. Release Please's `node` strategy updates the private root package version and `CHANGELOG.md`; it does not publish the package. Configure `extra-files` for the other version-bearing outputs:

```json
{
  "include-component-in-tag": false,
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "agent-plugin",
      "changelog-path": "CHANGELOG.md",
      "extra-files": [
        { "type": "json", "path": "plugin.config.json", "jsonpath": "$.version" },
        { "type": "json", "path": ".claude-plugin/marketplace.json", "jsonpath": "$.metadata.version" },
        { "type": "json", "path": "plugin/.claude-plugin/plugin.json", "jsonpath": "$.version" },
        { "type": "json", "path": "plugin/.codex-plugin/plugin.json", "jsonpath": "$.version" },
        { "type": "generic", "path": "plugin/runtime/hello-world.js" }
      ]
    }
  }
}
```

The generated runtime has Release Please generic-file markers around its only embedded version literal. `bun run release:validate` rejects drift between version surfaces, a missing extra-file mapping, an npm publish script, a public package, floating Action references in the release workflow, or missing required matrix, dependency, permission, repair, upload, and attestation markers.

Treat `.github/.release-please-manifest.json` as the Release Please baseline. Before the first automated release it is a seed version; after releases begin, Release Please advances it through generated release PRs.

Do not hand-edit versions or `CHANGELOG.md`. Review their generated changes together in the release PR.

### Derive releases from reviewed squash titles

Enforce Conventional Commit PR titles because a squash title becomes the commit Release Please evaluates:

```text
feat: add a portable command
fix(claude): correct hook matching
perf!: replace the execution protocol
```

Features advance the minor version; fixes and performance changes advance the patch version; `!` or a `BREAKING CHANGE` footer advances the major version. Hide test, CI, and maintenance entries unless they carry user release value.

Enable squash merging and protect `main`. The title is release input, not cosmetic formatting.

### Prove the candidate before tagging

Order the release workflow as a dependency chain:

```text
push to main
  -> native QuickJS proof on four platform pairs
  -> tests, version validation, deterministic packaging, offline execution
  -> Release Please maintains its PR or publishes a merged release
  -> attach the already-proven archive and provenance
  -> attest the public archive
```

The Release Please job depends on the package job. It cannot create `vX.Y.Z` until the exact pushed commit passes all native targets and the full local gate.

Upload the candidate between jobs under a workflow-run artifact name. When `release_created` is true, attach those exact bytes with `gh release upload`. Do not rebuild after tagging: publishing the already-proven archive keeps proof and release bytes identical.

Pin third-party GitHub Actions to full commit SHAs and validate the pins locally.

### Preserve deterministic and offline distribution

Package only `plugin/`. Normalize archive entry order, timestamps, numeric ownership, tar format, and gzip metadata. Build twice and require equal SHA-256 digests. Extract the archive and execute both harness command contracts with development runtimes removed from `PATH`.

For a public repository, attest the archive after GitHub Release creation. For a user-owned private repository, attach the same archive and provenance JSON without claiming unsupported attestation. Consumers can compare the downloaded archive digest with the attached provenance.

### Choose the automation token deliberately

The zero-secret baseline uses `${{ secrets.GITHUB_TOKEN }}` when `RELEASE_PLEASE_TOKEN` is absent. GitHub's recursion protection means events created by that token generally do not start another workflow, so the generated release PR may not receive normal PR checks automatically.

The release remains protected because every `main` push runs the four-platform and package proof before Release Please acts, and a merged release PR is proved again before tagging.

Add a narrowly scoped `RELEASE_PLEASE_TOKEN` when the generated PR must receive strict pre-merge checks. A fine-grained token or GitHub App token needs repository contents, pull requests, and issues write access. Treat it as a policy upgrade, not a publication prerequisite.

### Make partial publication repairable

Proof failures occur before the tag. Fix them through a normal PR and let the workflow rerun.

Asset upload or attestation can fail after GitHub Release creation. A plain rerun no longer receives `release_created`, so manual dispatch accepts an exact existing `release_tag`. The repair path checks out that tag, repeats the complete proof, uploads deterministic assets with `--clobber`, and recreates the public attestation. Never repair a release from current `main` when it differs from the tag.

## Why This Matters

The workflow separates three states:

- A merged commit is source available on `main`.
- A CI artifact is a proven package for one commit.
- A release is a reviewed version, changelog, tag, GitHub Release, and published copy of those proven bytes.

The standing release PR supplies a deliberate batching point. Contributors merge independently; maintainers release when the combined version and notes are ready. Dependency ordering supplies the mechanical safety point: no tag exists until the supported native matrix and packaged execution pass.

One synchronized version prevents Claude, Codex, generated runtime output, archives, and release metadata from disagreeing. Deterministic bytes and provenance make the artifact inspectable. Avoiding npm removes redundant publication credentials and recipient dependencies.

## When to Apply

Apply this workflow when one repository releases one plugin, normal merges should accumulate, several generated files carry one version, multiple native targets must pass before publication, and GitHub Releases are the delivery evidence surface.

Use Changesets when contributors must declare release intent per PR or independently version many packages. Use semantic-release when every releasable merge should publish immediately and a human-reviewed standing release PR is unwanted.

## Examples

Run the complete local gate:

```sh
bun run prove:all
```

Inspect synchronized release state:

```sh
bun run release:validate -- --json
```

Normal release:

1. Merge conventional squash commits into `main`.
2. Review the generated release PR's version and changelog.
3. Merge the release PR.
4. Wait for four-platform proof, tag, GitHub Release, archive, and provenance.
5. Verify public attestation or private SHA-256 provenance.

Repair missing assets after a release exists:

1. Open the `Release` workflow's manual dispatch form.
2. Enter the exact existing `vX.Y.Z` tag as `release_tag`.
3. Wait for the workflow to prove that tag and replace its assets.

## Related

- [Portable dual-harness plugin distribution](../architecture-patterns/portable-dual-harness-plugin-distribution.md)
- [Native development and versioned promotion](../../decisions/0002-development-and-main-promotion.md)
- [QuickJS compatibility spike](../../decisions/0003-quickjs-compatibility-spike.md)
- [Release Please](https://github.com/googleapis/release-please)
- [Release Please Action](https://github.com/googleapis/release-please-action)
- [GitHub workflow trigger rules](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow)
- [GitHub artifact attestations](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
