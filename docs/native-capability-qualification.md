# Qualify fresh native capabilities

Use this runbook when recording native activation, UI identity, exact hook trust, host-corroborated delegation, or host-observed lifecycle claims from fresh Claude and Codex profiles.

All fresh-native cells remain **UNPROVED** until a person records receipts from fresh Claude and Codex profiles. `prove:harness-install` proves package bytes, declarations, installed bytes, and direct handler mechanics. It explicitly does not prove native activation, hook trust, UI presentation, or native delegation.

## Keep raw evidence private

Keep raw receipts in the existing private qualification location under `$XDG_STATE_HOME/agent-plugin-template/runtime-custody/`, defaulting `XDG_STATE_HOME` to `~/.local/state`. Create every directory with mode `0700`, create every receipt with mode `0600`, and begin with `umask 077`. Extend the existing per-client receipt with a `nativeCapability` summary; do not create a second receipt framework. Use macOS and Linux POSIX hosts only; this lifecycle proof does not claim native Windows support.

For each client, bind the receipt to the exact source candidate SHA, archive SHA-256 from `*.checksums.json`, packaged payload hash, and independently measured installed payload hash. The packaged and installed hashes must match. A drift receipt also records the source candidate SHA and a distinct derived payload hash. `ship-canary` owns this candidate-lineage check.

## Record every bounded cell

Record these cells per client:

- Fresh discovery and branded UI identity.
- Skill-seeded generic native delegation, a correlated handback, and host-owned subagent lifecycle evidence.
- One native `SessionStart` receipt for startup or resume.
- Host-observed zero-output clean `Stop` completion.
- One continuation from a disposable candidate-derived drift copy, with no other blocking Stop hook active.
- Silent `stop_hook_active: true` re-entry and unchanged fixture bytes.
- Capability-tour and existing-skill operation when hooks are disabled or untrusted, with `currentSessionHook: unknown` and no native-activation claim.

Claude qualification starts with the generated disabled plugin, verifies installed bytes, then enables it for a fresh session. Record the fallback in a separate fresh session with hooks disabled. Codex qualification first observes the untrusted fallback, reviews and trusts the exact hook definition through `/hooks`, then uses a second fresh task for activation receipts. A changed Codex definition requires fresh exact-definition review; a version-only release leaves the definition unchanged.

## Promote bounded conclusions

Promote only the receipt SHA-256 values, lineage hashes, platform/client labels, and bounded pass/fail conclusions. Never promote paths, prompts, transcript text, session data, environment dumps, or raw host receipts. The existing files remain `claude-cli-<candidate-sha>-<target>.json`, `codex-cli-<candidate-sha>-<target>.json`, and `codex-desktop-<candidate-sha>-<target>.json`. They also record the real `BUN_MISSING` → preview → approved repair → retry journey. Set `humanApprovalClaimed: true` only after actual human approval; automated platform and fixture receipts use `humanApprovalClaimed: false`.

Qualification completes when every bounded cell has a result, every promoted claim is bound to the same candidate, packaged and installed payload hashes match, and the raw receipts remain private.
