# Bootstrap the runtime for OS-integrated plugins

## Status

Accepted — 2026-08-05.

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

### Three plugin categories

1. **Pure logic** (args + stdin -> stdout). QuickJS is the right runtime.
2. **Pure-JS npm plus shimmable globals** (e.g. `nanoid`). QuickJS plus a
   small host-shim layer.
3. **OS-integrated** (spawn, sockets, filesystem at OS depth). Needs a
   real Bun/Node runtime; QuickJS is impossible.

## Decision

Keep QuickJS as the runtime for category 1 and 2 payloads. It is the best
fit for the zero-install, tiny, offline goal, and no bundler change or
shim removes its ceiling.

For category 3, distribute on the **same Git-marketplace rails** (candidate
SHA binding, safe payload inventory, `*.checksums.json`, hosted canaries,
harness install proof — all runtime-agnostic) but **bootstrap the runtime
on first run** rather than embedding it or requiring it as a prerequisite.

The plugin payload stays small: bundled JS plus a launcher. On first use
the launcher resolves a pinned, checksum-verified Bun into a cache
directory (reusing an already-present runtime when present), then runs the
bundled JS on it. A doctor command reports and repairs runtime custody.

### Alternatives considered

- **Embed the runtime** (`bun build --compile`): a self-contained
  ~60–90 MB per-platform binary. True zero-install and offline, but a ~50×
  payload increase. Rejected as the default: the size cost is disproportionate
  for the common case, though it remains available where strict offline-first
  outweighs size.
- **Require the runtime** as a documented prerequisite ("you need Bun"):
  smallest artifact, simplest, but not zero-install. Correct for
  developer-facing tools whose users already have Bun; wrong as the default
  for broad end-user plugins.
- **Bootstrap on first run** (chosen): small payload, near-full capability,
  a one-time pinned fetch. It composes patterns this repo already owns —
  the `quickjs-assets.json` checksum-pinned per-platform binary manifest and
  the warm-Chrome fetch/detect/pin/cache/repair/doctor state machine — so it
  adds little new machinery.

## Consequences

- Zero-install-and-offline is preserved for category 1 and 2. For category
  3 it becomes zero-install-after-first-warm: the first run needs network
  to fetch the pinned runtime, and offline-first fails until warmed.
- The first-run fetch downloads an executable; it must be checksum-pinned
  per platform (mirroring `quickjs-assets.json`) and the fetch is a trust
  boundary. A doctor command must surface runtime custody and repair paths.
- The publishing-hardening machinery does not change: it carries a
  bootstrapping category-3 plugin unmodified. Only the payload's runtime
  marker and launcher differ.
- Category-2 support (pure-JS npm libraries) requires a QuickJS host-shim
  layer in `runtime/src/` for the missing globals (`crypto.getRandomValues`,
  `TextEncoder`/`TextDecoder`, timers). Any shimmed library must pass the
  four-platform distribution proof, and a `crypto` shim must bridge to real
  entropy — never `Math.random`, which silently makes `nanoid`/`uuid`
  identifiers predictable.

## Follow-up

- Author the QuickJS host-shim layer for category 2, gated by
  `prove:distribution` on all four targets.
- Prototype the category-3 first-run bootstrap by mirroring
  `quickjs-assets.json` for a pinned Bun and reusing the warm-Chrome custody
  pattern, with a doctor command.
