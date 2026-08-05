# runtime-custody — PROTOTYPE (throwaway)

DRY bootstrap for N OS-integrated skills. Proves the design three independent
cold Codex reviewers converged on: one shared custody engine + one pinned lock
+ generated per-skill launchers + shared cache, proven by execution.

## Run

```sh
bun run prototypes/category-gallery/runtime-custody/generate.ts   # (re)generate launchers
bun run prototypes/category-gallery/runtime-custody/prove.ts       # prove the whole thing
```

## Shape (the consensus)

| File | Role |
| --- | --- |
| `runtime-exec.sh` | the ONE shared engine: resolve skill→profile→asset, check/repair a shared cache with checksum verification, exec verified Bun. POSIX shell stage-zero (Bun doesn't exist yet). |
| `runtime.lock.json` | ONE template-wide, version-exact pin. Reviewed artifact; not build-regenerated. Per-platform sha256. |
| `catalog.json` | closed skill registry: skill id → entry + runtime profile. Skills never name a version/url/checksum/path. |
| `generate.ts` | generates one thin launcher per catalog skill (`bin/<skill>`). Adding skill #21 = one catalog entry + regenerate. `--check` = drift gate. |
| `bin/<skill>` | GENERATED 4-line shim → `runtime-exec.sh run <skill> -- "$@"`. |
| `skills/*.js` | the OS-integrated skills (spawn / fs). Run on bootstrapped Bun. |
| `prove.ts` | executable proof (8 checks): generate, both skills run, ONE shared cached runtime, doctor, repair, unknown-skill fail-closed, tampered-checksum fail-closed. |

## What's proven vs stubbed

Proven by running: generated launchers, two skills sharing one engine + one cached
runtime, checksum-verified custody, doctor/repair, fail-closed on unknown skill and
tampered checksum.

Stubbed: the network transport. The lock's `url` is `file://` (copies the pinned
local Bun); production downloads the checksum-pinned release URL. Only the transport
is abstracted — the custody/verify/cache/exec mechanism is real.

## Divergence not taken

Reviewers split on the bootstrap host: POSIX shell (2 votes, this prototype) vs
QuickJS-hosted primitives (1 vote, zero system-tool dependency). Shell depends on
`python3` + `shasum`/`sha256sum` here; a doctor prerequisite check reports a typed
failure if absent. The QuickJS-hosted variant removes that dependency at the cost of
building fetch/unzip inside qjs.
