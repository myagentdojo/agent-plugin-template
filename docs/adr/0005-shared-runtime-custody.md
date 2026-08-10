# Share one verified Bun runtime across plugin skills

## Status

Accepted — 2026-08-05; production contract updated 2026-08-08 after ADR 0006
made Bun the only runtime.

## Context

A plugin can contain many dependency-bearing skills. If each skill owns fetch,
verification, extraction, cache publication, and repair, the same sensitive
bootstrap logic drifts across every launcher. Users also get repeated downloads
and setup instructions.

## Decision

One deep `runtime-custody` module owns the complete Bun lifecycle. Every skill
reaches it through a generated launcher and selects only a logical skill id.
No skill supplies a version, URL, digest, cache path, or installer.

- `runtime-exec` is the sole platform-selection, acquisition, verification,
  atomic-publication, revalidation, and execution engine.
- `runtime/runtime.lock.json` is the human-reviewed source for one exact Bun
  version and four official target assets. Generated shell data is checked into
  the payload.
- `runtime/skill-catalog.json` is the one logical registry mapping skill id to
  bundle identity and the Bun profile.
- `plugin/runtime/bundle-inventory.json` owns active digest-named workspace
  bundles and third-party notices.
- Generation emits one thin launcher per catalog member. Drift, missing
  members, orphan launchers, and mixed-runtime files block packaging.

The public command surface is deliberately small:

```text
run <skill-id> -- <args>
repair
repair --apply
```

`run` is custody-read-only. A valid digest-addressed runtime is reverified and
executes the selected reverified bundle. Missing or corrupt state returns typed
repair guidance. Repair preview is read-only and network-free. The agent or
native workflow presents the plain-language action and obtains human approval;
only then may it invoke `repair --apply`, the sole acquisition or replacement
operation.

The shared cache lives in private per-user XDG state. Executables are addressed
by reviewed executable SHA-256, published atomically on the same filesystem,
and reverified before every run. All trusted plugins using the same reviewed
Bun identity can reuse the immutable blob.

The engine is a small POSIX-shell stage zero using fixed absolute host-tool
candidates. It downloads only an official locked HTTPS asset, verifies archive
and executable bounds and hashes, extracts only the named member, and probes
the exact Bun version before publication. It never runs an upstream installer
or trusts ambient Bun, PATH, bunfig, preload, `.env`, or `node_modules` state.

## Trust and approval boundary

The publisher vouches for reviewed bundles and dependencies, which execute
with the user's normal Bun and OS capabilities. Runtime custody verifies the
admitted identity; it is not a sandbox. `repair --apply` carries explicit
mutation intent but does not authenticate a human. The invoking skill or native
client workflow owns the approval and its receipt.

## Proof

Repository proof covers missing and corrupt state, preview and apply,
interrupted and concurrent writers, hostile environment, cache permissions,
bundle/runtime tampering, argument pass-through, and shared warm reuse.
Platform CI selects and acquires each of the four reviewed assets, runs a
packaged skill, and proves warm execution with custody network denied. Native
Claude and Codex receipts own discovery and the approval/repair/retry journey;
a named private manual receipt owns the bounded Codex Desktop smoke. The
capability-tour lifecycle sidecar is proved separately: it never selects,
installs, repairs, or prewarms this runtime.

## Consequences

- Adding a skill is workspace/bundle work plus a catalog entry and regeneration;
  custody logic remains single-owned.
- A Bun identity change is one reviewed lock decision and requires fresh human
  approval. Archive-only metadata changes retain the approved executable
  identity while still requiring full acquisition verification.
- Cold offline repair returns retry-later guidance and publishes nothing. Warm
  verified use works offline.
- The active contract supports Bun only. Another runtime requires a new
  decision, not a generic registry or per-skill bootstrap framework.
- The capability tour has one dependency-free, fail-open `SessionStart`/`Stop`
  lifecycle mechanics proof. It is not a runtime-custody hook and provides no
  production integrity or security guarantee.
- Runtime setup hooks, prewarm, doctor, inventory, prune, automatic repair-on-run,
  and user-managed setup commands remain absent.
