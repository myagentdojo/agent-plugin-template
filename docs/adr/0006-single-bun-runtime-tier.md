# One runtime: bootstrap Bun for every plugin

## Status

Accepted — 2026-08-06. Supersedes ADR 0004's two-tier model. Keeps ADR 0005
(shared runtime custody) unchanged — the custody engine becomes the single
path rather than the OS-integrated path.

## Context

ADR 0004 split plugins into two runtime tiers: a QuickJS-sandboxed default
(pure logic, plus pure-JS npm via a host-shim layer) and a Bun-OS-integrated
tier (spawn, sockets, filesystem) reached by bootstrapping Bun. The stated
value of the QuickJS tier was a tiny offline payload and, more importantly, an
inability to touch the operating system by construction — a sandbox.

Two facts, once settled, removed the reasons to keep that split:

- **Audience is publisher-vouched.** The plugins are distributed as public and
  private plugins that a consumer installs because they trust the publisher —
  the same trust they extend to any tool they install. This is not an
  untrusted-plugin platform, so a runtime that *cannot* touch the OS protects
  against a threat the trust model already excludes. The sandbox was the
  QuickJS tier's main non-cost advantage; for this audience it is low-value.
- **Isolation belongs at the architecture layer.** When sandboxing is needed,
  it is provided by the environment that runs the agent (container, VM, or an
  agent-sandbox framework) around the whole process — not by crippling a
  per-plugin runtime. Enforcing "can't touch the OS" inside the plugin runtime
  solves isolation at the wrong layer and only for the subset of plugins that
  happen to be on that tier.

The remaining QuickJS advantage was payload size, and ADR 0004 already measured
the Bun bootstrap as small: ~22 MB downloaded, ~60 MB cached, ~3.3 s cold, once,
then a cache hit shared across every plugin. That does not justify maintaining a
second runtime, a host-shim layer, four vendored QuickJS binaries, and a second
distribution proof.

## Decision

Use one runtime tier. Every plugin — pure logic or OS-integrated — runs on a
bootstrapped Bun via the shared runtime-custody engine (ADR 0005).

- Retire the QuickJS-NG interpreter, the `runtime/src` host-shim layer, the
  vendored `qjs-*` binaries, and the QuickJS-specific distribution proof from
  the plugin runtime path.
- A plugin is a normal Bun/TypeScript program. There is no tier decision, no
  shim, and no "does this need OS access?" classification.
- Custody is unchanged: one template-wide, version-exact Bun pin; a closed
  skill catalog; generated per-skill launchers; one shared
  digest-addressed cache; typed run/repair; fail-closed on unknown
  skill and checksum mismatch; drift blocked mechanically (ADR 0005).
- **Sandboxing, when required, is an architecture-layer concern.** Run the
  agent (and its plugins) inside a container, VM, or agent-sandbox framework.
  Do not reintroduce a runtime whose only job is to deny capabilities.

### Alternatives considered

- **Keep two tiers** (ADR 0004): a real security boundary for untrusted
  plugins on an open platform, but this audience installs publisher-vouched
  plugins, so the boundary guards a threat the trust model already excludes,
  at the cost of a permanent second runtime.
- **One Bun runtime with a per-plugin capability flag** (restricted Bun/Node
  permissions for "pure-logic" plugins): preserves a sandbox without QuickJS.
  Rejected as premature — it re-adds a classification and a permission model
  for the same low-value threat. It remains the natural first step *if* the
  audience later includes untrusted plugins; note it and do not build it now.

## Consequences

- One runtime, one mental model, one proof path. Contributors write ordinary
  Bun/TS skills; adding a skill is a catalog entry plus regeneration.
- The prototype work is not wasted: the runtime-custody engine (ADR 0005)
  becomes *the* path, and the OS-integrated example skills already run on it.
  The QuickJS-tier and shim prototypes become historical evidence only.
- Every plugin can touch the OS. That is acceptable for publisher-vouched
  distribution and explicitly deferred to architecture-layer isolation
  otherwise. If the audience changes to include untrusted plugins, reopen the
  capability-flag alternative above.
- ADR 0004's evidence stays valid and citable (QuickJS host-global ceiling,
  bundler parity, measured bootstrap cost, Bun-in-Rust and Python/`uv` facts);
  only its two-tier decision is superseded.

## Implemented follow-up

- The active payload, launchers, proof, and workflows are Bun-only.
- Every catalog skill routes through the POSIX-shell runtime-custody engine and
  the real checksum-pinned acquisition path.
- Keep the capability-flag alternative on file against a future untrusted
  audience.
