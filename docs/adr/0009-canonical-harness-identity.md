# Establish canonical harness identity

## Status

Accepted — 2026-08-14.

## Context

Claude Code and Codex need shared vocabulary for payload identity while retaining
harness-specific discovery, trust, installation, and restoration behavior. The
same harness facts were previously re-derived across scripts, and qualification
client labels risked being mistaken for new harness or driver branches.

[ADR-0001](0001-one-payload-native-harness-adapters.md) keeps native harness
adapters distinct around one payload. [ADR-0003](0003-reviewed-versioned-releases.md)
keeps Claude and Codex replacement state and lifecycle behavior distinct. The
identity vocabulary and driver seams must preserve both decisions.

## Decision

Use `claude` and `codex` as the canonical lowercase harness IDs. Keep their
harness-owned values in `scripts/harness-identity.ts`:

- `claude` displays as `Claude`, reads its native manifest from
  `.claude-plugin`, declares hooks at `./hooks/claude/hooks.json`, and receives
  the installed plugin root through `CLAUDE_PLUGIN_ROOT`.
- `codex` displays as `Codex`, reads its native manifest from `.codex-plugin`,
  declares hooks at `./hooks/codex/hooks.json`, and receives the installed
  plugin root through `PLUGIN_ROOT`.

Freeze `claude-cli` and `codex-cli` as the qualification-client IDs for CLI
journeys and receipts. Keep `codex-desktop` as vocabulary mapped to the `codex`
harness only; it does not create a desktop-specific code path.

Give the Claude install driver a Claude-specific dependency-injection interface
parallel to `CodexDriverDependencies`. Preserve the same lifecycle shape:
preflight, capture, mutate, verify, then restore on failure. Carry harness-typed
state payloads through each driver. Never collapse Claude and Codex state into a
unioned common struct.
