# Share one runtime custody engine across OS-integrated skills

## Status

Accepted — 2026-08-05. Builds on ADR 0004 (two runtime tiers). Where 0004
decides *which* runtime an OS-integrated plugin bootstraps, this ADR decides
*how* many such plugins share one bootstrap without repeating it.

## Context

ADR 0004 established that OS-integrated plugins (spawn, sockets, filesystem)
run on a bootstrapped runtime (Bun by default). A template may host many such
skills — assume ~20. If each skill hand-rolls fetch, checksum verification,
unzip, cache management, doctor, and repair, that security-sensitive lifecycle
is duplicated 20 times, drifts, and turns adding the 21st skill into a
copy-paste hazard.

Three independent designers, briefed cold and in separate contexts, were asked
to make the bootstrap DRY across 20 skills. They converged — unprompted — on
the same architecture, which is the decision recorded here. They diverged on
exactly one point (the bootstrap host), recorded below as the open sub-choice.

## Decision

One deep **`runtime-custody`** module owns the entire runtime lifecycle. Every
OS-integrated skill reaches it through a generated launcher and selects a
runtime *profile by id* — never a version, URL, checksum, cache path, or
installer.

### Ownership and seam

- **`runtime-exec`** (the engine) — sole implementation of platform detection,
  fetch, checksum verification, extraction, cache publication, check, repair,
  and `exec`. One fix repairs every skill; delete it and the logic reappears 20
  times (the deletion test that earns it a module).
- **`runtime.lock.json`** — one template-wide, version-exact pin. Per-platform
  `url` + `archiveSha256`/`executableSha256` + size. A **checked-in,
  review-owned** artifact, **not regenerated during ordinary builds**: changing
  the pinned runtime is a human trust decision, so it is reviewed like code.
- **`catalog.json`** — closed skill registry mapping skill id → entry +
  runtime profile. A skill id absent from the catalog fails closed.
- **`generate`** — generates one thin launcher per catalog skill and a
  drift-check mode; the launchers are generated, never hand-written.

### Skill-facing shape

A skill's launcher is a generated four-line shim:

```sh
#!/bin/sh
set -eu
d=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec "$d/runtime-exec" run <skill-id> -- "$@"
```

Public interface: `run <skill-id> -- <args>`, `doctor [profile]`,
`repair [profile]`. `run` is the only command skills use.

### Version pin: one template-wide, version-exact pin

Not per-skill. All skills share one runtime version and therefore one cached
runtime.

- **Chosen: one pin.** Simplest DRY, structurally prevents divergence, a single
  cache entry, one place to bump. The whole template moves runtime versions
  together, reviewed once.
- **Rejected: per-skill pins.** Lets skills drift onto different runtime
  versions, multiplies cache entries, and weakens "install once, reuse across
  all" for no benefit at this scale. Revisit only if a skill genuinely cannot
  move with the rest.

### Cache and keying

Key the shared cache by `profile / version / platform`, storing the verified
executable. A cache hit (present and checksum-matching) is reused by every
skill; the first OS-integrated skill pays the one-time bootstrap (~22 MB,
~3.3 s per ADR 0004), and all others hit the cache.

### Failure, doctor, repair

`doctor` reports a typed healthy/unhealthy result; `repair` rebuilds the cached
runtime. Checksum mismatch, partial download, missing prerequisite, corrupted
cache, and version drift each fail closed with a typed reason — never a silent
fallback, and never running an unverified binary.

### Trust boundary

Fetching and executing a runtime is a trust decision, made auditable by: the
review-owned lock (a human signs off on version + checksums), verification
before every exec, no upstream installer or `curl | sh`, and a doctor that
names a missing prerequisite rather than improvising.

### Drift prevention (mechanical, not prose)

A 21st skill cannot silently hand-roll its own bootstrap or pin a rogue
version: skills route only through the generated launcher and the closed
catalog, the single lock is the only pin, and a generate-drift check plus
release validation reject a launcher or pin that does not match canonical
sources — the same enforcement the template already uses for generated
manifests.

### Proven by execution

A self-proving check runs the whole mechanism rather than documenting it:
generate launchers, run two different skills through the one engine on the
bootstrapped runtime, assert a single shared cached runtime, exercise doctor
and repair, and confirm fail-closed on an unknown skill id and a tampered
checksum. The prototype passes all of these.

## Open sub-choice: the bootstrap host

The one point the three designers split on. Both are viable; pick during
productionization.

- **POSIX shell stage-zero** (2 of 3, and the prototype): `runtime-exec` is a
  shell script using the platform's `curl`/`unzip`/`sha256`. Simplest and most
  transparent, but depends on those tools; a doctor prerequisite check reports
  a typed failure when one is absent.
- **QuickJS-hosted primitives** (1 of 3): bundle HTTPS, SHA-256, and unzip into
  the already-embedded QuickJS interpreter, so stage-zero needs no system tools
  at all. Most self-contained and most on-brand for a template that already
  ships its own interpreter to avoid host dependencies, at the cost of building
  those primitives inside QuickJS.

## Consequences

- Adding an OS-integrated skill is a catalog entry plus regeneration; the
  security-sensitive lifecycle is authored once.
- All OS-integrated skills share one cached runtime; a runtime bump is one
  reviewed lock change that moves them together.
- The design is runtime-agnostic: a Python/`uv` profile (ADR 0004) is another
  closed `runtimeKind` branch reusing the same custody/verify/cache mechanics.
- The prototype lives on a throwaway branch; productionization must choose the
  bootstrap host, replace the abstracted `file://` transport with the
  checksum-pinned download, and wire the drift check and self-proving check
  into CI.

## Follow-up

- Choose the bootstrap host (shell vs QuickJS-hosted).
- Replace the stubbed transport with a real checksum-pinned download.
- Wire generate-drift and the self-proving custody check into CI and release
  validation.
- Add the `uv`/Python profile when a Python-native OS-integrated skill exists.
