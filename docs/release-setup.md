# Configure release automation

Use this runbook once per repository before enabling Release Please maintenance or publication.

1. Open **Settings → Actions → General → Workflow permissions**. Keep the default workflow permission read-only and allow GitHub Actions to create and approve pull requests.
2. Enable squash merging for all PRs, including Release Please PRs. Merge commits may remain available as an optional release-PR path. Publication does not trust a merge-mode label: it verifies either a one-parent candidate or a two-parent merge candidate against the reviewed PR and its frozen base.
3. Protect `main` in two places. In **Settings → Branches → Branch protection rules**, require `Conventional Commit title`, `Release impact`, `Hosted public and private Git canaries`, all four `Compatibility` checks, and `Deterministic package`; readiness reads that classic branch-protection endpoint. In an active, no-bypass `main` ruleset, enable **Require a pull request before merging** and **Block force pushes**.
4. Open **Settings → Rules → Rulesets**. Create an active tag ruleset for `v*` that restricts tag deletion and updates with no bypass actors.
5. Open **Settings → Environments**. Create `release` and configure required reviewers for publication and same-tag asset replacement.
6. Create the public and private canary repositories named by `plugin.config.json`, then create the `hosted-canary-qualification` environment. Add `CANARY_GH_TOKEN`: a fine-grained token for the exact configured `canary.actor`, scoped only to both canary repositories, with Contents read/write, Actions read, and metadata read. Add `CANARY_SSH_PRIVATE_KEY` and `CANARY_SSH_KNOWN_HOSTS` for the same canary identity. Qualification uses the token-backed GitHub API identity and SSH Git identity, and limits writes to create-only immutable candidate refs. Keeping Git transport on SSH allows candidates containing workflow files without broadening the API token.

   Keep secret values out of repository files, logs, and readiness output. `bun run readiness` proves repository configuration and required environment, variable, and secret names; it never reads secret values or proves real credential access. Hosted qualification binds the token-backed GitHub API identity and SSH Git identity and proves their real access.
7. Create a fine-grained token with only repository contents, pull requests, and issues write access. Store it as the GitHub Actions repository secret `RELEASE_PLEASE_TOKEN`. Record its expiry and rotate the stored token before expiry or revocation.
8. Set the repository variable `RELEASE_PLEASE_AUTOMATION_LOGIN` to the exact login that token uses to author the release PR.
9. Authenticate `gh` with read access to repository settings, then run `bun run readiness -- --repo OWNER/REPOSITORY`.
10. Enable release automation only after readiness reports `READY`.

The immutable `v*` tag ruleset and the no-bypass `main` ruleset are human-owned safeguards outside the workflow. The `main` ruleset prevents a force push from steering the push event's trusted pre-merge base. Release automation never receives repository-administration authority; it cannot change either ruleset or its own release environment. `bun run readiness` is read-only and fails closed when the default branch, squash path, direct-push protection, effective merge-history policy, required checks, Actions permissions, tag ruleset, hosted-canary environment and secret names, or workflow authority cannot be proved. It reads secret metadata only, never secret values.

Release automation requires `RELEASE_PLEASE_TOKEN`; it does not fall back to `GITHUB_TOKEN`. GitHub suppresses workflow runs caused by `GITHUB_TOKEN`, which would leave the generated release PR without its required checks. The separate repository variable `RELEASE_PLEASE_AUTOMATION_LOGIN` records the exact login that owns the token; both the release-impact gate and publication admission bind that identity.

Setup completes when `bun run readiness -- --repo OWNER/REPOSITORY` reports `READY`.
