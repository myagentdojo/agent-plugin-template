# Agent plugin repository template

Build one Git-distributed plugin for Claude Code and Codex.

- Share skills and portable runtime behavior.
- Keep native manifests and reload behavior separate.
- Author in Bun and TypeScript.
- Execute dependency-closed bundles through one verified, plugin-managed Bun runtime.
- Publish from GitHub Releases, not npm.
- Develop through each harness's native plugin workflow.

Contributors need Git and [Bun](https://bun.sh/docs/installation). Plugin consumers need Claude Code or Codex and Git access to the repository. They do not need a user-managed Bun, Node.js, Python, npm, or setup command.

## Choose a path

| Goal | Start |
| --- | --- |
| Create a plugin repository from this template | Continue at [Create a plugin repository](#create-a-plugin-repository). |
| Extend an initialized plugin repository | Continue at [Add plugin behavior](#add-plugin-behavior). |
| Install, upgrade, replace, or roll back a release | Read [Install, upgrade, or roll back a release](docs/installing.md). |
| Open or qualify a pull request | Read [Pull requests and CI](docs/pull-requests-and-ci.md). |
| Configure GitHub release automation | Read [Configure release automation](docs/release-setup.md). |
| Qualify fresh native capabilities | Read [Qualify fresh native capabilities](docs/native-capability-qualification.md). |
| Publish a release | Read [Publish a release](docs/publishing.md). |
| Maintain or repair release state | Read [Maintain or repair release state](docs/release-repair.md). |
| Qualify publishing-system changes with public/private canaries | Read [Qualify public and private canaries](docs/canary-qualification.md). |
| Change the distribution architecture or its language | Read [`CONTEXT.md`](CONTEXT.md), then the relevant [ADR](docs/adr/). |

## Create a plugin repository

### 1. Initialize the repository

Create a repository from this GitHub template, clone it, and install the locked development dependencies:

```sh
bun install --frozen-lockfile
```

Initialize the plugin identity once:

```sh
bun run init -- \
  --name dojo-hello \
  --display-name "Dojo Hello" \
  --author "My Agent Dojo" \
  --repository https://github.com/myagentdojo/dojo-hello
```

`plugin.config.json` owns plugin metadata. Generation derives both marketplace catalogs and native manifests.

```sh
bun run generate:check
```

Initialization completes when `generate:check` passes and every generated identity surface names the new plugin.

Continue at [Add plugin behavior](#add-plugin-behavior).

## Add plugin behavior

### Source owners

- `plugin.config.json`: plugin identity, version, and canary configuration.
- `runtime/runtime.lock.json`: approved Bun version and per-platform asset identity.
- `plugin/skills/<id>/SKILL.md`: installed skill workflow.
- `runtime/src/`: shared portable command logic.
- `packages/<id>/`: dependency-bearing workspace code.
- `runtime/skill-catalog.json`: logical skill registration.
- `plugin/`: complete installed Plugin Payload for both harnesses.

Both marketplace catalogs point at `./plugin`. Development staging, Git installation, packaging, and distribution proof all start from that subtree. Repository scripts, TypeScript source, Git metadata, and development state cannot enter the installed payload.

Edit these owners and commit their generated files together. Generated manifests, launchers, bundle inventories, and `plugin/runtime/*.js` name their source; regenerate them instead of editing them directly.

### 1. Implement the behavior

Keep portable command logic under `runtime/src/`. Add dependency-bearing skills as isolated workspace members, register them in `runtime/skill-catalog.json`, then regenerate the closed bundles and launchers.

```sh
bun run build
bun run generate:check
```

The change is internally complete when the catalog, generated launchers, bundle inventory, notices, and manifests match their sources.

### 2. Develop in both harnesses

Run profile-safe preparation checks first. These commands build local output and Codex staging without changing harness settings or installed plugins:

```sh
bun run dev -- claude --check
bun run dev -- codex --check
```

#### Claude Code

```sh
bun run dev:claude
```

The command builds portable JavaScript, watches runtime source, skills, hooks, and manifests, launches `claude --plugin-dir ./plugin`, and disables the installed production plugin only inside that process. After an edit, wait for the successful rebuild, then run `/reload-plugins` in the same Claude session.

Claude development completes when the reloaded session discovers and runs the changed skill from the checkout.

#### Codex

```sh
bun run dev:codex
```

Codex plugins are cached rather than loaded directly from the checkout. The command builds `plugin/`, copies it into ignored `.dev` staging, adds build metadata only to the staged Codex version, creates or validates the local development marketplace, reinstalls the plugin, and launches Codex. After an edit, rerun the command and start a fresh task.

Codex development completes when a fresh task discovers and runs the changed staged plugin.

Use the native development commands. A skills-only symlink or harness-global copy bypasses the manifests, launchers, runtime custody, cache identity, and installation boundary under test.

### 3. Prove the change

Run the local gate:

```sh
bun test
bun run generate:check
bun run release:validate
bun run prove:all
```

Local proof completes when the current worktree contains only the intended diff and `prove:all` passes. Then follow [Pull requests and CI](docs/pull-requests-and-ci.md) for PR naming, payload-impact classification, and hosted qualification.

## Architecture at a glance

```text
plugin/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── skills/{hello-world,runtime-custody,skill-a,skill-b}/SKILL.md
├── bin/{hello-world,skill-a,skill-b}
├── THIRD-PARTY-NOTICES.md
└── runtime/
    ├── runtime-exec
    ├── runtime-lock.sh
    ├── skill-catalog.sh
    ├── bundle-inventory.{json,sh}
    ├── hello-world.js
    └── skill-{a,b}-<digest>.js
```

The portable process seam is:

```text
skill id + arguments + invocation identity
    -> stdout + stderr + exit code
```

| Area | Shared | Claude Code | Codex |
| --- | --- | --- | --- |
| Skills | Portable Agent Skills content | `/PLUGIN:SKILL` invocation and Claude extensions | `$SKILL` invocation and Codex extensions |
| Runtime | Closed bundles, generated launchers, and one Bun custody engine | Executes the shared launcher | Executes the shared launcher |
| Manifest | Plugin identity only | Claude-native manifest | Codex-native manifest |
| Lifecycle hooks | One shared fail-open mechanics handler | Native `SessionStart`/`Stop` declaration; plugin enablement controls activation | Native `SessionStart`/`Stop` declaration; exact hook definition requires user trust |
| Development refresh | Source and payload | Direct checkout plus `/reload-plugins` | Staged reinstall plus a fresh task |
| Harness-only features | Nothing by default | Keep Claude-only components native | Keep Codex-only components native |

Use [`CONTEXT.md`](CONTEXT.md) for canonical language. The architecture rationale lives in the ADRs for [one payload with native adapters](docs/adr/0001-one-payload-native-harness-adapters.md), [shared runtime custody](docs/adr/0005-shared-runtime-custody.md), [one Bun runtime](docs/adr/0006-single-bun-runtime-tier.md), and [closed workspace bundles](docs/adr/0007-workspace-authoring-bundled-distribution.md).

## Proof commands

- `bun test`: initializer, metadata, CLI, release, development, and canary contracts.
- `bun run generate:check`: generated manifests match `plugin.config.json`.
- `bun run build`: regenerate the Bun hello-world bundle, workspace bundles, notices, and inventory.
- `bun run prove:runtime-custody`: exercise missing, repair, corruption, concurrency, hostile-environment, and pass-through behavior.
- `bun run prove:runtime-platform -- --target <target>`: acquire the reviewed target asset, execute the packaged skill, and prove warm offline reuse.
- `bun run prove:distribution`: build twice, compare package bytes, extract the payload, prove Bun-only closure, and verify cold read-only guidance.
- `bun run prove:dx`: verify canonical marketplace paths and native development boundaries.
- `bun run prove:all`: complete local gate.

## Current boundaries

- macOS arm64/x64 and Linux arm64/x64 only.
- The locked x64 baseline assets support AVX-capable CPUs for this Bun 1.3.14 candidate. Older no-AVX x64 hosts are outside the support boundary; custody executes `bun --version` before publication and refuses an unusable binary.
- Bun is pinned by version and per-target archive/executable digests; users do not install or pin it themselves.
- Publisher-reviewed bundles and dependencies execute with the user's normal Bun and OS capabilities. This is not a sandbox or an untrusted-plugin runtime.
- The build rejects native addons, statically visible computed loaders and direct `eval`/`Function` use, undeclared assets, and runtime package installation. These are deterministic bundle-hygiene checks, not adversarial capability confinement; publisher review owns indirect or obfuscated code, and architecture-layer isolation owns untrusted code ([ADR 0006](docs/adr/0006-single-bun-runtime-tier.md)).
- Claude reloads a direct development plugin in the existing session. Codex needs a staged reinstall and fresh task.
- The capability-tour `SessionStart`/`Stop` sidecar is a fail-open lifecycle mechanics proof, not a production integrity or security guarantee. Runtime setup hooks, prewarm, doctor, inventory, and prune commands remain absent.
- Managed, workspace-installed, or non-removable plugins require administrator replacement or rollback.
- Vendor plugin specifications change. Recheck the official documentation linked from the [installation guide](docs/installing.md) and [maintainer index](docs/releasing.md) when manifests, discovery, installation, or reload behavior changes.
