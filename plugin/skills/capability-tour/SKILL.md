---
name: capability-tour
description: "Run the native plugin capability tour and report truthful hook, skill, candidate, and delegation evidence."
---

# Native Plugin Capability Tour

Inspect only the installed plugin. Do not inspect the source checkout or unrelated project and user state. Resolve the installed plugin root three directories above this `SKILL.md`.

## Evidence collection

Read the installed Claude and Codex manifests, declared hook files, lifecycle fixture pair, runtime skill catalog, bundle inventory, launcher names, installed skill names, and `references/capability-reviewer.md`.

Keep these evidence layers separate:

- `declaration`: present and valid only when both manifests resolve their client-specific declarations and those declarations contain exactly `SessionStart` and `Stop` commands for the shared installed handler.
- `direct handler`: run `<absolute-installed-plugin-root>/hooks/native-capability-hook Stop <active-client>` directly once, where `<active-client>` is exactly `claude` or `codex`, using `{"stop_hook_active":false}` on stdin. Use the resolved absolute installed-plugin root, not a relative path or source-checkout path. Report only pass, lifecycle fixture mismatch, or operational failure. Direct execution never proves native activation.
- `currentSessionHook`: `observed` only when the current session already contains the native `SessionStart` context marker matching the installed identity and active client. Otherwise report `unknown`. Never infer it from manifest presence or direct handler success.
- `external candidate qualification`: report `qualified` only from a supplied host-owned receipt bound to this exact installed candidate. Otherwise report `unknown` or the supplied non-healthy conclusion.
- `delegation delivery`: use the rules below.

Call the fixture a lifecycle mechanics proof. Do not claim production integrity, security, or workspace quality.

## Delegation

When the active client exposes a generic native subagent primitive, request exactly one bounded read-only verification task. Seed it with the complete reviewer prompt from `references/capability-reviewer.md` plus only the bounded installed-plugin inputs named there. Do not select a model or agent persona. Do not create or modify an agent file, harness setting, project setting, or user setting.

After the handback:

- Use `native-subagent-via-skill` plus `claude` or `codex` only when the handback satisfies the reviewer schema, reports no mutation, and the host call supplies host-owned subagent lifecycle evidence correlated with that handback. Handback text or a model-authored delivery label is not proof.
- Use `inline-fallback-unavailable` when the active client has no generic native subagent primitive. Perform the same reviewer checks inline. Do not claim subagent proof.
- Use `inline-recovery-delegation-failed` when a delegation attempt fails or its handback/receipt is invalid. Perform the same checks inline and keep the overall result non-healthy. Do not attempt a second delegation or claim subagent proof.

Never claim a packaged standalone agent or companion installation. Never write agent configuration.

## Default response

Return these ordered groups. Keep raw paths, hashes, handler JSON, and reviewer JSON out of the response.

1. `Overall verdict`: one line with `healthy` or `non-healthy` plus installed name and version. Include the active client only alongside a validated `native-subagent-via-skill` delivery.
2. `Evidence matrix`: a compact table with rows in this order: declaration, direct handler, `currentSessionHook`, external candidate qualification, delegation delivery. State `observed`, `passed`, `qualified`, `unknown`, or the precise non-healthy result without merging evidence layers.
3. `Available portable skills`: list `hello-world`, `skill-a`, `skill-b`, `runtime-custody`, and `capability-tour`, marking the first three Bun-backed and the last two model-only.
4. `Next action`: include only for an untrusted hook, lifecycle fixture failure, failed delegation, or another non-healthy state. Give one concrete recovery action. Omit this group when healthy.
