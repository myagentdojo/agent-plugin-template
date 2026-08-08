import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, test } from "bun:test"

import {
	classifyReleaseImpact,
	isReleasePleaseVersionOnlyChange,
} from "./release-impact"

describe("release impact", () => {
	const root = resolve(import.meta.dir, "..")
	const nonReleasablePayloadChanges = [
		["docs: explain the skill", "plugin/skills/hello-world/SKILL.md"],
		["test: cover the hook", "plugin/hooks/claude/hooks.json"],
		["ci: package the launcher", "plugin/bin/hello-world"],
		["chore: refresh runtime assets", "plugin/runtime/quickjs-assets.json"],
		["refactor: reshape the manifest", "plugin/.codex-plugin/plugin.json"],
		["chore: refresh the marketplace", ".agents/plugins/marketplace.json"],
		["chore: tweak the skill source", "packages/skill-a/src/main.ts"],
		["chore: update the skill manifest", "packages/skill-b/package.json"],
		["chore: refresh the lockfile", "bun.lock"],
		["chore: tune the install config", "bunfig.toml"],
	] as const

	for (const [title, path] of nonReleasablePayloadChanges) {
		test(`rejects ${path} under ${title.split(":")[0]} title`, () => {
			expect(
				classifyReleaseImpact({
					title,
					changedFiles: [{ path }],
				}),
			).toEqual({
				payloadChanged: true,
				isReleasePleaseProjection: false,
				titleIsReleasable: false,
				ok: false,
				changedPayloadPaths: [path],
				acceptedTitleTypes: ["feat", "fix", "perf", "breaking (!)"],
			})
		})
	}

	test("allows documentation, tests, and CI changes under a non-releasable title", () => {
		const result = classifyReleaseImpact({
			title: "chore: maintain contributor checks",
			changedFiles: [
				{ path: "README.md" },
				{ path: "docs/distribution.md" },
				{ path: "scripts/release-impact.test.ts" },
				{ path: ".github/workflows/plugin-ci.yml" },
			],
		})

		expect(result).toMatchObject({
			payloadChanged: false,
			isReleasePleaseProjection: false,
			titleIsReleasable: false,
			ok: true,
			changedPayloadPaths: [],
		})
	})

	test("allows a payload source and generated output under fix title", () => {
		const result = classifyReleaseImpact({
			title: "fix: keep the portable command deterministic",
			changedFiles: [
				{ path: "runtime/src/portable-command.ts" },
				{ path: "plugin/runtime/hello-world.js" },
			],
		})

		expect(result).toMatchObject({
			payloadChanged: true,
			isReleasePleaseProjection: false,
			titleIsReleasable: true,
			ok: true,
			changedPayloadPaths: [
				"runtime/src/portable-command.ts",
				"plugin/runtime/hello-world.js",
			],
		})
	})

	test("treats runtime lock and catalog bumps as payload impact under fix title", () => {
		const result = classifyReleaseImpact({
			title: "fix: bump the pinned runtime lock",
			changedFiles: [
				{ path: "runtime/runtime.lock.json" },
				{ path: "runtime/skill-catalog.json" },
			],
		})

		expect(result).toMatchObject({
			payloadChanged: true,
			isReleasePleaseProjection: false,
			titleIsReleasable: true,
			ok: true,
			changedPayloadPaths: [
				"runtime/runtime.lock.json",
				"runtime/skill-catalog.json",
			],
		})
	})

	test("exempts the exact Release Please version and changelog projection", () => {
		const projection = [
			"plugin.config.json",
			".claude-plugin/marketplace.json",
			"plugin/.claude-plugin/plugin.json",
			"plugin/.codex-plugin/plugin.json",
			".github/.release-please-manifest.json",
			"CHANGELOG.md",
		].map((path) => ({ path, versionOnly: true }))

		const result = classifyReleaseImpact({
			title: "chore(main): release 1.2.3",
			changedFiles: projection,
			pullRequestIdentity: {
				headRef: "release-please--branches--main",
				authorLogin: "github-actions[bot]",
				expectedAutomationLogin: "github-actions[bot]",
			},
		})

		expect(result).toMatchObject({
			payloadChanged: true,
			isReleasePleaseProjection: true,
			titleIsReleasable: false,
			ok: true,
		})
	})

	test("exempts the full node Release Please projection including package.json", () => {
		const projection = [
			"package.json",
			"plugin.config.json",
			".claude-plugin/marketplace.json",
			"plugin/.claude-plugin/plugin.json",
			"plugin/.codex-plugin/plugin.json",
			".github/.release-please-manifest.json",
			"CHANGELOG.md",
		].map((path) => ({ path, versionOnly: true }))

		const result = classifyReleaseImpact({
			title: "chore(main): release 0.2.0",
			changedFiles: projection,
			pullRequestIdentity: {
				headRef: "release-please--branches--main",
				authorLogin: "github-actions[bot]",
				expectedAutomationLogin: "github-actions[bot]",
			},
		})

		expect(result).toMatchObject({
			isReleasePleaseProjection: true,
			ok: true,
		})
	})

	test("rejects a manual version projection without trusted Release Please identity", () => {
		const projection = [
			{ path: "plugin.config.json", versionOnly: true },
			{ path: "CHANGELOG.md", versionOnly: true },
		]

		for (const pullRequestIdentity of [
			undefined,
			{
				headRef: "manual-version-bump",
				authorLogin: "github-actions[bot]",
				expectedAutomationLogin: "github-actions[bot]",
			},
			{
				headRef: "release-please--branches--main",
				authorLogin: "octocat",
				expectedAutomationLogin: "github-actions[bot]",
			},
		]) {
			expect(
				classifyReleaseImpact({
					title: "chore(main): release 1.2.3",
					changedFiles: projection,
					pullRequestIdentity,
				}),
			).toMatchObject({ isReleasePleaseProjection: false, ok: false })
		}
	})

	test("removes the projection exemption for an unrelated payload change", () => {
		const result = classifyReleaseImpact({
			title: "chore(main): release 1.2.3",
			changedFiles: [
				{ path: "plugin.config.json", versionOnly: true },
				{ path: "plugin/runtime/hello-world.js", versionOnly: true },
				{ path: "CHANGELOG.md", versionOnly: true },
				{ path: "plugin/skills/hello-world/SKILL.md" },
			],
		})

		expect(result).toMatchObject({
			payloadChanged: true,
			isReleasePleaseProjection: false,
			titleIsReleasable: false,
			ok: false,
			changedPayloadPaths: [
				"plugin.config.json",
				"plugin/runtime/hello-world.js",
				"plugin/skills/hello-world/SKILL.md",
			],
		})
	})

	test("recognizes only the owned JSON version field as a version-only change", () => {
		const before = JSON.stringify({ version: "1.2.2", description: "Portable" })
		const versionOnly = JSON.stringify({ version: "1.2.3", description: "Portable" })
		const payloadEdit = JSON.stringify({ version: "1.2.3", description: "Changed" })

		expect(isReleasePleaseVersionOnlyChange("plugin.config.json", before, versionOnly)).toBe(
			true,
		)
		expect(isReleasePleaseVersionOnlyChange("plugin.config.json", before, payloadEdit)).toBe(
			false,
		)
	})

	test("recognizes only the package.json version field as a version-only change", () => {
		const before = JSON.stringify({ version: "0.1.0", scripts: { test: "bun test" } })
		const versionOnly = JSON.stringify({ version: "0.2.0", scripts: { test: "bun test" } })
		const scriptEdit = JSON.stringify({ version: "0.2.0", scripts: { test: "bun test unit" } })

		expect(isReleasePleaseVersionOnlyChange("package.json", before, versionOnly)).toBe(true)
		expect(isReleasePleaseVersionOnlyChange("package.json", before, scriptEdit)).toBe(false)
	})

	test("allows a non-version package.json edit without treating it as payload", () => {
		const result = classifyReleaseImpact({
			title: "chore: add a package script",
			changedFiles: [{ path: "package.json", versionOnly: false }],
		})

		expect(result).toMatchObject({
			payloadChanged: false,
			isReleasePleaseProjection: false,
			titleIsReleasable: false,
			ok: true,
			changedPayloadPaths: [],
		})
	})

	test("generated runtime bundles are not release-version projections", () => {
		expect(
			isReleasePleaseVersionOnlyChange(
				"plugin/hooks/codex/hooks.json",
				'{"command":"old"}',
				'{"command":"new"}',
			),
		).toBe(false)
		expect(
			isReleasePleaseVersionOnlyChange(
				"plugin/runtime/hello-world.js",
				"runOld()",
				"runNew()",
			),
		).toBe(false)
	})

	for (const title of [
		"feat!: replace the plugin contract",
		"fix!: remove the legacy hook",
		"refactor(runtime)!: replace the portable protocol",
		"feat(runtime): add a portable command",
		"fix: repair launcher routing",
		"perf: reduce startup work",
	]) {
		test(`accepts releasable title ${title}`, () => {
			const result = classifyReleaseImpact({
				title,
				changedFiles: [{ path: "plugin/bin/hello-world" }],
			})

			expect(result.titleIsReleasable).toBe(true)
			expect(result.ok).toBe(true)
		})
	}

	test("CLI failure emits structured recovery details", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, "run", "scripts/release-impact.ts"],
			cwd: new URL("..", import.meta.url).pathname,
			env: {
				...process.env,
				PR_TITLE: "docs: describe the launcher",
				CHANGED_FILES_JSON: JSON.stringify([{ path: "plugin/bin/hello-world" }]),
			},
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(1)
		const failure = JSON.parse(result.stdout.toString())
		expect(failure).toMatchObject({
			ok: false,
			category: "release_impact",
			retrySafe: true,
			changedPayloadPaths: ["plugin/bin/hello-world"],
			acceptedTitleTypes: ["feat", "fix", "perf", "breaking (!)"],
		})
		expect(failure.message).toContain("feat, fix, perf, or a breaking (!) title")
		expect(failure.nextAction).toContain("change the pull request title")
		expect(failure.runId).toBeString()
	})

	test("CLI accepts a trusted Release Please projection identity", () => {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"run",
				"scripts/release-impact.ts",
				"--pr-head-ref",
				"release-please--branches--main",
				"--pr-author-login",
				"github-actions[bot]",
				"--expected-release-please-login",
				"github-actions[bot]",
			],
			cwd: new URL("..", import.meta.url).pathname,
			env: {
				...process.env,
				PR_TITLE: "chore(main): release 1.2.3",
				CHANGED_FILES_JSON: JSON.stringify([
					{ path: "plugin.config.json", versionOnly: true },
					{ path: "CHANGELOG.md", versionOnly: true },
				]),
			},
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(0)
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			isReleasePleaseProjection: true,
			ok: true,
			sideEffects: "none",
		})
		expect(result.stderr.toString()).toBe("")
	})

	test("CLI fails closed when Release Please identity options are incomplete", () => {
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"run",
				"scripts/release-impact.ts",
				"--pr-head-ref",
				"release-please--branches--main",
			],
			cwd: new URL("..", import.meta.url).pathname,
			env: {
				...process.env,
				PR_TITLE: "chore(main): release 1.2.3",
				CHANGED_FILES_JSON: JSON.stringify([
					{ path: "plugin.config.json", versionOnly: true },
				]),
			},
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(1)
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			isReleasePleaseProjection: false,
			ok: false,
			category: "release_impact",
		})
		expect(result.stderr.toString()).toContain("release-impact:")
	})

	test("CLI classifies Git-backed changed files through the centralized projection policy", () => {
		const repository = mkdtempSync(join(tmpdir(), "release-impact-git-"))
		const run = (arguments_: string[]) =>
			Bun.spawnSync({ cmd: arguments_, cwd: repository, stdout: "pipe", stderr: "pipe" })
		for (const command of [
			["git", "init", "--quiet"],
			["git", "config", "user.name", "Release Impact Test"],
			["git", "config", "user.email", "release-impact@example.invalid"],
		]) expect(run(command).exitCode).toBe(0)
		mkdirSync(join(repository, "runtime", "src"), { recursive: true })
		writeFileSync(join(repository, "runtime", "src", "portable.ts"), "export const value = 1\n")
		expect(run(["git", "add", "runtime/src/portable.ts"]).exitCode).toBe(0)
		expect(run(["git", "commit", "--quiet", "-m", "base"]).exitCode).toBe(0)
		const base = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
		writeFileSync(join(repository, "runtime", "src", "portable.ts"), "export const value = 2\n")
		expect(run(["git", "add", "runtime/src/portable.ts"]).exitCode).toBe(0)
		expect(run(["git", "commit", "--quiet", "-m", "head"]).exitCode).toBe(0)
		const head = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
		const result = Bun.spawnSync({
			cmd: [
				process.execPath,
				"run",
				join(root, "scripts", "release-impact.ts"),
				"--base",
				base,
				"--head",
				head,
			],
			cwd: repository,
			env: {
				...process.env,
				CHANGED_FILES_JSON: undefined,
				PR_TITLE: "fix: update the portable runtime",
			},
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode, result.stderr.toString()).toBe(0)
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			ok: true,
			changedPayloadPaths: ["runtime/src/portable.ts"],
		})
	})

	test("CLI includes a payload path renamed into documentation", () => {
		const repository = mkdtempSync(join(tmpdir(), "release-impact-rename-"))
		const run = (arguments_: string[]) =>
			Bun.spawnSync({ cmd: arguments_, cwd: repository, stdout: "pipe", stderr: "pipe" })
		for (const command of [
			["git", "init", "--quiet"],
			["git", "config", "user.name", "Release Impact Test"],
			["git", "config", "user.email", "release-impact@example.invalid"],
		]) expect(run(command).exitCode).toBe(0)
		mkdirSync(join(repository, "plugin", "skills", "hello-world"), { recursive: true })
		mkdirSync(join(repository, "docs"), { recursive: true })
		writeFileSync(join(repository, "plugin", "skills", "hello-world", "SKILL.md"), "hello\n")
		expect(run(["git", "add", "plugin/skills/hello-world/SKILL.md"]).exitCode).toBe(0)
		expect(run(["git", "commit", "--quiet", "-m", "base"]).exitCode).toBe(0)
		const base = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
		expect(run(["git", "mv", "plugin/skills/hello-world/SKILL.md", "docs/hello-world.md"]).exitCode).toBe(0)
		expect(run(["git", "commit", "--quiet", "-m", "head"]).exitCode).toBe(0)
		const head = run(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
		const result = Bun.spawnSync({
			cmd: [process.execPath, "run", join(root, "scripts", "release-impact.ts"), "--base", base, "--head", head],
			cwd: repository,
			env: {
				...process.env,
				CHANGED_FILES_JSON: undefined,
				PR_TITLE: "docs: move the skill guide",
			},
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(1)
		expect(JSON.parse(result.stdout.toString())).toMatchObject({
			changedPayloadPaths: ["plugin/skills/hello-world/SKILL.md"],
		})
	})

	test("pull request gate executes trusted base code against the fetched head", () => {
		const workflow = readFileSync(join(root, ".github", "workflows", "release-impact.yml"), "utf8")

		expect(workflow).toContain("pull_request_target:")
		expect(workflow).toContain("statuses: write")
		expect(workflow).toContain("ref: ${{ github.event.pull_request.base.sha }}")
		expect(workflow).toContain("persist-credentials: false")
		expect(workflow).toContain('git fetch --no-tags origin "refs/pull/${PR_NUMBER}/head"')
		expect(workflow).toContain('--raw-field state=pending')
		expect(workflow).toContain('IMPACT_OUTCOME: ${{ steps.impact.outcome }}')
		expect(workflow).toContain("group: release-impact-${{ github.event.pull_request.number }}")
		expect(workflow).toContain("cancel-in-progress: true")
		expect(workflow).toContain('if current_pr=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"); then')
		expect(workflow).toContain('current_head_sha=$(jq -r .head.sha <<< "$current_pr")')
		expect(workflow).toContain('current_title=$(jq -r .title <<< "$current_pr")')
		expect(workflow).toContain('PR_TITLE="$current_title" bun run scripts/release-impact.ts')
		expect(workflow).toContain('if verified_pr=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}"); then')
		expect(workflow).toContain('description="Release impact could not read current pull request"')
		expect(workflow).toContain('description="Release impact could not verify the pull request after qualification"')
		expect(workflow).toContain('verified_head_sha=$(jq -r .head.sha <<< "$verified_pr")')
		expect(workflow).toContain('verified_title=$(jq -r .title <<< "$verified_pr")')
		expect(workflow.indexOf('verified_title=$(jq -r .title <<< "$verified_pr")')).toBeLessThan(
			workflow.indexOf('--raw-field state="${state}"'),
		)
		expect(workflow.indexOf("ref: ${{ github.event.pull_request.base.sha }}")).toBeLessThan(
			workflow.indexOf("bun run scripts/release-impact.ts"),
		)
	})

	test("CLI help exposes inputs, output, and side-effect posture", () => {
		const result = Bun.spawnSync({
			cmd: [process.execPath, "run", "scripts/release-impact.ts", "--help"],
			cwd: new URL("..", import.meta.url).pathname,
			stdout: "pipe",
			stderr: "pipe",
		})

		expect(result.exitCode).toBe(0)
		expect(result.stdout.toString()).toContain("--base <git-ref>")
		expect(result.stdout.toString()).toContain("--pr-head-ref <branch>")
		expect(result.stdout.toString()).toContain("--pr-author-login <login>")
		expect(result.stdout.toString()).toContain("--expected-release-please-login <login>")
		expect(result.stdout.toString()).toContain("Missing or mismatched identity disables")
		expect(result.stdout.toString()).toContain("one JSON result on stdout")
		expect(result.stdout.toString()).toContain("Side effects: none")
	})
})
