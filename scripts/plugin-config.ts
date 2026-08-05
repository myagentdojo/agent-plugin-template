import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Canonical plugin identity and presentation metadata. */
export interface PluginConfig {
	/** True only in the reusable template before a recipient initializes it. */
	template: boolean
	/** Stable kebab-case plugin and marketplace identifier. */
	name: string
	/** Human-readable plugin title. */
	displayName: string
	/** Strict semantic version embedded in Codex and release archives. */
	version: string
	/** Shared summary used by both harness manifests. */
	description: string
	/** Publisher identity. */
	author: { name: string }
	/** Canonical HTTPS source repository URL. */
	repository: string
	/** SPDX license identifier. */
	license: string
	/** Search and discovery terms. */
	keywords: string[]
	/** Marketplace category. */
	category: string
	/** Compact Codex plugin subtitle. */
	shortDescription: string
	/** Codex plugin detail description. */
	longDescription: string
	/** Declared user-visible capabilities. */
	capabilities: string[]
	/** Starter prompts shown by Codex. */
	defaultPrompts: string[]
	/** Public and private repositories used for hosted distribution proof. */
	canary: {
		/** GitHub account that must match the active CLI identity. */
		owner: string
		/** Public repository name under owner. */
		publicRepository: string
		/** Private repository name under owner. */
		privateRepository: string
	}
}

/** Generated manifest path and serialized contents. */
export interface GeneratedFile {
	/** Repository-relative output path. */
	path: string
	/** Stable JSON document including its trailing newline. */
	contents: string
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

function validateConfig(config: PluginConfig): void {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.name) || config.name.length > 64) {
		throw new Error("plugin name must be kebab-case and at most 64 characters")
	}
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(config.version)) {
		throw new Error("plugin version must use semantic versioning")
	}
	if (!config.displayName.trim() || !config.description.trim() || !config.author.name.trim()) {
		throw new Error("displayName, description, and author.name are required")
	}
	if (!config.repository.startsWith("https://")) {
		throw new Error("repository must be an absolute HTTPS URL")
	}
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(config.canary.owner)) {
		throw new Error("canary.owner must be a GitHub account name")
	}
	if (config.defaultPrompts.length > 3 || config.defaultPrompts.some((prompt) => prompt.length > 128)) {
		throw new Error("defaultPrompts accepts at most three entries of at most 128 characters")
	}
}

/** Load and validate the one metadata source used by every generated manifest. */
export function loadPluginConfig(root: string): PluginConfig {
	const config = JSON.parse(readFileSync(join(root, "plugin.config.json"), "utf8")) as PluginConfig
	validateConfig(config)
	return config
}

function claudeMarketplace(config: PluginConfig): GeneratedFile {
	return {
		path: ".claude-plugin/marketplace.json",
		contents: serialize({
			name: config.name,
			owner: config.author,
			metadata: {
				description: `Marketplace for ${config.displayName}`,
				version: config.version,
			},
			plugins: [
				{
					name: config.name,
					description: config.description,
					author: config.author,
					source: "./plugin",
				},
			],
		}),
	}
}

function codexMarketplace(config: PluginConfig): GeneratedFile {
	return {
		path: ".agents/plugins/marketplace.json",
		contents: serialize({
			name: config.name,
			interface: { displayName: config.displayName },
			plugins: [
				{
					name: config.name,
					source: { source: "local", path: "./plugin" },
					policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
					category: config.category,
				},
			],
		}),
	}
}

function claudeManifest(config: PluginConfig): GeneratedFile {
	return {
		path: "plugin/.claude-plugin/plugin.json",
		contents: serialize({
			name: config.name,
			description: config.description,
			author: config.author,
			repository: config.repository,
			license: config.license,
			keywords: config.keywords,
			skills: "./skills/",
			hooks: "./hooks/claude/hooks.json",
		}),
	}
}

function codexManifest(config: PluginConfig): GeneratedFile {
	return {
		path: "plugin/.codex-plugin/plugin.json",
		contents: serialize({
			name: config.name,
			version: config.version,
			description: config.description,
			author: config.author,
			repository: config.repository,
			license: config.license,
			keywords: config.keywords,
			skills: "./skills/",
			hooks: "./hooks/codex/hooks.json",
			interface: {
				displayName: config.displayName,
				shortDescription: config.shortDescription,
				longDescription: config.longDescription,
				developerName: config.author.name,
				category: config.category,
				capabilities: config.capabilities,
				defaultPrompt: config.defaultPrompts,
			},
		}),
	}
}

/** Render native Claude and Codex manifests from canonical metadata. */
export function renderGeneratedFiles(config: PluginConfig): GeneratedFile[] {
	validateConfig(config)
	return [
		claudeMarketplace(config),
		codexMarketplace(config),
		claudeManifest(config),
		codexManifest(config),
	]
}

/** Write every generated manifest to its deterministic repository path. */
export function writeGeneratedFiles(root: string, config: PluginConfig): GeneratedFile[] {
	const files = renderGeneratedFiles(config)
	for (const file of files) writeFileSync(join(root, file.path), file.contents)
	return files
}

/** Return generated paths whose checked-in contents differ from canonical metadata. */
export function checkGeneratedFiles(root: string, config: PluginConfig): string[] {
	return renderGeneratedFiles(config)
		.filter((file) => readFileSync(join(root, file.path), "utf8") !== file.contents)
		.map((file) => file.path)
}
