# Plugin Distribution

This context describes how one plugin moves from authoring into Claude Code and Codex without losing a shared identity or hiding harness-specific behavior.

## Language

**Harness**:
An agent environment that discovers, installs, and executes plugins. Claude Code and Codex are the supported harnesses.
_Avoid_: Host, runtime environment

**Plugin Repository**:
The workspace containing a plugin's source, tests, documentation, and release history.
_Avoid_: Plugin, when referring to the whole repository

**Plugin Payload**:
The complete distributable content representing one plugin version across supported harnesses.
_Avoid_: Bundle, package, plugin folder

**Plugin Installation**:
A harness-managed copy of a Plugin Payload.
_Avoid_: Checkout, cache, when the ownership distinction matters

**Harness Adapter**:
The harness-specific part of a Plugin Payload that expresses discovery, trust, and lifecycle semantics without redefining shared behavior.
_Avoid_: Host adapter, shared hook configuration

**Portable Runtime**:
Consumer-executable plugin behavior that does not depend on the contributor toolchain.
_Avoid_: Bun runtime, generated script

**Development Installation**:
A temporary Plugin Installation containing local or unreleased changes.
_Avoid_: Release, development marketplace

**Marketplace**:
A catalog that resolves plugin identity to a payload source and version.
_Avoid_: Package registry, artifact store

**Release**:
An immutable, versioned Plugin Payload made available for production installation.
_Avoid_: Main build, CI artifact, merged commit

**Capability Tour**:
One shared model-only skill that reports declarations, direct mechanics, current-session observation, external qualification status, and skill-seeded native delegation separately. It never reads, ingests, or infers private qualification receipts, and its default result is not an automated native-qualification claim. It uses one skill-local reviewer prompt with generic host delegation and an inline fallback; it has no standalone agent.
_Avoid_: Capability runner, agent package

**Lifecycle Mechanics Proof**:
The dependency-free `SessionStart`/`Stop` sidecar and plugin-owned drift fixture. It emits one bounded start context, stays silent on a clean Stop and active re-entry, blocks only a proven fixture mismatch, and otherwise fails open. It is not a production integrity or security guarantee and never sets up the runtime.
_Avoid_: Integrity monitor, security control

**Fresh-Native Qualification Receipt**:
A private, human-operated record from a fresh client profile. It owns native activation, UI identity, exact hook definition trust, host-corroborated delegation, and host-observed lifecycle claims. Raw receipts stay in private XDG state with `0700` directories and `0600` files; only hashes and bounded conclusions may be promoted.
_Avoid_: Automated proof report, transcript

## Capability boundaries

Automated proof binds the source candidate, package and installed payload bytes, declarations, fixture equality, and direct handler behavior. It leaves native activation, trust, UI, and delegation explicitly unproved. Fresh-native qualification binds promoted claims to the exact source commit, archive checksum, packaged payload hash, and installed payload hash. A derived drift copy keeps the source candidate SHA and records a distinct derived payload hash.

Claude installs disabled by default and can run the capability tour and portable skills when hooks are disabled. Codex keeps plugin enablement separate from hook trust: the user reviews the exact hook definition through `/hooks`; disabled or untrusted hooks preserve the same fallback behavior. Qualified platforms are macOS and Linux POSIX hosts. Native Windows support is not claimed.

The capability tour extends the same plugin. It adds no MCP, standalone agent, telemetry, user settings, companion installer, runtime setup hook, or second qualification framework.
