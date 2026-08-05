# Decision 0004: One canonical plugin, native host adapters

Status: accepted by the prototype when `bun run prove:all` passes.

## Decision

Use `plugin/` as the sole installable subtree.

- Share skills, launcher, QuickJS executables, and generated JavaScript.
- Keep Claude Code and Codex manifests separate.
- Keep hook declarations at explicit host-specific paths. Never use the shared
  `hooks/hooks.json` default because both hosts auto-discover it.
- Route both declarations into the same pure command implementation.
- Point both marketplace catalogs at `./plugin`.
- Package only `plugin/`.

## Why

Claude Code and Codex overlap on Agent Skills, command-hook stdin, and MCP. They differ on manifest schema, hook types, event coverage, trust, matching, and reload behavior. Sharing hook code removes real duplication. Sharing hook configuration would hide host semantics and weaken proof.

The four vendored QuickJS executables total about 7.7 MB in Git and compress to about 3.46 MB in the distribution archive. Runtime execution is offline and does not require Bun, Node.js, Python, npm, `curl`, or `unzip`.

## Consequences

- One marketplace install can no longer copy repository source, `.git`, CI scripts, or ignored Bun artifacts.
- Local Codex staging is generated from the canonical subtree and changes only its development version cachebuster.
- Claude Code loads the canonical subtree directly.
- Host-specific components such as Claude agents, LSP servers, monitors, themes, or output styles stay outside the shared core.
- Codex plugin hooks remain inactive until their exact definitions are trusted.

See `docs/research/claude-code-vs-codex-plugins.md` for the compatibility matrix and source links.
