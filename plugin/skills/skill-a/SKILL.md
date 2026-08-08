---
name: skill-a
description: "Run the bundled skill-a proof to show an ESM skill using ESM and CJS dependencies offline."
---

# Skill A

Status: not yet invocable — the custody launcher for this skill is not rendered against the runtime custody engine yet; it activates with launcher rendering.

Resolve the installed plugin root two directories above this `SKILL.md`, then run the active `runtime/skill-a-*.js` bundle listed in `runtime/bundle-inventory.json` with the plugin-managed Bun runtime.

Report the JSON result. The bundle carries its dependencies inside one file. It makes no network request and needs no source workspace, package metadata, or `node_modules`.
