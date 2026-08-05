import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expect, test } from "bun:test"

import { renderGeneratedFiles, type PluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginRoot = join(root, "plugin")
const config = JSON.parse(readFileSync(join(root, "plugin.config.json"), "utf8")) as PluginConfig
const claudeManifest = JSON.parse(
	readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
)
const codexManifest = JSON.parse(
	readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
)

const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

test("checked-in native manifests satisfy the published harness contracts", () => {
	for (const field of [
		"name",
		"version",
		"description",
		"author",
		"repository",
		"license",
		"keywords",
		"skills",
		"hooks",
	]) {
		expect(claudeManifest[field], `Claude manifest field ${field}`).toBeDefined()
		expect(codexManifest[field], `Codex manifest field ${field}`).toBeDefined()
	}

	expect(claudeManifest).toMatchObject({
		name: config.name,
		displayName: config.displayName,
		version: config.version,
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

	expect(config.version).toMatch(strictSemver)
	expect(config.displayName.length).toBeLessThanOrEqual(30)
	expect(codexManifest.interface).toMatchObject({
		displayName: config.displayName,
		shortDescription: config.shortDescription,
		longDescription: config.longDescription,
		developerName: config.author.name,
		category: config.category,
		capabilities: config.capabilities,
		defaultPrompt: config.defaultPrompts,
	})
	expect(config.shortDescription).not.toContain("\n")
	expect(config.shortDescription.length).toBeLessThanOrEqual(30)
	expect(config.longDescription.length).toBeLessThanOrEqual(4_000)
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
})

test.each([
	["name", (value: PluginConfig) => (value.name = "Not Valid"), "plugin name"],
	["semantic version", (value: PluginConfig) => (value.version = "01.0.0"), "semantic versioning"],
	["required display name", (value: PluginConfig) => (value.displayName = ""), "are required"],
	["display name", (value: PluginConfig) => (value.displayName = "x".repeat(31)), "displayName"],
	["developer name", (value: PluginConfig) => (value.author.name = "x".repeat(81)), "author.name"],
	["empty short description", (value: PluginConfig) => (value.shortDescription = ""), "shortDescription"],
	["short description line", (value: PluginConfig) => (value.shortDescription = "two\nlines"), "shortDescription"],
	["short description length", (value: PluginConfig) => (value.shortDescription = "x".repeat(31)), "shortDescription"],
	["long description", (value: PluginConfig) => (value.longDescription = ""), "longDescription"],
	["long description length", (value: PluginConfig) => (value.longDescription = "x".repeat(4_001)), "longDescription"],
	["category", (value: PluginConfig) => (value.category = "Unknown"), "category"],
	["capability count", (value: PluginConfig) => (value.capabilities = Array(21).fill("Read")), "capabilities"],
	["empty capability", (value: PluginConfig) => (value.capabilities = [""]), "capabilities"],
	["capability length", (value: PluginConfig) => (value.capabilities = ["x".repeat(121)]), "capabilities"],
	["repository", (value: PluginConfig) => (value.repository = "git@example.com:plugin.git"), "repository"],
	["canary owner", (value: PluginConfig) => (value.canary.owner = "not_valid"), "canary.owner"],
	["prompt count", (value: PluginConfig) => (value.defaultPrompts = Array(4).fill("Run")), "defaultPrompts"],
	["prompt length", (value: PluginConfig) => (value.defaultPrompts = ["x".repeat(129)]), "defaultPrompts"],
] as const)("rejects invalid published %s metadata", (_name, mutate, message) => {
	const invalid = structuredClone(config)
	mutate(invalid)
	expect(() => renderGeneratedFiles(invalid)).toThrow(message)
})
