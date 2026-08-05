# Decision 0003: QuickJS compatibility spike

Status: integrated for the current hello-world slice; future Bun-specific dependencies remain conditional.

## Question

Can the existing hello-world and hook command contracts run offline under a vendored QuickJS interpreter without Bun or Node at runtime?

## Result

Yes for the current slice.

- QuickJS NG: `0.16.1`.
- Host proof: macOS arm64.
- Portable JavaScript bundle: 1,525 bytes.
- Host interpreter: 1,303,984 bytes.
- Four-platform deterministic archive: about 3.46 MB compressed.
- Hello output: byte-equivalent between Bun and QuickJS.
- Hook stdin, stderr, and exit status: byte-equivalent between Bun and QuickJS.
- Extracted package: executes with Bun removed from `PATH` and no network access.

Run the promoted proof:

```sh
bun run spike:quickjs
CI=true bun run prove:quickjs-ci
```

## Publish CI spike

`.github/workflows/plugin-ci.yml` defines:

- native execution on Linux x64, Linux arm64, macOS arm64, and macOS x64;
- full commit-SHA pins for every GitHub Action;
- deterministic packaging after the compatibility matrix passes;
- SHA-named workflow artifact plus provenance JSON;
- GitHub artifact attestation only for a push to `main` in a public repository; user-owned private repositories keep the provenance JSON and skip the unsupported attestation job.

Local CI Testbed reproduction passed from a fresh temporary Git worktree with `CI=true` and a frozen Bun install. Hosted execution remains unproven until the repository has a commit and remote.

## Boundary

This does not prove that future Bun-specific libraries can move to QuickJS. Keep the portable core free of `Bun.*`, `node:*`, and host APIs. Re-run the compatibility proof against the first real runtime slice before adding such a dependency.
