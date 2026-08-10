import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, test } from "bun:test"

import {
	CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY,
	checkDirectoryReadiness,
	renderGeneratedFiles,
	type PluginConfig,
	validatePackageContract,
} from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginRoot = join(root, "plugin")
const config = JSON.parse(readFileSync(join(root, "plugin.config.json"), "utf8")) as PluginConfig
const claudeManifest = JSON.parse(
	readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
)
const codexManifest = JSON.parse(
	readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
)
const claudeMarketplace = JSON.parse(
	readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
)
const codexMarketplace = JSON.parse(
	readFileSync(join(root, ".agents", "plugins", "marketplace.json"), "utf8"),
)

test("checked-in native manifests satisfy the published harness contracts", () => {
	expect(() => validatePackageContract(config)).not.toThrow()

	for (const field of [
		"name",
		"version",
		"description",
		"author",
		"repository",
		"license",
		"keywords",
		"skills",
	]) {
		expect(claudeManifest[field], `Claude manifest field ${field}`).toBeDefined()
		expect(codexManifest[field], `Codex manifest field ${field}`).toBeDefined()
	}

	expect(claudeManifest).toMatchObject({
		name: config.name,
		displayName: config.displayName,
		version: config.version,
		defaultEnabled: false,
		description: config.description,
		author: config.author,
		repository: config.repository,
		license: config.license,
		keywords: config.keywords,
	})
	expect(codexManifest).toMatchObject({
		name: config.name,
		version: config.version,
		description: config.description,
		author: config.author,
		repository: config.repository,
		license: config.license,
		keywords: config.keywords,
	})

	expect(config.displayName.length).toBeLessThanOrEqual(30)
	expect(codexManifest.interface).toMatchObject({
		displayName: config.displayName,
		shortDescription: config.shortDescription,
		longDescription: config.longDescription,
		developerName: config.author.name,
		category: config.category,
		capabilities: config.capabilities,
		defaultPrompt: config.defaultPrompts,
		brandColor: config.brandColor,
		composerIcon: config.composerIcon,
		logo: config.logo,
	})
	expect(config.shortDescription).not.toContain("\n")
	expect(config.shortDescription.length).toBeLessThanOrEqual(30)
	expect(config.longDescription.length).toBeLessThanOrEqual(1_024)
	expect(config.capabilities.length).toBeLessThanOrEqual(20)
	expect(config.defaultPrompts.length).toBeLessThanOrEqual(3)
	expect(config.defaultPrompts.every((prompt: string) => prompt.length <= 128)).toBe(true)

	for (const manifest of [claudeManifest, codexManifest]) {
		for (const field of ["skills", "hooks"]) {
			const path = manifest[field]
			expect(path.startsWith("./"), `${field} must be plugin-relative`).toBe(true)
			expect(existsSync(join(pluginRoot, path)), `${field} target must exist`).toBe(true)
		}
	}
	for (const field of ["composerIcon", "logo"]) {
		const path = codexManifest.interface[field]
		expect(path.startsWith("./"), `${field} must be plugin-relative`).toBe(true)
		expect(existsSync(join(pluginRoot, path)), `${field} target must exist`).toBe(true)
	}
})

test("native marketplace projections preserve identity, source, policy, and activation safety", () => {
	expect(claudeMarketplace.metadata.version).toBe(config.version)
	expect(claudeMarketplace.plugins[0]).toMatchObject({
		name: config.name,
		displayName: config.displayName,
		source: "./plugin",
		defaultEnabled: false,
	})
	expect(claudeManifest).toMatchObject({
		name: claudeMarketplace.plugins[0].name,
		version: claudeMarketplace.metadata.version,
		defaultEnabled: false,
	})

	expect(codexMarketplace.plugins[0]).toMatchObject({
		name: config.name,
		source: { source: "local", path: "./plugin" },
		policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
		category: config.category,
	})
	expect(codexMarketplace).not.toHaveProperty("version")
	expect(codexMarketplace.plugins[0]).not.toHaveProperty("version")
	expect(codexMarketplace.plugins[0].policy.installation).not.toBe("INSTALLED_BY_DEFAULT")
})

test("disabled-on-install behavior names its Claude Code compatibility boundary", () => {
	expect(CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY).toEqual({
		minimumVersion: "2.1.154",
		warning: "Earlier Claude Code clients ignore defaultEnabled and may enable plugins on install.",
	})
})

test.each([
	["stable", "1.2.3"],
	["prerelease", "1.2.3-rc.1"],
	["build", "1.2.3+build.5"],
] as const)("accepts a valid %s semantic version", (_name, version) => {
	const valid = structuredClone(config)
	valid.version = version
	expect(() => renderGeneratedFiles(valid)).not.toThrow()
})

test.each([
	"https://github.com/myagentdojo/agent-plugin-template",
	"https://github.com/myagentdojo/agent-plugin-template.git",
] as const)("accepts the canonical GitHub HTTPS repository URL %s", (repository) => {
	const valid = structuredClone(config)
	valid.repository = repository
	expect(() => renderGeneratedFiles(valid)).not.toThrow()
})

test.each([
	["name", (value: PluginConfig) => (value.name = "Not Valid"), "plugin name"],
	["leading-zero core version", (value: PluginConfig) => (value.version = "01.0.0"), "semantic versioning"],
	["leading-zero prerelease", (value: PluginConfig) => (value.version = "1.2.3-01"), "semantic versioning"],
	["invalid prerelease", (value: PluginConfig) => (value.version = "1.2.3-rc_1"), "semantic versioning"],
	["invalid build", (value: PluginConfig) => (value.version = "1.2.3+build_5"), "semantic versioning"],
	["missing version component", (value: PluginConfig) => (value.version = "1.2"), "semantic versioning"],
	["version length", (value: PluginConfig) => (value.version = `1.2.3-${"a".repeat(59)}`), "64 characters"],
	["required display name", (value: PluginConfig) => (value.displayName = ""), "are required"],
	["multiline display name", (value: PluginConfig) => (value.displayName = "Two\nLines"), "displayName"],
	["display name", (value: PluginConfig) => (value.displayName = "x".repeat(31)), "displayName"],
	["developer name", (value: PluginConfig) => (value.author.name = "x".repeat(81)), "author.name"],
	["multiline developer name", (value: PluginConfig) => (value.author.name = "Two\nLines"), "author.name"],
	["description length", (value: PluginConfig) => (value.description = "x".repeat(1_025)), "description"],
	["description control text", (value: PluginConfig) => (value.description = "unsafe\u0000text"), "description"],
	["empty short description", (value: PluginConfig) => (value.shortDescription = ""), "shortDescription"],
	["short description line", (value: PluginConfig) => (value.shortDescription = "two\nlines"), "shortDescription"],
	["short description length", (value: PluginConfig) => (value.shortDescription = "x".repeat(31)), "shortDescription"],
	["long description", (value: PluginConfig) => (value.longDescription = ""), "longDescription"],
	["long description length", (value: PluginConfig) => (value.longDescription = "x".repeat(1_025)), "longDescription"],
	["long description control text", (value: PluginConfig) => (value.longDescription = "unsafe\u0000text"), "longDescription"],
	["category", (value: PluginConfig) => (value.category = "Unknown"), "category"],
	["capability count", (value: PluginConfig) => (value.capabilities = Array(21).fill("Read")), "capabilities"],
	["empty capability", (value: PluginConfig) => (value.capabilities = [""]), "capabilities"],
	["capability length", (value: PluginConfig) => (value.capabilities = ["x".repeat(121)]), "capabilities"],
	["duplicate capability", (value: PluginConfig) => (value.capabilities = ["Read files", " Read   files "]), "capabilities"],
	["multiline capability", (value: PluginConfig) => (value.capabilities = ["Read\nfiles"]), "capabilities"],
	["license", (value: PluginConfig) => (value.license = ""), "license"],
	["unsupported license", (value: PluginConfig) => (value.license = "MIT OR Apache-2.0"), "license"],
	["empty keyword", (value: PluginConfig) => (value.keywords = [""]), "keywords"],
	["duplicate keyword", (value: PluginConfig) => (value.keywords = ["Agent Plugin", " agent   plugin "]), "keywords"],
	["unsupported keyword", (value: PluginConfig) => (value.keywords = ["agent/plugin"]), "keywords"],
	["non-HTTPS repository", (value: PluginConfig) => (value.repository = "http://example.com/plugin.git"), "repository"],
	["repository without host", (value: PluginConfig) => (value.repository = "https://"), "repository"],
	["repository credentials", (value: PluginConfig) => (value.repository = "https://user:secret@example.com/plugin.git"), "repository"],
	["non-GitHub repository", (value: PluginConfig) => (value.repository = "https://git.example.com/team/plugin.git"), "canonical GitHub"],
	["repository query", (value: PluginConfig) => (value.repository = "https://github.com/team/plugin.git?ref=main"), "canonical GitHub"],
	["repository unsupported text", (value: PluginConfig) => (value.repository = "https://example.com/plugin name.git"), "repository"],
	["canary owner", (value: PluginConfig) => (value.canary.owner = "not_valid"), "canary.owner"],
	[
		"missing canary owner",
		(value: PluginConfig) => delete (value.canary as { owner?: string }).owner,
		"canary.owner",
	],
	["canary actor", (value: PluginConfig) => (value.canary.actor = "not_valid"), "canary.actor"],
	[
		"missing canary actor",
		(value: PluginConfig) => delete (value.canary as { actor?: string }).actor,
		"canary.actor",
	],
	["prompt count", (value: PluginConfig) => (value.defaultPrompts = Array(4).fill("Run")), "defaultPrompts"],
	["prompt length", (value: PluginConfig) => (value.defaultPrompts = ["x".repeat(129)]), "defaultPrompts"],
	["empty prompt", (value: PluginConfig) => (value.defaultPrompts = [""]), "defaultPrompts"],
	["whitespace prompt", (value: PluginConfig) => (value.defaultPrompts = ["   "]), "defaultPrompts"],
	["multiline prompt", (value: PluginConfig) => (value.defaultPrompts = ["Run\nthis"]), "defaultPrompts"],
	["duplicate prompt", (value: PluginConfig) => (value.defaultPrompts = ["Run this", " Run   this "]), "defaultPrompts"],
	["mention prompt", (value: PluginConfig) => (value.defaultPrompts = ["@agent run this"]), "defaultPrompts"],
	["brand color", (value: PluginConfig) => (value.brandColor = "blue"), "brandColor"],
	["lowercase brand color", (value: PluginConfig) => (value.brandColor = "#abcdef"), "brandColor"],
	["composer icon escape", (value: PluginConfig) => (value.composerIcon = "../icon.svg"), "composerIcon"],
	["logo extension", (value: PluginConfig) => (value.logo = "./assets/logo.png"), "logo"],
] as const)("rejects invalid published %s metadata", (_name, mutate, message) => {
	const invalid = structuredClone(config)
	mutate(invalid)
	expect(() => renderGeneratedFiles(invalid)).toThrow(message)
})

test("directory-readiness text subset reports its limits without claiming publication readiness", () => {
	expect(checkDirectoryReadiness(config)).toEqual({
		ok: true,
		profile: "directory-readiness text subset",
		errors: [],
		notEvaluated: [
			"public ZIP",
			"assets",
			"identity",
			"portal review",
			"approval",
			"publication",
		],
	})
})

test("package validation and directory-readiness text limits remain separate boundaries", () => {
	const packageReady = structuredClone(config)
	packageReady.displayName = "x".repeat(31)

	expect(() => validatePackageContract(packageReady)).not.toThrow()
	expect(checkDirectoryReadiness(packageReady)).toMatchObject({
		profile: "directory-readiness text subset",
		ok: false,
		errors: ["displayName must be at most 30 characters"],
	})
	expect(() => renderGeneratedFiles(packageReady)).toThrow("directory-readiness text subset")
})

const claudeExecutable = Bun.which("claude")
if (claudeExecutable) {
	test("checked-in Claude plugin passes strict native validation", () => {
		const result = Bun.spawnSync({
			cmd: [claudeExecutable, "plugin", "validate", "--strict", pluginRoot],
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		})
		expect(result.exitCode, `${result.stdout.toString()}${result.stderr.toString()}`).toBe(0)
	})
} else {
	test.skip("checked-in Claude plugin passes strict native validation (Claude CLI unavailable)", () => {})
}
