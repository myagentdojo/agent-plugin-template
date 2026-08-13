# Pull requests and CI

Use this runbook when naming a pull request, classifying payload impact, qualifying the current head, or operating the optional Codex review gate.

Complete the root README's [local proof](../README.md#3-prove-the-change) before opening the pull request.

## Name the pull request

Use a Conventional Commit PR title. The title becomes the normal PR's squash commit and drives release notes:

```text
feat: add a portable command
fix(runtime): correct custody routing
docs: clarify private installation
```

Installable payload changes require a releasable title: `feat`, `fix`, `perf`, or any valid Conventional Commit type with `!` for a breaking release. A payload-changing `refactor`, `docs`, `test`, `ci`, `build`, or `chore` title fails the `Release impact` check unless it uses `!`. Documentation-, test-, and CI-only changes are exempt because they do not change the installed payload. The pure Release Please version projection is also exempt.

`feat` advances the minor version. `fix` and `perf` advance the patch version. `!` advances the major version. Documentation and maintenance changes appear only when configured as visible changelog sections.

## Qualify the current head

Hosted CI builds one candidate, then on Linux x64, Linux arm64, macOS arm64, and macOS x64 acquires the locked Bun asset through `repair --apply` into isolated state, runs a packaged skill, and proves warm reuse with custody network denied. It then creates the deterministic archive and `*.checksums.json`. The checksums bind the source commit, archive, runtime lock, bundle inventory, and payload inventory. They are integrity evidence for the named bytes, not independent publisher or builder authenticity. Public `main` artifacts receive GitHub artifact attestation. User-owned private repositories retain the checksums JSON and skip the unsupported attestation job.

PR qualification completes when the title matches the payload impact and every required check passes on the current head.

## Operate the optional Codex review gate

Require the `Codex review gate` status on `main` to make review opt-in without leaving every PR blocked. New PR commits start green. A maintainer with write access can comment `@codex review`; the status becomes pending. After the ChatGPT Codex Connector reports a clean review, inspect the conversation and comment `@codex-gate approve <reviewed-commit> <codex-comment-id>` using the 10- to 40-character reviewed SHA and the numeric ID from that exact Codex comment URL. When Codex reports findings, resolve them, push the fixes, and request another review of the new commit instead of approving the stale review.

Enable Codex code review for the repository before activating the required status. Approval requires write permission, the current commit, the exact bot-authored comment receipt bound to that commit, and no Codex review or inline-finding objects on it. The explicit attestation owns semantic judgment; the review conversation remains the source of finding details.

Review-gate qualification completes when the required status is green on the exact reviewed head.
