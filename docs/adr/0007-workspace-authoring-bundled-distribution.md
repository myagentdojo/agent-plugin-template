# Author in a Bun workspace, ship bundled dependency-free skills

## Status

Accepted — 2026-08-06. Complements ADR 0006 (single Bun runtime) and ADR 0005
(shared runtime custody). Where those decide how the *runtime* reaches the
consumer, this decides how *dependencies* do.

## Context

ADR 0006 makes every plugin a bootstrapped-Bun program, and ADR 0005 shares one
runtime across many skills. That solves runtime custody but leaves a separate
cost: each skill has its own dependencies. With ~20 skills, each carrying a
`package.json`, the questions are: how are dependency versions kept consistent,
and what does the consumer have to install?

Bootstrapping the runtime is cheap and one-time (ADR 0006). Installing
dependencies per consumer is not: it reintroduces network fetches, lockfile
reconciliation across many packages, offline failure, and the Python-style
"present but fighting the package manager" friction — the exact costs the
runtime bootstrap was designed to avoid.

The repository already demonstrates the answer. It is a Bun workspace whose
members are the skills and runtime packages, with a **catalog** pinning shared
dependency versions once. Its browser-use skill ships `files: ["dist"]` built
by a bundling step — it distributes a bundled artifact, not its `package.json`
dependencies or a `node_modules` tree.

## Decision

Separate authoring from distribution.

- **Authoring: one Bun workspace.** All skills are workspace members. A
  workspace **catalog** pins shared dependency versions once, so 20 skills
  cannot drift onto different versions of a shared library, and one root
  `bun install` resolves everything into one hoisted `node_modules`. Adding a
  skill is adding a workspace member.
- **Distribution: per-skill bundles, dependency-free.** Each skill is bundled
  (`bun build`) into a self-contained artifact with its dependencies inlined.
  The shipped plugin contains bundled entrypoints, never `node_modules`, never
  per-skill `package.json` dependencies, and never a consumer-side install
  step. This is the pattern browser-use already ships.

The consumer therefore pays the runtime bootstrap once (ADR 0006) and installs
**zero dependencies, ever**. Dependencies are resolved at author build time, in
the author's workspace, and baked into the artifact.

### Per-skill vs whole-plugin bundling

Chosen: **per-skill bundles** — one self-contained artifact per skill, matching
browser-use. Skills stay independently buildable and shippable; the launcher
(ADR 0005 custody engine) selects a skill's bundled entrypoint.

Rejected: **one whole-plugin bundle** with shared dependencies deduplicated.
It avoids duplicating a shared library across bundles, but couples all skills
into one build and weakens independent shipping. The saving is bundle *size*,
not install *cost* (install cost is already zero), and any duplication is
trivial next to the ~60 MB bootstrapped runtime. Not worth the coupling.

## Consequences

- The "20 skills each with a package.json" problem does not exist at
  distribution time: none of those `package.json` files or their `node_modules`
  ship. They are authoring-time inputs only.
- Consumer install cost is the runtime bootstrap alone. No dependency fetch, no
  lockfile reconciliation, no offline-install failure.
- Shared dependency versions are governed once by the workspace catalog, so
  skills cannot silently diverge; a build-time check can enforce that a skill
  declares only catalog-pinned or explicitly-allowed versions.
- A shared library used by several skills is duplicated across their bundles.
  This costs bundle size, not install time, and is negligible against the
  runtime. Revisit only if total artifact size becomes a real constraint.
- Bundling is the release-time boundary: the payload walker, checksums, and
  distribution proof (from the publishing-hardening work) apply to the bundled
  artifacts, not to source or `node_modules`.

## Follow-up

- Make per-skill bundling a generated, catalog-aware build step in the template
  (each workspace skill → one `dist/<skill>.js`), mirroring browser-use's
  `build-dist`.
- Add a build-time check that a skill's dependencies resolve only to
  catalog-pinned (or explicitly allowed) versions, preventing drift across the
  workspace.
- Confirm the bundled artifacts are what the ADR 0005 catalog entries point at,
  so custody/exec runs the bundle, never a source tree needing install.
