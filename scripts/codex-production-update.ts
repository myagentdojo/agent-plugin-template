import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"

import {
	assertReplacementAdmission,
	comparePayload,
	nativeHarnessEnvironment,
	regularFileInventory,
	type TaggedCheckout,
} from "./prove-harness-install"
import {
	assertExactHarnessRecovery,
	type HarnessRecoverySnapshot,
} from "./harness-install-recovery"
import { loadPluginConfig } from "./plugin-config"
import { payloadInventorySha256, pluginPayloadInventory } from "./plugin-files"

const STABLE_RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const FULL_COMMIT = /^[a-f0-9]{40}$/

type CommandPhase =
	| "local_inspection"
	| "remote_fetch"
	| "functional_proof"
	| "native_mutation"
	| "recovery"

const COMMAND_TIMEOUT_MS: Readonly<Record<CommandPhase, number>> = {
	local_inspection: 10_000,
	remote_fetch: 60_000,
	functional_proof: 120_000,
	native_mutation: 60_000,
	recovery: 60_000,
}

const COMMAND_PHASE_LABEL: Readonly<Record<CommandPhase, string>> = {
	local_inspection: "local inspection",
	remote_fetch: "remote discovery or fetch",
	functional_proof: "functional proof",
	native_mutation: "native mutation",
	recovery: "recovery",
}

interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

interface CodexMarketplaceList {
	marketplaces: Array<{
		name: string
		root: string
		marketplaceSource: { sourceType: string; source: string }
	}>
}

interface CodexInstalledPlugin {
	pluginId: string
	name: string
	marketplaceName: string
	version: string
	installed: boolean
	enabled: boolean
	source: { source: string; path: string }
	marketplaceSource: { sourceType: string; source: string }
	installPolicy: string
	authPolicy: string
}

interface CodexPluginList {
	installed: CodexInstalledPlugin[]
	available: unknown[]
}

interface CodexMarketplaceAddResult {
	marketplaceName: string
	installedRoot: string
	alreadyAdded: boolean
}

interface CodexPluginAddResult {
	pluginId: string
	name: string
	marketplaceName: string
	version: string
	installedPath: string
	authPolicy: string
}

interface MarketplaceInstallMetadata {
	source_type: string
	source: string
	ref_name: string
	sparse_paths: string[]
	revision: string
}

interface CurrentCodexState {
	pluginName: string
	pluginId: string
	marketplaceName: string
	source: string
	ref: string
	commit: string
	version: string
	installedPath: string
	marketplaceRoot: string
	enabled: boolean
	installPolicy: string
	authPolicy: string
	payloadHash: string
}

interface PreflightRelease extends TaggedCheckout {
	payloadHash: string
}

/** Input accepted by the one Codex production-update owner. */
export interface CodexProductionUpdateInput {
	/** Selected immutable tag or the `latest` Release selector. */
	target: string
	/** Explicit mutation authority. Preview remains the default. */
	apply: boolean
	/** Correlation identifier supplied by the CLI contract. */
	runId: string
	/** Template repository whose plugin identity selects the installation. */
	repositoryRoot: string
	/** Process environment containing the operator's existing Codex and Git lanes. */
	environment: Record<string, string | undefined>
}

/** One selected immutable Release bound to its peeled commit and manifest. */
export interface SelectedReleaseResult {
	/** Original user selector. */
	requested: string
	/** Stable immutable version tag selected once for the transaction. */
	tag: string
	/** Peeled commit behind either an annotated or lightweight tag. */
	commit: string
	/** Manifest version proven from the detached checkout. */
	manifestVersion: string
	/** SHA-256 over the admitted Plugin Payload inventory and bytes. */
	payloadHash: string
}

/** Captured Plugin Installation state that owns recovery after mutation. */
export interface PriorCodexUpdateResult {
	/** Configured Git source with URL credentials removed. */
	source: string
	/** Configured immutable Marketplace ref. */
	ref: string
	/** Commit verified across config, metadata, tag, and checkout. */
	commit: string
	/** Installed manifest version. */
	version: string
	/** Host-owned installed Plugin Payload path. */
	installedPath: string
	/** Host-reported Marketplace checkout root. */
	marketplaceRoot: string
	/** Prior enablement state. */
	enabled: boolean
	/** Native installation policy. */
	installPolicy: string
	/** Native authentication policy. */
	authPolicy: string
	/** SHA-256 over the installed payload inventory and bytes. */
	payloadHash: string
}

/** Successful machine result for preview, no-op, or applied update. */
export interface CodexProductionUpdateResult {
	/** Contract revision for additive consumer validation. */
	schemaVersion: 1
	/** Package-owned result vocabulary. */
	contractId: "plugin.production-update"
	/** Correlation identifier for one invocation. */
	runId: string
	/** Discriminator for successful results. */
	ok: true
	/** Whether the invocation previewed or applied the transaction. */
	mode: "preview" | "apply"
	/** Only supported production-update harness. */
	harness: "codex"
	/** Whether this invocation changed native state. */
	changed: boolean
	/** Whether selected and prior Releases differ. */
	wouldChange: boolean
	/** Stable completed state. */
	transactionState: "previewed" | "no_op" | "updated"
	/** Same-input retry judgment. */
	retrySafety: "safe"
	/** Selected target Release evidence. */
	selectedRelease: SelectedReleaseResult
	/** Exact prior state retained for recovery. */
	prior: PriorCodexUpdateResult
	/** Actual post-run state, equal to prior for preview and no-op. */
	resulting: PriorCodexUpdateResult
	/** Proof lineage kept separate from fresh-install qualification. */
	proof: {
		kind: "in_place_update"
		status: "target_preflight" | "installed_match"
		selectedRelease: string
		marketplaceRelease: string
		installationRelease: string
		functionalProofRelease: string
		lineageMatched: boolean
		freshInstall: "not_run"
	}
	/** Bounded completed side effects. */
	sideEffects: string[]
	/** One current safe continuation. */
	nextAction: string
}

/** Structured operational failure without raw command output or credentials. */
export class CodexProductionUpdateError extends Error {
	/** Stable failure family for scripts and agents. */
	readonly category: string
	/** Whether any native update state changed. */
	readonly changed: boolean
	/** Terminal transaction state. */
	readonly transactionState: "blocked" | "restored" | "unknown"
	/** Same-input retry judgment. */
	readonly retrySafety: "safe" | "unsafe" | "inspect_required"
	/** Bounded completed side effects. */
	readonly sideEffects: string[]
	/** One current safe continuation. */
	readonly nextAction: string
	/** Internal command phase whose bounded execution expired. */
	readonly timedOutPhase?: CommandPhase

	/**
	 * Create one redacted production-update failure.
	 *
	 * @param category - Stable machine failure family
	 * @param message - Safe human summary
	 * @param options - Transaction state and continuation evidence
	 *
	 * @example
	 * ```ts
	 * throw new CodexProductionUpdateError("current_state", "Plugin Installation missing")
	 * ```
	 */
	constructor(
		category: string,
		message: string,
		options: {
			changed?: boolean
			transactionState?: "blocked" | "restored" | "unknown"
			retrySafety?: "safe" | "unsafe" | "inspect_required"
			sideEffects?: string[]
			nextAction?: string
			timedOutPhase?: CommandPhase
		} = {},
	) {
		super(message)
		this.name = "CodexProductionUpdateError"
		this.category = category
		this.changed = options.changed ?? false
		this.transactionState = options.transactionState ?? "blocked"
		this.retrySafety = options.retrySafety ?? "safe"
		this.sideEffects = options.sideEffects ?? []
		this.nextAction = options.nextAction ?? "Inspect the current Codex Plugin Installation."
		this.timedOutPhase = options.timedOutPhase
	}
}

function command(
	commandArguments: string[],
	options: {
		cwd: string
		environment: Record<string, string | undefined>
		category: string
		label: string
		phase: CommandPhase
	},
): CommandResult {
	const timeout = COMMAND_TIMEOUT_MS[options.phase]
	const result = Bun.spawnSync({
		cmd: commandArguments,
		cwd: options.cwd,
		env: options.environment,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout,
	})
	const output = {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	}
	if (result.exitedDueToTimeout) {
		const diagnostic =
			options.phase === "recovery"
				? "exact restoration remains unverified"
				: options.phase === "native_mutation"
					? "recovery must verify the exact prior Release before retry"
					: "the command stopped before its phase completed"
		throw new CodexProductionUpdateError(
			options.category,
			`${options.label} timed out during ${COMMAND_PHASE_LABEL[options.phase]} after ${timeout / 1_000} seconds; ${diagnostic}`,
			{
				timedOutPhase: options.phase,
				retrySafety: options.phase === "recovery" ? "inspect_required" : "safe",
				nextAction:
					options.phase === "recovery"
						? "Inspect the same Codex Marketplace and Plugin Installation before retrying."
						: undefined,
			},
		)
	}
	if (output.exitCode !== 0) {
		throw new CodexProductionUpdateError(
			options.category,
			`${options.label} failed without changing the active Plugin Installation`,
		)
	}
	return output
}

function jsonCommand<T>(
	commandArguments: string[],
	options: Parameters<typeof command>[1],
): T {
	const result = command(commandArguments, options)
	try {
		return JSON.parse(result.stdout) as T
	} catch {
		throw new CodexProductionUpdateError(
			options.category,
			`${options.label} returned unreadable JSON`,
		)
	}
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodexProductionUpdateError("current_state", `${label} is missing or unreadable`)
	}
	return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new CodexProductionUpdateError("current_state", `${label} is missing or unreadable`)
	}
	return value
}

function safeSource(source: string): string {
	if (!/^https?:\/\//.test(source)) return source
	try {
		const parsed = new URL(source)
		parsed.username = ""
		parsed.password = ""
		return parsed.toString()
	} catch {
		return "[redacted invalid Git URL]"
	}
}

function canonicalPath(path: string): string {
	return realpathSync(path)
}

function pathOwnedBy(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate)
	return (
		relativePath.length > 0 &&
		relativePath !== ".." &&
		!relativePath.startsWith(`..${sep}`) &&
		!isAbsolute(relativePath)
	)
}

function readJson<T>(path: string, category: string, label: string): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T
	} catch {
		throw new CodexProductionUpdateError(category, `${label} is missing or unreadable`)
	}
}

function assertPayloadMatches(
	release: PreflightRelease,
	installedPath: string,
	category: string,
): string {
	try {
		const installedInventory = comparePayload(release, installedPath)
		return payloadInventorySha256(installedPath, installedInventory)
	} catch {
		throw new CodexProductionUpdateError(
			category,
			"installed Plugin Payload inventory or bytes differ from the selected Release",
		)
	}
}

function inspectCurrentState(
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
	commandPhase: CommandPhase = "local_inspection",
): CurrentCodexState {
	const codexExecutable = Bun.which("codex")
	if (!codexExecutable) {
		throw new CodexProductionUpdateError("current_state", "Codex CLI is not available")
	}
	const pluginName = loadPluginConfig(repositoryRoot).name
	const pluginId = `${pluginName}@${pluginName}`
	const marketplaceList = jsonCommand<CodexMarketplaceList>(
		[codexExecutable, "plugin", "marketplace", "list", "--json"],
		{
			cwd: repositoryRoot,
			environment,
			category: "current_state",
			label: "Codex Marketplace inspection",
			phase: commandPhase,
		},
	)
	const pluginList = jsonCommand<CodexPluginList>(
		[codexExecutable, "plugin", "list", "--json"],
		{
			cwd: repositoryRoot,
			environment,
			category: "current_state",
			label: "Codex Plugin Installation inspection",
			phase: commandPhase,
		},
	)
	const marketplace = marketplaceList.marketplaces.find((entry) => entry.name === pluginName)
	const plugin = pluginList.installed.find((entry) => entry.pluginId === pluginId)
	if (!marketplace || !plugin) {
		throw new CodexProductionUpdateError(
			"current_state",
			"The configured Codex Marketplace or Plugin Installation is missing",
		)
	}
	if (!plugin.installed || plugin.marketplaceName !== pluginName || plugin.name !== pluginName) {
		throw new CodexProductionUpdateError("current_state", "Codex reported ambiguous plugin identity")
	}
	const codeHome = environment.CODEX_HOME ?? join(homedir(), ".codex")
	const ownedCodeHome = canonicalPath(codeHome)
	const marketplaceRoot = canonicalPath(marketplace.root)
	if (!pathOwnedBy(ownedCodeHome, marketplaceRoot)) {
		throw new CodexProductionUpdateError(
			"mutation_blocked",
			"Marketplace state is outside the user-owned Codex home and cannot be replaced locally",
			{ nextAction: "Ask the workspace or managed-environment administrator to replace it." },
		)
	}
	const configPath = join(codeHome, "config.toml")
	let configDocument: Record<string, unknown>
	try {
		configDocument = objectValue(Bun.TOML.parse(readFileSync(configPath, "utf8")), "Codex config")
	} catch (error) {
		if (error instanceof CodexProductionUpdateError) throw error
		throw new CodexProductionUpdateError("current_state", "Codex config is missing or unreadable")
	}
	const marketplaceConfigs = objectValue(configDocument.marketplaces, "Codex Marketplace config")
	const pluginConfigs = objectValue(configDocument.plugins, "Codex Plugin config")
	const marketplaceConfig = objectValue(
		marketplaceConfigs[pluginName],
		"owned Codex Marketplace config",
	)
	const pluginConfig = objectValue(pluginConfigs[pluginId], "owned Codex Plugin config")
	const metadataPath = join(marketplace.root, ".codex-marketplace-install.json")
	const metadata = existsSync(metadataPath)
		? readJson<MarketplaceInstallMetadata>(
				metadataPath,
				"current_state",
				"Codex Marketplace install metadata",
			)
		: undefined
	const source = stringValue(marketplaceConfig.source, "configured Marketplace source")
	const ref = stringValue(marketplaceConfig.ref, "configured Marketplace ref")
	const configuredCommit =
		typeof marketplaceConfig.last_revision === "string"
			? marketplaceConfig.last_revision
			: undefined
	if (!STABLE_RELEASE_TAG.test(ref)) {
		throw new CodexProductionUpdateError(
			"current_state",
			"The active Marketplace is not pinned to an immutable stable Release tag",
		)
	}
	if (
		marketplace.marketplaceSource.sourceType !== "git" ||
		marketplaceConfig.source_type !== "git" ||
		(metadata !== undefined && metadata.source_type !== "git")
	) {
		throw new CodexProductionUpdateError(
			"current_state",
			"Only user-owned Git Marketplace installations can be updated",
		)
	}
	if (
		marketplace.marketplaceSource.source !== source ||
		plugin.marketplaceSource.source !== source ||
		(metadata !== undefined && metadata.source !== source)
	) {
		throw new CodexProductionUpdateError("current_state", "Marketplace source evidence disagrees")
	}
	if (metadata !== undefined && metadata.ref_name !== ref) {
		throw new CodexProductionUpdateError("current_state", "Marketplace ref evidence disagrees")
	}
	if (
		metadata !== undefined &&
		(!Array.isArray(metadata.sparse_paths) || metadata.sparse_paths.length > 0)
	) {
		throw new CodexProductionUpdateError(
			"current_state",
			"Sparse Marketplace installations need administrator replacement",
		)
	}
	const checkoutCommit = command(["git", "rev-parse", "HEAD"], {
		cwd: marketplace.root,
		environment,
		category: "current_state",
		label: "Marketplace checkout revision inspection",
		phase: commandPhase,
	}).stdout.trim()
	const peeledTagCommit = command(["git", "rev-parse", `refs/tags/${ref}^{commit}`], {
		cwd: marketplace.root,
		environment,
		category: "current_state",
		label: "Marketplace tag inspection",
		phase: commandPhase,
	}).stdout.trim()
	const capturedCommit = configuredCommit ?? metadata?.revision ?? checkoutCommit
	if (
		!FULL_COMMIT.test(capturedCommit) ||
		(configuredCommit !== undefined && configuredCommit !== checkoutCommit) ||
		(metadata !== undefined && metadata.revision !== checkoutCommit) ||
		checkoutCommit !== peeledTagCommit
	) {
		throw new CodexProductionUpdateError("current_state", "Marketplace commit evidence disagrees")
	}
	if (pluginConfig.enabled !== plugin.enabled) {
		throw new CodexProductionUpdateError("current_state", "Plugin enabled-state evidence disagrees")
	}
	if (!plugin.enabled) {
		throw new CodexProductionUpdateError(
			"mutation_blocked",
			"Codex cannot restore the disabled state through a supported CLI surface",
			{ nextAction: "Use an administrator-owned replacement path that preserves disabled state." },
		)
	}
	if (plugin.installPolicy !== "AVAILABLE" || plugin.authPolicy !== "ON_INSTALL") {
		throw new CodexProductionUpdateError(
			"current_state",
			"Plugin Installation policy does not permit the supported replacement path",
		)
	}
	if (canonicalPath(plugin.source.path) !== canonicalPath(join(marketplace.root, "plugin"))) {
		throw new CodexProductionUpdateError("current_state", "Plugin source path is ambiguous")
	}
	const installedPath = join(codeHome, "plugins", "cache", pluginName, pluginName, plugin.version)
	if (!existsSync(installedPath)) {
		throw new CodexProductionUpdateError("current_state", "Installed Plugin Payload path is missing")
	}
	const installedManifest = readJson<{ version?: unknown }>(
		join(installedPath, ".codex-plugin", "plugin.json"),
		"current_state",
		"installed Codex manifest",
	)
	if (installedManifest.version !== plugin.version) {
		throw new CodexProductionUpdateError("current_state", "Installed manifest version disagrees")
	}
	const installedRoot = canonicalPath(installedPath)
	if (!pathOwnedBy(ownedCodeHome, installedRoot)) {
		throw new CodexProductionUpdateError(
			"mutation_blocked",
			"Plugin Installation state is outside the user-owned Codex home and cannot be replaced locally",
			{ nextAction: "Ask the workspace or managed-environment administrator to replace it." },
		)
	}
	let payloadInventory: string[]
	try {
		payloadInventory = regularFileInventory(installedRoot)
	} catch {
		throw new CodexProductionUpdateError(
			"current_state",
			"Installed Plugin Payload inventory is unsafe or unreadable",
		)
	}
	return {
		pluginName,
		pluginId,
		marketplaceName: pluginName,
		source,
		ref,
		commit: capturedCommit,
		version: plugin.version,
		installedPath: installedRoot,
		marketplaceRoot,
		enabled: plugin.enabled,
		installPolicy: plugin.installPolicy,
		authPolicy: plugin.authPolicy,
		payloadHash: payloadInventorySha256(installedRoot, payloadInventory),
	}
}

function preflightRelease(
	source: string,
	tag: string,
	temporaryRoot: string,
	environment: Record<string, string | undefined>,
	pluginName: string,
	category: "release_preflight" | "restoration_preflight",
): PreflightRelease {
	if (!STABLE_RELEASE_TAG.test(tag)) {
		throw new CodexProductionUpdateError(category, "Target must be an immutable stable vX.Y.Z tag")
	}
	const checkoutRoot = join(temporaryRoot, category)
	command(["git", "init", "--quiet", checkoutRoot], {
		cwd: temporaryRoot,
		environment,
		category,
		label: "Detached Release checkout initialization",
		phase: "local_inspection",
	})
	command(["git", "remote", "add", "origin", source], {
		cwd: checkoutRoot,
		environment,
		category,
		label: "Release Git source configuration",
		phase: "local_inspection",
	})
	command(["git", "fetch", "--quiet", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`], {
		cwd: checkoutRoot,
		environment,
		category,
		label: "Immutable Release fetch",
		phase: "remote_fetch",
	})
	const resolvedSha = command(["git", "rev-parse", `refs/tags/${tag}^{commit}`], {
		cwd: checkoutRoot,
		environment,
		category,
		label: "Release tag peeling",
		phase: "local_inspection",
	}).stdout.trim()
	if (!FULL_COMMIT.test(resolvedSha)) {
		throw new CodexProductionUpdateError(category, "Release tag did not peel to one commit")
	}
	command(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", resolvedSha], {
		cwd: checkoutRoot,
		environment,
		category,
		label: "Detached Release checkout",
		phase: "local_inspection",
	})
	const codexManifest = readJson<{ name?: unknown; version?: unknown }>(
		join(checkoutRoot, "plugin", ".codex-plugin", "plugin.json"),
		category,
		"Codex Release manifest",
	)
	const claudeManifest = readJson<{ name?: unknown; version?: unknown; defaultEnabled?: unknown }>(
		join(checkoutRoot, "plugin", ".claude-plugin", "plugin.json"),
		category,
		"Claude Release manifest",
	)
	if (
		codexManifest.name !== pluginName ||
		claudeManifest.name !== pluginName ||
		typeof codexManifest.version !== "string" ||
		codexManifest.version !== claudeManifest.version ||
		tag !== `v${codexManifest.version}` ||
		claudeManifest.defaultEnabled !== false
	) {
		throw new CodexProductionUpdateError(category, "Release tag and manifest identity disagree")
	}
	const marketplace = readJson<{
		name?: unknown
		plugins?: Array<{
			name?: unknown
			source?: { source?: unknown; path?: unknown }
			policy?: { installation?: unknown; authentication?: unknown }
		}>
	}>(
		join(checkoutRoot, ".agents", "plugins", "marketplace.json"),
		category,
		"Codex Marketplace policy",
	)
	const marketplacePlugin = marketplace.plugins?.[0]
	if (
		marketplace.name !== pluginName ||
		marketplacePlugin?.name !== pluginName ||
		marketplacePlugin.source?.source !== "local" ||
		marketplacePlugin.source.path !== "./plugin" ||
		marketplacePlugin.policy?.installation !== "AVAILABLE" ||
		marketplacePlugin.policy.authentication !== "ON_INSTALL"
	) {
		throw new CodexProductionUpdateError(category, "Release Marketplace policy is not admissible")
	}
	let inventory: string[]
	try {
		inventory = pluginPayloadInventory(checkoutRoot)
	} catch (error) {
		if (error instanceof CodexProductionUpdateError) throw error
		throw new CodexProductionUpdateError(
			category,
			"Release Plugin Payload inventory failed safety admission",
		)
	}
	return {
		requestedRef: tag,
		resolvedSha,
		checkoutRoot,
		manifestVersion: codexManifest.version,
		inventory,
		payloadHash: payloadInventorySha256(join(checkoutRoot, "plugin"), inventory),
	}
}

function assertTagStillBound(
	source: string,
	release: PreflightRelease,
	temporaryRoot: string,
	environment: Record<string, string | undefined>,
): void {
	const verificationRoot = join(temporaryRoot, "tag-binding")
	command(["git", "init", "--quiet", verificationRoot], {
		cwd: temporaryRoot,
		environment,
		category: "release_preflight",
		label: "Release binding verification initialization",
		phase: "local_inspection",
	})
	command(["git", "remote", "add", "origin", source], {
		cwd: verificationRoot,
		environment,
		category: "release_preflight",
		label: "Release binding source configuration",
		phase: "local_inspection",
	})
	command(
		["git", "fetch", "--quiet", "--no-tags", "origin", `refs/tags/${release.requestedRef}:refs/tags/${release.requestedRef}`],
		{
			cwd: verificationRoot,
			environment,
			category: "release_preflight",
			label: "Release binding verification fetch",
			phase: "remote_fetch",
		},
	)
	const currentCommit = command(
		["git", "rev-parse", `refs/tags/${release.requestedRef}^{commit}`],
		{
			cwd: verificationRoot,
			environment,
			category: "release_preflight",
			label: "Release binding verification peel",
			phase: "local_inspection",
		},
	).stdout.trim()
	if (currentCommit !== release.resolvedSha) {
		throw new CodexProductionUpdateError(
			"release_preflight",
			"Selected Release tag moved between discovery and preflight",
		)
	}
}

function runSelectedReleaseFunctionalProof(
	release: PreflightRelease,
	environment: Record<string, string | undefined>,
): void {
	const proofPath = join(release.checkoutRoot, "runtime", "src", "portable-command.test.ts")
	if (!existsSync(proofPath)) {
		throw new CodexProductionUpdateError(
			"release_lineage",
			"Selected Release does not contain its focused functional proof",
		)
	}
	const manifest = readJson<{ version?: unknown }>(
		join(release.checkoutRoot, "plugin", ".codex-plugin", "plugin.json"),
		"release_lineage",
		"selected Release proof manifest",
	)
	if (
		manifest.version !== release.manifestVersion ||
		release.requestedRef !== `v${release.manifestVersion}`
	) {
		throw new CodexProductionUpdateError(
			"release_lineage",
			"Functional proof Release differs from the selected Marketplace Release",
		)
	}
	command([process.execPath, "test", "runtime/src/portable-command.test.ts"], {
		cwd: release.checkoutRoot,
		environment: {
			...nativeHarnessEnvironment(environment),
			CI: "1",
			NO_COLOR: "1",
		},
		category: "release_lineage",
		label: "Selected Release functional proof",
		phase: "functional_proof",
	})
}

function runMatchedInstalledFunctionalProof(
	release: PreflightRelease,
	installed: CurrentCodexState,
	environment: Record<string, string | undefined>,
): void {
	if (
		installed.ref !== release.requestedRef ||
		installed.commit !== release.resolvedSha ||
		installed.version !== release.manifestVersion ||
		installed.payloadHash !== release.payloadHash
	) {
		throw new CodexProductionUpdateError(
			"release_lineage",
			"Selected Marketplace, Plugin Installation, and functional proof Releases differ",
		)
	}
	runSelectedReleaseFunctionalProof(release, environment)
}

function selectedReleaseResult(requested: string, release: PreflightRelease): SelectedReleaseResult {
	return {
		requested,
		tag: release.requestedRef,
		commit: release.resolvedSha,
		manifestVersion: release.manifestVersion,
		payloadHash: release.payloadHash,
	}
}

function priorResult(current: CurrentCodexState): PriorCodexUpdateResult {
	return {
		source: safeSource(current.source),
		ref: current.ref,
		commit: current.commit,
		version: current.version,
		installedPath: current.installedPath,
		marketplaceRoot: current.marketplaceRoot,
		enabled: current.enabled,
		installPolicy: current.installPolicy,
		authPolicy: current.authPolicy,
		payloadHash: current.payloadHash,
	}
}

function recoverySnapshot(current: CurrentCodexState): HarnessRecoverySnapshot {
	return {
		source: current.source,
		ref: current.ref,
		commit: current.commit,
		version: current.version,
		installedPath: current.installedPath,
		marketplaceRoot: current.marketplaceRoot,
		payloadInventory: regularFileInventory(current.installedPath),
		payloadHash: current.payloadHash,
		enabled: current.enabled,
		installPolicy: current.installPolicy,
		authPolicy: current.authPolicy,
	}
}

function sameCapturedState(left: CurrentCodexState, right: CurrentCodexState): boolean {
	return (
		left.pluginId === right.pluginId &&
		left.source === right.source &&
		left.ref === right.ref &&
		left.commit === right.commit &&
		left.version === right.version &&
		left.installedPath === right.installedPath &&
		left.marketplaceRoot === right.marketplaceRoot &&
		left.enabled === right.enabled &&
		left.installPolicy === right.installPolicy &&
		left.authPolicy === right.authPolicy &&
		left.payloadHash === right.payloadHash
	)
}

function nativeJson<T>(
	codexExecutable: string,
	arguments_: string[],
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
	label: string,
	phase: "native_mutation" | "recovery" = "native_mutation",
): T {
	return jsonCommand<T>([codexExecutable, ...arguments_], {
		cwd: repositoryRoot,
		environment,
		category: phase === "recovery" ? "recovery" : "native_mutation",
		label,
		phase,
	})
}

function bestEffortNativeJson(
	codexExecutable: string,
	arguments_: string[],
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
): void {
	try {
		command([codexExecutable, ...arguments_], {
			cwd: repositoryRoot,
			environment,
			category: "recovery",
			label: "Recovery cleanup",
			phase: "recovery",
		})
	} catch {
		// Cleanup is opportunistic. Exact restoration and verification below remain authoritative.
	}
}

function verifyReleaseState(
	state: CurrentCodexState,
	release: PreflightRelease,
	expectedSource: string,
	expectedEnabled: boolean,
	installedPath: string,
): void {
	if (
		state.source !== expectedSource ||
		state.ref !== release.requestedRef ||
		state.commit !== release.resolvedSha ||
		state.version !== release.manifestVersion ||
		state.enabled !== expectedEnabled ||
		state.installPolicy !== "AVAILABLE" ||
		state.authPolicy !== "ON_INSTALL" ||
		state.installedPath !== canonicalPath(installedPath)
	) {
		throw new CodexProductionUpdateError(
			"postcondition",
			"Codex post-install identity or policy differs from the selected Release",
		)
	}
	const installedHash = assertPayloadMatches(release, state.installedPath, "postcondition")
	if (installedHash !== release.payloadHash || state.payloadHash !== release.payloadHash) {
		throw new CodexProductionUpdateError(
			"postcondition",
			"Installed Plugin Payload bytes differ from the selected Release",
		)
	}
}

function verifySelectedMarketplace(
	codexExecutable: string,
	current: CurrentCodexState,
	target: PreflightRelease,
	addResult: CodexMarketplaceAddResult,
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
): void {
	const marketplaceList = nativeJson<CodexMarketplaceList>(
		codexExecutable,
		["plugin", "marketplace", "list", "--json"],
		repositoryRoot,
		environment,
		"Target Marketplace inspection",
	)
	const marketplace = marketplaceList.marketplaces.find(
		(entry) => entry.name === current.marketplaceName,
	)
	if (
		!marketplace ||
		addResult.marketplaceName !== current.marketplaceName ||
		marketplace.marketplaceSource.sourceType !== "git" ||
		marketplace.marketplaceSource.source !== current.source ||
		canonicalPath(marketplace.root) !== canonicalPath(addResult.installedRoot)
	) {
		throw new CodexProductionUpdateError(
			"postcondition",
			"Target Marketplace identity or source differs before Plugin Installation",
		)
	}
	const codeHome = environment.CODEX_HOME ?? join(homedir(), ".codex")
	let configDocument: Record<string, unknown>
	try {
		configDocument = objectValue(
			Bun.TOML.parse(readFileSync(join(codeHome, "config.toml"), "utf8")),
			"Codex config",
		)
	} catch (error) {
		if (error instanceof CodexProductionUpdateError) throw error
		throw new CodexProductionUpdateError("postcondition", "Target Codex config is unreadable")
	}
	const marketplaceConfigs = objectValue(configDocument.marketplaces, "Codex Marketplace config")
	const marketplaceConfig = objectValue(
		marketplaceConfigs[current.marketplaceName],
		"target Marketplace config",
	)
	if (
		marketplaceConfig.source !== current.source ||
		marketplaceConfig.ref !== target.requestedRef
	) {
		throw new CodexProductionUpdateError(
			"postcondition",
			"Configured Marketplace source or ref differs from the selected Release",
		)
	}
	const checkoutCommit = command(["git", "rev-parse", "HEAD"], {
		cwd: marketplace.root,
		environment,
		category: "postcondition",
		label: "Target Marketplace checkout inspection",
		phase: "local_inspection",
	}).stdout.trim()
	const tagCommit = command(
		["git", "rev-parse", `refs/tags/${target.requestedRef}^{commit}`],
		{
			cwd: marketplace.root,
			environment,
			category: "postcondition",
			label: "Target Marketplace tag inspection",
			phase: "local_inspection",
		},
	).stdout.trim()
	const exactTag = command(["git", "describe", "--tags", "--exact-match", "HEAD"], {
		cwd: marketplace.root,
		environment,
		category: "postcondition",
		label: "Target Marketplace exact-tag inspection",
		phase: "local_inspection",
	}).stdout.trim()
	if (
		checkoutCommit !== target.resolvedSha ||
		tagCommit !== target.resolvedSha ||
		exactTag !== target.requestedRef
	) {
		throw new CodexProductionUpdateError(
			"postcondition",
			"Marketplace checkout tag or commit differs from the selected Release",
		)
	}
}

function restorePriorRelease(
	current: CurrentCodexState,
	restoration: PreflightRelease,
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
): CurrentCodexState {
	const codexExecutable = Bun.which("codex")
	if (!codexExecutable) {
		throw new CodexProductionUpdateError("recovery", "Codex CLI disappeared during recovery")
	}
	bestEffortNativeJson(
		codexExecutable,
		["plugin", "remove", current.pluginId, "--json"],
		repositoryRoot,
		environment,
	)
	bestEffortNativeJson(
		codexExecutable,
		["plugin", "marketplace", "remove", current.marketplaceName, "--json"],
		repositoryRoot,
		environment,
	)
	nativeJson<CodexMarketplaceAddResult>(
		codexExecutable,
		["plugin", "marketplace", "add", current.source, "--ref", current.ref, "--json"],
		repositoryRoot,
		environment,
		"Prior Marketplace restoration",
		"recovery",
	)
	const addResult = nativeJson<CodexPluginAddResult>(
		codexExecutable,
		["plugin", "add", current.pluginId, "--json"],
		repositoryRoot,
		environment,
		"Prior Plugin Installation restoration",
		"recovery",
	)
	const restored = inspectCurrentState(repositoryRoot, environment, "recovery")
	verifyReleaseState(restored, restoration, current.source, current.enabled, addResult.installedPath)
	try {
		assertExactHarnessRecovery(recoverySnapshot(current), recoverySnapshot(restored), "Codex")
	} catch {
		throw new CodexProductionUpdateError(
			"recovery",
			"Restored Plugin Installation differs from the captured prior state",
		)
	}
	return restored
}

function githubRepositoryFromSource(source: string): string | undefined {
	const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
		source,
	)
	if (ssh) return `${ssh[1]}/${ssh[2]}`
	try {
		const parsed = new URL(source)
		if (parsed.hostname !== "github.com") return undefined
		const segments = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/")
		if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))) {
			return undefined
		}
		return `${segments[0]}/${segments[1]}`
	} catch {
		return undefined
	}
}

function compareStableTags(left: string, right: string): number {
	const leftParts = left.slice(1).split(".").map(Number)
	const rightParts = right.slice(1).split(".").map(Number)
	for (let index = 0; index < 3; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
		if (difference !== 0) return difference
	}
	return 0
}

function resolveLatestStableRelease(
	source: string,
	repositoryRoot: string,
	environment: Record<string, string | undefined>,
): string {
	const repository = githubRepositoryFromSource(source)
	if (!repository) {
		throw new CodexProductionUpdateError(
			"release_selection",
			"Latest selection requires a GitHub Marketplace source",
			{ nextAction: "Retry with one explicit immutable vX.Y.Z tag." },
		)
	}
	const ghExecutable = Bun.which("gh")
	if (!ghExecutable) {
		throw new CodexProductionUpdateError(
			"release_selection",
			"Latest selection requires authenticated or public GitHub Release discovery",
			{ nextAction: "Configure GitHub CLI read access or retry with an explicit immutable tag." },
		)
	}
	const response = jsonCommand<unknown>(
		[
			ghExecutable,
			"api",
			"--paginate",
			"--slurp",
			`repos/${repository}/releases?per_page=100`,
		],
		{
			cwd: repositoryRoot,
			environment,
			category: "release_selection",
			label: "GitHub Release discovery",
			phase: "remote_fetch",
		},
	)
	const pages = Array.isArray(response) ? response : []
	const releases = pages.flatMap((page) => (Array.isArray(page) ? page : [page]))
	const stableTags = releases.flatMap((release) => {
		if (typeof release !== "object" || release === null || Array.isArray(release)) return []
		const candidate = release as Record<string, unknown>
		return candidate.draft === false &&
			candidate.prerelease === false &&
			typeof candidate.tag_name === "string" &&
			STABLE_RELEASE_TAG.test(candidate.tag_name)
			? [candidate.tag_name]
			: []
	})
	stableTags.sort(compareStableTags).reverse()
	const selected = stableTags[0]
	if (!selected) {
		throw new CodexProductionUpdateError(
			"release_selection",
			"GitHub reported no stable immutable Release",
			{ nextAction: "Publish a stable vX.Y.Z GitHub Release, then rerun preview." },
		)
	}
	return selected
}

/**
 * Preview or apply one release-bound Codex Marketplace replacement.
 *
 * @param input - Correlated selector, authority, repository, and process environment
 * @returns Stable machine result after independent release and installation checks
 * @throws {CodexProductionUpdateError} When any identity, policy, byte, or transaction check fails
 *
 * @example
 * ```ts
 * const result = runCodexProductionUpdate({
 *   target: "v1.2.3",
 *   apply: false,
 *   runId: crypto.randomUUID(),
 *   repositoryRoot: process.cwd(),
 *   environment: process.env,
 * })
 * ```
 */
export function runCodexProductionUpdate(
	input: CodexProductionUpdateInput,
): CodexProductionUpdateResult {
	const current = inspectCurrentState(input.repositoryRoot, input.environment)
	const targetTag =
		input.target === "latest"
			? resolveLatestStableRelease(current.source, input.repositoryRoot, input.environment)
			: input.target
	const completedSideEffects = ["read Codex Marketplace and Plugin Installation state"]
	const temporaryRoot = mkdtempSync(join(tmpdir(), "plugin-production-update-"))
	try {
		const target = preflightRelease(
			current.source,
			targetTag,
			temporaryRoot,
			input.environment,
			current.pluginName,
			"release_preflight",
		)
		completedSideEffects.push(
			"fetch and admit the target Release in a temporary detached checkout",
		)
		const restoration = preflightRelease(
			current.source,
			current.ref,
			temporaryRoot,
			input.environment,
			current.pluginName,
			"restoration_preflight",
		)
		completedSideEffects.push(
			"fetch and admit the restoration Release in a temporary detached checkout",
		)
		assertReplacementAdmission({
			target,
			restoration,
			allowedRefs: [target.requestedRef, restoration.requestedRef],
			managed: false,
			removable: true,
		})
		const installedPayloadHash = assertPayloadMatches(
			restoration,
			current.installedPath,
			"restoration_preflight",
		)
		if (installedPayloadHash !== current.payloadHash) {
			throw new CodexProductionUpdateError(
				"restoration_preflight",
				"Captured installed Plugin Payload changed during preflight",
			)
		}
		runSelectedReleaseFunctionalProof(target, input.environment)
		completedSideEffects.push("run functional proof from the selected Release checkout")
		assertTagStillBound(current.source, target, temporaryRoot, input.environment)
		const wouldChange = current.ref !== target.requestedRef || current.commit !== target.resolvedSha
		if (input.apply && !wouldChange) {
			return {
				schemaVersion: 1,
				contractId: "plugin.production-update",
				runId: input.runId,
				ok: true,
				mode: "apply",
				harness: "codex",
				changed: false,
				wouldChange: false,
				transactionState: "no_op",
				retrySafety: "safe",
				selectedRelease: selectedReleaseResult(input.target, target),
				prior: priorResult(current),
				resulting: priorResult(current),
		proof: {
					kind: "in_place_update",
					status: "installed_match",
					selectedRelease: target.requestedRef,
					marketplaceRelease: current.ref,
					installationRelease: `v${current.version}`,
					functionalProofRelease: target.requestedRef,
					lineageMatched: true,
					freshInstall: "not_run",
				},
				sideEffects: [...completedSideEffects],
				nextAction: "No update is required; the configured Release is already selected.",
			}
			}
			if (input.apply) {
				const revalidated = inspectCurrentState(input.repositoryRoot, input.environment)
				if (!sameCapturedState(current, revalidated)) {
					throw new CodexProductionUpdateError(
						"mutation_blocked",
						"Codex state changed after preview preflight; rerun preview against current state",
					)
				}
				const codexExecutable = Bun.which("codex")
				if (!codexExecutable) {
					throw new CodexProductionUpdateError(
						"mutation_blocked",
						"Codex CLI disappeared before mutation",
					)
				}
			const mutationSideEffects = [...completedSideEffects]
				try {
					nativeJson<unknown>(
						codexExecutable,
						["plugin", "remove", current.pluginId, "--json"],
						input.repositoryRoot,
						input.environment,
						"Prior Plugin Installation removal",
					)
					mutationSideEffects.push("removed the prior Plugin Installation")
					nativeJson<unknown>(
						codexExecutable,
						["plugin", "marketplace", "remove", current.marketplaceName, "--json"],
						input.repositoryRoot,
						input.environment,
						"Prior Marketplace removal",
					)
					mutationSideEffects.push("removed the prior Marketplace")
					const marketplaceAdd = nativeJson<CodexMarketplaceAddResult>(
						codexExecutable,
						[
							"plugin",
							"marketplace",
							"add",
							current.source,
							"--ref",
							target.requestedRef,
							"--json",
						],
						input.repositoryRoot,
						input.environment,
						"Target Marketplace add",
					)
					mutationSideEffects.push("added the Marketplace pinned to the selected Release")
					verifySelectedMarketplace(
						codexExecutable,
						current,
						target,
						marketplaceAdd,
						input.repositoryRoot,
						input.environment,
					)
					mutationSideEffects.push("verified the selected Marketplace before installation")
					const pluginAdd = nativeJson<CodexPluginAddResult>(
						codexExecutable,
						["plugin", "add", current.pluginId, "--json"],
						input.repositoryRoot,
						input.environment,
						"Target Plugin Installation add",
					)
					if (
						pluginAdd.pluginId !== current.pluginId ||
						pluginAdd.marketplaceName !== current.marketplaceName ||
						pluginAdd.version !== target.manifestVersion
					) {
						throw new CodexProductionUpdateError(
							"postcondition",
							"Codex add result differs from the selected Release",
						)
					}
					mutationSideEffects.push("installed the selected Plugin Payload")
					const resulting = inspectCurrentState(input.repositoryRoot, input.environment)
					verifyReleaseState(
						resulting,
						target,
						current.source,
						current.enabled,
						pluginAdd.installedPath,
					)
					mutationSideEffects.push(
						"verified Release lineage, policy, path, and payload bytes",
					)
					runMatchedInstalledFunctionalProof(target, resulting, input.environment)
					mutationSideEffects.push(
						"ran matched in-place functional proof from the selected Release checkout",
					)
					return {
						schemaVersion: 1,
						contractId: "plugin.production-update",
						runId: input.runId,
						ok: true,
						mode: "apply",
						harness: "codex",
						changed: true,
						wouldChange: true,
						transactionState: "updated",
						retrySafety: "safe",
						selectedRelease: selectedReleaseResult(input.target, target),
						prior: priorResult(current),
						resulting: priorResult(resulting),
						proof: {
							kind: "in_place_update",
							status: "installed_match",
							selectedRelease: target.requestedRef,
							marketplaceRelease: resulting.ref,
							installationRelease: `v${resulting.version}`,
							functionalProofRelease: target.requestedRef,
							lineageMatched: true,
							freshInstall: "not_run",
						},
						sideEffects: mutationSideEffects,
						nextAction: "Start a fresh Codex task and exercise the selected Plugin Release.",
					}
				} catch (mutationError) {
					try {
						restorePriorRelease(
							current,
							restoration,
							input.repositoryRoot,
							input.environment,
						)
						throw new CodexProductionUpdateError(
							"mutation_failed_restored",
							mutationError instanceof CodexProductionUpdateError &&
								mutationError.timedOutPhase === "native_mutation"
								? "Target update timed out during native mutation; the exact prior Release was restored and verified"
								: "Target update failed; the exact prior Release was restored and verified",
							{
								changed: true,
								transactionState: "restored",
								retrySafety: "safe",
								sideEffects: [
									...mutationSideEffects,
									"restored and verified the exact prior Release",
								],
								nextAction: `Rerun the preview for ${target.requestedRef} before another apply.`,
							},
						)
					} catch (recoveryError) {
						if (
							recoveryError instanceof CodexProductionUpdateError &&
							recoveryError.category === "mutation_failed_restored"
						) {
							throw recoveryError
						}
						throw new CodexProductionUpdateError(
							"mutation_state_unknown",
							recoveryError instanceof CodexProductionUpdateError &&
								recoveryError.timedOutPhase === "recovery"
								? "Recovery timed out; target update and exact restoration could not be verified; automatic retry stopped"
								: "Target update and exact restoration could not be verified; automatic retry stopped",
							{
								changed: true,
								transactionState: "unknown",
								retrySafety: "inspect_required",
								sideEffects: mutationSideEffects,
								nextAction: "Inspect the same Codex Marketplace and Plugin Installation before retrying.",
							},
						)
					}
				}
			}
		return {
			schemaVersion: 1,
			contractId: "plugin.production-update",
			runId: input.runId,
			ok: true,
			mode: "preview",
			harness: "codex",
			changed: false,
			wouldChange,
			transactionState: "previewed",
			retrySafety: "safe",
			selectedRelease: selectedReleaseResult(input.target, target),
			prior: priorResult(current),
			resulting: priorResult(current),
			proof: {
				kind: "in_place_update",
				status: wouldChange ? "target_preflight" : "installed_match",
				selectedRelease: target.requestedRef,
				marketplaceRelease: current.ref,
				installationRelease: `v${current.version}`,
				functionalProofRelease: target.requestedRef,
				lineageMatched: !wouldChange,
				freshInstall: "not_run",
			},
			sideEffects: [...completedSideEffects],
			nextAction: wouldChange
				? `bun run update -- --harness codex --target ${target.requestedRef} --apply`
				: "No update is required; the configured Release is already selected.",
		}
	} catch (error) {
		if (error instanceof CodexProductionUpdateError && error.sideEffects.length === 0) {
			throw new CodexProductionUpdateError(error.category, error.message, {
				changed: error.changed,
				transactionState: error.transactionState,
				retrySafety: error.retrySafety,
				sideEffects: [...completedSideEffects],
				nextAction: error.nextAction,
				timedOutPhase: error.timedOutPhase,
			})
		}
		throw error
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
}
