# Context Map

This repo is multi-context. Each context owns its own vocabulary; this map says where to read.

Consumer rules for these files: `docs/agents/domain.md`.

## Contexts

| Context | Glossary | Context ADRs | Scope |
| --- | --- | --- | --- |
| **System-wide** | [`CONTEXT.md`](./CONTEXT.md) | [`docs/adr/`](./docs/adr/) | Plugin distribution across Harnesses: Plugin Payload, Harness Adapter, Portable Runtime, Marketplace, Release, Capability Tour, and the capability boundaries. |
| **skill-a** | `packages/skill-a/CONTEXT.md` _(not yet created)_ | `packages/skill-a/docs/adr/` _(not yet created)_ | Dependency-bearing workspace skill. Currently an ESM/CJS interop boundary fixture. |
| **skill-b** | `packages/skill-b/CONTEXT.md` _(not yet created)_ | `packages/skill-b/docs/adr/` _(not yet created)_ | Dependency-bearing workspace skill. Currently an ESM/CJS interop boundary fixture. |

Entries marked _not yet created_ are intentional. Per-context files are created lazily by `/domain-modeling` when a context develops vocabulary or decisions of its own. Until then, the system-wide glossary governs.

## Which glossary governs

- A term describing distribution, packaging, harness behavior, runtime custody, or release → **system-wide** `CONTEXT.md`.
- A term meaningful only inside one workspace package → that package's `CONTEXT.md`; create it when the term first needs pinning.
- A decision affecting more than one context → `docs/adr/` at the root, not a context ADR.

## Non-contexts

`plugin/`, `runtime/`, and `scripts/` are not contexts. `plugin/` is generated output, and `runtime/` and `scripts/` are owned by the system-wide glossary. Ownership for editing these lives in [`AGENTS.md`](./AGENTS.md).
