# Prototype 0001: Marketplace installation and development mode

Snapshot: 2026-08-05. Claude Code `2.1.222`. Codex CLI `0.146.0`.

## Question

Can one Bun-authored Hello World plugin install from GitHub in Claude Code and Codex, execute without Bun at runtime, and support a practical local edit loop in both hosts?

## Production installation proof

Added `myagentdojo/agent-plugin-template` as a Git marketplace in both hosts. Installed `harness-native-plugin-prototype@harness-native-plugin-prototype` in both hosts.

- Claude cached Git commit `77c50e1c960d` and invoked `/harness-native-plugin-prototype:hello-world` in a fresh session.
- Codex cached version `0.1.0` and invoked `$hello-world` in a fresh task.
- Both returned `{"ok":true,"command":"hello","message":"Hello, world!",...}`.
- Both cached launchers ran with `PATH=/usr/bin:/bin`, proving no Bun, Node.js, Python, npm package, or network dependency at runtime.

## Development proof

Changed the TypeScript greeting to `Hello from dev mode, world!` for the experiment, rebuilt it, proved both hosts returned the changed value, then restored the production greeting.

Claude Code:

1. `bun run dev:claude` builds the canonical plugin and launches `claude --plugin-dir ./plugin`.
2. A session-only settings override disables the installed production plugin ID for that process. Persistent Claude settings do not change.
3. The watcher rebuilds after source, skill, hook, or manifest edits.
4. `/reload-plugins` reloads the local plugin in the same session.

Codex:

1. `bun run dev:codex` builds and copies the canonical plugin into ignored staging.
2. The staged Codex manifest receives one timestamp cachebuster.
3. Codex reinstalls the staged plugin from `harness-native-plugin-dev`.
4. A fresh task loads the new cached version.

## Failure found by the live harness

The original layout stored the Codex hook adapter at `hooks/hooks.json` and the Claude adapter at `hooks/claude/hooks.json`. Claude auto-discovered the default `hooks/hooks.json` in addition to its explicit manifest path. It ran the Codex declaration with an empty `PLUGIN_ROOT`, producing `/bin/hello-world` failures.

Static manifest validation and direct runtime tests did not catch this cross-host discovery collision.

Fix:

- `hooks/claude/hooks.json`
- `hooks/codex/hooks.json`
- Each native manifest points explicitly at its own adapter.
- No shared default `hooks/hooks.json` exists.

## Verdict

Accepted for the prototype.

- Production distribution: Git marketplace plus cached plugin install.
- Shared implementation: skill, launcher, generated JavaScript, and QuickJS runtimes.
- Claude development boundary: watcher plus `/reload-plugins`.
- Codex development boundary: cachebuster reinstall plus fresh task.
- Host hook declarations remain physically separate to prevent auto-discovery collisions.

## Recipient follow-up

The template was later initialized into dedicated public and private recipient repositories. The public hosted workflow was reverified successful on 2026-08-05 across the four native compatibility jobs, deterministic package, and artifact attestation. The session record reports the private hosted workflow and private SSH installation as successful; that repository requires an authorized GitHub identity and was not independently reverified during the final documentation pass.

## Remaining boundary

Codex installs non-managed hooks without trusting them. The user must review and trust the current definition in `/hooks`; definition changes return to the trust boundary. Do not bypass that review in the normal development command.

The bundled plugin-creator validator used during this snapshot rejects the documented Codex `hooks` manifest field. Codex `0.146.0`, the current Codex manual, and live installation accept it. Treat the validator result as stale until its schema catches up.
