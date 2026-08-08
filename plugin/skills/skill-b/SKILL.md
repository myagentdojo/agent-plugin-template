---
name: skill-b
description: "Run the bundled skill-b proof to show a CJS skill using CJS and conditional-export dependencies offline."
---

# Skill B

Resolve the installed plugin root two directories above this `SKILL.md`, then run its `bin/skill-b` launcher.

Report the JSON result. If the launcher returns a custody JSON envelope, follow the `runtime-custody` skill to preview repair, ask for approval, apply the repair, and retry. The bundle carries its dependencies inside one file and needs no source workspace, package metadata, or `node_modules`.
