---
name: runtime-custody
description: "Repair or explain the plugin-managed Bun runtime after a custody JSON envelope such as BUN_MISSING or REPAIR_REQUIRED."
---

# Runtime Custody

Use this when a plugin skill run returned a custody JSON envelope (`code` such as `BUN_MISSING` or `REPAIR_REQUIRED`) or the user asks about the plugin's Bun runtime.

Resolve the installed plugin root two directories above this `SKILL.md`. The behavior owner is `runtime/runtime-exec`: its `help` output and JSON envelope define the command surface, codes, and exit classes; do not restate them.

Workflow:

1. Read the envelope's `code` and `nextAction`.
2. Run `runtime/runtime-exec repair` to preview. The preview is read-only and makes no network request.
3. Present the preview's plain-language action to the human and get explicit approval. This workflow owns the approval and its receipt; the engine does not authenticate anyone.
4. Only after approval, run `runtime/runtime-exec repair --apply` — the sole operation that acquires or replaces the runtime.
5. Rerun the original skill.
6. On `FOREIGN_LOCK_REQUIRES_APPROVAL`, present `nextAction` and confirm no other machine is repairing the cache. After explicit approval, run the exact recovery command from `nextAction`, then rerun the original skill.
7. On failures with `retrySafe: true` (for example offline or a held lock), retry later per `nextAction`. Keep cache recovery inside `runtime-exec`.

Runtime identity is pinned by a reviewed lock; repair downloads only the locked official release and verifies the bytes before publication.
