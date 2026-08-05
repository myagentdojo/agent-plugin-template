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
