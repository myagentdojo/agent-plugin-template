import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const ignoredEntries = new Set([".dev", ".git", ".worktrees", "dist", "node_modules"])

function copyRepository(): string {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "agent-plugin-release-"))
	cpSync(root, temporaryRoot, {
		recursive: true,
		filter: (source) => source === root || !ignoredEntries.has(basename(source)),
	})
	return temporaryRoot
}

function validate(cwd: string): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/release-validate.ts", "--json"],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("release metadata has one synchronized semantic version", () => {
	const result = validate(root)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		ok: true,
		version: expect.any(String),
		changelog: "CHANGELOG.md",
		npmPublicationRequired: false,
	})
})

test("release validation rejects a drifted version surface", () => {
	const temporaryRoot = copyRepository()
	const packagePath = join(temporaryRoot, "package.json")
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))
	packageJson.version = "9.9.9"
	writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("package.json version")
	expect(result.stderr.toString()).toContain("plugin.config.json")
})

test("release workflow is pinned and publishes proven assets after validation", () => {
	const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8")
	const actionReferences = [...workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
		(match) => match[1],
	)

	expect(actionReferences.length).toBeGreaterThan(0)
	expect(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference))).toBe(true)
	expect(workflow).toContain("bun run prove:all")
	expect(workflow).toContain("inputs.release_tag || github.sha")
	expect(workflow).toContain("gh release upload")
	expect(workflow).toContain("actions/attest")
})
