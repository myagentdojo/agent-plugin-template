# Extend one plugin with a native capability tour

## Status

Accepted — 2026-08-10.

## Context

The repository needs one truthful tour of shared skills, client-native lifecycle
declarations, branded identity, and native delegation. Automated package and
handler checks can prove bytes and direct mechanics. They cannot prove that a
fresh Claude or Codex client discovered the plugin, presented its identity,
trusted and activated hooks, or delivered a native subagent lifecycle.

Claude and Codex also have asymmetric trust. Claude installs the generated
plugin disabled by default and activates its declarations when the plugin is
enabled. Codex separates plugin enablement from hook trust and requires the user
to review the exact hook definition through `/hooks`.

## Decision

Extend the same plugin as one capability tour.

- Keep one shared model-only skill and one skill-local reviewer prompt.
- Seed one generic native subagent through the client host primitive when
  available. Use equivalent read-only inline checks when delegation is
  unavailable or fails. Do not package a standalone agent.
- Generate separate Claude and Codex hook declarations around one shared POSIX
  handler.
- Limit hooks to `SessionStart` and `Stop`. Show success once at startup or
  resume. Stay silent for a clean Stop and active Stop re-entry.
- Use the plugin-owned source/projection pair only as a lifecycle mechanics
  proof. Request one continuation only for a proven byte mismatch. Fail open for
  malformed input, missing tools, unreadable metadata, or operational doubt.
- Keep the handler dependency-free and mutation-free. It never runs workspace
  code or performs runtime setup, repair, prewarm, inventory, or pruning.

The lifecycle mechanics proof is not a production integrity or security
guarantee. It demonstrates bounded host hook behavior only.

## Evidence and trust boundary

Repository tests and candidate-bound automated proofs own generated declaration
bytes, package inventory, fixture equality, direct handler mechanics, archive
identity, and installed payload equality. `prove-harness-install` retains an
explicit `not-proved` native qualification cell unless a bounded external
summary is supplied. Direct execution never becomes a native activation claim.

Fresh native qualification remains human-operated. Raw receipts live in private
XDG state with `0700` directories and `0600` files. Only receipt hashes, lineage
hashes, client/platform labels, and bounded conclusions may be promoted. Paths,
prompts, transcripts, session data, environment dumps, and raw host receipts
remain private.

Each client receipt covers:

- Fresh discovery and UI identity.
- Skill-seeded native delegation with correlated handback and host-owned
  lifecycle evidence.
- One native `SessionStart` receipt and host-observed silent clean `Stop`.
- A candidate-derived drift continuation bound to the source candidate SHA and
  a distinct derived payload hash, followed by silent re-entry.
- Capability-tour and existing-skill fallback while hooks are disabled or
  untrusted, without a native-activation claim.
- Codex exact hook definition trust; Claude records this as not applicable.

`ship-canary` owns candidate lineage. Promoted claims bind to the exact source
commit, archive checksum, packaged payload hash, and independently measured
installed payload hash. Packaged and installed payload hashes must agree. The
derived drift hash must differ.

Qualification cells remain unproved until those receipts exist. Documentation
must not infer native behavior from declarations, direct handler execution, or
historical client runs.

## Exclusions

- No MCP.
- No standalone agent or agent configuration.
- No telemetry.
- No user settings mutation or companion installer.
- No generic capability framework or second qualification framework.
- No hook-driven runtime setup.
- No native Windows claim. Qualification covers macOS and Linux POSIX hosts.

## Consequences

- One capability tour works across both clients while native declarations and
  trust remain client-specific.
- Disabled or untrusted hooks do not block the tour or existing skills.
- Static hooks, the skill, reviewer prompt, and assets stay outside the
  version-only release projection.
- A changed Codex hook definition requires fresh exact-definition review. A
  version-only release does not change the definition.
