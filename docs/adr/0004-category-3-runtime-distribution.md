# Two runtime tiers: QuickJS-sandboxed and Bun-OS-integrated

## Status

Superseded by ADR 0006 (2026-08-06). This ADR recommended two runtime tiers
(QuickJS-sandboxed default, Bun-OS-integrated escalation). ADR 0006 collapses
that to a single Bun tier once the deciding factors were settled: the plugins
are first-party and self-hosted (so QuickJS's by-construction sandbox is
low-value), isolation belongs at the architecture layer (container/VM/agent
sandbox) rather than the plugin runtime, and the measured bootstrap cost is
small. The evidence sections below (QuickJS host-global ceiling, bundler
parity, measured bootstrap cost, Bun/Python facts) remain accurate and are
cited by 0006; only the two-tier *decision* is superseded.

## Context

This template ships plugins whose payload runs under an embedded QuickJS-NG
interpreter (see ADR 0001, ADR 0002). QuickJS keeps the payload tiny
(~1.3 MB per platform), offline, and zero-install: consumers need no Bun,
Node.js, npm, or post-install download.

A question arose: can a plugin built on these rails import arbitrary npm
libraries, and can an OS-integrated tool (one that spawns processes, opens
sockets, and touches the filesystem — for example a Chrome-driving browser
automation tool) be distributed the same way?

### Evidence (throwaway spikes)

Three spikes settled the mechanics. Prototype code lived in a scratch
directory, out of this repo; only the conclusions are recorded here.

- **npm under QuickJS.** Eight libraries were bundled through this
  template's exact `Bun.build({ target: "browser", format: "esm",
  external: ["qjs:std"] })` settings and run under the real `qjs` binary.
  All eight bundled. Pure-ECMAScript libraries (`ms`, `zod`, `date-fns`,
  `lodash-es`, `picocolors`, `chalk`, `picomatch`, `eventemitter3`) ran.
  `nanoid` and `uuid` failed with `ReferenceError: crypto is not defined`
  — a missing host global, not a bundling failure. A two-line
  `crypto.getRandomValues` shim made both run.
- **Bundler is not the ceiling.** The same libraries were bundled through
  Bun, esbuild, and Rollup (the last with `@rollup/plugin-node-resolve` +
  `commonjs`). All three produced identical run/fail outcomes with the same
  errors. The ceiling is what QuickJS-NG 0.16.1 provides as host globals,
  not how the code is packaged.
- **OS-integrated code cannot run on QuickJS at all.** An audit of a real
  browser-automation tool found effectively zero external npm dependencies
  but heavy Node built-in use: `node:child_process`, `node:net`,
  `node:http`, `node:fs`/`fs/promises`, `node:crypto`, `node:os`. Process
  spawning and sockets have no host to shim to in QuickJS. Such a tool
  requires a Node-API-capable runtime, full stop.

### Two runtime tiers, not three categories

An earlier framing split plugins into three categories: pure logic, pure-JS
npm with shims, and OS-integrated. But the first two run on the **same
runtime** (QuickJS) and differ only by whether a host-shim layer is present.
A shim is an in-tier detail, not an architectural fork. The real fork is a
single question: **does the plugin need to touch the operating system
(spawn a process, open a socket, read the filesystem at OS depth)?**

That yields two tiers:

- **QuickJS-sandboxed tier.** Pure ECMAScript logic and pure-JS npm
  libraries, the latter running once a small host-shim layer supplies the
  Web globals QuickJS lacks (`crypto.getRandomValues`, `TextEncoder`/
  `TextDecoder`, timers). Tiny (~1.3 MB in-artifact interpreter), offline,
  zero-install, deterministic, and — decisively — **incapable of spawning
  processes or opening sockets by construction**. That inability is a
  security property, not a limitation: a QuickJS-tier plugin physically
  cannot exfiltrate data or shell out regardless of its code.
- **Bun-OS-integrated tier.** Anything that spawns processes, opens
  sockets, or uses the filesystem at OS depth. Requires a real Node-API
  runtime; QuickJS is impossible. Heavier (a ~60–90 MB Bun), needs the
  runtime bootstrapped or embedded, and carries the full power (and full
  trust surface) of the host.

### Why not run everything on the Bun tier

Bun's capability is a strict superset, so "put everything on Bun" is
tempting. It is rejected because the tiers are a **cost ladder**, and most
plugins should sit on the lowest rung that does the job:

- **Payload.** Forcing every plugin onto Bun replaces a ~1.3 MB in-artifact
  interpreter with a ~60–90 MB runtime per consumer — absurd for a plugin
  that transforms text, and a distribution burden across a marketplace of
  small plugins.
- **Offline and trust.** The QuickJS tier is zero-install and fully offline
  the moment the reviewed payload lands. The Bun tier must fetch and execute
  a runtime binary on first use: a network dependency and a new trust
  decision. Only workloads that need OS access should pay that.
- **Sandbox.** The QuickJS tier cannot reach the network or filesystem.
  Moving a trivial plugin to Bun hands it that power for no benefit. Keeping
  "this plugin *cannot* touch the OS" is worth preserving for most of the
  ecosystem.

Pick the QuickJS tier by default; escalate to the OS-integrated tier (Bun
or Python) only for the minority of plugins that genuinely need OS access.

## Decision

Keep QuickJS as the default runtime tier (pure logic, plus pure-JS npm via
an in-tier host-shim layer). It is the best fit for the zero-install, tiny,
offline, sandboxed goal, and no bundler change or shim removes its ceiling.

For the Bun-OS-integrated tier, distribute on the **same Git-marketplace
rails** (candidate SHA binding, safe payload inventory, `*.checksums.json`,
hosted canaries, harness install proof — all runtime-agnostic) but
**bootstrap the runtime on first run** rather than embedding it or requiring
it as a prerequisite.

The plugin payload stays small: bundled code plus a launcher. On first use
the launcher resolves a pinned, checksum-verified runtime into a cache
directory (reusing an already-present runtime when present), then runs the
payload on it. A doctor command reports and repairs runtime custody. The
runtime is Bun or Python, chosen by what the tool is written in (see below).

### Alternatives considered

- **Embed the runtime** (`bun build --compile`): a self-contained
  ~60–90 MB per-platform binary. True zero-install and offline, but a ~50×
  payload increase. Rejected as the default: the size cost is disproportionate
  for the common case, though it remains available where strict offline-first
  outweighs size.
- **Require the runtime** as a documented prerequisite ("you need Bun"):
  smallest artifact, zero overhead when the runtime is already present, but
  it pushes an explicit install step onto the user and fails offline for a
  runtime-less machine. Reasonable when the audience is known to have the
  runtime (developer tools; Python where a system `python3` already exists);
  the opt-out, not the default.
- **Bootstrap on first run** (chosen default): small payload, near-full
  capability, a one-time pinned fetch. Measured cost is small — a Bun
  bootstrap is ~22 MB downloaded, ~60 MB cached, and **~3.3 s wall-clock**
  cold (download + unzip + first run), incurred once and then a cache hit
  for every later OS-integrated plugin at the same pinned version. That
  three-second, invisible warm-up beats making the user find and install a
  runtime, and it works on any machine, developer or not, with no
  prerequisite and no dependency fight. It composes patterns this repo
  already owns — the `quickjs-assets.json` checksum-pinned per-platform
  binary manifest and the warm-Chrome fetch/detect/pin/cache/repair/doctor
  state machine — so it adds little new machinery.

### The OS-integrated runtime is itself a choice: Bun vs Python

The Bun-OS-integrated tier is named for Bun, but the tier is really "a real
OS-capable runtime," and Bun is not the only candidate. **Python** is a
first-class alternative: much OS-integration and agent/automation tooling is
already written in it, and for a Python-authored tool, bootstrapping a pinned
Python (or `uv`) is the natural custody path rather than translating to Bun.

The tier's decision (bootstrap on first run, on the same rails) is
**runtime-agnostic**: the pinned-binary manifest, checksum gate, cache, and
self-proving bootstrap check work identically whether the resolved runtime is
Bun or a Python/`uv` toolchain. So the OS-integrated tier splits into a
sub-choice made per tool by what the tool is written in:

- **Bun** when the tool is TypeScript/JavaScript and wants the same authoring
  stack as the QuickJS tier (shared `runtime/src/`, one language).
- **Python** when the tool is Python-native; bootstrap a pinned Python/`uv`
  instead. Larger and with its own packaging model (wheels, venvs), but no
  rewrite.

Do not force a Python tool onto Bun (or vice versa) to unify the runtime —
the bootstrap rails already absorb either. Pick the runtime the tool is
written in; the distribution machinery does not care.

**Runtime implementation is distribution-neutral.** Bun's stable series is
built in Zig on JavaScriptCore; a Zig-to-Rust rewrite (announced July 2026,
memory-safety motivated) is in the canary channel but not yet the default.
From the plugin-rails perspective this changes nothing: Bun is a single
self-contained ~60 MB binary either way, and the tier boundary, bootstrap
cost, and OS-capability answer are unaffected by the implementation
language. The only consequence is operational — a Zig-built and a Rust-built
Bun are different binaries with different checksums, so the pinned-runtime
manifest must stay version-exact across that transition (it already is).
On the Python side, `uv` (itself Rust) is the tool that de-risks the
dependency story: it makes bootstrapping a pinned Python plus its wheels
fast and reproducible, softening Python's venv/PEP-668 friction.

## Consequences

- Zero-install-and-offline is preserved for the QuickJS tier. The
  OS-integrated tier becomes zero-install-after-first-warm: the first run
  fetches the pinned runtime (Bun or Python), and offline-first fails until
  warmed.
- The first-run fetch downloads an executable/toolchain; it must be
  checksum-pinned per platform (mirroring `quickjs-assets.json`) and the
  fetch is a trust boundary. A doctor command must surface runtime custody
  and repair paths.
- The publishing-hardening machinery does not change: it carries a
  bootstrapping OS-integrated plugin unmodified, Bun or Python. Only the
  payload's runtime marker and launcher differ.
- The QuickJS host-shim layer (in `runtime/src/`) supplies the missing Web
  globals (`crypto.getRandomValues`, `TextEncoder`/`TextDecoder`, timers).
  Any shimmed library must pass the four-platform distribution proof, and a
  `crypto` shim must bridge to real entropy (e.g. `/dev/urandom` via
  `qjs:std`) — never `Math.random`, which silently makes `nanoid`/`uuid`
  identifiers predictable.
- The OS-integrated tier does **not** need a QuickJS-style four-platform
  runtime proof: it does not ship the runtime, so runtime portability belongs
  to Bun/Python, not this template. The template-owned check is instead a
  **self-proving bootstrap** — an executable proof that resolves, installs to
  a clean cache, checksum-verifies, runs the skill on the cached runtime, and
  fails closed on a tampered checksum. The prototype demonstrates this: it
  proves the mechanism by running it, not by documenting steps.

## Follow-up

- Author the QuickJS host-shim layer, gated by `prove:distribution` on all
  four targets.
- Productionize the OS-integrated bootstrap by mirroring
  `quickjs-assets.json` for a pinned runtime (Bun and/or Python/`uv`) and
  reusing the warm-Chrome custody pattern, with a doctor command and the
  self-proving bootstrap check wired into CI.
