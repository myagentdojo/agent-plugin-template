import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { currentRuntimeTarget, parsePlatformProofOptions } from "./prove-runtime-platform"

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

test.each([
	["plugin CI", ".github/workflows/plugin-ci.yml", "runtime-candidate-${{ github.sha }}"],
	["release", ".github/workflows/release.yml", "release-platform-candidate-${{ github.run_id }}"],
] as const)("%s builds once and proves the same candidate on every target", (_name, path, artifact) => {
	const workflow = readFileSync(resolve(root, path), "utf8")
	expect(workflow).toContain("name: Build candidate once".replace("candidate", path.includes("release") ? "release candidate" : "candidate"))
	expect(workflow).toContain(artifact)
	expect(workflow).toContain("bun run prove:runtime-platform")
	expect(workflow).toContain("--fixture-acknowledged")
	expect(workflow).toContain('cmp --silent "$candidate_archive" "$rebuilt_archive"')
	expect(workflow).toContain('cmp --silent "$candidate_checksums" "$rebuilt_checksums"')
	for (const target of ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]) {
		expect(workflow).toContain(`target: ${target}`)
	}
})
