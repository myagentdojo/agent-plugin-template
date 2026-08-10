import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { classifyReleaseImpact } from "./release-impact"

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

test("static capability sidecars are release-relevant but outside the version projection", () => {
	for (const path of [
		"plugin/hooks/codex/hooks.json",
		"plugin/hooks/fixture/lifecycle-mechanics-proof.source.json",
		"plugin/skills/capability-tour/SKILL.md",
		"plugin/skills/capability-tour/references/capability-reviewer.md",
		"plugin/assets/logo.svg",
	]) {
		expect(() =>
			validateReleaseProjection(
				[{ filename: path, status: "modified" }],
				() => ({ before: "before", after: "after" }),
			),
		).toThrow("unsupported path")
		expect(
			classifyReleaseImpact({
				title: "chore: change a static capability sidecar",
				changedFiles: [{ path }],
				pullRequestIdentity: {
					headRef: "release-please--branches--main",
					authorLogin: "github-actions[bot]",
					expectedAutomationLogin: "github-actions[bot]",
				},
			}),
		).toMatchObject({ payloadChanged: true, isReleasePleaseProjection: false, ok: false })
	}
})

test("projection binds every changed candidate blob to the reviewed pull-request head", () => {
	const file = { filename: "plugin.config.json", status: "modified", sha: "reviewed-blob" }
	const versions = {
		before: '{"version":"0.1.0","name":"x"}',
		after: '{"version":"0.2.0","name":"x"}',
		afterSha: "reviewed-blob",
	}

	expect(validateReleaseProjection([file], () => versions).changedFiles).toEqual([
		"plugin.config.json",
	])
	expect(() =>
		validateReleaseProjection([{ ...file, sha: "different-blob" }], () => versions),
	).toThrow("reviewed head blob")
})

test("projection binds the complete candidate changed-file set to the reviewed pull request", () => {
	const file = { filename: "plugin.config.json", status: "modified", sha: "reviewed-blob" }
	const versions = {
		before: '{"version":"0.1.0","name":"x"}',
		after: '{"version":"0.2.0","name":"x"}',
		afterSha: "reviewed-blob",
	}

	expect(validateReleaseProjection([file], () => versions, [file.filename]).changedFiles).toEqual([
		file.filename,
	])
	expect(() =>
		validateReleaseProjection([file], () => versions, [file.filename, "plugin/runtime/extra.js"]),
	).toThrow("candidate changed-file set")
})

test("changelog projection prepends exactly one current-version section", () => {
	const manifest = {
		before: '{".":"0.1.0"}',
		after: '{".":"0.2.0"}',
	}
	const before = "# Changelog\n\n## [0.1.0](https://example.invalid/v0.1.0) (2026-08-01)\n\nOld bytes.\n"
	const current = "## [0.2.0](https://example.invalid/v0.2.0) (2026-08-06)\n\n### Features\n\n* Added.\n\n"
	const validateChangelog = (after: string): ReturnType<typeof validateReleaseProjection> =>
		validateReleaseProjection(
			[{ filename: "CHANGELOG.md", status: "modified" }],
			(path) => path === "CHANGELOG.md" ? { before, after } : manifest,
		)

	expect(validateChangelog(`# Changelog\n\n${current}${before.slice("# Changelog\n\n".length)}`).changedFiles).toEqual([
		"CHANGELOG.md",
	])
	expect(() => validateChangelog(`${before}${current}`)).toThrow("non-version behavior")
	expect(() =>
		validateChangelog(`# Changelog\n\nUnrelated prefix.\n\n${current}${before.slice("# Changelog\n\n".length)}`),
	).toThrow("non-version behavior")
	expect(() =>
		validateChangelog(`# Changelog\n\n${current}${before.slice("# Changelog\n\n".length).replace("Old bytes.", "Rewritten.")}`),
	).toThrow("non-version behavior")
	expect(() =>
		validateChangelog(`# Changelog\n\n${current}## Unrelated\n\nExtra.\n\n${before.slice("# Changelog\n\n".length)}`),
	).toThrow("non-version behavior")
	expect(() =>
		validateChangelog(`# Changelog\n\n${current.replaceAll("0.2.0", "0.3.0")}${before.slice("# Changelog\n\n".length)}`),
	).toThrow("non-version behavior")
})

test("bootstrap changelog projection accepts one initial current-version section", () => {
	const result = validateReleaseProjection(
		[{ filename: "CHANGELOG.md", status: "modified" }],
		(path) => path === "CHANGELOG.md"
			? {
				before: "",
				after: "# Changelog\n\n## 0.1.0 (2026-08-06)\n\nInitial release.\n",
			}
			: { before: "{}", after: '{".":"0.1.0"}' },
	)

	expect(result.changedFiles).toEqual(["CHANGELOG.md"])
})

test("projection CLI executes the same policy against Git refs", () => {
	const repository = mkdtempSync(join(tmpdir(), "release-projection-cli-"))
	const run = (arguments_: string[]) =>
		Bun.spawnSync({ cmd: arguments_, cwd: repository, stdout: "pipe", stderr: "pipe" })
	const unreviewedPath = "unreviewed-☃\nfile.txt"
	let result: ReturnType<typeof Bun.spawnSync> | undefined
	let unsupportedPathResult: ReturnType<typeof Bun.spawnSync> | undefined
	try {
		for (const command of [
			["git", "init", "--quiet"],
			["git", "config", "user.name", "Projection Test"],
			["git", "config", "user.email", "projection@example.invalid"],
			["git", "config", "commit.gpgsign", "false"],
			["git", "config", "tag.gpgsign", "false"],
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
		const headBlob = run(["git", "rev-parse", `${head}:plugin.config.json`]).stdout.toString().trim()
		const projection = join(repository, "projection.json")
		writeFileSync(
			projection,
			`${JSON.stringify([{ filename: "plugin.config.json", status: "modified", sha: headBlob }])}\n`,
		)

		result = run([
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
		writeFileSync(join(repository, unreviewedPath), "unreviewed\n")
		expect(run(["git", "add", "--", unreviewedPath]).exitCode).toBe(0)
		expect(run(["git", "commit", "--quiet", "-m", "unreviewed path"]).exitCode).toBe(0)
		const headWithUnreviewedPath = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
		const unreviewedBlob = run([
			"git",
			"rev-parse",
			`${headWithUnreviewedPath}:${unreviewedPath}`,
		]).stdout.toString().trim()
		const projectionWithUnreviewedPath = join(repository, "projection-with-unreviewed-path.json")
		writeFileSync(
			projectionWithUnreviewedPath,
			`${JSON.stringify([
				{ filename: "plugin.config.json", status: "modified", sha: headBlob },
				{ filename: unreviewedPath, status: "modified", sha: unreviewedBlob },
			])}\n`,
		)
		unsupportedPathResult = run([
			process.execPath,
			"run",
			join(import.meta.dir, "release-projection.ts"),
			"--base",
			base,
			"--head",
			headWithUnreviewedPath,
			"--projection",
			projectionWithUnreviewedPath,
			"--json",
		])
	} finally {
		rmSync(repository, { recursive: true, force: true })
	}

	expect(existsSync(repository)).toBe(false)
	expect(result).toBeDefined()
	if (!result) throw new Error("projection CLI fixture did not run")
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: true,
		changedFiles: ["plugin.config.json"],
	})
	expect(unsupportedPathResult).toBeDefined()
	if (!unsupportedPathResult) throw new Error("newline-path projection fixture did not run")
	expect(unsupportedPathResult.exitCode).toBe(1)
	expect(unsupportedPathResult.stderr.toString()).toContain(`unsupported path: ${unreviewedPath}`)
	expect(RELEASE_PROJECTION_PATHS).not.toContain("plugin/runtime/hello-world.js")
})
