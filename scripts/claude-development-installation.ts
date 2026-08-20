import { createHash, randomUUID } from "node:crypto"
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"

import { bunCommandRunner, type CommandRunner } from "./command-runner"
import { loadPluginConfig } from "./plugin-config"

const MINIMUM_COMMAND_SOURCE_VERSION = [2, 1, 229] as const
const SNAPSHOT_SCHEMA_VERSION = 1 as const
const LINK_MARKER_FILE = ".claude-plugin-link"
// Links sit at cache/<name>-dev/<plugin>/<version>/<entry>. A deeper tree is
// recorded as unreadable rather than walked, so a layout change surfaces as an
// unverifiable cache instead of a silent clean result.
const MAXIMUM_CACHE_WALK_DEPTH = 3

export const claudeWatchSources = [
	{ relativePath: "runtime", recursive: true },
	{ relativePath: "packages", recursive: true },
	{ relativePath: "plugin/skills", recursive: true },
	{ relativePath: "plugin/hooks", recursive: true },
	{ relativePath: "plugin/assets", recursive: true },
	{ relativePath: "plugin/.claude-plugin", recursive: true },
	{ relativePath: "plugin/.codex-plugin", recursive: true },
	{ relativePath: "package.json", recursive: false },
	{ relativePath: "bun.lock", recursive: false },
	{ relativePath: "bunfig.toml", recursive: false },
	{ relativePath: "plugin.config.json", recursive: false },
] as const

export type ClaudeDevelopmentOperation = "check" | "install" | "restore" | "watch"
export type ClaudeDevelopmentMode = "inspect" | "preview" | "apply" | "watch"
export type ClaudeDevelopmentTransactionState =
	"ready" | "previewed" | "no_op" | "installed" | "restored" | "blocked" | "unknown"

interface ClaudePluginListEntry {
	id: string
	version: string
	scope: string
	enabled: boolean
	installPath: string
}

interface ClaudeMarketplaceListEntry {
	name: string
	source: string
	path?: string
	repo?: string
	url?: string
	ref?: string
	installLocation?: string
}

interface RestorableMarketplace {
	addSource: string
	sourceType: string
}

interface PriorProductionState {
	marketplace?: RestorableMarketplace
	plugin?: {
		enabled: boolean
		version: string
	}
}

interface RestorationSnapshot {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
	profileRoot: string
	repositoryRoot: string
	pluginName: string
	prior: PriorProductionState
	transactionState: "captured" | "development_installed" | "restored" | "unknown"
	sideEffects: string[]
}

interface OrphanedDevelopmentCache {
	cacheRoot: string
	danglingLinks: string[]
	unreadablePaths: string[]
	depthExceededPaths: string[]
	recordedTargets: string[]
}

interface InspectedState {
	productionPlugin?: ClaudePluginListEntry
	developmentPlugin?: ClaudePluginListEntry
	productionMarketplace?: ClaudeMarketplaceListEntry
	developmentMarketplace?: ClaudeMarketplaceListEntry
	linkedToCanonicalPayload: boolean
	orphanedCache?: OrphanedDevelopmentCache
}

export interface ClaudeDevelopmentInstallationInput {
	operation: ClaudeDevelopmentOperation
	apply: boolean
	runId?: string
	repositoryRoot: string
	environment: Record<string, string | undefined>
	runner?: CommandRunner
}

export interface ClaudeDevelopmentInstallationResult {
	schemaVersion: 1
	contractId: "plugin.development-installation"
	runId: string
	ok: true
	harness: "claude"
	operation: ClaudeDevelopmentOperation
	mode: ClaudeDevelopmentMode
	changed: boolean
	transactionState: Exclude<ClaudeDevelopmentTransactionState, "blocked" | "unknown">
	retrySafety: "safe"
	current: {
		production: "absent" | "marketplace-only" | "installed"
		development: "absent" | "marketplace-only" | "installed"
		singleSource: boolean
		linkedToCanonicalPayload: boolean
	}
	sideEffects: string[]
	nextAction: string
}

export type ClaudeDevelopmentErrorAction =
	"FIX_INPUT" | "INSPECT_STATE" | "RUN_RESTORE" | "ASK_ADMIN" | "ESCALATE"

export class ClaudeDevelopmentInstallationError extends Error {
	readonly code: string
	readonly action: ClaudeDevelopmentErrorAction
	readonly errorFamily: string
	readonly changed: boolean
	readonly transactionState: "blocked" | "restored" | "unknown"
	readonly retrySafety: "safe" | "unsafe" | "inspect_required"
	readonly sideEffects: string[]
	readonly nextAction: string

	constructor(
		code: string,
		message: string,
		options: {
			action?: ClaudeDevelopmentErrorAction
			errorFamily?: string
			changed?: boolean
			transactionState?: "blocked" | "restored" | "unknown"
			retrySafety?: "safe" | "unsafe" | "inspect_required"
			sideEffects?: string[]
			nextAction?: string
			cause?: unknown
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause })
		this.name = "ClaudeDevelopmentInstallationError"
		this.code = code
		this.action = options.action ?? "INSPECT_STATE"
		this.errorFamily = options.errorFamily ?? "state"
		this.changed = options.changed ?? false
		this.transactionState = options.transactionState ?? "blocked"
		this.retrySafety = options.retrySafety ?? "safe"
		this.sideEffects = options.sideEffects ?? []
		this.nextAction = options.nextAction ?? "Run `bun run dev -- claude check --json --no-input`."
	}
}

/**
 * Take the first meaningful line of captured output, bounded for one message.
 */
function firstReportedLine(output: string | undefined): string | undefined {
	const line = (output ?? "")
		.split("\n")
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate.length > 0)
	if (!line) return undefined
	// A source URL may carry userinfo, and this file already refuses to persist
	// one; surfacing it through a failure message would defeat that guard.
	const redacted = line.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1<redacted>@")
	return redacted.length > 200 ? `${redacted.slice(0, 200)}...` : redacted
}

function command(
	runner: CommandRunner,
	commandArguments: readonly string[],
	options: {
		repositoryRoot: string
		environment: Record<string, string | undefined>
		code: string
		label: string
		timeout?: number
	},
): string {
	let result
	try {
		result = runner.run(commandArguments, {
			workingDirectory: options.repositoryRoot,
			environment: options.environment,
			timeout: options.timeout ?? 60_000,
		})
	} catch {
		throw new ClaudeDevelopmentInstallationError(options.code, `${options.label} could not start`, {
			errorFamily: "runtime",
			action: "FIX_INPUT",
		})
	}
	if (result.exitCode !== 0) {
		// The refusal a Claude session raises for an unaccepted command source
		// only appears here, so dropping it leaves the caller unable to tell a
		// review gate from a broken payload.
		const reported = firstReportedLine(result.stderr) ?? firstReportedLine(result.stdout)
		throw new ClaudeDevelopmentInstallationError(
			options.code,
			`${options.label} failed without proving the requested state${reported ? `: ${reported}` : ""}`,
			{
				errorFamily: result.exitCode === 124 ? "timeout" : "runtime",
				action: result.exitCode === 124 ? "INSPECT_STATE" : "FIX_INPUT",
			},
		)
	}
	return result.stdout
}

function jsonCommand<T>(
	runner: CommandRunner,
	commandArguments: readonly string[],
	options: Parameters<typeof command>[2],
): T {
	const output = command(runner, commandArguments, options)
	try {
		return JSON.parse(output) as T
	} catch {
		throw new ClaudeDevelopmentInstallationError(
			options.code,
			`${options.label} returned unreadable JSON`,
			{ errorFamily: "protocol", action: "INSPECT_STATE" },
		)
	}
}

function profileRoot(environment: Record<string, string | undefined>): string {
	return resolve(environment.CLAUDE_CONFIG_DIR ?? join(environment.HOME ?? homedir(), ".claude"))
}

function developmentRoot(repositoryRoot: string): string {
	return join(repositoryRoot, ".dev", "claude")
}

/**
 * Describe a development cache the Claude CLI no longer lists.
 *
 * Deregistering the Marketplace makes the installation invisible to
 * `plugin list`, so every CLI-driven check reports it identically to a profile
 * that never installed. The cache root outliving that registration is itself
 * the orphan; dangling links and recorded link targets are the detail that
 * explains it, never the trigger. Requiring the detail would report a cache
 * whose links still resolve as a clean absence, which is the defect this
 * function exists to end.
 *
 * A directory the walk cannot read is recorded rather than skipped, so an
 * unreadable tree stays distinguishable from a tree proven clean.
 */
function describeOrphanedDevelopmentCache(
	pluginName: string,
	environment: Record<string, string | undefined>,
): OrphanedDevelopmentCache | undefined {
	const cacheRoot = join(profileRoot(environment), "plugins", "cache", `${pluginName}-dev`)
	if (!existsSync(cacheRoot)) return undefined
	const danglingLinks: string[] = []
	const unreadablePaths: string[] = []
	const depthExceededPaths: string[] = []
	const recordedTargets: string[] = []
	const walk = (directory: string, depth: number): void => {
		if (depth > MAXIMUM_CACHE_WALK_DEPTH) {
			depthExceededPaths.push(directory)
			return
		}
		let entries: string[]
		try {
			entries = readdirSync(directory)
		} catch {
			unreadablePaths.push(directory)
			return
		}
		for (const entry of entries) {
			const entryPath = join(directory, entry)
			let stats
			try {
				stats = lstatSync(entryPath)
			} catch {
				unreadablePaths.push(entryPath)
				continue
			}
			if (stats.isSymbolicLink()) {
				if (!existsSync(entryPath)) danglingLinks.push(entryPath)
			} else if (entry === LINK_MARKER_FILE) {
				recordedTargets.push(readRecordedLinkTarget(entryPath) ?? entryPath)
			} else if (stats.isDirectory()) {
				walk(entryPath, depth + 1)
			}
		}
	}
	walk(cacheRoot, 0)
	return { cacheRoot, danglingLinks, unreadablePaths, depthExceededPaths, recordedTargets }
}

/**
 * Read the payload path a linked cache entry recorded at install time.
 *
 * The marker survives a payload whose links still resolve, so it is the only
 * evidence that separates a cache serving this checkout from one serving a
 * checkout that has since moved or been replaced.
 */
function readRecordedLinkTarget(markerPath: string): string | undefined {
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as { target?: unknown }
		return typeof parsed.target === "string" ? parsed.target : undefined
	} catch {
		return undefined
	}
}

function marketplaceRoot(repositoryRoot: string): string {
	return join(developmentRoot(repositoryRoot), "marketplace")
}

function snapshotPath(
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
): string {
	const profileKey = createHash("sha256")
		.update(profileRoot(environment))
		.digest("hex")
		.slice(0, 16)
	return join(developmentRoot(repositoryRoot), "restore-state", `${profileKey}.json`)
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`
}

function commandSource(pluginRoot: string): string {
	const value = `printf '%s\\n' ${shellQuote(pluginRoot)}`
	if (!/^[\x20-\x7e]+$/.test(value) || value.length > 500 || / {4}/.test(value)) {
		throw new ClaudeDevelopmentInstallationError(
			"COMMAND_SOURCE_PATH_UNSUPPORTED",
			"The repository path cannot be represented by Claude Code's command-source contract",
			{
				action: "FIX_INPUT",
				errorFamily: "input",
				nextAction:
					"Use an ASCII repository path without runs of four spaces, then rerun the check.",
			},
		)
	}
	return value
}

function writeJsonAtomic(path: string, value: unknown, mode: number): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const temporaryPath = `${path}.${randomUUID()}.tmp`
	writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode })
	chmodSync(temporaryPath, mode)
	renameSync(temporaryPath, path)
}

function prepareMarketplace(repositoryRoot: string): string {
	const pluginConfig = loadPluginConfig(repositoryRoot)
	const root = marketplaceRoot(repositoryRoot)
	const manifestPath = join(root, ".claude-plugin", "marketplace.json")
	const pluginRoot = realpathSync(join(repositoryRoot, "plugin"))
	writeJsonAtomic(
		manifestPath,
		{
			name: `${pluginConfig.name}-dev`,
			owner: { name: pluginConfig.author.name },
			metadata: {
				description: `Live linked development marketplace for ${pluginConfig.displayName}`,
			},
			plugins: [
				{
					name: pluginConfig.name,
					displayName: `${pluginConfig.displayName} Development`,
					description: pluginConfig.description,
					author: { name: pluginConfig.author.name },
					source: {
						source: "command",
						command: commandSource(pluginRoot),
						mode: "link",
					},
					defaultEnabled: false,
				},
			],
		},
		0o600,
	)
	return root
}

function parseVersion(value: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim())
	if (!match) {
		throw new ClaudeDevelopmentInstallationError(
			"CLAUDE_VERSION_UNREADABLE",
			"Claude Code returned an unreadable version",
			{ errorFamily: "runtime", action: "FIX_INPUT" },
		)
	}
	return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function versionAtLeast(value: [number, number, number], minimum: readonly number[]): boolean {
	for (let index = 0; index < minimum.length; index += 1) {
		if (value[index] > minimum[index]) return true
		if (value[index] < minimum[index]) return false
	}
	return true
}

function restorableMarketplace(entry: ClaudeMarketplaceListEntry): RestorableMarketplace {
	switch (entry.source) {
		case "directory":
			if (!entry.path || !isAbsolute(entry.path)) break
			return { sourceType: entry.source, addSource: resolve(entry.path) }
		case "github":
			if (!entry.repo) break
			return {
				sourceType: entry.source,
				addSource: `${entry.repo}${entry.ref ? `@${entry.ref}` : ""}`,
			}
		case "git":
		case "url": {
			if (!entry.url) break
			let url: URL
			try {
				url = new URL(entry.url)
			} catch {
				break
			}
			if (url.username || url.password) {
				throw new ClaudeDevelopmentInstallationError(
					"PRODUCTION_SOURCE_CONTAINS_CREDENTIALS",
					"The production Marketplace source contains inline credentials and cannot be persisted safely",
					{ action: "ASK_ADMIN", errorFamily: "auth" },
				)
			}
			return {
				sourceType: entry.source,
				addSource: `${entry.url}${entry.source === "git" && entry.ref ? `#${entry.ref}` : ""}`,
			}
		}
	}
	throw new ClaudeDevelopmentInstallationError(
		"PRODUCTION_SOURCE_UNRESTORABLE",
		"The production Marketplace source cannot be reconstructed through the supported Claude CLI",
		{ action: "ASK_ADMIN", errorFamily: "state" },
	)
}

function verifyLinkedPayload(pluginRoot: string, installPath: string): boolean {
	if (!existsSync(installPath)) return false
	for (const entry of readdirSync(pluginRoot)) {
		const canonicalEntry = join(pluginRoot, entry)
		const installedEntry = join(installPath, entry)
		if (!existsSync(installedEntry) || !lstatSync(installedEntry).isSymbolicLink()) return false
		if (realpathSync(installedEntry) !== realpathSync(canonicalEntry)) return false
	}
	return true
}

function inspectState(
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
	runner: CommandRunner,
): InspectedState {
	const pluginName = loadPluginConfig(repositoryRoot).name
	const productionId = `${pluginName}@${pluginName}`
	const developmentMarketplaceName = `${pluginName}-dev`
	const developmentId = `${pluginName}@${developmentMarketplaceName}`
	const plugins = jsonCommand<ClaudePluginListEntry[]>(
		runner,
		["claude", "plugin", "list", "--json"],
		{
			repositoryRoot,
			environment,
			code: "PLUGIN_STATE_UNREADABLE",
			label: "Claude Plugin Installation inspection",
		},
	)
	const marketplaces = jsonCommand<ClaudeMarketplaceListEntry[]>(
		runner,
		["claude", "plugin", "marketplace", "list", "--json"],
		{
			repositoryRoot,
			environment,
			code: "MARKETPLACE_STATE_UNREADABLE",
			label: "Claude Marketplace inspection",
		},
	)
	const relatedPlugins = plugins.filter((entry) => entry.id.startsWith(`${pluginName}@`))
	const unknown = relatedPlugins.filter(
		(entry) => ![productionId, developmentId].includes(entry.id),
	)
	if (unknown.length > 0) {
		throw new ClaudeDevelopmentInstallationError(
			"UNKNOWN_PLUGIN_IDENTITY",
			"Claude reports an unowned plugin identity with the same plugin name",
			{ action: "ASK_ADMIN", errorFamily: "state" },
		)
	}
	if (relatedPlugins.some((entry) => entry.scope !== "user")) {
		throw new ClaudeDevelopmentInstallationError(
			"NON_USER_PLUGIN_IDENTITY",
			"A project or local plugin identity must be removed by its owning scope before global development installation",
			{ action: "ASK_ADMIN", errorFamily: "scope" },
		)
	}
	const productionPlugins = relatedPlugins.filter((entry) => entry.id === productionId)
	const developmentPlugins = relatedPlugins.filter((entry) => entry.id === developmentId)
	if (productionPlugins.length > 1 || developmentPlugins.length > 1) {
		throw new ClaudeDevelopmentInstallationError(
			"AMBIGUOUS_PLUGIN_IDENTITY",
			"Claude reports more than one installation for a known plugin identity",
			{ action: "ASK_ADMIN", errorFamily: "state" },
		)
	}
	const productionMarketplace = marketplaces.find((entry) => entry.name === pluginName)
	const developmentMarketplace = marketplaces.find(
		(entry) => entry.name === developmentMarketplaceName,
	)
	const productionPlugin = productionPlugins[0]
	const developmentPlugin = developmentPlugins[0]
	if (
		developmentMarketplace &&
		(developmentMarketplace.source !== "directory" ||
			!developmentMarketplace.path ||
			resolve(developmentMarketplace.path) !== resolve(marketplaceRoot(repositoryRoot)))
	) {
		throw new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_MARKETPLACE_MISMATCH",
			"The development Marketplace name is owned by another source",
			{ action: "INSPECT_STATE", errorFamily: "conflict" },
		)
	}
	if (productionPlugin && !productionMarketplace) {
		throw new ClaudeDevelopmentInstallationError(
			"PRODUCTION_MARKETPLACE_MISSING",
			"The production Plugin Installation has no matching Marketplace",
			{ action: "ASK_ADMIN", errorFamily: "state" },
		)
	}
	if (developmentPlugin && !developmentMarketplace) {
		throw new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_MARKETPLACE_MISSING",
			"The development Plugin Installation has no matching Marketplace",
			{ action: "INSPECT_STATE", errorFamily: "state" },
		)
	}
	if (!developmentPlugin && developmentMarketplace) {
		throw new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_STATE_INCOMPLETE",
			"The development Marketplace exists without its Plugin Installation",
			{
				action: "RUN_RESTORE",
				errorFamily: "state",
				nextAction: "Run `bun run dev -- claude restore` to inspect the recovery plan.",
			},
		)
	}
	if (
		(productionPlugin || productionMarketplace) &&
		(developmentPlugin || developmentMarketplace)
	) {
		throw new ClaudeDevelopmentInstallationError(
			"DUPLICATE_PLUGIN_SOURCES",
			"Production and development Plugin Installations are present together",
			{
				action: "RUN_RESTORE",
				errorFamily: "conflict",
				nextAction: "Run `bun run dev -- claude restore` to inspect the recovery plan.",
			},
		)
	}
	return {
		productionPlugin,
		developmentPlugin,
		productionMarketplace,
		developmentMarketplace,
		linkedToCanonicalPayload:
			developmentPlugin !== undefined &&
			verifyLinkedPayload(
				realpathSync(join(repositoryRoot, "plugin")),
				developmentPlugin.installPath,
			),
		orphanedCache:
			developmentPlugin === undefined
				? describeOrphanedDevelopmentCache(pluginName, environment)
				: undefined,
	}
}

function installationState(
	plugin: ClaudePluginListEntry | undefined,
	marketplace: ClaudeMarketplaceListEntry | undefined,
): "absent" | "marketplace-only" | "installed" {
	if (plugin) return "installed"
	return marketplace ? "marketplace-only" : "absent"
}

function result(
	input: ClaudeDevelopmentInstallationInput,
	state: InspectedState,
	options: {
		mode: ClaudeDevelopmentMode
		changed: boolean
		transactionState: Exclude<ClaudeDevelopmentTransactionState, "blocked" | "unknown">
		sideEffects?: string[]
		nextAction: string
	},
): ClaudeDevelopmentInstallationResult {
	return {
		schemaVersion: 1,
		contractId: "plugin.development-installation",
		runId: input.runId ?? randomUUID(),
		ok: true,
		harness: "claude",
		operation: input.operation,
		mode: options.mode,
		changed: options.changed,
		transactionState: options.transactionState,
		retrySafety: "safe",
		current: {
			production: installationState(state.productionPlugin, state.productionMarketplace),
			development: installationState(state.developmentPlugin, state.developmentMarketplace),
			singleSource: !(
				(state.productionPlugin || state.productionMarketplace) &&
				(state.developmentPlugin || state.developmentMarketplace)
			),
			linkedToCanonicalPayload: state.linkedToCanonicalPayload,
		},
		sideEffects: options.sideEffects ?? [],
		nextAction: options.nextAction,
	}
}

function capturePriorState(
	input: ClaudeDevelopmentInstallationInput,
	state: InspectedState,
): RestorationSnapshot {
	const pluginName = loadPluginConfig(input.repositoryRoot).name
	const snapshot: RestorationSnapshot = {
		schemaVersion: SNAPSHOT_SCHEMA_VERSION,
		profileRoot: profileRoot(input.environment),
		repositoryRoot: realpathSync(input.repositoryRoot),
		pluginName,
		prior: {
			marketplace: state.productionMarketplace
				? restorableMarketplace(state.productionMarketplace)
				: undefined,
			plugin: state.productionPlugin
				? {
						enabled: state.productionPlugin.enabled,
						version: state.productionPlugin.version,
					}
				: undefined,
		},
		transactionState: "captured",
		sideEffects: [],
	}
	writeJsonAtomic(snapshotPath(input.repositoryRoot, input.environment), snapshot, 0o600)
	return snapshot
}

function readSnapshot(input: ClaudeDevelopmentInstallationInput): RestorationSnapshot {
	let snapshot: RestorationSnapshot
	try {
		snapshot = JSON.parse(
			readFileSync(snapshotPath(input.repositoryRoot, input.environment), "utf8"),
		) as RestorationSnapshot
	} catch {
		throw new ClaudeDevelopmentInstallationError(
			"RESTORATION_SNAPSHOT_MISSING",
			"The profile-bound restoration snapshot is missing or unreadable",
			{
				action: "INSPECT_STATE",
				errorFamily: "recovery",
				retrySafety: "inspect_required",
			},
		)
	}
	if (
		typeof snapshot !== "object" ||
		snapshot === null ||
		Array.isArray(snapshot) ||
		snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
		typeof snapshot.prior !== "object" ||
		snapshot.prior === null ||
		Array.isArray(snapshot.prior) ||
		snapshot.profileRoot !== profileRoot(input.environment) ||
		snapshot.repositoryRoot !== realpathSync(input.repositoryRoot) ||
		snapshot.pluginName !== loadPluginConfig(input.repositoryRoot).name ||
		(snapshot.prior.plugin !== undefined && snapshot.prior.marketplace === undefined)
	) {
		throw new ClaudeDevelopmentInstallationError(
			"RESTORATION_SNAPSHOT_MISMATCH",
			"The restoration snapshot belongs to another repository, plugin, or Claude profile",
			{
				action: "INSPECT_STATE",
				errorFamily: "recovery",
				retrySafety: "inspect_required",
			},
		)
	}
	return snapshot
}

function productionMatchesSnapshot(state: InspectedState, snapshot: RestorationSnapshot): boolean {
	if (Boolean(state.productionMarketplace) !== Boolean(snapshot.prior.marketplace)) return false
	if (state.productionMarketplace && snapshot.prior.marketplace) {
		if (!marketplaceMatchesSnapshot(state.productionMarketplace, snapshot.prior.marketplace)) {
			return false
		}
	}
	if (Boolean(state.productionPlugin) !== Boolean(snapshot.prior.plugin)) return false
	if (state.productionPlugin && snapshot.prior.plugin) {
		return (
			state.productionPlugin.enabled === snapshot.prior.plugin.enabled &&
			state.productionPlugin.version === snapshot.prior.plugin.version
		)
	}
	return true
}

function marketplaceMatchesSnapshot(
	marketplace: ClaudeMarketplaceListEntry,
	expected: RestorableMarketplace,
): boolean {
	try {
		const current = restorableMarketplace(marketplace)
		return current.sourceType === expected.sourceType && current.addSource === expected.addSource
	} catch {
		return false
	}
}

function restorationConflict(message: string, sideEffects: string[]): never {
	throw new ClaudeDevelopmentInstallationError("RESTORATION_STATE_CONFLICT", message, {
		action: "INSPECT_STATE",
		errorFamily: "recovery",
		changed: true,
		transactionState: "unknown",
		retrySafety: "inspect_required",
		sideEffects,
	})
}

function persistSnapshot(
	input: ClaudeDevelopmentInstallationInput,
	snapshot: RestorationSnapshot,
): void {
	writeJsonAtomic(snapshotPath(input.repositoryRoot, input.environment), snapshot, 0o600)
}

function nativeMutation(
	input: ClaudeDevelopmentInstallationInput,
	runner: CommandRunner,
	arguments_: string[],
	label: string,
	sideEffect: string,
	snapshot: RestorationSnapshot,
): void {
	command(runner, ["claude", ...arguments_], {
		repositoryRoot: input.repositoryRoot,
		environment: input.environment,
		code: "CLAUDE_MUTATION_FAILED",
		label,
	})
	snapshot.sideEffects.push(sideEffect)
	persistSnapshot(input, snapshot)
}

function restoreFromSnapshot(
	input: ClaudeDevelopmentInstallationInput,
	runner: CommandRunner,
	snapshot: RestorationSnapshot,
): InspectedState {
	const pluginName = snapshot.pluginName
	const developmentMarketplaceName = `${pluginName}-dev`
	const developmentId = `${pluginName}@${developmentMarketplaceName}`
	const productionId = `${pluginName}@${pluginName}`
	let state = inspectStateForRecovery(input.repositoryRoot, input.environment, runner)
	if (state.developmentPlugin) {
		nativeMutation(
			input,
			runner,
			["plugin", "uninstall", developmentId, "--keep-data", "--scope", "user"],
			"Claude development Plugin uninstall",
			"development_plugin_uninstalled",
			snapshot,
		)
	}
	state = inspectStateForRecovery(input.repositoryRoot, input.environment, runner)
	if (state.developmentMarketplace) {
		nativeMutation(
			input,
			runner,
			["plugin", "marketplace", "remove", developmentMarketplaceName, "--scope", "user"],
			"Claude development Marketplace removal",
			"development_marketplace_removed",
			snapshot,
		)
	}
	state = inspectStateForRecovery(input.repositoryRoot, input.environment, runner)
	if (
		state.productionMarketplace &&
		(!snapshot.prior.marketplace ||
			!marketplaceMatchesSnapshot(state.productionMarketplace, snapshot.prior.marketplace))
	) {
		restorationConflict(
			"The current production Marketplace does not match the captured restoration source",
			snapshot.sideEffects,
		)
	}
	if (snapshot.prior.marketplace && !state.productionMarketplace) {
		nativeMutation(
			input,
			runner,
			["plugin", "marketplace", "add", snapshot.prior.marketplace.addSource, "--scope", "user"],
			"Claude production Marketplace restoration",
			"production_marketplace_restored",
			snapshot,
		)
	}
	state = inspectStateForRecovery(input.repositoryRoot, input.environment, runner)
	if (
		state.productionPlugin &&
		(!snapshot.prior.plugin || state.productionPlugin.version !== snapshot.prior.plugin.version)
	) {
		restorationConflict(
			"The current production Plugin Installation does not match the captured version",
			snapshot.sideEffects,
		)
	}
	if (snapshot.prior.plugin && !state.productionPlugin) {
		nativeMutation(
			input,
			runner,
			["plugin", "install", productionId, "--scope", "user", "--yes"],
			"Claude production Plugin restoration",
			"production_plugin_restored",
			snapshot,
		)
		state = inspectStateForRecovery(input.repositoryRoot, input.environment, runner)
		if (state.productionPlugin?.version !== snapshot.prior.plugin.version) {
			throw new ClaudeDevelopmentInstallationError(
				"PRODUCTION_VERSION_UNAVAILABLE",
				"Claude restored a production Plugin version that differs from the captured version",
				{
					action: "INSPECT_STATE",
					errorFamily: "recovery",
					changed: true,
					transactionState: "unknown",
					retrySafety: "inspect_required",
					sideEffects: snapshot.sideEffects,
				},
			)
		}
	}
	if (snapshot.prior.plugin && state.productionPlugin?.enabled !== snapshot.prior.plugin.enabled) {
		nativeMutation(
			input,
			runner,
			[
				"plugin",
				snapshot.prior.plugin.enabled ? "enable" : "disable",
				productionId,
				"--scope",
				"user",
			],
			"Claude production enabled-state restoration",
			"production_enabled_state_restored",
			snapshot,
		)
	}
	const restored = inspectState(input.repositoryRoot, input.environment, runner)
	if (
		restored.developmentPlugin ||
		restored.developmentMarketplace ||
		!productionMatchesSnapshot(restored, snapshot)
	) {
		throw new ClaudeDevelopmentInstallationError(
			"RESTORATION_VERIFICATION_FAILED",
			"Claude did not report the exact captured production or absent state after restoration",
			{
				action: "INSPECT_STATE",
				errorFamily: "recovery",
				changed: true,
				transactionState: "unknown",
				retrySafety: "inspect_required",
				sideEffects: snapshot.sideEffects,
			},
		)
	}
	snapshot.transactionState = "restored"
	persistSnapshot(input, snapshot)
	return restored
}

function describeCause(cause: unknown): string {
	if (cause instanceof ClaudeDevelopmentInstallationError) return `${cause.code}: ${cause.message}`
	if (cause instanceof Error) return cause.message
	return String(cause)
}

function failInstallAfterRestoration(
	input: ClaudeDevelopmentInstallationInput,
	runner: CommandRunner,
	snapshot: RestorationSnapshot,
	cause: unknown,
): never {
	const causeDescription = describeCause(cause)
	try {
		restoreFromSnapshot(input, runner, snapshot)
	} catch (restorationCause) {
		snapshot.transactionState = "unknown"
		persistSnapshot(input, snapshot)
		throw new ClaudeDevelopmentInstallationError(
			"INSTALL_AND_RESTORATION_FAILED",
			`Development installation failed and exact production restoration could not be verified. Installation cause: ${causeDescription}. Restoration cause: ${describeCause(restorationCause)}`,
			{
				action: "INSPECT_STATE",
				errorFamily: "recovery",
				changed: true,
				transactionState: "unknown",
				retrySafety: "inspect_required",
				sideEffects: snapshot.sideEffects,
				cause,
			},
		)
	}
	throw new ClaudeDevelopmentInstallationError(
		"INSTALL_FAILED_RESTORED",
		`Development installation failed and the exact prior production state was restored. Cause: ${causeDescription}`,
		{
			action: "FIX_INPUT",
			errorFamily: "recovery",
			changed: true,
			transactionState: "restored",
			retrySafety: "safe",
			sideEffects: snapshot.sideEffects,
			cause,
		},
	)
}

function inspectStateForRecovery(
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
	runner: CommandRunner,
): InspectedState {
	try {
		return inspectState(repositoryRoot, environment, runner)
	} catch (error) {
		if (
			error instanceof ClaudeDevelopmentInstallationError &&
			["DUPLICATE_PLUGIN_SOURCES", "DEVELOPMENT_STATE_INCOMPLETE"].includes(error.code)
		) {
			const pluginName = loadPluginConfig(repositoryRoot).name
			const plugins = jsonCommand<ClaudePluginListEntry[]>(
				runner,
				["claude", "plugin", "list", "--json"],
				{
					repositoryRoot,
					environment,
					code: "PLUGIN_STATE_UNREADABLE",
					label: "Claude Plugin Installation recovery inspection",
				},
			)
			const marketplaces = jsonCommand<ClaudeMarketplaceListEntry[]>(
				runner,
				["claude", "plugin", "marketplace", "list", "--json"],
				{
					repositoryRoot,
					environment,
					code: "MARKETPLACE_STATE_UNREADABLE",
					label: "Claude Marketplace recovery inspection",
				},
			)
			return {
				productionPlugin: plugins.find((entry) => entry.id === `${pluginName}@${pluginName}`),
				developmentPlugin: plugins.find((entry) => entry.id === `${pluginName}@${pluginName}-dev`),
				productionMarketplace: marketplaces.find((entry) => entry.name === pluginName),
				developmentMarketplace: marketplaces.find((entry) => entry.name === `${pluginName}-dev`),
				linkedToCanonicalPayload: false,
			}
		}
		throw error
	}
}

function prepare(input: ClaudeDevelopmentInstallationInput, runner: CommandRunner): InspectedState {
	if (input.operation !== "restore") {
		command(runner, ["bun", "run", "build"], {
			repositoryRoot: input.repositoryRoot,
			environment: input.environment,
			code: "BUILD_FAILED",
			label: "Plugin Payload build",
			timeout: 120_000,
		})
		const root = prepareMarketplace(input.repositoryRoot)
		const versionOutput = command(runner, ["claude", "--version"], {
			repositoryRoot: input.repositoryRoot,
			environment: input.environment,
			code: "CLAUDE_UNAVAILABLE",
			label: "Claude Code version inspection",
		})
		if (!versionAtLeast(parseVersion(versionOutput), MINIMUM_COMMAND_SOURCE_VERSION)) {
			throw new ClaudeDevelopmentInstallationError(
				"CLAUDE_VERSION_UNSUPPORTED",
				"Claude Code 2.1.229 or later is required for command-source link mode",
				{ action: "FIX_INPUT", errorFamily: "runtime" },
			)
		}
		command(runner, ["claude", "plugin", "validate", root], {
			repositoryRoot: input.repositoryRoot,
			environment: input.environment,
			code: "DEVELOPMENT_MARKETPLACE_INVALID",
			label: "Claude development Marketplace validation",
		})
	}
	const state =
		input.operation === "restore"
			? inspectStateForRecovery(input.repositoryRoot, input.environment, runner)
			: inspectState(input.repositoryRoot, input.environment, runner)
	if (state.developmentPlugin && input.operation !== "restore") readSnapshot(input)
	return state
}

function install(
	input: ClaudeDevelopmentInstallationInput,
	runner: CommandRunner,
	state: InspectedState,
): ClaudeDevelopmentInstallationResult {
	if (state.developmentPlugin && state.linkedToCanonicalPayload) {
		const snapshot = readSnapshot(input)
		if (state.developmentPlugin.enabled) {
			return result(input, state, {
				mode: input.apply ? "apply" : "preview",
				changed: false,
				transactionState: "no_op",
				nextAction:
					"Run `bun run dev:claude`, then use ordinary Claude sessions and `/reload-plugins`.",
			})
		}
		if (!input.apply) {
			return result(input, state, {
				mode: "preview",
				changed: false,
				transactionState: "previewed",
				nextAction:
					"Rerun with `--apply` to re-enable the snapshot-owned Development Installation.",
			})
		}
		try {
			nativeMutation(
				input,
				runner,
				["plugin", "enable", state.developmentPlugin.id, "--scope", "user"],
				"Claude development Plugin re-enable",
				"development_plugin_enabled",
				snapshot,
			)
			const enabled = inspectState(input.repositoryRoot, input.environment, runner)
			if (!enabled.developmentPlugin?.enabled || !enabled.linkedToCanonicalPayload) {
				throw new ClaudeDevelopmentInstallationError(
					"DEVELOPMENT_VERIFICATION_FAILED",
					"Claude did not report one enabled live-linked Development Installation",
					{ action: "RUN_RESTORE", errorFamily: "verification" },
				)
			}
			snapshot.transactionState = "development_installed"
			persistSnapshot(input, snapshot)
			return result(input, enabled, {
				mode: "apply",
				changed: true,
				transactionState: "installed",
				sideEffects: snapshot.sideEffects,
				nextAction:
					"Run `bun run dev:claude`, then use ordinary Claude sessions and `/reload-plugins`.",
			})
		} catch (error) {
			failInstallAfterRestoration(input, runner, snapshot, error)
		}
	}
	if (state.developmentPlugin && !state.linkedToCanonicalPayload) {
		throw new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_LINK_MISMATCH",
			"The development Plugin Installation is not linked to this checkout's canonical payload",
			{ action: "RUN_RESTORE", errorFamily: "conflict" },
		)
	}
	if (!input.apply) {
		return result(input, state, {
			mode: "preview",
			changed: false,
			transactionState: "previewed",
			nextAction: "Review the captured production state, then rerun with `--apply`.",
		})
	}
	const snapshot = capturePriorState(input, state)
	const pluginName = snapshot.pluginName
	const productionId = `${pluginName}@${pluginName}`
	const developmentMarketplaceName = `${pluginName}-dev`
	const developmentId = `${pluginName}@${developmentMarketplaceName}`
	try {
		if (state.productionPlugin) {
			nativeMutation(
				input,
				runner,
				["plugin", "uninstall", productionId, "--keep-data", "--scope", "user"],
				"Claude production Plugin uninstall",
				"production_plugin_uninstalled",
				snapshot,
			)
		}
		if (state.productionMarketplace) {
			nativeMutation(
				input,
				runner,
				["plugin", "marketplace", "remove", pluginName, "--scope", "user"],
				"Claude production Marketplace removal",
				"production_marketplace_removed",
				snapshot,
			)
		}
		nativeMutation(
			input,
			runner,
			["plugin", "marketplace", "add", marketplaceRoot(input.repositoryRoot), "--scope", "user"],
			"Claude development Marketplace add",
			"development_marketplace_added",
			snapshot,
		)
		nativeMutation(
			input,
			runner,
			["plugin", "install", developmentId, "--scope", "user", "--yes"],
			"Claude development Plugin install",
			"development_plugin_installed",
			snapshot,
		)
		nativeMutation(
			input,
			runner,
			["plugin", "enable", developmentId, "--scope", "user"],
			"Claude development Plugin enable",
			"development_plugin_enabled",
			snapshot,
		)
		const installed = inspectState(input.repositoryRoot, input.environment, runner)
		if (!installed.developmentPlugin?.enabled || !installed.linkedToCanonicalPayload) {
			throw new ClaudeDevelopmentInstallationError(
				"DEVELOPMENT_VERIFICATION_FAILED",
				"Claude did not report one enabled live-linked Development Installation",
				{ action: "RUN_RESTORE", errorFamily: "verification" },
			)
		}
		snapshot.transactionState = "development_installed"
		persistSnapshot(input, snapshot)
		return result(input, installed, {
			mode: "apply",
			changed: true,
			transactionState: "installed",
			sideEffects: snapshot.sideEffects,
			nextAction:
				"Run `bun run dev:claude`, then open ordinary Claude sessions outside this repository.",
		})
	} catch (error) {
		failInstallAfterRestoration(input, runner, snapshot, error)
	}
}

function restore(
	input: ClaudeDevelopmentInstallationInput,
	runner: CommandRunner,
	state: InspectedState,
): ClaudeDevelopmentInstallationResult {
	const snapshot = readSnapshot(input)
	const alreadyRestored =
		!state.developmentPlugin &&
		!state.developmentMarketplace &&
		productionMatchesSnapshot(state, snapshot)
	if (alreadyRestored) {
		return result(input, state, {
			mode: input.apply ? "apply" : "preview",
			changed: false,
			transactionState: "no_op",
			nextAction: "The captured production or absent state is already restored.",
		})
	}
	if (!input.apply) {
		return result(input, state, {
			mode: "preview",
			changed: false,
			transactionState: "previewed",
			nextAction: "Review the restoration target, then rerun with `--apply`.",
		})
	}
	try {
		const restored = restoreFromSnapshot(input, runner, snapshot)
		return result(input, restored, {
			mode: "apply",
			changed: true,
			transactionState: "restored",
			sideEffects: snapshot.sideEffects,
			nextAction: "The exact captured production or absent state is restored.",
		})
	} catch (error) {
		if (
			error instanceof ClaudeDevelopmentInstallationError &&
			error.transactionState === "unknown"
		) {
			throw error
		}
		snapshot.transactionState = "unknown"
		persistSnapshot(input, snapshot)
		throw new ClaudeDevelopmentInstallationError(
			"RESTORATION_FAILED",
			"Exact production restoration could not be verified",
			{
				action: "INSPECT_STATE",
				errorFamily: "recovery",
				changed: true,
				transactionState: "unknown",
				retrySafety: "inspect_required",
				sideEffects: snapshot.sideEffects,
			},
		)
	}
}

async function runWatch(
	input: ClaudeDevelopmentInstallationInput,
	runner: CommandRunner,
	state: InspectedState,
): Promise<ClaudeDevelopmentInstallationResult> {
	if (!state.developmentPlugin?.enabled || !state.linkedToCanonicalPayload) {
		throw new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_INSTALLATION_NOT_READY",
			"Build watching requires one enabled live-linked Development Installation",
			{
				action: "FIX_INPUT",
				errorFamily: "state",
				nextAction: "Run `bun run dev -- claude install` to preview setup.",
			},
		)
	}
	let rebuildTimer: ReturnType<typeof setTimeout> | undefined
	const watchers: ReturnType<typeof watch>[] = []
	const closeWatchers = () => {
		for (const watcher_ of watchers) watcher_.close()
	}
	try {
		for (const { relativePath, recursive } of claudeWatchSources) {
			const target = join(input.repositoryRoot, relativePath)
			if (!existsSync(target)) continue
			watchers.push(
				watch(target, { recursive }, () => {
					if (rebuildTimer) clearTimeout(rebuildTimer)
					rebuildTimer = setTimeout(() => {
						try {
							command(runner, ["bun", "run", "build"], {
								repositoryRoot: input.repositoryRoot,
								environment: input.environment,
								code: "BUILD_FAILED",
								label: "Plugin Payload rebuild",
								timeout: 120_000,
							})
							process.stderr.write("Build complete. Run /reload-plugins in Claude Code.\n")
						} catch (error) {
							const message = error instanceof Error ? error.message : "rebuild failed"
							process.stderr.write(
								`Rebuild failed: ${message}. Watching for the next change.\n`,
							)
						}
					}, 100)
				}),
			)
		}
	} catch (error) {
		closeWatchers()
		throw error
	}
	const stop = () => {
		closeWatchers()
	}
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	await new Promise<void>((resolvePromise) => {
		process.once("SIGINT", resolvePromise)
		process.once("SIGTERM", resolvePromise)
	})
	return result(input, state, {
		mode: "watch",
		changed: false,
		transactionState: "ready",
		nextAction: "Run /reload-plugins after each successful build.",
	})
}

/**
 * Name the first few paths so the reader can act, bounded for one message.
 */
function namePaths(paths: readonly string[]): string {
	const shown = paths.slice(0, 3).join(", ")
	return paths.length > 3 ? `${shown}, and ${paths.length - 3} more` : shown
}

/**
 * Recognise a cache this checkout left behind rather than one it lost.
 *
 * `restore` uninstalls with `--keep-data`, so a clean exit leaves the cache
 * root standing with its marker still naming this payload. Refusing that would
 * lock the documented exit path out of its own next install. A cache whose
 * marker is missing, unreadable, or names another payload stays an orphan: the
 * checkout that owned it is the one that cannot answer for it.
 */
function servesThisCheckout(cache: OrphanedDevelopmentCache, repositoryRoot: string): boolean {
	if (cache.unreadablePaths.length > 0 || cache.depthExceededPaths.length > 0) return false
	if (cache.danglingLinks.length > 0 || cache.recordedTargets.length === 0) return false
	let payload: string
	try {
		payload = realpathSync(join(repositoryRoot, "plugin"))
	} catch {
		return false
	}
	return cache.recordedTargets.every((target) => {
		try {
			return realpathSync(target) === payload
		} catch {
			return false
		}
	})
}

/**
 * Separate a cache proven orphaned from one the walk could not read.
 *
 * Restoration reads a snapshot under the linked checkout, and an orphan is the
 * case where that checkout is gone, so `RUN_RESTORE` would send a caller into
 * `RESTORATION_SNAPSHOT_MISSING`. Removing the cache root is the recovery that
 * actually applies.
 */
function orphanedCacheError(cache: OrphanedDevelopmentCache): ClaudeDevelopmentInstallationError {
	if (cache.unreadablePaths.length > 0) {
		return new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_CACHE_UNVERIFIABLE",
			`A development cache at ${cache.cacheRoot} could not be inspected: ${cache.unreadablePaths.length} path(s) were unreadable, so its state is unproven (${namePaths(cache.unreadablePaths)})`,
			{
				action: "INSPECT_STATE",
				errorFamily: "verification",
				retrySafety: "inspect_required",
				nextAction: `Inspect ${cache.cacheRoot} and its permissions, then rerun \`bun run dev -- claude check\`.`,
			},
		)
	}
	if (cache.depthExceededPaths.length > 0) {
		return new ClaudeDevelopmentInstallationError(
			"DEVELOPMENT_CACHE_UNVERIFIABLE",
			`A development cache at ${cache.cacheRoot} nests deeper than this inspection walks, so its state is unproven (${namePaths(cache.depthExceededPaths)})`,
			{
				action: "ESCALATE",
				errorFamily: "verification",
				retrySafety: "inspect_required",
				nextAction:
					"The cache layout changed. Raise the inspection depth in `scripts/claude-development-installation.ts` to match it.",
			},
		)
	}
	const parts = [
		...(cache.danglingLinks.length > 0 ? [`${cache.danglingLinks.length} dangling link(s)`] : []),
		...(cache.recordedTargets.length > 0
			? [`recorded payload target ${cache.recordedTargets[0]}`]
			: []),
	]
	const detail =
		parts.length > 0
			? parts.join(", ")
			: "the cache root stands while Claude lists no installation"
	return new ClaudeDevelopmentInstallationError(
		"DEVELOPMENT_CACHE_ORPHANED",
		`A development cache at ${cache.cacheRoot} outlived its registration (${detail}), and Claude no longer lists the installation`,
		{
			action: "FIX_INPUT",
			errorFamily: "state",
			nextAction: `Remove ${cache.cacheRoot}, then run \`bun run dev -- claude install\` from the checkout you want to develop.`,
		},
	)
}

/**
 * Own one Claude Code development-installation lifecycle behind the repository dev front door.
 */
export async function runClaudeDevelopmentInstallation(
	input: ClaudeDevelopmentInstallationInput,
): Promise<ClaudeDevelopmentInstallationResult> {
	const runner = input.runner ?? bunCommandRunner
	const state = prepare(input, runner)
	// `restore` owns snapshot recovery and `watch` only rebuilds, so both stay
	// reachable while a stale cache is present. `restore` also uninstalls with
	// `--keep-data`, so a cache this checkout still owns is its own residue and
	// must not lock the next install out of the profile.
	if (
		state.orphanedCache &&
		(input.operation === "check" || input.operation === "install") &&
		!servesThisCheckout(state.orphanedCache, input.repositoryRoot)
	) {
		throw orphanedCacheError(state.orphanedCache)
	}
	switch (input.operation) {
		case "check":
			// `install` refuses this state, so reporting it as ready would leave
			// check the only operation calling a mismatched link healthy.
			if (state.developmentPlugin && !state.linkedToCanonicalPayload) {
				throw new ClaudeDevelopmentInstallationError(
					"DEVELOPMENT_LINK_MISMATCH",
					"The development Plugin Installation is not linked to this checkout's canonical payload",
					{ action: "RUN_RESTORE", errorFamily: "conflict" },
				)
			}
			return result(input, state, {
				mode: "inspect",
				changed: false,
				transactionState: "ready",
				nextAction: state.developmentPlugin
					? "Run `bun run dev:claude`, then use `/reload-plugins` after builds."
					: "Run `bun run dev -- claude install` to preview persistent setup.",
			})
		case "install":
			return install(input, runner, state)
		case "restore":
			return restore(input, runner, state)
		case "watch":
			return runWatch(input, runner, state)
	}
}
