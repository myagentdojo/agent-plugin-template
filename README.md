# Agent plugin repository template

One Git-distributed plugin per repository. Shared skills and runtime. Native Claude Code and Codex adapters. No skill syncing, symlinks, npm publication, or runtime dependency on Bun, Node.js, or Python.

After creating a repository from this GitHub template, initialize its identity once:

```sh
bun run init -- \
  --name dojo-hello \
  --display-name "Dojo Hello" \
  --author "My Agent Dojo" \
  --repository https://github.com/myagentdojo/dojo-hello
```

`plugin.config.json` is the only plugin metadata source. `bun run generate` derives both native manifests and both marketplace catalogs. CI fails when a generated file drifts.

Then run:

```sh
bun run prove:all
```

## Canonical payload

```text
plugin/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── skills/hello-world/SKILL.md
├── hooks/
│   ├── claude/hooks.json
│   └── codex/hooks.json
├── bin/hello-world
├── QUICKJS-LICENSE
└── runtime/
    ├── hello-world.js
    ├── quickjs-assets.json
    └── qjs-{darwin,linux}-{arm64,x86_64}
```

Both marketplace catalogs point at `./plugin`. The release archive copies that subtree exactly. Repository source, scripts, Git metadata, development staging, and old compiled Bun artifacts cannot enter the plugin install.

## Runtime model

Maintain TypeScript under `runtime/src/`. Bun builds the standards-only command contract into `plugin/runtime/hello-world.js`.

The launcher selects one bundled QuickJS NG `0.16.1` executable for macOS arm64/x64 or Linux arm64/x64. Runtime execution is offline. The deterministic archive is about 3.46 MB compressed.

This is not `bun build --compile`. Bun is the authoring and build tool. QuickJS is the small portable execution engine.

## Shared versus host-specific

Share:

- `skills/`
- TypeScript command logic
- generated JavaScript
- launcher and QuickJS executables
- future standards-based MCP server implementation

Keep native:

- plugin manifests
- hook declarations
- trust and reload behavior
- Claude-only agents, LSP servers, monitors, themes, output styles, and settings
- Codex-specific marketplace interface and policy metadata

See `docs/research/claude-code-vs-codex-plugins.md` for the researched compatibility matrix.

## Development

Claude Code:

```sh
bun run dev:claude
```

This builds and launches `claude --plugin-dir ./plugin`. Save source, let the watcher rebuild, then run `/reload-plugins`.
The launch applies a session-only settings override for the production plugin ID, so an installed marketplace copy cannot contribute stale skills or hooks. Persistent Claude settings remain unchanged.

Codex:

```sh
bun run dev:codex
```

This copies the exact canonical plugin into ignored staging, changes only the staged Codex version with a local cachebuster, reinstalls from a local marketplace, and launches Codex. Start a fresh task after edits.

## Marketplace install proof

The Git repository is directly installable in both hosts. Substitute the repository and plugin name written to `plugin.config.json`:

```sh
claude plugin marketplace add OWNER/REPOSITORY
claude plugin install PLUGIN_NAME@PLUGIN_NAME

codex plugin marketplace add OWNER/REPOSITORY --ref main
codex plugin add PLUGIN_NAME@PLUGIN_NAME
```

See `docs/prototypes/0001-marketplace-install-and-dev-mode.md` for the live install and edit-reload evidence.

Inspect without changing harness state:

```sh
bun run dev -- claude --check
bun run dev -- codex --check
```

## Proofs

- `bun test`: prove init, generated metadata, CLI discovery, development identity, and canary orchestration.
- `bun run generate:check`: prove checked-in manifests match `plugin.config.json`.
- `bun run build`: regenerate portable JavaScript.
- `bun run spike:quickjs`: compare Bun and QuickJS behavior on the host.
- `bun run prove:distribution`: package twice, prove deterministic bytes, extract offline, verify every interpreter digest, and run both hook adapters.
- `bun run prove:dx`: verify canonical marketplace paths and native reload contracts.
- `bun run prove:quickjs-ci`: verify runtime equivalence, distribution, four-host CI, pinned actions, and public-repository attestation configuration.
- `bun run prove:all`: run the complete local gate.

`.github/workflows/plugin-ci.yml` runs the compatibility matrix, packages the exact plugin, and uploads a PR/main artifact. Public repositories also attest the main artifact. GitHub does not offer artifact attestations to user-owned private repositories, so private template instances skip that job and retain the generated provenance JSON.

## Public and private canaries

After the implementation is merged, use a clean checkout of `origin/main`:

```sh
bun run ship:canary -- --dry-run
bun run ship:canary -- --execute
```

The command verifies the active GitHub identity, target visibility and lineage, clean source commit, and generated manifests. Execute mode creates missing canary repositories without starter commits, performs fast-forward-only pushes, and waits for both hosted workflows. It never force-pushes or rewrites canary history.

## Boundaries

- macOS arm64/x64 and Linux arm64/x64 only.
- Future Bun-specific dependencies require a new runtime compatibility decision.
- Codex plugin hooks require explicit trust for the current hook definition.
- Production update visibility is a harness refresh/start boundary, not an instantaneous result of merging to `main`.
