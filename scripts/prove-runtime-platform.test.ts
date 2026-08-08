import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
	currentRuntimeTarget,
	networkIsolatedCommand,
	parsePlatformProofOptions,
} from "./prove-runtime-platform"

const root = resolve(import.meta.dir, "..")

test("platform proof requires explicit fixture acknowledgement before repair apply", () => {
	expect(() =>
		parsePlatformProofOptions([
			"--archive",
			"candidate.tar.gz",
			"--checksums",
			"candidate.checksums.json",
			"--target",
			"linux-x64",
		]),
	).toThrow("--fixture-acknowledged is required")
})

test("platform proof admits exactly the four reviewed targets", () => {
	const options = parsePlatformProofOptions([
		"--archive",
		"candidate.tar.gz",
		"--checksums",
		"candidate.checksums.json",
		"--target",
		"darwin-arm64",
		"--fixture-acknowledged",
	])
	expect(options.target).toBe("darwin-arm64")
	expect(options.fixtureAcknowledged).toBe(true)
	expect(() =>
		parsePlatformProofOptions([
			"--archive",
			"candidate.tar.gz",
			"--checksums",
			"candidate.checksums.json",
			"--target",
			"windows-x64",
			"--fixture-acknowledged",
		]),
	).toThrow("unsupported target")
})

test("host identity maps only supported Darwin and Linux architectures", () => {
	expect(currentRuntimeTarget("darwin", "arm64")).toBe("darwin-arm64")
	expect(currentRuntimeTarget("darwin", "x64")).toBe("darwin-x64")
	expect(currentRuntimeTarget("linux", "arm64")).toBe("linux-arm64")
	expect(currentRuntimeTarget("linux", "x64")).toBe("linux-x64")
	expect(currentRuntimeTarget("win32", "x64")).toBeUndefined()
})

test("skill runs use kernel-enforced network isolation on each supported host", () => {
	expect(networkIsolatedCommand(["/plugin/bin/skill-a"], "darwin", 501, 20)).toEqual([
		"/usr/bin/sandbox-exec",
		"-p",
		"(version 1) (allow default) (deny network*)",
		"/plugin/bin/skill-a",
	])
	expect(networkIsolatedCommand(["/plugin/bin/skill-a"], "linux", 1001, 1001)).toEqual([
		"/usr/bin/sudo",
		"-n",
		"--preserve-env=HOME,XDG_CACHE_HOME,PATH",
		"/usr/bin/unshare",
		"--net",
		"--setuid=1001",
		"--setgid=1001",
		"--",
		"/plugin/bin/skill-a",
	])
})

test.each([
	[
		"plugin CI",
		".github/workflows/plugin-ci.yml",
		"Build candidate once",
		"runtime-candidate-${{ github.sha }}",
	],
	[
		"release",
		".github/workflows/release.yml",
		"Build release candidate once",
		"release-platform-candidate-${{ github.run_id }}",
	],
] as const)("%s builds once and proves the same candidate on every target", (_name, path, jobName, artifact) => {
	const workflow = readFileSync(resolve(root, path), "utf8")
	const candidateJob = workflow.slice(
		workflow.indexOf("\n  candidate:\n"),
		workflow.indexOf("\n  compatibility:\n"),
	)
	expect(workflow).toContain(`name: ${jobName}`)
	expect(candidateJob).toContain("persist-credentials: false")
	expect(workflow).toContain(artifact)
	expect(workflow).toContain("bun run prove:runtime-platform")
	expect(workflow).toContain("--fixture-acknowledged")
	expect(workflow.match(/--dir "\$RUNNER_TEMP\/platform-candidate"/g)).toHaveLength(2)
	expect(workflow).toContain('find "$RUNNER_TEMP/platform-candidate"')
	expect(workflow).toContain('cmp --silent "$candidate_archive" "$rebuilt_archive"')
	expect(workflow).toContain('cmp --silent "$candidate_checksums" "$rebuilt_checksums"')
	for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
		expect(workflow).toContain(`target: ${target}`)
	}
})

test("platform proof isolates HOME from the cache whose cold-run emptiness it asserts", () => {
	const source = readFileSync(resolve(root, "scripts/prove-runtime-platform.ts"), "utf8")
	expect(source).toContain('const homeRoot = join(isolationRoot, "home")')
	expect(source).toContain("HOME: homeRoot")
	expect(source).toContain("XDG_CACHE_HOME: cacheRoot")
	expect(source).toContain("readdirSync(cacheRoot).length !== 0")
})
