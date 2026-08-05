# Decision 0001: Native development and versioned promotion

Status: prototype accepted when `bun run prove:all` passes.

## Decision

Keep one canonical plugin tree. Use harness-native loading and update boundaries.

| Lane | Build | Delivery | Reload boundary |
| --- | --- | --- | --- |
| Claude development | Bun watcher | `claude --plugin-dir <checkout>/plugin` | `/reload-plugins` |
| Codex development | Bun build | full staged copy, cachebuster, `codex plugin add` | fresh task |
| Production | release PR plus full proof | versioned Git marketplace payload and GitHub Release | marketplace update plus harness reload/start |

Do not use skill syncing or symlinks. Codex's linked-skill technique cannot represent hooks, manifests, or runtime files.

## Why

- Claude loads a checkout directly and reloads plugin components in a running session.
- Codex installs plugins into a cache. A full plugin therefore needs a staged copy and reinstall during development.
- Current Codex starts a Git marketplace upgrade task and refreshes installed plugin caches when the marketplace advances.
- Both native manifests carry the same explicit semantic version. Ordinary commits on `main` do not advance the installed production version.
- Release Please maintains one human-reviewed release PR. Merging it updates every version surface and `CHANGELOG.md`, then the release workflow proves the exact commit before creating the tag and GitHub Release.
- A merged release commit contains generated JavaScript with the new version because PR and release validation reject source, metadata, and distribution drift.

## Commands

```sh
bun run dev:claude
bun run dev:codex
bun run dev -- codex --check
bun run prove:all
bun run release:validate
```

## Consequences

- Claude gives the fastest loop: save, rebuild, `/reload-plugins`.
- Codex requires a fresh task after each full-plugin reinstall. Do not claim live hot reload.
- Merging a normal PR changes `main` but does not publish a version.
- Merging the generated release PR creates the version boundary after the release proof passes.
- Users refresh their marketplace and reload or start a fresh task to observe a released version.
- Release archives stay small because four QuickJS executables compress together to about 3.46 MB.
