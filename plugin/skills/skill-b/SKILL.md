---
name: skill-b
description: "Run the bundled skill-b proof to show a CJS skill using CJS and conditional-export dependencies offline."
---

# Skill B

Status: not yet invocable — the custody launcher for this skill is not rendered against the runtime custody engine yet; it activates with launcher rendering.

Resolve the installed plugin root two directories above this `SKILL.md`, then run the active `runtime/skill-b-*.js` bundle listed in `runtime/bundle-inventory.json` with the plugin-managed Bun runtime.

Report the JSON result. The bundle carries its dependencies inside one file. It makes no network request and needs no source workspace, package metadata, or `node_modules`.
