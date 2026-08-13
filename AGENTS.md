# Agent Plugin Template

Build one Git-distributed plugin payload for Claude Code and Codex. Keep shared behavior portable; keep each harness's manifest, trust, and lifecycle adapter native.

## Owners

- Plugin metadata: edit `plugin.config.json`; run `bun run generate`.
- Release identity or version: route through `scripts/init.ts` or the generated release PR. `.github/release-please-config.json` owns the Release Please package name.
- Skill workflow: edit `plugin/skills/<id>/`.
- Portable implementation: edit dependency-free commands in `runtime/src/`; edit dependency-bearing workspace code in `packages/<id>/src/`; register bundles in `runtime/skill-catalog.json`.
- Runtime custody: edit the engine in `plugin/runtime/runtime-exec` or the approved runtime identity in `runtime/runtime.lock.json`; preserve `docs/adr/0005-shared-runtime-custody.md` and `docs/adr/0006-single-bun-runtime-tier.md`.
- Generated output: follow the source header when present. For headerless manifests and hook JSON, edit `plugin.config.json` and run `bun run generate`. For bundles, inventory, and notices, edit workspace sources and run `bun run build`. Commit source and output together.
- Release or publishing behavior: read `docs/adr/0003-reviewed-versioned-releases.md` and route through `docs/releasing.md`.
- Runtime or dependency distribution architecture: read `docs/adr/0006-single-bun-runtime-tier.md` and `docs/adr/0007-workspace-authoring-bundled-distribution.md` before editing.
- Harness adapters or lifecycle hooks: read `docs/adr/0001-one-payload-native-harness-adapters.md` and `docs/adr/0008-native-plugin-capability-tour.md` before editing.
- Historical plans: use `docs/plans/` for rationale only; reconcile every proposal with current code and accepted ADRs.

## Change Loop

1. Find the canonical source and its generated or packaged consumers.
2. Change the smallest owning surface; preserve Claude and Codex asymmetries.
3. For behavior changes, add focused contract coverage beside the owning script or runtime module.
4. Run the focused test, `bun run generate:check`, then the smallest relevant proof from `package.json`.
5. With both `claude` and `codex` on `PATH`, run `bun run prove:all` for payload, packaging, runtime-custody, or cross-harness changes; otherwise report the unavailable native prerequisite. Local completion means the worktree contains only the intended diff and every applicable local check passes.

## Proof Boundaries

- Keep harness tests isolated from real user profiles, plugin settings, credentials, caches, and persistent data.
- Outside isolated acknowledged fixtures, present the repair preview and obtain human approval before `repair --apply`; a changed Bun executable identity requires fresh approval.
- Treat direct handler execution and package-byte checks as mechanics proof, not native discovery, trust, activation, UI, or delegation proof.
- Fresh native completion: follow `docs/native-capability-qualification.md`; every bounded cell needs a human-recorded result bound to one candidate.
- Hosted or PR completion: follow `docs/pull-requests-and-ci.md`; every required check must pass on the current head. Revalidate canaries, safeguards, and release state before release claims.
- Raw native receipts: follow the private XDG location, permissions, and promotion boundary in `docs/native-capability-qualification.md`.
- Preserve the consumer contract: no user-managed Bun, Node.js, Python, npm, or setup command.

Initialization, development, installation, replacement, qualification, or release: start at `README.md`'s **Choose a path** index.
