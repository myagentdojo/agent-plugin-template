import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { expect, test } from "bun:test"

const root = resolve(import.meta.dir, "..")
const initialVersion = "0.1.0"
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
	".github/release-please-config.json",
	"package.json",
	".github/.release-please-manifest.json",
	"CHANGELOG.md",
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

function commitPackageCheckout(repositoryRoot: string): string {
	function git(...arguments_: string[]): ReturnType<typeof Bun.spawnSync> {
		return Bun.spawnSync({
			cmd: ["git", ...arguments_],
			cwd: repositoryRoot,
			stdout: "pipe",
			stderr: "pipe",
		})
	}

	for (const arguments_ of [
		["init", "--quiet"],
		["add", "--", "plugin.config.json", "plugin"],
		[
			"-c",
			"user.name=Plugin Test",
			"-c",
			"user.email=plugin-test@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"package fixture",
		],
	] as const) {
		const result = git(...arguments_)
		expect(result.exitCode, result.stderr.toString()).toBe(0)
	}
	const head = git("rev-parse", "HEAD")
	expect(head.exitCode, head.stderr.toString()).toBe(0)
	return head.stdout.toString().trim()
}

function packageWithSource(
	repositoryRoot: string,
	sourceVariable: "SOURCE_COMMIT" | "GITHUB_SHA",
	value: string,
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [process.execPath, "run", "scripts/package.ts"],
		cwd: repositoryRoot,
		env: {
			...process.env,
			SOURCE_COMMIT: undefined,
			GITHUB_SHA: undefined,
			[sourceVariable]: value,
		},
		stdout: "pipe",
		stderr: "pipe",
	})
}

function successfulPackageWithSource(
	repositoryRoot: string,
	sourceVariable: "SOURCE_COMMIT" | "GITHUB_SHA",
	value: string,
): { archive: string; checksums: string } {
	const packaged = packageWithSource(repositoryRoot, sourceVariable, value)
	expect(packaged.exitCode, packaged.stderr.toString()).toBe(0)
	return JSON.parse(packaged.stdout.toString().trim())
}

function createReleasedTemplate(prefix: string): string {
	const temporaryRoot = copyTemplate(prefix)
	const packagePath = join(temporaryRoot, "package.json")
	const packageJson = JSON.parse(readFileSync(packagePath, "utf8"))
	packageJson.version = "9.9.9"
	writeJson(packagePath, packageJson)

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
		plugin: { name: "dojo-hello", version: initialVersion },
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
			actor: "myagentdojo",
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
		version: initialVersion,
		defaultEnabled: false,
		skills: "./skills/",
		hooks: "./hooks/claude/hooks.json",
	})
	const claudeMarketplace = JSON.parse(
		readFileSync(join(temporaryRoot, ".claude-plugin", "marketplace.json"), "utf8"),
	)
	expect(claudeMarketplace.plugins[0]).toMatchObject({
		name: "dojo-hello",
		source: "./plugin",
		defaultEnabled: false,
	})

	const codexManifest = JSON.parse(
		readFileSync(join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)
	expect(codexManifest).toMatchObject({
		name: "dojo-hello",
		version: initialVersion,
		skills: "./skills/",
		hooks: "./hooks/codex/hooks.json",
		interface: {
			displayName: "Dojo Hello",
			brandColor: "#3B5CCC",
			composerIcon: "./assets/composer-icon.svg",
			logo: "./assets/logo.svg",
		},
	})
	for (const field of ["composerIcon", "logo"] as const) {
		const assetPath = join(temporaryRoot, "plugin", codexManifest.interface[field])
		expect(existsSync(assetPath)).toBe(true)
		expect(readFileSync(assetPath, "utf8")).not.toMatch(/Harness Plugin Prototype|dojo-hello|Dojo Hello/)
	}

	const codexMarketplace = JSON.parse(
		readFileSync(join(temporaryRoot, ".agents", "plugins", "marketplace.json"), "utf8"),
	)
	expect(codexMarketplace.plugins[0]).toMatchObject({
		name: "dojo-hello",
		source: { source: "local", path: "./plugin" },
		policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
	})
})

test("organization-owned canaries keep repository owner separate from authenticated actor", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-org-canary-")
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"dojo-hello",
			"--repository",
			"https://github.com/myagentdojo-org/dojo-hello",
			"--canary-actor",
			"dojo-release-bot",
			"--force",
			"--json",
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const config = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	expect(config.canary).toEqual({
		owner: "myagentdojo-org",
		actor: "dojo-release-bot",
		publicRepository: "dojo-hello-public-canary",
		privateRepository: "dojo-hello-private-canary",
	})
})

test("mixed-case github.com derives canaries from the supplied repository", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-mixed-github-")
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"dojo-hello",
			"--repository",
			"https://GitHub.COM/another-owner/another-repository",
			"--force",
			"--json",
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	const config = JSON.parse(readFileSync(join(temporaryRoot, "plugin.config.json"), "utf8"))
	expect(config.canary).toEqual({
		owner: "another-owner",
		actor: "another-owner",
		publicRepository: "another-repository-public-canary",
		privateRepository: "another-repository-private-canary",
	})
})

test("init help discovers the canary actor identity override", () => {
	const result = Bun.spawnSync({
		cmd: [process.execPath, "run", "init", "--", "--help"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode, result.stderr.toString()).toBe(0)
	expect(result.stdout.toString()).toContain("--canary-actor <login>")
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
	const packageJson = JSON.parse(readFileSync(join(temporaryRoot, "package.json"), "utf8"))
	expect(packageJson.version).toBe("0.1.0")
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

	expect(
		JSON.parse(readFileSync(join(temporaryRoot, ".github", ".release-please-manifest.json"), "utf8")),
	).toEqual({})
	expect(readFileSync(join(temporaryRoot, "CHANGELOG.md"), "utf8")).toBe("")
	const releaseConfig = JSON.parse(
		readFileSync(join(temporaryRoot, ".github", "release-please-config.json"), "utf8"),
	)
	expect(releaseConfig.packages["."]["package-name"]).toBe("dojo-hello")

	expect(existsSync(join(temporaryRoot, "plugin", "hooks", "claude", "hooks.json"))).toBe(true)
	expect(existsSync(join(temporaryRoot, "plugin", "hooks", "codex", "hooks.json"))).toBe(true)
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

test.each([
	{
		case: "unreadable release config",
		path: ".github/release-please-config.json",
		mutate: (temporaryRoot: string) =>
			rmSync(join(temporaryRoot, ".github", "release-please-config.json")),
		expected: "cannot read release reset file .github/release-please-config.json",
	},
	{
		case: "malformed release config",
		path: ".github/release-please-config.json",
		mutate: (temporaryRoot: string) =>
			writeFileSync(join(temporaryRoot, ".github", "release-please-config.json"), "{\n"),
		expected: "release reset file .github/release-please-config.json is not valid JSON",
	},
] as const)("$case returns structured failure naming $path before writes", ({ mutate, expected }) => {
	const temporaryRoot = copyTemplate("agent-plugin-template-reset-failure-")
	const configPath = join(temporaryRoot, "plugin.config.json")
	const manifestPath = join(temporaryRoot, "plugin", ".codex-plugin", "plugin.json")
	const configBefore = readFileSync(configPath)
	const manifestBefore = readFileSync(manifestPath)
	mutate(temporaryRoot)

	const result = initializeTemplate(temporaryRoot, ["--json"])

	expect(result.exitCode).toBe(2)
	expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({
		ok: false,
		category: "usage",
		message: expected,
		retrySafe: true,
	})
	expect(readFileSync(configPath)).toEqual(configBefore)
	expect(readFileSync(manifestPath)).toEqual(manifestBefore)
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

test("non-GitHub repository is rejected instead of silently retaining template canaries", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-invalid-metadata-")
	const before = readResetTargets(temporaryRoot)
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			"dojo-hello",
			"--repository",
			"https://gitlab.com/myagentdojo/dojo-hello",
			"--force",
			"--json",
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(2)
	expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({
		ok: false,
		category: "usage",
		message: "--repository must be a canonical GitHub HTTPS repository",
		retrySafe: true,
	})
	expect(readResetTargets(temporaryRoot)).toEqual(before)
})

test.each([
	["supplied", "dojo-hello", ["--display-name", "x".repeat(31)]],
	["derived", "very-long-plugin-name-with-over-thirty-chars", []],
] as const)("invalid %s display name returns structured usage without writes", (_source, name, options) => {
	const temporaryRoot = copyTemplate("agent-plugin-template-invalid-display-name-")
	const before = readResetTargets(temporaryRoot)
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			"init",
			"--",
			"--name",
			name,
			"--force",
			"--json",
			...options,
		],
		cwd: temporaryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(result.exitCode).toBe(2)
	expect(JSON.parse(result.stdout.toString().trim())).toMatchObject({
		ok: false,
		category: "usage",
		message: "--display-name must be non-empty, single-line text of at most 30 characters",
		retrySafe: true,
	})
	expect(readResetTargets(temporaryRoot)).toEqual(before)
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
	const sourceCommit = commitPackageCheckout(temporaryRoot)

	const packaged = Bun.spawnSync({
		cmd: ["bun", "run", "package"],
		cwd: temporaryRoot,
		env: { ...process.env, SOURCE_COMMIT: sourceCommit, GITHUB_SHA: undefined },
		stdout: "pipe",
		stderr: "pipe",
	})
	expect(packaged.exitCode, packaged.stderr.toString()).toBe(0)
	const result = JSON.parse(packaged.stdout.toString().trim().split("\n").at(-1) ?? "")
	expect(basename(result.archive)).toBe(`dojo-hello-${initialVersion}.tar.gz`)
	expect(basename(result.checksums)).toBe(`dojo-hello-${initialVersion}.checksums.json`)
	const checksums = JSON.parse(readFileSync(result.checksums, "utf8"))
	expect(checksums).toMatchObject({
		repository: "https://github.com/myagentdojo/dojo-hello",
		sourceCommit,
		tag: `v${initialVersion}`,
		plugin: "dojo-hello",
		version: initialVersion,
		archive: `dojo-hello-${initialVersion}.tar.gz`,
		archiveBytes: expect.any(Number),
		archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		runtimeLockSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		bundleInventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		payloadInventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		evidence:
			"Checksum metadata is integrity evidence for these archive bytes, not independent publisher or builder authenticity.",
	})
})

test("package accepts an explicit source commit when Git metadata is unavailable", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-package-no-git-")
	const init = initializeTemplate(temporaryRoot)
	expect(init.exitCode, init.stderr.toString()).toBe(0)
	const sourceCommit = "a".repeat(40)
	const result = successfulPackageWithSource(temporaryRoot, "SOURCE_COMMIT", sourceCommit)
	const checksums = JSON.parse(readFileSync(result.checksums, "utf8"))
	expect(checksums.sourceCommit).toBe(sourceCommit)
})

test("package rejects payload files outside the exact expected inventory", () => {
	const temporaryRoot = copyTemplate("agent-plugin-template-package-filenames-")
	const init = initializeTemplate(temporaryRoot)
	expect(init.exitCode, init.stderr.toString()).toBe(0)
	const unusualName = "line\nbreak\\slash.txt"
	const unusualPath = join(temporaryRoot, "plugin", "runtime", unusualName)
	writeFileSync(unusualPath, "unusual filename payload\n")
	const sourceCommit = commitPackageCheckout(temporaryRoot)
	const packaged = packageWithSource(temporaryRoot, "SOURCE_COMMIT", sourceCommit)
	expect(packaged.exitCode).not.toBe(0)
	expect(packaged.stderr.toString()).toContain("Bun payload closure: unexpected payload file")
})

test.each(["SOURCE_COMMIT", "GITHUB_SHA"] as const)(
	"package rejects an invalid explicit %s",
	(sourceVariable) => {
		const temporaryRoot = copyTemplate("agent-plugin-template-package-source-")
		const init = initializeTemplate(temporaryRoot)
		expect(init.exitCode, init.stderr.toString()).toBe(0)

		const packaged = packageWithSource(temporaryRoot, sourceVariable, "A".repeat(40))
		expect(packaged.exitCode).not.toBe(0)
		expect(packaged.stderr.toString()).toContain(
			`${sourceVariable} must be exactly 40 lowercase hexadecimal characters`,
		)
	},
)

test.each(["SOURCE_COMMIT", "GITHUB_SHA"] as const)(
	"package rejects %s when it differs from Git HEAD",
	(sourceVariable) => {
		const temporaryRoot = copyTemplate("agent-plugin-template-package-mismatch-")
		const init = initializeTemplate(temporaryRoot)
		expect(init.exitCode, init.stderr.toString()).toBe(0)
		const gitHead = commitPackageCheckout(temporaryRoot)
		const mismatchedCommit = gitHead === "b".repeat(40) ? "c".repeat(40) : "b".repeat(40)
		const packaged = packageWithSource(temporaryRoot, sourceVariable, mismatchedCommit)
		expect(packaged.exitCode).not.toBe(0)
		expect(packaged.stderr.toString()).toContain(`${sourceVariable} does not match git HEAD`)
	},
)

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
