import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const templateVersion = JSON.parse(readFileSync(join(root, "plugin.config.json"), "utf8")).version
const ignoredEntries = new Set([
	".claude",
	".dev",
	".git",
	".worktrees",
	"dist",
	"node_modules",
])
const resetPaths = [
	"plugin.config.json",
	".claude-plugin/marketplace.json",
	".agents/plugins/marketplace.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
	"plugin/hooks/codex/hooks.json",
	".github/release-please-config.json",
	".github/.release-please-manifest.json",
	"CHANGELOG.md",
	"plugin/runtime/hello-world.js",
]

function copyTemplate(prefix: string): string {
	const temporaryRoot = mkdtempSync(join(tmpdir(), prefix))
	cpSync(root, temporaryRoot, {
		recursive: true,
		filter: (source) => source === root || !ignoredEntries.has(basename(source)),
	})
	return temporaryRoot
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function createReleasedTemplate(prefix: string): string {
	const temporaryRoot = copyTemplate(prefix)
	const configPath = join(temporaryRoot, "plugin.config.json")
	const config = JSON.parse(readFileSync(configPath, "utf8"))
	config.version = "9.9.9"
	writeJson(configPath, config)

	const claudeMarketplacePath = join(temporaryRoot, ".claude-plugin", "marketplace.json")
	const claudeMarketplace = JSON.parse(readFileSync(claudeMarketplacePath, "utf8"))
	claudeMarketplace.metadata.version = "9.9.9"
	writeJson(claudeMarketplacePath, claudeMarketplace)

	for (const manifestPath of [
		join(temporaryRoot, "plugin", ".claude-plugin", "plugin.json"),
		join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json"),
	]) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
		manifest.version = "9.9.9"
		writeJson(manifestPath, manifest)
	}

	const runtimePath = join(temporaryRoot, "plugin", "runtime", "hello-world.js")
	writeFileSync(
		runtimePath,
		readFileSync(runtimePath, "utf8").replace(
			'const PLUGIN_VERSION = "0.1.0";',
			'const PLUGIN_VERSION = "9.9.9";',
		),
	)
	const codexHooksPath = join(temporaryRoot, "plugin", "hooks", "codex", "hooks.json")
	writeFileSync(
		codexHooksPath,
		readFileSync(codexHooksPath, "utf8").replaceAll(
			"--plugin-version 0.1.0",
			"--plugin-version 9.9.9",
		),
	)
	writeJson(join(temporaryRoot, ".github", ".release-please-manifest.json"), { ".": "9.9.9" })
	writeFileSync(join(temporaryRoot, "CHANGELOG.md"), "# Changelog\n\n## 9.9.9\n\n- Template history\n")
	return temporaryRoot
}

function readResetTargets(temporaryRoot: string): Map<string, string> {
	return new Map(
		resetPaths.map((path) => [path, readFileSync(join(temporaryRoot, path), "utf8")]),
	)
}

function initializeTemplate(temporaryRoot: string, options: string[] = []): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"dojo-hello",
			"--author",
			"My Agent Dojo",
			"--repository",
			"https://github.com/myagentdojo/dojo-hello",
			"--force",
			...options,
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("template user initializes both harness manifests from one metadata source", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-init-")
	const result = initializeTemplate(temporaryRoot, [
		"--display-name",
		"Dojo Hello",
		"--description",
		"Portable hello-world agent plugin",
		"--json",
	])

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const output = JSON.parse(result.stdout.toString().trim())
	expect(output).toMatchObject({
		ok: true,
		action: "initialized",
		sideEffects: "repository-files-written",
		plugin: { name: "dojo-hello", version: templateVersion },
	})

	const config = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	expect(config).toMatchObject({
		template: false,
		name: "dojo-hello",
		displayName: "Dojo Hello",
		description: "Portable hello-world agent plugin",
		author: { name: "My Agent Dojo" },
		repository: "https://github.com/myagentdojo/dojo-hello",
		canary: {
			owner: "myagentdojo",
			publicRepository: "dojo-hello-public-canary",
			privateRepository: "dojo-hello-private-canary",
		},
	})

	const claudeManifest = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
	)
	expect(claudeManifest).toMatchObject({
		name: "dojo-hello",
		displayName: "Dojo Hello",
		version: templateVersion,
		skills: "./skills/",
		hooks: "./hooks/claude/hooks.json",
	})

	const codexManifest = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)
	expect(codexManifest).toMatchObject({
		name: "dojo-hello",
		version: templateVersion,
		skills: "./skills/",
		hooks: "./hooks/codex/hooks.json",
		interface: { displayName: "Dojo Hello" },
	})

	const codexMarketplace = JSON.parse(
		readFileSync(join(temporaryRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
	)
	expect(codexMarketplace.plugins[0]).toMatchObject({
		name: "dojo-hello",
		source: { source: "local", path: "./plugin" },
		policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
	})
})

test("initialization resets recipient release lineage to 0.1.0", () => {
	const temporaryRoot = createReleasedTemplate("agent-plugin-template-release-reset-")
	const result = initializeTemplate(temporaryRoot, ["--json"])

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const output = JSON.parse(result.stdout.toString().trim())
	expect(output).toMatchObject({
		ok: true,
		action: "initialized",
		plugin: { name: "dojo-hello", version: "0.1.0" },
	})
	expect(output.files).toEqual(expect.arrayContaining(resetPaths))

	const config = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	expect(config.version).toBe("0.1.0")
	const claudeManifest = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
	)
	const codexManifest = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)
	const claudeMarketplace = JSON.parse(
		readFileSync(join(temporaryRoot, ".claude-plugin", "marketplace.json"), "utf8"),
	)
	expect(claudeManifest.version).toBe("0.1.0")
	expect(codexManifest.version).toBe("0.1.0")
	expect(claudeMarketplace.metadata.version).toBe("0.1.0")

	const runtime = readFileSync(join(temporaryRoot, "plugin", "runtime", "hello-world.js"), "utf8")
	expect(runtime).toContain('// x-release-please-start-version\nconst PLUGIN_VERSION = "0.1.0";\n// x-release-please-end')
	expect(
		JSON.parse(readFileSync(join(temporaryRoot, ".github", ".release-please-manifest.json"), "utf8")),
	).toEqual({})
	expect(readFileSync(join(temporaryRoot, "CHANGELOG.md"), "utf8")).toBe("")
	const releaseConfig = JSON.parse(
		readFileSync(join(temporaryRoot, ".github", "release-please-config.json"), "utf8"),
	)
	expect(releaseConfig.packages["."]["package-name"]).toBe("dojo-hello")

	const codexHooks = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", "hooks", "codex", "hooks.json"), "utf8"),
	)
	for (const event of ["SessionStart", "Stop"]) {
		expect(codexHooks.hooks[event][0].hooks[0].command).toContain("--plugin-version 0.1.0")
	}
})

test("reinitialization without force preserves recipient release files", () => {
	const temporaryRoot = createReleasedTemplate("agent-plugin-template-release-refusal-")
	const initialized = initializeTemplate(temporaryRoot)
	expect(initialized.exitCode, initialized.stderr.toString()).toBe(0)
	const before = readResetTargets(temporaryRoot)

	const refused = Bun.spawnSync({
		cmd: [process.execPath, "run", "init", "--", "--name", "replacement-name", "--json"],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(refused.exitCode).toBe(2)
	expect(JSON.parse(refused.stdout.toString().trim())).toMatchObject({
		ok: false,
		category: "usage",
		message: "repository is already initialized; pass --force to replace its metadata",
		retrySafe: true,
	})
	expect(readResetTargets(temporaryRoot)).toEqual(before)
})

test("dry run reports release reset without changing files", () => {
	const temporaryRoot = createReleasedTemplate("agent-plugin-template-release-preview-")
	const before = readResetTargets(temporaryRoot)
	const result = initializeTemplate(temporaryRoot, ["--dry-run", "--json"])

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const output = JSON.parse(result.stdout.toString().trim())
	expect(output).toMatchObject({
		ok: true,
		action: "preview",
		sideEffects: "none",
		plugin: { name: "dojo-hello", version: "0.1.0" },
	})
	expect(output.files).toEqual(expect.arrayContaining(resetPaths))
	expect(readResetTargets(temporaryRoot)).toEqual(before)
})

test("generated manifest check detects drift from canonical metadata", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-drift-")

	const manifestPath = join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json")
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
	manifest.name = "drifted-name"
	Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

	const result = Bun.spawnSync({
		cmd: ["bun", "run", "generate:check"],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(1)
	expect(result.stderr.toString()).toContain("plugin/.codex-plugin/plugin.json")
	expect(result.stderr.toString()).toContain("bun run generate")
})

test("test fixtures can reinitialize a customized recipient", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-recipient-")
	const customized = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"recipient-hello",
			"--author",
			"My Agent Dojo",
			"--repository",
			"https://github.com/myagentdojo/recipient-hello",
			"--force",
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(customized.exitCode, customized.stderr.toString()).toBe(0)

	const reinitialized = initializeTemplate(temporaryRoot)
	expect(reinitialized.exitCode, reinitialized.stderr.toString()).toBe(0)
})

test("initialized repository packages the configured plugin identity", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-package-")
	const init = initializeTemplate(temporaryRoot)
	expect(init.exitCode, init.stderr.toString()).toBe(0)

	const packaged = Bun.spawnSync({
		cmd: ["bun", "run", "package"],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(packaged.exitCode, packaged.stderr.toString()).toBe(0)
	const result = JSON.parse(packaged.stdout.toString().trim().split("\n").at(-1) ?? "")
	expect(basename(result.archive)).toBe(`dojo-hello-${templateVersion}.tar.gz`)
	const provenance = JSON.parse(readFileSync(result.provenance, "utf8"))
	expect(provenance).toMatchObject({ plugin: "dojo-hello", version: templateVersion })
})

test("initialized repository development plan uses configured plugin identity", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-dev-")
	const init = initializeTemplate(temporaryRoot)
	expect(init.exitCode, init.stderr.toString()).toBe(0)

	const dryRun = Bun.spawnSync({
		cmd: ["bun", "run", "dev", "--", "codex", "--dry-run", "--json"],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(dryRun.exitCode, dryRun.stderr.toString()).toBe(0)
	const plan = JSON.parse(dryRun.stdout.toString().trim().split("\n").at(-1) ?? "")
	expect(plan.install).toContain("codex plugin add dojo-hello@dojo-hello-dev")
})
