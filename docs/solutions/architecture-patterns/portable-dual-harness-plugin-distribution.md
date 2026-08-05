---
title: Portable dual-harness plugin distribution
date: 2026-08-05
category: architecture-patterns
module: agent-plugin-template
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - One Git repository distributes the same plugin capability to Claude Code and Codex
  - Runtime code is authored in Bun TypeScript but recipients cannot be assumed to have Bun, Node.js, Python, or npm
  - Skills and portable behavior can be shared while manifests, hooks, trust, and reload semantics differ by harness
  - The plugin needs both Git marketplace installation and a practical local development loop
  - Public and private repositories need the same delivery model with explicit provenance boundaries
related_components:
  - development_workflow
  - testing_framework
  - documentation
tags:
  - agent-plugins
  - claude-code
  - codex
  - bun
  - quickjs
  - git-marketplace
  - native-hooks
  - portable-runtime
---

# Portable dual-harness plugin distribution

## Context

This repository began with a portability problem, not a TypeScript problem. Plugin logic was comfortable to author and test with Bun, but a Claude Code or Codex user should not need Bun, Node.js, Python, npm, a post-install download, or network access at execution time.

Three plausible approaches were rejected:

1. Publishing the runtime to npm would add a second registry and install lifecycle even though each harness already installs a complete plugin from Git.
2. Shipping one `bun build --compile` executable per platform produced an aggregate prototype release observed during this session at roughly 305 MB. The experiment was not retained as a repository artifact, but it showed that embedding Bun four times was disproportionate to the command being delivered.
3. Syncing or symlinking only skill directories could not represent the plugin-level manifests, hooks, launcher, runtime, and assets that form the complete product.

The accepted shape is one Git-distributed repository with one canonical plugin payload, shared portable behavior, and thin native harness adapters:

```text
runtime/src/*.ts                    Bun authoring and build-time proof
        |
        v
plugin/runtime/hello-world.js       generated standards-oriented JavaScript
        |
        +-- plugin/bin/hello-world  selects a bundled QuickJS executable
        +-- plugin/skills/          shared Agent Skills subset
        +-- plugin/hooks/claude/    Claude-native declarations
        +-- plugin/hooks/codex/     Codex-native declarations
        +-- plugin/.claude-plugin/  Claude-native manifest
        +-- plugin/.codex-plugin/   Codex-native manifest
```

A live prototype exposed one boundary that static checks missed. A historical shared default hook declaration, removed by this fix, was also auto-discovered by Claude Code. Claude then ran the Codex command without a usable root variable. The fix physically separated declarations at `plugin/hooks/claude/hooks.json` and `plugin/hooks/codex/hooks.json`, pointed each manifest to its own declaration, and added a proof that rejects a reintroduced shared default hook file.

## Guidance

### Treat `plugin/` as the distribution boundary

Keep every consumer-required file under `plugin/`. Both marketplace catalogs point to `./plugin`; development staging and packaging copy this same subtree through `scripts/plugin-files.ts`.

Package the subtree exactly. Do not package the repository root and maintain an exclusion list. The positive boundary keeps TypeScript, scripts, Git state, CI configuration, `node_modules`, and development state out of installed plugins by construction.

### Use Bun for authorship, not consumer execution

Bun owns repository development: tests, metadata generation, TypeScript bundling, packaging, and CI. `scripts/build.ts` emits browser-targeted ESM for the portable runtime. It does not use `bun build --compile`.

QuickJS owns installed execution. `plugin/bin/hello-world` selects one checksum-pinned runtime for macOS arm64, macOS x64, Linux arm64, or Linux x64, then executes the generated JavaScript. The distribution proof extracts the package and runs the launcher through both harness command contracts with `PATH=/usr/bin:/bin`.

Keep portable behavior behind a narrow process seam:

```text
arguments + complete stdin + invocation identity
    -> stdout + stderr + exit code
```

Do not assume arbitrary Bun or Node libraries work in QuickJS. A dependency on `Bun.*`, `node:*`, native addons, dynamic package resolution, or unsupported Web APIs reopens the runtime decision and requires a fresh compatibility proof.

### Share behavior and preserve host semantics

Share only the portable overlap:

- Agent Skills written to the supported cross-harness subset.
- Portable TypeScript command logic and generated JavaScript.
- Launcher and checksum-pinned QuickJS assets.
- Standards-based runtime components whose configuration is validated separately in both hosts.

Keep these native:

- `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`.
- Claude and Codex hook declarations.
- Root variables, command syntax, matchers, handler types, trust, and reload behavior.
- Features that exist in only one harness.

The current hooks call the same launcher but use different root variables. Similar event names do not make their JSON safely interchangeable. The dated compatibility matrix in [Claude Code and Codex plugins](../../research/claude-code-vs-codex-plugins.md) owns the detailed host comparison.

### Generate native metadata from one config

Use `plugin.config.json` as the identity and presentation owner. `scripts/plugin-config.ts` derives both marketplace catalogs and both native manifests; `bun run generate:check` rejects drift.

Stable production releases embed the same semantic version in both native manifests. This prevents an unreleased commit on `main` from presenting itself as a new published plugin version. Development bypasses that boundary through Claude's direct plugin directory or Codex's staged build-metadata cachebuster.

One config means one metadata owner, not identical host manifests.

### Use each harness's native development boundary

Claude Code supports direct checkout development:

```sh
bun run dev:claude
```

The command builds, watches portable source and plugin files, and launches Claude with `--plugin-dir <checkout>/plugin`. It disables an installed production copy only inside that launched process. After a successful rebuild, run `/reload-plugins` in the Claude session.

Codex uses a staged development marketplace:

```sh
bun run dev:codex
```

The command copies the canonical payload to ignored staging, changes only the staged Codex version with build metadata, creates or validates a local marketplace, reinstalls the plugin, and launches Codex. Rerun after edits and use a fresh task. This is reinstall-and-restart, not hot reload.

Use profile-safe preparation checks before mutating either harness profile. They build and stage local files, but do not change harness settings or installed plugins:

```sh
bun run dev -- claude --check
bun run dev -- codex --check
```

### Gate merges and distinguish artifacts from releases

Run the local gate before a PR:

```sh
bun test
bun run generate:check
bun run prove:all
```

Hosted CI runs native QuickJS compatibility on the four supported platform pairs, packages only after that matrix passes, rejects generated-runtime drift, and uploads the archive plus provenance JSON. Public `main` artifacts receive GitHub artifact attestation; private user-owned repositories retain deterministic provenance without claiming unsupported attestation.

A CI artifact proves a commit. A production release additionally owns the semantic version, generated changelog, tag, GitHub Release, and attached package. Do not use npm as a release intermediary.

### Prove the template in clean public and private recipients

Template CI is necessary but insufficient. Initialize clean public and private recipients, run local gates after replacing identity, push without force, and verify their hosted workflows. `scripts/ship-canary.ts` checks active GitHub identity, repository visibility, generated metadata, no tracked changes, source lineage, and target fast-forward safety before publishing.

The public recipient's hosted workflow was independently reverified as successful on 2026-08-05. The session record reports the corresponding private recipient run and public HTTPS plus private SSH marketplace acceptance in both harnesses, but the private evidence requires an authorized GitHub identity and was not independently reverified during documentation grounding. Treat all live-harness acceptance as dated and rerun it when host behavior changes.

## Why This Matters

The model separates three concerns:

- **Authorship:** Bun and TypeScript provide the contributor experience.
- **Distribution:** each harness installs one complete plugin from Git.
- **Execution:** installed commands use bundled QuickJS runtimes offline.

One payload removes projection drift. The same canonical payload feeds marketplace installation, deterministic packages, and offline proof. Codex development stages that payload and changes only its native manifest version with a cachebuster. Separate native adapters preserve the real safety and reload contracts of each harness.

The size trade-off is practical: four QuickJS assets total about 7.7 MB uncompressed and about 3.46 MB in the deterministic archive, compared with the session-observed 305 MB Bun standalone experiment. Determinism comes from sorted entries, normalized timestamps and ownership, timestamp-free gzip, and a proof requiring two independently produced archives to have the same SHA-256 digest.

## When to Apply

Apply this pattern when:

- One plugin installs into Claude Code and Codex from Git.
- Skills and core command behavior are substantially shared.
- Runtime code can be expressed as standards-oriented JavaScript plus a small adapter.
- Offline execution, private repositories, or minimal consumer prerequisites matter.
- Production support can be bounded to the shipped macOS and Linux architectures.
- Native trust, manifest, hook, and reload behavior must stay explicit.

Reconsider it when Windows is required, the runtime needs Bun or Node primitives, host-specific skill metadata changes meaning, or a vendor-operated catalog rather than a Git marketplace is the product requirement.

## Examples

Initialize a repository created from the template:

```sh
bun run init -- \
  --name dojo-hello \
  --display-name "Dojo Hello" \
  --author "My Agent Dojo" \
  --repository https://github.com/myagentdojo/dojo-hello

bun run generate:check
bun run prove:all
```

Install the same public plugin in both harnesses:

```sh
claude plugin marketplace add OWNER/REPOSITORY
claude plugin install PLUGIN_NAME@PLUGIN_NAME

codex plugin marketplace add OWNER/REPOSITORY --ref main
codex plugin add PLUGIN_NAME@PLUGIN_NAME
```

Private repositories use the same plugin payload through an authenticated Git transport. Verify the active host identity first. No npm publication is required.

## Related

- [Canonical dual-harness plugin decision](../../decisions/0004-canonical-dual-harness-plugin.md)
- [Development and promotion decision](../../decisions/0002-development-and-main-promotion.md)
- [QuickJS compatibility decision](../../decisions/0003-quickjs-compatibility-spike.md)
- [Marketplace and development-mode prototype](../../prototypes/0001-marketplace-install-and-dev-mode.md)
- [Claude Code and Codex compatibility matrix](../../research/claude-code-vs-codex-plugins.md)
- [Versioned plugin releases with Release Please](../workflow/versioned-plugin-releases-with-release-please.md)
- [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [Build Codex plugins](https://developers.openai.com/plugins/build/plugins)
- [Codex plugin documentation](https://learn.chatgpt.com/docs/plugins)
