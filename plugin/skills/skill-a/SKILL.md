---
name: skill-a
description: "Run the bundled skill-a proof to show an ESM skill using ESM and CJS dependencies offline."
---

# Skill A

Resolve the installed plugin root two directories above this `SKILL.md`, then run its `bin/skill-a` launcher.

Report the JSON result. If the launcher returns a custody JSON envelope, follow the `runtime-custody` skill to preview repair, ask for approval, apply the repair, and retry. The bundle carries its dependencies inside one file and needs no source workspace, package metadata, or `node_modules`.
