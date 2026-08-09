# Publish reviewed versioned releases

Status: accepted.

## Decision

Normal pull requests may merge into `main` without publishing. Release Please maintains the human-reviewed release pull request with `skip-github-release: true`. It owns the semantic-version projection and changelog, but never creates a tag or GitHub Release. npm and publish-on-every-merge remain outside the design because native marketplaces install from Git and maintainers need an explicit batching boundary.

The release workflow classifies each invocation into one state:

- **Maintenance:** a normal push updates the standing release PR only.
- **Publication:** a push containing exactly one eligible merged release PR admits and publishes one candidate commit.
- **Repair:** manual dispatch repairs an incomplete publication from one exact existing immutable tag.

Publication admits only a release PR based on `main`, opened by the configured Release Please automation identity, merged to a candidate equal to `github.sha`, and containing exactly the allowed version projection. Normal PRs and Release Please PRs may use squash merge. Admission accepts only a verified one-parent or two-parent candidate: in both cases the first parent must equal the trusted pre-merge base and the merged PR's frozen base, and every changed candidate blob must equal the corresponding blob reported for the reviewed PR head; for a two-parent candidate, the second parent must also equal the reviewed PR head. A multi-commit rebase fails that first-parent binding and is rejected.

The one-parent path is motivated by squash merge. GitHub exposes no reliable field that proves which merge button produced a commit, so a provenance-equivalent single-commit rebase is admitted when it satisfies the same immutable-SHA, base, merged-PR association, identity, and projection invariants. This is deliberately a topology check, not a general rebase or merge-policy framework.

The workflow persists the same nine-field candidate record before proof: `repository`, `baseBranch`, `pullRequest`, `automationIdentity`, `mergeCommit`, `version`, `tag`, `expectedTagState`, and `projectionDigest`. Topology is not added to that tag-carried record; it is rederived from the immutable candidate commit. Every later checkout, validation, package, tag, Release target, and checksum binding uses that candidate SHA even if `main` advances.

After four-platform and deterministic-distribution proof, the workflow creates `vX.Y.Z` explicitly at the candidate SHA, verifies the remote tag resolves to that SHA, and creates the GitHub Release with tag verification and an explicit target. Release Please has no publication role.

Packaging emits a deterministic `tar.gz` and `*.checksums.json`. The JSON binds `repository`, `sourceCommit`, `tag`, `plugin`, `version`, `archive`, `archiveBytes`, and `archiveSha256`, plus an evidence note. This is integrity evidence for the archive bytes. It is not independent publisher or builder authenticity. Public repositories may add GitHub artifact attestation; user-owned private repositories retain checksum evidence without that unsupported attestation path.

## Repair contract

Manual dispatch accepts `operation=maintenance` or `operation=repair`. Maintenance is the default and only updates the standing release PR. Repair requires `operation=repair` plus `release_tag` naming an existing `vX.Y.Z` tag. Repair begins from the immutable tag, rederives candidate topology and fresh PR authorship from GitHub, and checks identity against repository configuration rather than trusting the tag-carried record. It repeats the complete proof and validates any existing GitHub Release target. It compares each asset before writing: matching assets remain untouched, missing assets are added, and mismatches fail closed. A mismatched asset may be replaced only when `replace_mismatched_assets=true` is approved through the protected `release` environment. Repair never moves the tag and never represents a new release.

## Human-owned safeguards

A human configures an active `v*` tag ruleset that restricts deletion and updates with no bypass actors. A human also configures an active, no-bypass `main` ruleset that requires pull requests and blocks force pushes. That rule keeps the push event's pre-merge base outside an actor-controlled force-push path. Squash merging remains required for ordinary and release pull requests; two-parent merge commits are optional. The human also configures required `main` checks, Actions permissions, required reviewers on the `release` environment, and the `hosted-canary-qualification` environment with scoped `CANARY_GH_TOKEN`, `CANARY_SSH_PRIVATE_KEY`, and `CANARY_SSH_KNOWN_HOSTS` secrets. The token owns GitHub API calls; SSH owns Git transport, including immutable candidates that contain workflow files. Release automation receives narrow job permissions and never repository-administration authority.

`bun run readiness` reads GitHub and local workflow state without mutation. It fails closed unless the default branch is `main`, squash merging is enabled, an active no-bypass branch ruleset requires pull requests and blocks force pushes on `main`, all release-path checks protect `main`, Actions is enabled, the immutable tag ruleset is active, the hosted-canary environment and required secret names exist, and no workflow grants repository administration. Secret values are never read. Automation is enabled only while these safeguards remain ready.

Installable payload changes require a releasable Conventional Commit PR title: `feat`, `fix`, `perf`, or a breaking `!` title. Documentation-, test-, and CI-only changes are exempt. The pure Release Please version projection is exempt because it changes release identity without changing installable behavior.

## Native replacement contract

Both clients replace a pinned Git marketplace only after detached preflight proves the source, ref, resolved commit, credentials, manifest version, marketplace policy, and payload. Target and restoration refs are proved before destructive work. Managed, workspace-installed, or non-removable state routes to an administrator.

Claude Code preserves one `user`, `project`, or `local` scope through uninstall, marketplace removal, pinned add, install, explicit enablement, and verification. Uninstall uses `--keep-data`. Failure restores the prior scoped declaration and install without deleting persistent data. The host-selected active cache, not an orphan directory, is compared with the detached payload. Generated Claude entries set `defaultEnabled: false`; clients older than 2.1.154 ignore that setting. Private SSH requires accepted host keys and an agent-loaded key. Private HTTPS requires a credential helper; an environment token alone is insufficient. Background and manual refreshes use that durable Git credential path. Automatic update remains user or team policy.

Codex preserves marketplace source, pinned ref, and prior enabled state. It does not inherit Claude scopes or Claude default-disabled behavior. JSON output records marketplace roots, installed paths, versions, and enabled state before and after removal and add. Replacement stops before removal if the prior cache cannot be restored. The first fresh task keeps hooks skipped while untrusted; `/hooks` review accepts only the exact installed definition and executable closure. Enablement and hook trust remain separate states. A second fresh task proves post-review behavior and bytes. `codex plugin marketplace upgrade` is the explicit refresh operation; automatic refresh is unspecified. Supported surfaces are Codex CLI and Codex in the ChatGPT desktop app, not the IDE extension, Chat, mobile, or an unspecified universal host.

## Qualification and distribution boundaries

Public and private Git-repository canaries qualify publishing-system changes, not every recipient release. They bind both GitHub API identity and real Git transport identity. The private canary publishes the exact source commit; the public canary publishes a deterministic root commit containing only the installable plugin, marketplace metadata, and a trusted minimal hosted-proof workflow. Each published commit receives its own `refs/heads/candidate/<sha>`. Hosted proof and native cache comparison bind to those exact commits. Candidate refs are never moved, force-pushed, deleted, or reused for another commit.

This repository implements Git-marketplace distribution: deterministic tarball, checksums, optional public attestation, pinned public/private Git installation, and Git canaries. OpenAI universal-directory submission remains separate work requiring a public ZIP, assets, publisher identity, portal submission, review, approval, and publication. Passing the directory-readiness text subset does not complete that work. Anthropic `claude-community` submission also remains separate work requiring its form, safety review, and catalog commit-SHA pinning. Git canary success makes no claim about either deferred catalog path.
