import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

import {
	RELEASE_PROJECTION_PATHS,
	validateReleaseProjection,
} from "./release-projection"

test("one projection policy accepts version-only changes and rejects behavioral drift", () => {
	const versionOnly = validateReleaseProjection(
		[{ filename: "plugin.config.json", status: "modified", sha: "1" }],
		() => ({ before: '{"version":"0.1.0","name":"x"}', after: '{"version":"0.2.0","name":"x"}' }),
	)

	expect(versionOnly.changedFiles).toEqual(["plugin.config.json"])
	expect(versionOnly.projectionDigest).toMatch(/^[a-f0-9]{64}$/)
	expect(() =>
		validateReleaseProjection(
			[{ filename: "plugin.config.json", status: "modified" }],
			() => ({ before: '{"version":"0.1.0","name":"x"}', after: '{"version":"0.2.0","name":"y"}' }),
		),
	).toThrow("non-version behavior")
	expect(() =>
		validateReleaseProjection([{ filename: "README.md", status: "modified" }], () => ({
			before: "a",
			after: "b",
		})),
	).toThrow("unsupported path")
})

test("projection CLI executes the same policy against Git refs", () => {
	const repository = mkdtempSync(join(tmpdir(), "release-projection-cli-"))
	const run = (arguments_: string[]) =>
		Bun.spawnSync({ cmd: arguments_, cwd: repository, stdout: "pipe", stderr: "pipe" })
	for (const command of [
		["git", "init", "--quiet"],
		["git", "config", "user.name", "Projection Test"],
		["git", "config", "user.email", "projection@example.invalid"],
	]) {
		expect(run(command).exitCode).toBe(0)
	}
	writeFileSync(join(repository, "plugin.config.json"), '{"name":"x","version":"0.1.0"}\n')
	expect(run(["git", "add", "plugin.config.json"]).exitCode).toBe(0)
	expect(run(["git", "commit", "--quiet", "-m", "base"]).exitCode).toBe(0)
	const base = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
	writeFileSync(join(repository, "plugin.config.json"), '{"name":"x","version":"0.2.0"}\n')
	expect(run(["git", "add", "plugin.config.json"]).exitCode).toBe(0)
	expect(run(["git", "commit", "--quiet", "-m", "version"]).exitCode).toBe(0)
	const head = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
	const projection = join(repository, "projection.json")
	writeFileSync(projection, '[{"filename":"plugin.config.json","status":"modified","sha":"1"}]\n')

	const result = run([
		process.execPath,
		"run",
		join(import.meta.dir, "release-projection.ts"),
		"--base",
		base,
		"--head",
		head,
		"--projection",
		projection,
		"--json",
	])

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: true,
		changedFiles: ["plugin.config.json"],
	})
	expect(RELEASE_PROJECTION_PATHS).toContain("plugin/runtime/hello-world.js")
})
