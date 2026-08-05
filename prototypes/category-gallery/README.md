# Category gallery — PROTOTYPE (throwaway)

One runnable example plugin skill per runtime category. Proves each category
runs on the runtime its workload requires. Throwaway; not wired into the real
`plugin/` generation. Companion to ADR 0004.

## Run

```sh
bun run prototypes/category-gallery/run.ts
```

## Categories

| Dir | Runtime | Proves |
| --- | --- | --- |
| `cat1-pure-logic/` | QuickJS | args/stdin -> stdout, no deps (what hello-world already is) |
| `cat2-npm-shim/` | QuickJS + host shim | a real npm lib (`nanoid`) that needs `crypto` runs once the shim bridges `crypto.getRandomValues` to `/dev/urandom` (real entropy, never `Math.random`); `zod` runs unshimmed |
| `cat3-bootstrap/` | bootstrapped Bun | an OS-integrated skill (spawns `git`, reads/writes fs) on a runtime resolved by a first-run launcher (reuse-if-present, else fetch a pinned Bun) — impossible under QuickJS |

`shared/quickjs-host-shims.ts` is the QuickJS host-shim layer ADR 0004 calls for.

## Verdict (2026-08-05)

All three run. cat2 confirms npm-under-QuickJS works with a real-entropy shim;
cat3 confirms OS-integration needs a real runtime and the Option-B bootstrap
carries it. The publishing rails (candidate SHA, safe walker, checksums,
canaries) are runtime-agnostic and would carry any of the three unchanged.

## Stubs / not-production

- cat3 launcher REUSES a present `bun` and only *describes* the pinned fetch +
  checksum verification; production mirrors `plugin/runtime/quickjs-assets.json`.
- No four-platform proof here; a real cat2/cat3 skill must pass `prove:distribution`.
