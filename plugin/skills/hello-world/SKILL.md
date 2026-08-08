---
name: hello-world
description: "Run the bundled hello-world app to prove portable plugin distribution."
---

# Hello World

Resolve the installed plugin root two directories above this `SKILL.md`, then run its `bin/hello-world hello --json` launcher.

Report the JSON result. The launcher uses the shared verified Bun runtime managed by this plugin. If it returns a custody JSON envelope, follow the `runtime-custody` skill to preview repair, ask for approval, apply the repair, and retry. The user never needs to install Bun or run setup manually.
