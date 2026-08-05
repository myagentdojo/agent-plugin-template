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
		releaseState: "bootstrap",
		changelog: "CHANGELOG.md",
		npmPublicationRequired: false,
	})
})

test("release validation accepts a synchronized post-bootstrap manifest", () => {
	const temporaryRoot = copyRepository()
	const pluginConfig = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	writeFileSync(
		join(temporaryRoot, ".github", ".release-please-manifest.json"),
		`${JSON.stringify({ ".": pluginConfig.version }, null, 2)}\n`,
	)
	writeFileSync(
		join(temporaryRoot, "CHANGELOG.md"),
		`# Changelog\n\n## ${pluginConfig.version}\n\nInitial release.\n`,
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		releaseState: "released",
		version: pluginConfig.version,
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

test("release validation rejects an empty manifest after v0.1.0", () => {
	const temporaryRoot = copyRepository()
	for (const path of [
		"package.json",
		"plugin.config.json",
		"plugin/.claude-plugin/plugin.json",
		"plugin/.codex-plugin/plugin.json",
	]) {
		const absolutePath = join(temporaryRoot, path)
		const json = JSON.parse(readFileSync(absolutePath, "utf8"))
		json.version = "0.2.0"
		writeFileSync(absolutePath, `${JSON.stringify(json, null, 2)}\n`)
	}
	const marketplacePath = join(temporaryRoot, ".claude-plugin", "marketplace.json")
	const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"))
	marketplace.metadata.version = "0.2.0"
	writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
	const runtimePath = join(temporaryRoot, "plugin", "runtime", "hello-world.js")
	writeFileSync(
		runtimePath,
		readFileSync(runtimePath, "utf8").replace('const PLUGIN_VERSION = "0.1.0";', 'const PLUGIN_VERSION = "0.2.0";'),
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("empty release-please manifest")
})

test("release validation rejects unexpected manifest packages", () => {
	const temporaryRoot = copyRepository()
	writeFileSync(
		join(temporaryRoot, ".github", ".release-please-manifest.json"),
		`${JSON.stringify({ unexpected: "0.1.0" }, null, 2)}\n`,
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("bootstrap release-please manifest must be empty")
})

test("release validation rejects a duplicate changelog heading", () => {
	const temporaryRoot = copyRepository()
	writeFileSync(
		join(temporaryRoot, "CHANGELOG.md"),
		"# Changelog\n\n## 0.1.0\n\nInitial release.\n\n## Changelog\n",
	)

	const result = validate(temporaryRoot)
	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("duplicate Changelog heading")
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
