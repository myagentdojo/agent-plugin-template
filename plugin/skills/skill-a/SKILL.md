---
name: skill-a
description: "Run the bundled skill-a proof to show an ESM skill using ESM and CJS dependencies offline."
---

# Skill A

Resolve the installed plugin root two directories above this `SKILL.md`, then run the active `runtime/skill-a-*.js` bundle listed in `runtime/bundle-inventory.json` with the plugin-managed Bun runtime.

Report the JSON result. The bundle carries its dependencies inside one file. It makes no network request and needs no source workspace, package metadata, or `node_modules`.
