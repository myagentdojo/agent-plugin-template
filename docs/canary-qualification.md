# Qualify public and private canaries

Use this runbook when a change touches the owned release, package, install-proof, readiness, or canary infrastructure.

Public and private Git-repository canaries qualify publishing-system changes only. They are not required for every recipient plugin release. CI classifies the publishing-system paths that require this qualification.

For a manual qualification after merge, run from a clean checkout of the exact `origin/main` commit:

```sh
bun run ship:canary -- --dry-run --ref origin/main
bun run ship:canary -- --execute --ref origin/main
```

Unprivileged PR CI checks generated manifests with the candidate's own generator. The privileged canary driver executes only trusted base code. It accepts the exact same-repository PR head, binds the active `gh` login and real SSH or HTTPS Git transport identity to trusted canary targets, verifies visibility and the exact source SHA, and never executes candidate code. The private canary receives that source commit. The public canary receives a deterministic root commit containing only `plugin/`, the Claude and Codex marketplace files, and a trusted minimal hosted-proof workflow, so private repository source and history cannot become public. Each target uses `refs/heads/candidate/<published-commit-sha>` and a create-only lease: the missing ref may be created or an identical concurrent winner accepted, but an existing ref cannot be replaced. Execute mode waits for hosted CI, then installs both native Claude and Codex clients through each proven Git remote and compares their caches with the exact published candidate. Candidate qualification lineage additionally binds the source commit, archive checksum, packaged payload hash, and installed payload hash before native claims can be promoted. It never deletes, replaces, or reuses candidate history.

These canaries prove this repository's Git publishing transport and native Git-marketplace installation path. They do not validate or claim OpenAI universal-directory ZIP acceptance, review, approval, or publication.

Canary qualification completes when both visibility targets prove the exact source candidate and installed payload bytes.
