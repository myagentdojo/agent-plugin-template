# Decision 0002: Native development and main promotion

Status: prototype accepted when `bun run prove:all` passes.

## Decision

Keep one canonical plugin tree. Use harness-native loading and update boundaries.

| Lane | Build | Delivery | Reload boundary |
| --- | --- | --- | --- |
| Claude development | Bun watcher | `claude --plugin-dir <checkout>/plugin` | `/reload-plugins` |
| Codex development | Bun build | full staged copy, cachebuster, `codex plugin add` | fresh task |
| Production | PR check plus main rebuild | Git marketplace tracking `main` | harness startup |

Do not use skill syncing or symlinks. Codex's linked-skill technique cannot represent hooks, manifests, or runtime files.

## Why

- Claude loads a checkout directly and reloads plugin components in a running session.
- Codex installs plugins into a cache. A full plugin therefore needs a staged copy and reinstall during development.
- Current Codex starts a Git marketplace upgrade task and refreshes installed plugin caches when the marketplace advances.
- Claude marketplace auto-update runs at startup when enabled. Omitting the Claude plugin version lets the Git commit SHA identify each update.
- A merged commit already contains the generated JavaScript because PR CI rejects source and distribution drift. The main workflow rebuilds, proves, and packages that exact commit.

## Commands

```sh
bun run dev:claude
bun run dev:codex
bun run dev -- codex --check
bun run prove:all
```

## Consequences

- Claude gives the fastest loop: save, rebuild, `/reload-plugins`.
- Codex requires a fresh task after each full-plugin reinstall. Do not claim live hot reload.
- Production updates appear at harness startup, not at the instant GitHub merges the PR.
- Release archives stay small because four QuickJS executables compress together to about 3.46 MB.
