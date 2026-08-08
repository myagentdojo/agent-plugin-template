# Author with Bun and execute with bundled QuickJS

## Status

Superseded by ADR 0006 on 2026-08-06. This file preserves the original spike
rationale only; no active payload, launcher, proof, or release workflow uses
QuickJS.

Contributors use Bun and TypeScript, while each Plugin Payload includes generated standards-oriented JavaScript and checksum-pinned QuickJS executables for consumer execution. This avoids npm, post-install downloads, and requiring a contributor runtime on recipient machines; it also keeps the four-target release far smaller than bundling Bun into every executable. Dependencies on Bun, Node.js, native addons, or unsupported Web APIs reopen this decision and require compatibility proof.
