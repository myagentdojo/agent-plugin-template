import { cpSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const ignoredEntries = new Set([
	".claude",
	".dev",
	".git",
	".worktrees",
	"dist",
	"node_modules",
])

function copyTemplate(prefix: string): string {
	const temporaryRoot = mkdtempSync(join(tmpdir(), prefix))
	cpSync(root, temporaryRoot, {
		recursive: true,
		filter: (source) => source === root || !ignoredEntries.has(basename(source)),
	})
	return temporaryRoot
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
		plugin: { name: "dojo-hello", version: "0.1.0" },
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
		skills: "./skills/",
		hooks: "./hooks/claude/hooks.json",
	})
	expect(claudeManifest).not.toHaveProperty("version")

	const codexManifest = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)
	expect(codexManifest).toMatchObject({
		name: "dojo-hello",
		version: "0.1.0",
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
	expect(basename(result.archive)).toBe("dojo-hello-0.1.0.tar.gz")
	const provenance = JSON.parse(readFileSync(result.provenance, "utf8"))
	expect(provenance).toMatchObject({ plugin: "dojo-hello", version: "0.1.0" })
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
