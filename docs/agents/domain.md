# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo is **multi-context**: `CONTEXT-MAP.md` at the root points at each context's `CONTEXT.md`.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`CONTEXT.md`** at the repo root — the system-wide glossary (Harness, Plugin Payload, Harness Adapter, Portable Runtime, Capability Tour, and the capability boundaries).
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. Also check `packages/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo has no `src/` — workspace contexts live under `packages/`:

```text
/
├── CONTEXT-MAP.md
├── CONTEXT.md                         ← system-wide glossary
├── docs/adr/                          ← system-wide decisions (0001–0008)
├── plugin/                            ← generated payload; not a context
├── runtime/                           ← portable runtime + skill catalog
├── scripts/                           ← authoring, release, and proof tooling
└── packages/
    ├── skill-a/
    │   ├── CONTEXT.md                 ← created lazily by /domain-modeling
    │   └── docs/adr/                  ← context-specific decisions
    └── skill-b/
        ├── CONTEXT.md
        └── docs/adr/
```

Per-context `CONTEXT.md` and `docs/adr/` directories are **created lazily**. At the time of writing, `packages/skill-a` and `packages/skill-b` are dependency-boundary fixtures proving ESM/CJS interop, and every accepted decision is system-wide. Don't create empty per-context files ahead of real vocabulary.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the governing `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

The root glossary is explicit about rejected synonyms — for example, prefer **Harness** over "host", **Plugin Payload** over "bundle" or "package", **Harness Adapter** over "host adapter", and **Portable Runtime** over "Bun runtime" or "generated script".

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (workspace authoring, bundled distribution) — but worth reopening because…_

Note that ADR 0002 and ADR 0004 are **superseded** (by 0006). Treat superseded ADRs as historical rationale only; reconcile proposals against the current accepted set.
