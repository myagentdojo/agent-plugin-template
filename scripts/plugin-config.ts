import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Canonical plugin identity and presentation metadata. */
export interface PluginConfig {
	/** True only in the reusable template before a recipient initializes it. */
	template: boolean
	/** Stable kebab-case plugin and marketplace identifier. */
	name: string
	/** Human-readable plugin title. */
	displayName: string
	/** Strict semantic version embedded in both native manifests and release archives. */
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
	/** Restrained hexadecimal accent projected into Codex interface metadata. */
	brandColor: string
	/** Plugin-relative identity-neutral composer icon. */
	composerIcon: string
	/** Plugin-relative identity-neutral logo. */
	logo: string
	/** Public and private repositories used for hosted distribution proof. */
	canary: {
		/** GitHub account or organization that owns the canary repositories. */
		owner: string
		/** GitHub user whose CLI and transport credentials authorize canary writes. */
		actor: string
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

/** Directory text checks plus an explicit boundary around deferred publication work. */
export interface DirectoryReadinessReport {
	/** Named subset evaluated by this report. */
	profile: "directory-readiness text subset"
	/** Whether every text limit in the subset passed. */
	ok: boolean
	/** Human-readable failures owned by the subset. */
	errors: string[]
	/** Public-directory work deliberately outside this metadata check. */
	notEvaluated: string[]
}

/** Claude Code compatibility boundary for disabled-on-install behavior. */
export const CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY = {
	minimumVersion: "2.1.154",
	warning: "Earlier Claude Code clients ignore defaultEnabled and may enable plugins on install.",
} as const

const packageContractProfile = "required local/repo git-marketplace package contract"
const directoryReadinessProfile = "directory-readiness text subset" as const
const directoryReadinessNotEvaluated = [
	"public ZIP",
	"assets",
	"identity",
	"portal review",
	"approval",
	"publication",
]
const strictSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const unsupportedSingleLineCharacters = /[\u0000-\u001F\u007F]/
const unsupportedLongDescriptionCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
const unsupportedUrlCharacters = /[^\u0021-\u007E]|["<>\\^`{|}]/
const codexCategories = new Set([
	"Productivity",
	"Creativity",
	"Developer Tools",
	"Business & Operations",
	"Data & Analytics",
	"Communication",
	"Education & Research",
	"Security",
	"Finance",
	"Healthcare",
	"Travel",
	"Entertainment",
	"Other",
])

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

function packageContractError(message: string): Error {
	return new Error(`${packageContractProfile}: ${message}`)
}

function normalizedText(value: string): string {
	return value.trim().replace(/\s+/g, " ")
}

function hasNormalizedDuplicates(values: string[], caseInsensitive = false): boolean {
	const normalized = values.map((value) => {
		const text = normalizedText(value)
		return caseInsensitive ? text.toLocaleLowerCase("en-US") : text
	})
	return new Set(normalized).size !== normalized.length
}

function isSupportedSingleLine(value: unknown): value is string {
	return (
		typeof value === "string" &&
		Boolean(value.trim()) &&
		!unsupportedSingleLineCharacters.test(value)
	)
}

function validateRepository(repository: unknown): void {
	if (
		typeof repository !== "string" ||
		repository.length > 2_048 ||
		unsupportedUrlCharacters.test(repository) ||
		/%(?![0-9A-Fa-f]{2})/.test(repository)
	) {
		throw packageContractError(
			"repository must be an absolute HTTPS URL with supported characters and at most 2048 characters",
		)
	}

	let parsed: URL
	try {
		parsed = new URL(repository)
	} catch {
		throw packageContractError("repository must be an absolute HTTPS URL with a host")
	}
	if (parsed.protocol !== "https:" || !parsed.host) {
		throw packageContractError("repository must be an absolute HTTPS URL with a host")
	}
	if (parsed.username || parsed.password) {
		throw packageContractError("repository must not contain embedded credentials")
	}
	if (
		parsed.hostname.toLowerCase() !== "github.com" ||
		parsed.port ||
		parsed.search ||
		parsed.hash ||
		!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(parsed.pathname)
	) {
		throw packageContractError(
			"repository must be a canonical GitHub HTTPS repository URL without a port, query, or fragment",
		)
	}
}

/**
 * Validate metadata required for local and repository Git marketplace packages.
 *
 * @param config - Canonical metadata projected into native manifests
 * @throws {Error} When a generated package field violates the required contract
 *
 * @example
 * ```typescript
 * validatePackageContract(config)
 * ```
 */
export function validatePackageContract(config: PluginConfig): void {
	if (
		typeof config.name !== "string" ||
		!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.name) ||
		config.name.length > 64
	) {
		throw packageContractError("plugin name must be kebab-case and at most 64 characters")
	}
	if (typeof config.version !== "string" || config.version.length > 64) {
		throw packageContractError(
			"plugin version must use semantic versioning and be at most 64 characters",
		)
	}
	if (!strictSemver.test(config.version)) {
		throw packageContractError("plugin version must use semantic versioning")
	}
	if (
		!isSupportedSingleLine(config.displayName) ||
		!isSupportedSingleLine(config.description) ||
		!isSupportedSingleLine(config.author?.name)
	) {
		throw packageContractError("displayName, description, and author.name are required single-line text")
	}
	if (config.description.length > 1_024) {
		throw packageContractError("description must be at most 1024 characters")
	}
	if (!isSupportedSingleLine(config.shortDescription)) {
		throw packageContractError("shortDescription must be one non-empty line of supported text")
	}
	if (
		typeof config.longDescription !== "string" ||
		!config.longDescription.trim() ||
		config.longDescription.length > 1_024 ||
		unsupportedLongDescriptionCharacters.test(config.longDescription)
	) {
		throw packageContractError(
			"longDescription must be non-empty supported text of at most 1024 characters",
		)
	}
	if (!codexCategories.has(config.category)) {
		throw packageContractError("category must be a supported Codex directory category")
	}
	if (
		!Array.isArray(config.capabilities) ||
		config.capabilities.length > 20 ||
		config.capabilities.some(
			(capability) => !isSupportedSingleLine(capability) || capability.length > 120,
		) ||
		hasNormalizedDuplicates(config.capabilities, true)
	) {
		throw packageContractError(
			"capabilities accepts at most 20 unique, non-empty, single-line entries of at most 120 characters",
		)
	}
	validateRepository(config.repository)
	if (!isSupportedSingleLine(config.license) || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(config.license)) {
		throw packageContractError("license must be a supported SPDX identifier of at most 64 characters")
	}
	if (
		!Array.isArray(config.keywords) ||
		config.keywords.length > 20 ||
		config.keywords.some(
			(keyword) =>
				!isSupportedSingleLine(keyword) ||
				keyword.length > 64 ||
				!/^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(keyword),
		) ||
		hasNormalizedDuplicates(config.keywords, true)
	) {
		throw packageContractError(
			"keywords accepts at most 20 unique, supported, single-line entries of at most 64 characters",
		)
	}
	if (
		typeof config.canary?.owner !== "string" ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(config.canary.owner)
	) {
		throw packageContractError("canary.owner must be a GitHub account name")
	}
	if (
		typeof config.canary?.actor !== "string" ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(config.canary.actor)
	) {
		throw packageContractError("canary.actor must be a GitHub user name")
	}
	if (
		!Array.isArray(config.defaultPrompts) ||
		config.defaultPrompts.length > 3 ||
		config.defaultPrompts.some(
			(prompt) => !isSupportedSingleLine(prompt) || prompt.trimStart().startsWith("@"),
		) ||
		hasNormalizedDuplicates(config.defaultPrompts)
	) {
		throw packageContractError(
			"defaultPrompts accepts at most three unique, non-empty, single-line entries that do not start with @mentions",
		)
	}
	if (!/^#[0-9A-F]{6}$/.test(config.brandColor)) {
		throw packageContractError("brandColor must be an uppercase six-digit hexadecimal color")
	}
	for (const [field, path] of [
		["composerIcon", config.composerIcon],
		["logo", config.logo],
	] as const) {
		if (!/^\.\/assets\/[a-z0-9]+(?:-[a-z0-9]+)*\.svg$/.test(path)) {
			throw packageContractError(`${field} must be a plugin-relative SVG asset path`)
		}
	}
}

/**
 * Report the stricter Codex directory text subset without claiming public submission readiness.
 *
 * @param config - Canonical metadata whose directory text limits are checked
 * @returns Text-limit results plus the public-directory work not evaluated
 *
 * @example
 * ```typescript
 * const report = checkDirectoryReadiness(config)
 * if (!report.ok) console.error(report.errors)
 * ```
 */
export function checkDirectoryReadiness(config: PluginConfig): DirectoryReadinessReport {
	const errors: string[] = []
	if (typeof config.displayName !== "string" || config.displayName.length > 30) {
		errors.push("displayName must be at most 30 characters")
	}
	if (typeof config.author?.name !== "string" || config.author.name.length > 80) {
		errors.push("author.name must be at most 80 characters")
	}
	if (typeof config.shortDescription !== "string" || config.shortDescription.length > 30) {
		errors.push("shortDescription must be at most 30 characters")
	}
	if (
		!Array.isArray(config.defaultPrompts) ||
		config.defaultPrompts.some((prompt) => typeof prompt !== "string" || prompt.length > 128)
	) {
		errors.push("defaultPrompts entries must be at most 128 characters")
	}
	return {
		profile: directoryReadinessProfile,
		ok: errors.length === 0,
		errors,
		notEvaluated: [...directoryReadinessNotEvaluated],
	}
}

function validateConfig(config: PluginConfig): void {
	validatePackageContract(config)
	const directoryReadiness = checkDirectoryReadiness(config)
	if (!directoryReadiness.ok) {
		throw new Error(`${directoryReadiness.profile}: ${directoryReadiness.errors.join("; ")}`)
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
					displayName: config.displayName,
					description: config.description,
					author: config.author,
					source: "./plugin",
					defaultEnabled: false,
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
			displayName: config.displayName,
			version: config.version,
			defaultEnabled: false,
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

function codexInterface(config: PluginConfig): Record<string, unknown> {
	return {
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
			interface: codexInterface(config),
		}),
	}
}

/** Build one client's hook declaration object; proofs reuse this as the comparison contract. */
export function hookDeclarationBody(client: "claude" | "codex"): Record<string, unknown> {
	const pluginRoot = client === "claude" ? "CLAUDE_PLUGIN_ROOT" : "PLUGIN_ROOT"
	const command = (event: "SessionStart" | "Stop") =>
		`"\${${pluginRoot}}/hooks/native-capability-hook" ${event} ${client}`
	return {
		hooks: {
			SessionStart: [{ hooks: [{ type: "command", command: command("SessionStart") }] }],
			Stop: [{ hooks: [{ type: "command", command: command("Stop") }] }],
		},
	}
}

function hookDeclaration(client: "claude" | "codex"): GeneratedFile {
	return {
		path: `plugin/hooks/${client}/hooks.json`,
		contents: serialize(hookDeclarationBody(client)),
	}
}
/** Render native Claude and Codex files from canonical metadata. */
export function renderGeneratedFiles(config: PluginConfig): GeneratedFile[] {
	validateConfig(config)
	return [
		claudeMarketplace(config),
		codexMarketplace(config),
		claudeManifest(config),
		codexManifest(config),
		hookDeclaration("claude"),
		hookDeclaration("codex"),
	]
}

/** Write rendered files idempotently to deterministic repository paths. */
export function writeGeneratedFileSet(root: string, files: GeneratedFile[]): GeneratedFile[] {
	for (const file of files) {
		const path = join(root, file.path)
		if (existsSync(path) && readFileSync(path, "utf8") === file.contents) continue
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, file.contents)
	}
	return files
}

/** Write every generated manifest to its deterministic repository path. */
export function writeGeneratedFiles(root: string, config: PluginConfig): GeneratedFile[] {
	return writeGeneratedFileSet(root, renderGeneratedFiles(config))
}

/** Return generated paths whose checked-in contents differ from canonical metadata. */
export function checkGeneratedFiles(root: string, config: PluginConfig): string[] {
	return renderGeneratedFiles(config)
		.filter(
			(file) =>
				!existsSync(join(root, file.path)) ||
				readFileSync(join(root, file.path), "utf8") !== file.contents,
		)
		.map((file) => file.path)
}
