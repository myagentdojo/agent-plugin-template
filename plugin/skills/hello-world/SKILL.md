---
name: hello-world
description: "Run the bundled hello-world app to prove portable plugin distribution."
---

# Hello World

Resolve the installed plugin root two directories above this `SKILL.md`, then run its `bin/hello-world hello --json` launcher.

Report the JSON result. The launcher uses the matching QuickJS executable already carried by the plugin. It makes no network request and needs no global Bun, Node.js, Python, or npm package.
