import { createHash, randomUUID } from "node:crypto"
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

import {
	assertCodexReportedVersion,
	proveCodexFixtureCopy as runCodexFixtureCopy,
	proveCodexNative as runCodexNative,
} from "./harness-install-codex"
import {
	provePostMutationRecovery,
} from "./harness-install-recovery"
import { copyPluginPayload, payloadInventorySha256, pluginPayloadInventory } from "./plugin-files"
import {
	CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY,
	hookDeclarationBody,
	loadPluginConfig,
	type PluginConfig,
	writeGeneratedFiles,
} from "./plugin-config"
import { requireProofControlEnvelope } from "./proof-control-envelope"
import { currentRuntimeTarget } from "./prove-runtime-platform"

const help = `Prove tagged plugin installation in isolated Claude and Codex homes.

Usage:
  bun run prove:harness-install [--require-native --fixture-acknowledged | --allow-fixture-copy] [--json]
  bun run prove:harness-install --help

Options:
  --json       Emit the proof report as JSON. This is also the default output.
  --require-native  Explicitly require both native CLIs (the default).
  --fixture-acknowledged  Allow isolated repair mutation in native qualification. Never claims human approval.
  --allow-fixture-copy  Development-only byte proof when native CLIs are unavailable.
  -h, --help   Show this help.

Safety:
  Creates only temporary Git fixtures and isolated harness homes.
  Never reads or writes the operator's Claude or Codex plugin state.
`

type HarnessMode = "native-local-marketplace" | "native-hosted-marketplace" | "fixture-copy"
type ClaudeScope = "user" | "project" | "local"

export interface TaggedCheckout {
	requestedRef: string
	resolvedSha: string
	checkoutRoot: string
	manifestVersion: string
	inventory: string[]
}

export interface FixtureRelease {
	repositoryRoot: string
	base: TaggedCheckout
	target: TaggedCheckout
}

interface HarnessSkip {
	case: string
	reason: string
}

interface CommandResult {
	exitCode: number
	stdout: string
	stderr: string
}

interface TransportInput {
	source: string
	transport: "local" | "ssh" | "https"
	hostKeyAccepted?: boolean
	agentKeyLoaded?: boolean
	credentialHelperConfigured?: boolean
	tokenEnvironmentOnly?: boolean
}

export interface ReplacementAdmissionInput {
	target: TaggedCheckout
	restoration: TaggedCheckout
	allowedRefs: string[]
	managed: boolean
	removable: boolean
}

interface ClaudeInstall {
	version: string
	scope: ClaudeScope
	enabled: boolean
	activeCachePath: string
}

interface ClaudeInstalledJson {
	id: string
	version: string
	scope: ClaudeScope
	enabled: boolean
	installPath: string
}

interface ClaudeScopeProof {
	scope: ClaudeScope
	initialVersion: string
	initialEnabled: boolean
	upgradedVersion: string
	rolledBackVersion: string
	enabledAfterReview: boolean
	dataMarkerPreserved: boolean
	failureRestored: boolean
	orphanedCacheIgnored: boolean
	activeCachePath: string
}

interface ClaudeProof {
	mode: HarnessMode
	version: string
	scope: ClaudeScope
	enabled: boolean
	activeCachePath: string
	inventory: string[]
	requestedRef: string
	resolvedSha: string
	defaultEnabled: false
	compatibility: typeof CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY
	scopes: ClaudeScopeProof[]
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

interface CodexMarketplaceAddJson {
	marketplaceName: string
	installedRoot: string
	alreadyAdded: boolean
}

interface CodexPluginAddJson {
	pluginId: string
	name: string
	marketplaceName: string
	version: string
	installedPath: string
	authPolicy: string
}

interface CodexMarketplaceListJson {
	marketplaces: Array<{
		name: string
		root: string
		marketplaceSource: { sourceType: string; source: string }
	}>
}

interface CodexPluginListJson {
	installed: CodexInstalledPlugin[]
	available: unknown[]
}

export interface CodexInstallState {
	marketplaceAdd: CodexMarketplaceAddJson
	add: CodexPluginAddJson
	marketplace: CodexMarketplaceListJson
	list: CodexPluginListJson
	plugin: CodexInstalledPlugin
}

export interface CodexProof {
	mode: HarnessMode
	version: string
	installedPath: string
	inventory: string[]
	requestedRef: string
	resolvedSha: string
	marketplaceIdentity: string
	configuredSource: string
	configuredRef: string
	installedMarketplaceRoot: string
	enabled: boolean
	installPolicy: string
	authPolicy: string
	marketplaceCacheVersion: "local"
	jsonEvidence: {
		marketplaceAdd: CodexMarketplaceAddJson
		marketplaceList: CodexMarketplaceListJson
		pluginAdd: CodexPluginAddJson
		pluginList: CodexPluginListJson
	} | null
	localRefresh: {
		initialInstalledPath?: string
		upgradedInstalledPath?: string
		initialInventory?: string[]
		upgradedInventory?: string[]
		bytesChanged: boolean
		rolledBack: boolean
		enabledStateRestored: boolean
		failureRestored: boolean
	}
	installedState: {
		pluginEnabled: boolean
		executionEntry: "explicit skill launcher"
		runtimeRepairOwner: "agent workflow with human approval"
	} | null
}

export interface InstalledCapabilityEvidence {
	candidateCommit: string
	candidatePayloadHash: string
	installedPayloadHash: string
	declarationHealth: "healthy"
	directHandlerHealth: "healthy"
	fixtureState: "matched"
	currentSessionHook: "unknown" | "proved"
	nativeActivation: "not-proved" | "proved"
	externalCandidateQualification: "unknown" | "proved"
	nativeDelegation: "not-proved" | "proved"
	nativeQualification:
		| { status: "not-proved"; receipt: null }
		| { status: "proved"; receipt: NativeQualificationEvidence }
		| { status: "failed"; receipt: NativeQualificationEvidence }
	portableSkillsWithoutHooks: ["hello-world", "skill-a", "skill-b", "runtime-custody", "capability-tour"]
}

/** Hash-only conclusions that may be promoted from a private fresh-client receipt. */
export interface NativeQualificationEvidence {
	schema: "native-capability-qualification-v1"
	client: "claude" | "codex"
	platform: "macos" | "linux"
	receiptSha256: string
	sourceCandidateSha: string
	archiveSha256: string
	packagedPayloadHash: string
	installedPayloadHash: string
	derivedPayloadHash: string
	conclusions: {
		discovery: "proved" | "failed"
		uiIdentity: "proved" | "failed"
		skillSeededNativeDelegation: "proved" | "failed"
		hostOwnedLifecycleEvidence: "proved" | "failed"
		sessionStart: "proved" | "failed"
		cleanStop: "silent" | "failed"
		driftContinuation: "proved" | "failed"
		reentry: "silent" | "failed"
		hooksFallback: "proved" | "failed"
		exactDefinitionTrust: "proved" | "failed" | "not-applicable"
	}
	evidence: {
		discoverySha256: string
		uiIdentitySha256: string
		delegationLifecycleSha256: string
		sessionStartSha256: string
		cleanStopSha256: string
		driftSha256: string
		reentrySha256: string
		hooksFallbackSha256: string
		exactDefinitionTrustSha256?: string
	}
}

export interface NativeQualificationBinding {
	client: "claude" | "codex"
	sourceCommit: string
	archiveSha256: string
	packagedPayloadHash: string
	installedPayloadHash: string
}

export interface NativeQualificationPromotion {
	summary: unknown
	lineage: Omit<NativeQualificationBinding, "client">
}

function qualificationRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("native qualification promotion accepts only bounded summary and evidence hashes")
	}
	return value as Record<string, unknown>
}

function requireQualificationKeys(value: unknown, expected: string[]): Record<string, unknown> {
	const record = qualificationRecord(value)
	if (Object.keys(record).sort().join("\0") !== [...expected].sort().join("\0")) {
		throw new Error("native qualification promotion accepts only bounded summary and evidence hashes")
	}
	return record
}

function qualificationSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

/** Validate a private receipt's promotable subset without accepting paths, transcripts, or session data. */
export function promoteNativeQualificationEvidence(
	input: unknown,
	expected: NativeQualificationBinding,
): NativeQualificationEvidence {
	const summary = requireQualificationKeys(input, [
		"schema",
		"client",
		"platform",
		"receiptSha256",
		"sourceCandidateSha",
		"archiveSha256",
		"packagedPayloadHash",
		"installedPayloadHash",
		"derivedPayloadHash",
		"conclusions",
		"evidence",
	])
	const conclusions = requireQualificationKeys(summary.conclusions, [
		"discovery",
		"uiIdentity",
		"skillSeededNativeDelegation",
		"hostOwnedLifecycleEvidence",
		"sessionStart",
		"cleanStop",
		"driftContinuation",
		"reentry",
		"hooksFallback",
		"exactDefinitionTrust",
	])
	const evidenceKeys = [
		"discoverySha256",
		"uiIdentitySha256",
		"delegationLifecycleSha256",
		"sessionStartSha256",
		"cleanStopSha256",
		"driftSha256",
		"reentrySha256",
		"hooksFallbackSha256",
	]
	if (expected.client === "codex") evidenceKeys.push("exactDefinitionTrustSha256")
	const evidence = requireQualificationKeys(summary.evidence, evidenceKeys)

	if (
		summary.schema !== "native-capability-qualification-v1" ||
		summary.client !== expected.client ||
		(summary.platform !== "macos" && summary.platform !== "linux") ||
		!qualificationSha256(summary.receiptSha256) ||
		!qualificationSha256(summary.archiveSha256) ||
		!qualificationSha256(summary.packagedPayloadHash) ||
		!qualificationSha256(summary.installedPayloadHash) ||
		!qualificationSha256(summary.derivedPayloadHash) ||
		!Object.values(evidence).every(qualificationSha256)
	) {
		throw new Error("native qualification promotion contains invalid bounded evidence metadata")
	}
	if (
		summary.sourceCandidateSha !== expected.sourceCommit ||
		summary.archiveSha256 !== expected.archiveSha256 ||
		summary.packagedPayloadHash !== expected.packagedPayloadHash ||
		summary.installedPayloadHash !== expected.installedPayloadHash ||
		summary.packagedPayloadHash !== summary.installedPayloadHash
	) {
		throw new Error("native qualification promotion does not match candidate lineage")
	}
	if (summary.derivedPayloadHash === summary.packagedPayloadHash) {
		throw new Error("native qualification promotion requires a distinct derived payload hash")
	}
	for (const field of [
		"discovery",
		"uiIdentity",
		"skillSeededNativeDelegation",
		"hostOwnedLifecycleEvidence",
		"sessionStart",
		"driftContinuation",
		"hooksFallback",
	] as const) {
		if (conclusions[field] !== "proved" && conclusions[field] !== "failed") {
			throw new Error("native qualification promotion contains an invalid bounded conclusion")
		}
	}
	for (const field of ["cleanStop", "reentry"] as const) {
		if (conclusions[field] !== "silent" && conclusions[field] !== "failed") {
			throw new Error("native qualification promotion contains an invalid bounded conclusion")
		}
	}
	if (
		(expected.client === "claude" && conclusions.exactDefinitionTrust !== "not-applicable") ||
		(expected.client === "codex" &&
			conclusions.exactDefinitionTrust !== "proved" &&
			conclusions.exactDefinitionTrust !== "failed")
	) {
		throw new Error("native qualification promotion has the wrong exact-definition trust conclusion")
	}
	return input as NativeQualificationEvidence
}

function nativeQualificationPassed(receipt: NativeQualificationEvidence): boolean {
	return (
		receipt.conclusions.discovery === "proved" &&
		receipt.conclusions.uiIdentity === "proved" &&
		receipt.conclusions.skillSeededNativeDelegation === "proved" &&
		receipt.conclusions.hostOwnedLifecycleEvidence === "proved" &&
		receipt.conclusions.sessionStart === "proved" &&
		receipt.conclusions.cleanStop === "silent" &&
		receipt.conclusions.driftContinuation === "proved" &&
		receipt.conclusions.reentry === "silent" &&
		receipt.conclusions.hooksFallback === "proved" &&
		(receipt.client === "claude"
			? receipt.conclusions.exactDefinitionTrust === "not-applicable"
			: receipt.conclusions.exactDefinitionTrust === "proved")
	)
}

interface HarnessInstallProof {
	ok: true
	runId: string
	sideEffects: string
	temporaryRoot: string
	preflight: TaggedCheckout
	targetPreflight: TaggedCheckout
	restorationPreflight: TaggedCheckout
	claude: ClaudeProof
	codex: CodexProof
	capabilityEvidence: {
		candidateCommit: string
		fixtureCommit: string
		candidatePayloadHash: string
		clients: {
			claude: InstalledCapabilityEvidence
			codex: InstalledCapabilityEvidence
		}
	}
	runtimeJourneys?: {
		claude: NativeRuntimeJourney
		codex: NativeRuntimeJourney
	}
	versionAgreement: true
	payloadClosureChanged: true
	skips: HarnessSkip[]
	nextAction: string
}

export interface HarnessInstallProofOptions {
	/** Require both real harness CLIs; fixture copies cannot qualify CI or release. */
	requireNative?: boolean
	/** Run missing, preview, repair, retry, and corrupt-recovery journeys from installed payloads. */
	qualifyRuntimeJourney?: boolean
	/** Explicit CI/test acknowledgement for isolated repair mutation; never a human-approval claim. */
	fixtureAcknowledged?: boolean
}

interface NativeRuntimeJourney {
	kind: "installed-payload-mechanics"
	client: "claude-cli" | "codex-cli"
	target: string
	repository: string
	sourceCommit: string
	version: string
	runtimeLockSha256: string
	payloadHash: string
	bundleInventorySha256: string
	approvalPrompt: string
	fixtureAcknowledged: true
	humanApprovalClaimed: false
	agentWorkflowProved: false
	journey: string[]
}

interface NativeHarnessExecutables {
	claude?: string
	codex?: string
}

/** Replace a temporary evidence path with an explicit cleaned marker, including macOS /var aliases. */
export function redactTemporaryEvidencePath(value: unknown, temporaryRoot: string): unknown {
	if (typeof value !== "string") return value
	const directRelative = value.startsWith(temporaryRoot) ? relative(temporaryRoot, value) : undefined
	const temporaryName = basename(temporaryRoot)
	const aliasIndex = value.indexOf(temporaryName)
	const aliasRelative = aliasIndex === -1 ? undefined : value.slice(aliasIndex + temporaryName.length + 1)
	const evidencePath = directRelative ?? aliasRelative
	return evidencePath === undefined ? value : `[cleaned temporary evidence: ${evidencePath}]`
}

function command(
	commandArguments: string[],
	options: { cwd: string; env: Record<string, string | undefined> },
): CommandResult {
	const result = Bun.spawnSync({
		cmd: commandArguments,
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
	})
	const output = {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	}
	if (output.exitCode !== 0) {
		throw new Error(
			`command failed (${commandArguments[0]} ${commandArguments.slice(1).join(" ")}): ${output.stderr || output.stdout}`,
		)
	}
	return output
}

function jsonCommand<T>(
	commandArguments: string[],
	options: { cwd: string; env: Record<string, string | undefined> },
): T {
	const result = command(commandArguments, options)
	try {
		return JSON.parse(result.stdout) as T
	} catch {
		throw new Error(
			`command returned unreadable JSON (${commandArguments[0]} ${commandArguments.slice(1).join(" ")})`,
		)
	}
}

function regularFiles(root: string): string[] {
	const inventory: string[] = []
	function walk(directory: string): void {
		for (const entry of readdirSync(directory).sort()) {
			const absolutePath = join(directory, entry)
			const relativePath = relative(root, absolutePath).split(sep).join("/")
			const status = lstatSync(absolutePath)
			if (status.isSymbolicLink()) throw new Error(`fixture entry is a symlink: ${relativePath}`)
			if (status.isDirectory()) {
				walk(absolutePath)
				continue
			}
			if (!status.isFile()) throw new Error(`fixture entry is not a regular file: ${relativePath}`)
			inventory.push(relativePath)
		}
	}
	walk(root)
	return inventory.sort()
}

function gitEnvironment(indexPath?: string): Record<string, string | undefined> {
	return {
		...process.env,
		GIT_AUTHOR_NAME: "Harness Install Proof",
		GIT_AUTHOR_EMAIL: "proof@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_NAME: "Harness Install Proof",
		GIT_COMMITTER_EMAIL: "proof@example.invalid",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
		GIT_INDEX_FILE: indexPath,
	}
}

function snapshotFixture(repositoryRoot: string, requestedRef: string, message: string): string {
	const indexPath = join(repositoryRoot, `.fixture-index-${requestedRef}`)
	const environment = gitEnvironment(indexPath)
	rmSync(indexPath, { force: true })
	for (const relativePath of regularFiles(repositoryRoot).filter((path) => path !== ".git")) {
		if (relativePath.startsWith(".git/")) continue
		const absolutePath = join(repositoryRoot, relativePath)
		const blob = command(["git", "hash-object", "-w", "--", absolutePath], {
			cwd: repositoryRoot,
			env: environment,
		}).stdout.trim()
		const mode = statSync(absolutePath).mode & 0o111 ? "100755" : "100644"
		command(["git", "update-index", "--add", "--cacheinfo", `${mode},${blob},${relativePath}`], {
			cwd: repositoryRoot,
			env: environment,
		})
	}
	const tree = command(["git", "write-tree"], { cwd: repositoryRoot, env: environment }).stdout.trim()
	const commit = command(["git", "commit-tree", tree, "-m", message], {
		cwd: repositoryRoot,
		env: environment,
	}).stdout.trim()
	command(["git", "update-ref", `refs/tags/${requestedRef}`, commit], {
		cwd: repositoryRoot,
		env: gitEnvironment(),
	})
	rmSync(indexPath, { force: true })
	return commit
}

function nextPatchVersion(version: string): string {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
	if (!match) throw new Error(`fixture version must be a stable semantic version: ${version}`)
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

/** Copy only the installable plugin and marketplace metadata into a sanitized repository root. */
export function copyMarketplaceDistribution(sourceRoot: string, repositoryRoot: string): void {
	mkdirSync(repositoryRoot, { recursive: true })
	copyPluginPayload(sourceRoot, join(repositoryRoot, "plugin"))
	for (const relativePath of [
		".claude-plugin/marketplace.json",
		".agents/plugins/marketplace.json",
	]) {
		const targetPath = join(repositoryRoot, relativePath)
		mkdirSync(dirname(targetPath), { recursive: true })
		cpSync(join(sourceRoot, relativePath), targetPath)
	}
}

function writeFixtureSource(sourceRoot: string, repositoryRoot: string): PluginConfig {
	copyMarketplaceDistribution(sourceRoot, repositoryRoot)
	cpSync(join(sourceRoot, "plugin.config.json"), join(repositoryRoot, "plugin.config.json"))
	return loadPluginConfig(repositoryRoot)
}

function checkoutTaggedRelease(
	repositoryRoot: string,
	requestedRef: string,
	checkoutsRoot: string,
): TaggedCheckout {
	if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(requestedRef)) {
		throw new Error(`requested ref must be an immutable stable version tag: ${requestedRef}`)
	}
	const resolvedSha = command(
		["git", "rev-parse", "--verify", `refs/tags/${requestedRef}^{commit}`],
		{ cwd: repositoryRoot, env: gitEnvironment() },
	).stdout.trim()
	if (!/^[a-f0-9]{40}$/.test(resolvedSha)) {
		throw new Error(`requested ref did not resolve to a 40-character commit SHA: ${requestedRef}`)
	}
	const checkoutRoot = join(checkoutsRoot, requestedRef)
	command(["git", "-c", "protocol.file.allow=always", "clone", "--quiet", "--no-checkout", repositoryRoot, checkoutRoot], {
		cwd: checkoutsRoot,
		env: gitEnvironment(),
	})
	command(["git", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", resolvedSha], {
		cwd: checkoutRoot,
		env: gitEnvironment(),
	})
	const head = command(["git", "rev-parse", "HEAD"], {
		cwd: checkoutRoot,
		env: gitEnvironment(),
	}).stdout.trim()
	if (head !== resolvedSha) throw new Error("detached checkout does not match the resolved tag SHA")
	const claudeManifest = JSON.parse(
		readFileSync(join(checkoutRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
	)
	const codexManifest = JSON.parse(
		readFileSync(join(checkoutRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)
	if (claudeManifest.version !== codexManifest.version) {
		throw new Error("tagged Claude and Codex manifest versions differ")
	}
	if (requestedRef !== `v${claudeManifest.version}`) {
		throw new Error(
			`immutable tag ${requestedRef} does not match manifest version ${claudeManifest.version}`,
		)
	}
	if (claudeManifest.defaultEnabled !== false) {
		throw new Error("tagged Claude manifest must set defaultEnabled to false")
	}
	const claudeMarketplace = JSON.parse(
		readFileSync(join(checkoutRoot, ".claude-plugin", "marketplace.json"), "utf8"),
	)
	if (claudeMarketplace.plugins?.[0]?.defaultEnabled !== false) {
		throw new Error("tagged Claude marketplace must set defaultEnabled to false")
	}
	return {
		requestedRef,
		resolvedSha,
		checkoutRoot,
		manifestVersion: claudeManifest.version,
		inventory: pluginPayloadInventory(checkoutRoot),
	}
}

function createFixtureRelease(sourceRoot: string, temporaryRoot: string): FixtureRelease {
	const repositoryRoot = join(temporaryRoot, "tagged-marketplace.git-fixture")
	const config = writeFixtureSource(sourceRoot, repositoryRoot)
	command(["git", "init", "--quiet"], { cwd: repositoryRoot, env: gitEnvironment() })
	const baseRef = `v${config.version}`
	snapshotFixture(repositoryRoot, baseRef, `release ${baseRef}`)

	const targetConfig = structuredClone(config)
	targetConfig.version = nextPatchVersion(config.version)
	writeFileSync(
		join(repositoryRoot, "plugin.config.json"),
		`${JSON.stringify(targetConfig, null, 2)}\n`,
	)
	writeGeneratedFiles(repositoryRoot, targetConfig)
	const targetRef = `v${targetConfig.version}`
	snapshotFixture(repositoryRoot, targetRef, `release ${targetRef}`)

	const checkoutsRoot = join(temporaryRoot, "detached")
	mkdirSync(checkoutsRoot)
	return {
		repositoryRoot,
		base: checkoutTaggedRelease(repositoryRoot, baseRef, checkoutsRoot),
		target: checkoutTaggedRelease(repositoryRoot, targetRef, checkoutsRoot),
	}
}

function comparePayload(checkout: TaggedCheckout, installedPath: string): string[] {
	const installedInventory = regularFiles(installedPath)
	if (installedInventory.join("\n") !== checkout.inventory.join("\n")) {
		throw new Error("installed payload inventory differs from tagged plugin inventory")
	}
	for (const relativePath of checkout.inventory) {
		const taggedPath = join(checkout.checkoutRoot, "plugin", relativePath)
		const installedFile = join(installedPath, relativePath)
		if (!existsSync(installedFile) || !lstatSync(installedFile).isFile()) {
			throw new Error(`installed payload entry is not a regular file: ${relativePath}`)
		}
		if (!readFileSync(installedFile).equals(readFileSync(taggedPath))) {
			throw new Error(`installed payload bytes differ from tagged release: ${relativePath}`)
		}
	}
	return installedInventory
}

/**
 * Build the minimal process environment native plugin CLIs need without forwarding credentials.
 *
 * @param environment - Parent process environment that may contain publication credentials
 * @returns Allowlisted shell, locale, temporary-directory, and SSH-agent settings
 *
 * @example
 * ```ts
 * nativeHarnessEnvironment({ PATH: "/usr/bin", GH_TOKEN: "secret" })
 * ```
 */
export function nativeHarnessEnvironment(
	environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
	const allowed = [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TMPDIR",
		"TMP",
		"TEMP",
		"LANG",
		"LC_ALL",
		"SSH_AUTH_SOCK",
		"SSH_AGENT_PID",
		"GIT_SSH_COMMAND",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_NOSYSTEM",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
	] as const
	return Object.fromEntries(
		allowed.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]]),
	)
}

function claudeEnvironment(home: string): Record<string, string | undefined> {
	return { ...nativeHarnessEnvironment(process.env), CLAUDE_CONFIG_DIR: home, CI: "1", NO_COLOR: "1" }
}

function codexEnvironment(home: string): Record<string, string | undefined> {
	return { ...nativeHarnessEnvironment(process.env), CODEX_HOME: home, CI: "1", NO_COLOR: "1" }
}

function findClaudeInstall(
	claudeExecutable: string,
	environment: Record<string, string | undefined>,
	cwd: string,
	pluginId: string,
	scope: ClaudeScope,
): ClaudeInstall {
	const installed = jsonCommand<ClaudeInstalledJson[]>([claudeExecutable, "plugin", "list", "--json"], {
		cwd,
		env: environment,
	})
	const active = installed.find((entry) => entry.id === pluginId && entry.scope === scope)
	if (!active) throw new Error(`Claude did not report the ${scope}-scoped plugin as installed`)
	return {
		version: active.version,
		scope: active.scope,
		enabled: active.enabled,
		activeCachePath: active.installPath,
	}
}

function addClaudeMarketplace(
	claudeExecutable: string,
	marketplaceRoot: string,
	scope: ClaudeScope,
	environment: Record<string, string | undefined>,
	cwd: string,
): void {
	command(
		[claudeExecutable, "plugin", "marketplace", "add", marketplaceRoot, "--scope", scope],
		{ cwd, env: environment },
	)
}

function replaceClaudeInstall(
	claudeExecutable: string,
	pluginId: string,
	marketplaceName: string,
	marketplaceRoot: string,
	scope: ClaudeScope,
	environment: Record<string, string | undefined>,
	cwd: string,
): ClaudeInstall {
	command(
		[claudeExecutable, "plugin", "uninstall", pluginId, "--keep-data", "--scope", scope],
		{ cwd, env: environment },
	)
	command(
		[claudeExecutable, "plugin", "marketplace", "remove", marketplaceName, "--scope", scope],
		{ cwd, env: environment },
	)
	addClaudeMarketplace(claudeExecutable, marketplaceRoot, scope, environment, cwd)
	command([claudeExecutable, "plugin", "install", pluginId, "--scope", scope], {
		cwd,
		env: environment,
	})
	const disabled = findClaudeInstall(claudeExecutable, environment, cwd, pluginId, scope)
	if (disabled.enabled) throw new Error("Claude replacement became enabled before explicit review")
	command([claudeExecutable, "plugin", "enable", pluginId, "--scope", scope], {
		cwd,
		env: environment,
	})
	return findClaudeInstall(claudeExecutable, environment, cwd, pluginId, scope)
}

function proveClaudeNative(
	fixture: FixtureRelease,
	pluginName: string,
	claudeExecutable: string,
	temporaryRoot: string,
): ClaudeProof {
	const marketplaceName = pluginName
	const pluginId = `${pluginName}@${marketplaceName}`
	const scopeResults: ClaudeScopeProof[] = []
	let primary: ClaudeInstall | undefined
	let primaryInventory: string[] = []
	for (const scope of ["user", "project", "local"] as const) {
		const home = join(temporaryRoot, "claude", scope, "home")
		const project = join(temporaryRoot, "claude", scope, "project")
		mkdirSync(home, { recursive: true })
		mkdirSync(project, { recursive: true })
		const environment = claudeEnvironment(home)
		addClaudeMarketplace(claudeExecutable, fixture.base.checkoutRoot, scope, environment, project)
		command([claudeExecutable, "plugin", "install", pluginId, "--scope", scope], {
			cwd: project,
			env: environment,
		})
		const initial = findClaudeInstall(claudeExecutable, environment, project, pluginId, scope)
		if (initial.enabled) throw new Error("Claude installed a default-disabled plugin as enabled")
		const initialInventory = comparePayload(fixture.base, initial.activeCachePath)
		const dataRoot = join(home, "plugins", "data", pluginId)
		const markerPath = join(dataRoot, "u6-marker.txt")
		mkdirSync(dataRoot, { recursive: true })
		writeFileSync(markerPath, `${scope} marker\n`)
		const priorRecovery = {
			source: fixture.base.checkoutRoot,
			ref: fixture.base.requestedRef,
			version: initial.version,
			payloadInventory: initialInventory,
			enabled: initial.enabled,
			scope,
			persistentData: readFileSync(markerPath, "utf8"),
		}

		const upgraded = replaceClaudeInstall(
			claudeExecutable,
			pluginId,
			marketplaceName,
			fixture.target.checkoutRoot,
			scope,
			environment,
			project,
		)
		if (upgraded.version !== fixture.target.manifestVersion) {
			throw new Error(`Claude ${scope} upgrade reported the wrong version`)
		}
		const rolledBack = replaceClaudeInstall(
			claudeExecutable,
			pluginId,
			marketplaceName,
			fixture.base.checkoutRoot,
			scope,
			environment,
			project,
		)
		if (rolledBack.version !== fixture.base.manifestVersion) {
			throw new Error(`Claude ${scope} rollback reported the wrong version`)
		}
		if (readFileSync(markerPath, "utf8") !== `${scope} marker\n`) {
			throw new Error(`Claude ${scope} persistent data did not survive replacement`)
		}
		const restoredAfterFailure = provePostMutationRecovery(
			priorRecovery,
			{
				harness: "Claude",
				mutate: () => {
					command(
						[claudeExecutable, "plugin", "uninstall", pluginId, "--keep-data", "--scope", scope],
						{ cwd: project, env: environment },
					)
					command(
						[claudeExecutable, "plugin", "marketplace", "remove", marketplaceName, "--scope", scope],
						{ cwd: project, env: environment },
					)
				},
				restore: () => {
					addClaudeMarketplace(
						claudeExecutable,
						fixture.base.checkoutRoot,
						scope,
						environment,
						project,
					)
					command([claudeExecutable, "plugin", "install", pluginId, "--scope", scope], {
						cwd: project,
						env: environment,
					})
					const restored = findClaudeInstall(
						claudeExecutable,
						environment,
						project,
						pluginId,
						scope,
					)
					return {
						value: restored,
						snapshot: {
							source: fixture.base.checkoutRoot,
							ref: fixture.base.requestedRef,
							version: restored.version,
							payloadInventory: comparePayload(fixture.base, restored.activeCachePath),
							enabled: restored.enabled,
							scope: restored.scope,
							persistentData: readFileSync(markerPath, "utf8"),
						},
					}
				},
			},
		)
		const failureRestored = true
		command([claudeExecutable, "plugin", "enable", pluginId, "--scope", scope], {
			cwd: project,
			env: environment,
		})
		const activeAfterFailure = findClaudeInstall(
			claudeExecutable,
			environment,
			project,
			pluginId,
			scope,
		)
		const orphanedCachePath = join(dirname(activeAfterFailure.activeCachePath), "0.0.0-orphaned")
		mkdirSync(orphanedCachePath, { recursive: true })
		writeFileSync(join(orphanedCachePath, "orphan-marker.txt"), "not active\n")
		const hostSelected = findClaudeInstall(
			claudeExecutable,
			environment,
			project,
			pluginId,
			scope,
		)
		if (hostSelected.activeCachePath === orphanedCachePath) {
			throw new Error("Claude proof selected an orphaned cache directory")
		}
		const inventory = comparePayload(fixture.base, hostSelected.activeCachePath)
		scopeResults.push({
			scope,
			initialVersion: initial.version,
			initialEnabled: initial.enabled,
			upgradedVersion: upgraded.version,
			rolledBackVersion: rolledBack.version,
			enabledAfterReview: hostSelected.enabled,
			dataMarkerPreserved: true,
			failureRestored,
			orphanedCacheIgnored: true,
			activeCachePath: hostSelected.activeCachePath,
		})
		if (scope === "user") {
			primary = hostSelected
			primaryInventory = inventory
		}
	}
	if (!primary) throw new Error("Claude user-scope proof did not run")
	return {
		mode: "native-local-marketplace" as HarnessMode,
		version: primary.version,
		scope: primary.scope,
		enabled: primary.enabled,
		activeCachePath: primary.activeCachePath,
		inventory: primaryInventory,
		requestedRef: fixture.base.requestedRef,
		resolvedSha: fixture.base.resolvedSha,
		defaultEnabled: false,
		compatibility: CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY,
		scopes: scopeResults,
	}
}

function proveClaudeFixtureCopy(
	fixture: FixtureRelease,
	pluginName: string,
	temporaryRoot: string,
): ClaudeProof {
	const activeCachePath = join(
		temporaryRoot,
		"claude-fixture-home",
		"plugins",
		"cache",
		pluginName,
		pluginName,
		fixture.base.manifestVersion,
	)
	copyPluginPayload(fixture.base.checkoutRoot, activeCachePath)
	return {
		mode: "fixture-copy" as HarnessMode,
		version: fixture.base.manifestVersion,
		scope: "user" as ClaudeScope,
		enabled: false,
		activeCachePath,
		inventory: comparePayload(fixture.base, activeCachePath),
		requestedRef: fixture.base.requestedRef,
		resolvedSha: fixture.base.resolvedSha,
		defaultEnabled: false,
		compatibility: CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY,
		scopes: [],
	}
}

function findCodexPlugin(
	codexExecutable: string,
	environment: Record<string, string | undefined>,
	cwd: string,
	pluginId: string,
): { raw: CodexPluginListJson; plugin: CodexInstalledPlugin } {
	const raw = jsonCommand<CodexPluginListJson>([codexExecutable, "plugin", "list", "--json"], {
		cwd,
		env: environment,
	})
	const plugin = raw.installed.find((entry) => entry.pluginId === pluginId)
	if (!plugin) throw new Error("Codex did not report the plugin as installed")
	return { raw, plugin }
}

function installCodex(
	codexExecutable: string,
	marketplaceRoot: string,
	pluginId: string,
	environment: Record<string, string | undefined>,
	cwd: string,
	ref?: string,
): CodexInstallState {
	const marketplaceArguments = [codexExecutable, "plugin", "marketplace", "add", marketplaceRoot]
	if (ref) marketplaceArguments.push("--ref", ref)
	marketplaceArguments.push("--json")
	const addMarketplace = jsonCommand<CodexMarketplaceAddJson>(
		marketplaceArguments,
		{ cwd, env: environment },
	)
	const add = jsonCommand<CodexPluginAddJson>([codexExecutable, "plugin", "add", pluginId, "--json"], {
		cwd,
		env: environment,
	})
	const marketplace = jsonCommand<CodexMarketplaceListJson>(
		[codexExecutable, "plugin", "marketplace", "list", "--json"],
		{ cwd, env: environment },
	)
	const listed = findCodexPlugin(codexExecutable, environment, cwd, pluginId)
	return { marketplaceAdd: addMarketplace, add, marketplace, list: listed.raw, plugin: listed.plugin }
}

/** Native install evidence fetched independently from one hosted marketplace ref. */
export interface HostedHarnessInstallProof {
	temporaryRoot: string
	preflight: TaggedCheckout
	claude: {
		mode: "native-hosted-marketplace"
		version: string
		inventory: string[]
		/** SHA-256 measured over the bytes each native client actually installed. */
		installedPayloadHash: string
	}
	codex: {
		mode: "native-hosted-marketplace"
		version: string
		inventory: string[]
		/** SHA-256 measured over the bytes each native client actually installed. */
		installedPayloadHash: string
	}
}

/** Bind each native client to the same transport-specific hosted Git remote and ref. */
export function hostedMarketplaceSources(
	remote: string,
	ref: string,
): { claude: string; codex: string; ref: string } {
	const supportedRemote =
		/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(remote) ||
		/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(remote)
	if (!supportedRemote || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
		throw new Error("hosted marketplace proof requires an SSH or HTTPS Git remote and a supported ref")
	}
	return { claude: `${remote}#${ref}`, codex: remote, ref }
}

/**
 * Install one hosted marketplace ref through both native CLIs in isolated homes.
 *
 * The candidate checkout supplies expected bytes only. Both harnesses fetch the hosted repository
 * independently, so a local fixture cannot satisfy this proof.
 */
export function proveHostedHarnessInstall(
	sourceRoot: string,
	remote: string,
	ref: string,
	expectedSha: string,
): HostedHarnessInstallProof {
	if (!ref || !/^[a-f0-9]{40}$/.test(expectedSha)) {
		throw new Error("hosted marketplace proof requires a ref and full expected commit SHA")
	}
	const sources = hostedMarketplaceSources(remote, ref)
	const claudeExecutable = Bun.which("claude")
	const codexExecutable = Bun.which("codex")
	if (!claudeExecutable || !codexExecutable) {
		throw new Error("native harness CLIs are required for hosted marketplace proof")
	}
	const repositoryRoot = resolve(sourceRoot)
	const claudeManifest = JSON.parse(
		readFileSync(join(repositoryRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
	) as { name?: unknown; version?: unknown }
	const codexManifest = JSON.parse(
		readFileSync(join(repositoryRoot, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	) as { name?: unknown; version?: unknown }
	if (
		typeof claudeManifest.name !== "string" ||
		typeof claudeManifest.version !== "string" ||
		claudeManifest.name !== codexManifest.name ||
		claudeManifest.version !== codexManifest.version
	) {
		throw new Error("hosted Claude and Codex manifest identities differ")
	}
	const expected: TaggedCheckout = {
		requestedRef: ref,
		resolvedSha: expectedSha,
		checkoutRoot: repositoryRoot,
		manifestVersion: claudeManifest.version,
		inventory: pluginPayloadInventory(repositoryRoot),
	}
	const temporaryRoot = mkdtempSync(join(tmpdir(), "hosted-harness-install-proof-"))
	try {
		const claudeHome = join(temporaryRoot, "claude", "home")
		const claudeProject = join(temporaryRoot, "claude", "project")
		mkdirSync(claudeHome, { recursive: true })
		mkdirSync(claudeProject, { recursive: true })
		const claudeEnv = claudeEnvironment(claudeHome)
		addClaudeMarketplace(
			claudeExecutable,
			sources.claude,
			"user",
			claudeEnv,
			claudeProject,
		)
		const pluginId = `${claudeManifest.name}@${claudeManifest.name}`
		command([claudeExecutable, "plugin", "install", pluginId, "--scope", "user"], {
			cwd: claudeProject,
			env: claudeEnv,
		})
		const claudeInstall = findClaudeInstall(
			claudeExecutable,
			claudeEnv,
			claudeProject,
			pluginId,
			"user",
		)
		if (claudeInstall.version !== claudeManifest.version) {
			throw new Error("Claude hosted install reported the wrong manifest version")
		}
		const claudeInventory = comparePayload(expected, claudeInstall.activeCachePath)
		const claudeInstalledPayloadHash = payloadInventorySha256(
			claudeInstall.activeCachePath,
			claudeInventory,
		)

		const codexHome = join(temporaryRoot, "codex", "home")
		const codexProject = join(temporaryRoot, "codex", "project")
		mkdirSync(codexHome, { recursive: true })
		mkdirSync(codexProject, { recursive: true })
		const codexInstall = installCodex(
			codexExecutable,
			sources.codex,
			pluginId,
			codexEnvironment(codexHome),
			codexProject,
			ref,
		)
		assertCodexReportedVersion(codexInstall, claudeManifest.version, "hosted install")
		const codexInventory = comparePayload(expected, codexInstall.add.installedPath)
		const codexInstalledPayloadHash = payloadInventorySha256(
			codexInstall.add.installedPath,
			codexInventory,
		)
		return {
			temporaryRoot,
			preflight: expected,
			claude: {
				mode: "native-hosted-marketplace",
				version: claudeInstall.version,
				inventory: claudeInventory,
				installedPayloadHash: claudeInstalledPayloadHash,
			},
			codex: {
				mode: "native-hosted-marketplace",
				version: codexInstall.add.version,
				inventory: codexInventory,
				installedPayloadHash: codexInstalledPayloadHash,
			},
		}
	} catch (error) {
		rmSync(temporaryRoot, { recursive: true, force: true })
		throw error
	}
}

function removeCodex(
	codexExecutable: string,
	pluginId: string,
	marketplaceName: string,
	environment: Record<string, string | undefined>,
	cwd: string,
): void {
	jsonCommand<unknown>([codexExecutable, "plugin", "remove", pluginId, "--json"], {
		cwd,
		env: environment,
	})
	jsonCommand<unknown>(
		[codexExecutable, "plugin", "marketplace", "remove", marketplaceName, "--json"],
		{ cwd, env: environment },
	)
}

/**
 * Validate Git transport prerequisites without attempting private network access.
 *
 * @param input - Transport facts supplied by the caller's credential preflight
 * @returns Accepted transport and source when every required prerequisite is present
 * @throws {Error} When SSH or HTTPS admission is incomplete or token-only
 *
 * @example
 * ```typescript
 * admitGitTransport({ source: "/tmp/repo", transport: "local" })
 * ```
 */
export function admitGitTransport(input: TransportInput): { source: string; transport: string } {
	if (input.tokenEnvironmentOnly) {
		throw new Error("token environment variables alone do not satisfy Git credential admission")
	}
	if (input.transport === "ssh" && (!input.hostKeyAccepted || !input.agentKeyLoaded)) {
		throw new Error("SSH admission requires accepted host keys and an agent-loaded key")
	}
	if (input.transport === "https" && !input.credentialHelperConfigured) {
		throw new Error("HTTPS admission requires a configured Git credential helper")
	}
	return { source: input.source, transport: input.transport }
}

/**
 * Block replacement before mutation unless target and restoration tags remain admissible.
 *
 * @param input - Detached target/restoration evidence plus managed-state policy
 * @returns Mutation admission with a stable administrator handoff when permitted
 * @throws {Error} When either ref is denied, managed, non-removable, or not a matching immutable tag
 *
 * @example
 * ```typescript
 * assertReplacementAdmission({ target, restoration, allowedRefs: [target.requestedRef, restoration.requestedRef], managed: false, removable: true })
 * ```
 */
export function assertReplacementAdmission(
	input: ReplacementAdmissionInput,
): { admitted: true; nextAction: string } {
	if (input.managed || !input.removable) {
		throw new Error(
			"administrator handoff required: managed or non-removable plugin state cannot be replaced locally",
		)
	}
	for (const checkout of [input.target, input.restoration]) {
		if (!input.allowedRefs.includes(checkout.requestedRef)) {
			throw new Error(`replacement ref denied before mutation: ${checkout.requestedRef}`)
		}
		if (checkout.requestedRef !== `v${checkout.manifestVersion}`) {
			throw new Error(`replacement ref does not match inspected manifest: ${checkout.requestedRef}`)
		}
		if (!/^[a-f0-9]{40}$/.test(checkout.resolvedSha)) {
			throw new Error(`replacement ref has no proven commit: ${checkout.requestedRef}`)
		}
	}
	return { admitted: true, nextAction: "capture host JSON state, then replace through native commands" }
}

/**
 * Bind native-install review to the exact versioned plugin payload bytes.
 *
 * @param pluginRoot - Installed plugin payload root
 * @returns Exact inventory and payload hashes used for review comparison
 *
 * @example
 * ```typescript
 * const evidence = runtimeClosureEvidence(installedPath)
 * ```
 */
export function runtimeClosureEvidence(
	pluginRoot: string,
	inventory: string[] = regularFiles(pluginRoot),
): {
	version: string
	inventoryHash: string
	payloadHash: string
} {
	const manifest = JSON.parse(
		readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
	)
	return {
		version: manifest.version,
		inventoryHash: createHash("sha256").update(inventory.join("\0")).digest("hex"),
		payloadHash: payloadInventorySha256(pluginRoot, inventory),
	}
}

/**
 * Inspect installed bytes and direct handler mechanics without making a native claim.
 *
 * `currentSessionHook` derives only from the explicit `currentSessionMarker` input
 * (the current session's native context marker); a qualification receipt is a
 * separate evidence layer and never proves the current session's hook.
 */
export function proveInstalledCapabilityEvidence(
	pluginRoot: string,
	client: "claude" | "codex",
	candidateCommit: string,
	candidatePayloadHash: string,
	qualification?: NativeQualificationPromotion,
	currentSessionMarker?: boolean,
): InstalledCapabilityEvidence {
	if (!/^[a-f0-9]{40}$/.test(candidateCommit) || !/^[a-f0-9]{64}$/.test(candidatePayloadHash)) {
		throw new Error("installed capability evidence requires a candidate commit and payload hash")
	}
	const manifest = JSON.parse(
		readFileSync(join(pluginRoot, `.${client}-plugin`, "plugin.json"), "utf8"),
	) as { version?: unknown; hooks?: unknown }
	const declarationPath = `./hooks/${client}/hooks.json`
	if (manifest.hooks !== declarationPath) {
		throw new Error(`${client} installed declaration path is invalid`)
	}
	const declaration = JSON.parse(
		readFileSync(join(pluginRoot, declarationPath), "utf8"),
	) as Record<string, unknown>
	if (JSON.stringify(declaration) !== JSON.stringify(hookDeclarationBody(client))) {
		throw new Error(`${client} installed declaration bytes do not match the capability contract`)
	}
	const fixtureSource = readFileSync(
		join(pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.source.json"),
	)
	const fixtureProjection = readFileSync(
		join(pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
	)
	if (!fixtureSource.equals(fixtureProjection)) {
		throw new Error(`${client} installed lifecycle mechanics proof fixture differs`)
	}
	const installedInventory = regularFiles(pluginRoot)
	const installed = runtimeClosureEvidence(pluginRoot, installedInventory)
	if (installed.payloadHash !== candidatePayloadHash) {
		throw new Error(`${client} installed payload hash differs from the candidate payload`)
	}
	const installedSkills = installedInventory
		.filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
		.map((path) => path.slice("skills/".length, -"/SKILL.md".length))
	const portableSkills = [
		"capability-tour",
		"hello-world",
		"runtime-custody",
		"skill-a",
		"skill-b",
	]
	if (JSON.stringify(installedSkills) !== JSON.stringify(portableSkills)) {
		throw new Error(`${client} installed portable skill inventory differs`)
	}
	const executableSkills = ["hello-world", "skill-a", "skill-b"]
	const launchers = installedInventory
		.filter((path) => path.startsWith("bin/"))
		.map((path) => path.slice("bin/".length))
	const catalogProjection = readFileSync(
		join(pluginRoot, "runtime", "skill-catalog.sh"),
		"utf8",
	)
	if (JSON.stringify(launchers) !== JSON.stringify(executableSkills)) {
		throw new Error(`${client} installed launcher inventory differs`)
	}
	for (const skillId of executableSkills) {
		if (!catalogProjection.includes(`\n\t${skillId})`)) {
			throw new Error(`${client} installed runtime catalog omits ${skillId}`)
		}
		const launcher = readFileSync(join(pluginRoot, "bin", skillId), "utf8")
		if (!launcher.includes(`runtime/runtime-exec\" run ${skillId} --`) || launcher.includes("hooks/")) {
			throw new Error(`${client} installed ${skillId} launcher is not hook-independent`)
		}
	}
	if (catalogProjection.includes("capability-tour")) {
		throw new Error(`${client} installed runtime catalog includes capability-tour`)
	}
	const bundleInventory = JSON.parse(
		readFileSync(join(pluginRoot, "runtime", "bundle-inventory.json"), "utf8"),
	) as { bundles?: Record<string, unknown> }
	if (
		JSON.stringify(Object.keys(bundleInventory.bundles ?? {}).sort()) !==
		JSON.stringify(executableSkills)
	) {
		throw new Error(`${client} installed bundle inventory differs`)
	}
	if (typeof manifest.version !== "string") throw new Error(`${client} installed version is invalid`)
	const handler = join(pluginRoot, "hooks", "native-capability-hook")
	const runHandler = (event: "SessionStart" | "Stop", input: string) =>
		Bun.spawnSync({
			cmd: [handler, event, client],
			cwd: pluginRoot,
			env: { PATH: "/usr/bin:/bin" },
			timeout: 15_000,
			stdin: Buffer.from(input),
			stdout: "pipe",
			stderr: "pipe",
		})
	const start = runHandler("SessionStart", '{"source":"startup"}')
	// The hook reads its display name from the claude manifest for both clients;
	// only that manifest carries a top-level displayName.
	const identityManifest = JSON.parse(
		readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
	) as { displayName?: unknown }
	if (typeof identityManifest.displayName !== "string" || !identityManifest.displayName) {
		throw new Error(`${client} installed claude manifest displayName is invalid`)
	}
	const expectedContext = `${identityManifest.displayName} v${manifest.version} | ${client} | SessionStart:startup`
	let startContext: unknown
	try {
		startContext = JSON.parse(start.stdout.toString()).hookSpecificOutput?.additionalContext
	} catch {
		startContext = undefined
	}
	if (start.exitCode !== 0 || start.stderr.toString() !== "" || startContext !== expectedContext) {
		throw new Error(`${client} installed direct SessionStart handler check failed`)
	}
	const stop = runHandler("Stop", '{"stop_hook_active":false}')
	if (stop.exitCode !== 0 || stop.stdout.toString() !== "" || stop.stderr.toString() !== "") {
		throw new Error(`${client} installed direct Stop handler check failed`)
	}
	let nativeQualification: InstalledCapabilityEvidence["nativeQualification"] = {
		status: "not-proved",
		receipt: null,
	}
	if (qualification !== undefined) {
		if (
			qualification.lineage.sourceCommit !== candidateCommit ||
			qualification.lineage.packagedPayloadHash !== candidatePayloadHash ||
			qualification.lineage.installedPayloadHash !== installed.payloadHash
		) {
			throw new Error("native qualification lineage does not match the installed candidate proof")
		}
		const receipt = promoteNativeQualificationEvidence(qualification.summary, {
			client,
			...qualification.lineage,
		})
		nativeQualification = {
			status: nativeQualificationPassed(receipt) ? "proved" : "failed",
			receipt,
		}
	}
	const nativeProved = nativeQualification.status === "proved"
	return {
		candidateCommit,
		candidatePayloadHash,
		installedPayloadHash: installed.payloadHash,
		declarationHealth: "healthy",
		directHandlerHealth: "healthy",
		fixtureState: "matched",
		currentSessionHook: currentSessionMarker === true ? "proved" : "unknown",
		nativeActivation: nativeProved ? "proved" : "not-proved",
		externalCandidateQualification: nativeProved ? "proved" : "unknown",
		nativeDelegation: nativeProved ? "proved" : "not-proved",
		nativeQualification,
		portableSkillsWithoutHooks: [
			"hello-world",
			"skill-a",
			"skill-b",
			"runtime-custody",
			"capability-tour",
		],
	}
}

function nativeRuntimeTarget(): string {
	const target = currentRuntimeTarget()
	if (!target) {
		throw new Error(`native runtime qualification does not support ${process.platform}-${process.arch}`)
	}
	return target
}

function runInstalledRuntime(
	pluginRoot: string,
	cacheRoot: string,
	commandArguments: string[],
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: commandArguments,
		cwd: pluginRoot,
		env: {
			HOME: cacheRoot,
			XDG_CACHE_HOME: cacheRoot,
			PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 180_000,
	})
}

function proveNativeRuntimeJourney(
	client: NativeRuntimeJourney["client"],
	pluginRoot: string,
	temporaryRoot: string,
	corruptRecovery: boolean,
	identity: Pick<NativeRuntimeJourney, "repository" | "sourceCommit" | "runtimeLockSha256">,
): NativeRuntimeJourney {
	const target = nativeRuntimeTarget()
	const cacheRoot = join(temporaryRoot, "runtime-journeys", client)
	mkdirSync(cacheRoot, { recursive: true, mode: 0o700 })
	const launcher = join(pluginRoot, "bin", client === "claude-cli" ? "skill-a" : "skill-b")
	const engine = join(pluginRoot, "runtime", "runtime-exec")
	const missing = requireProofControlEnvelope(
		`${client} cold run`,
		runInstalledRuntime(pluginRoot, cacheRoot, [launcher]),
		20,
		"BUN_MISSING",
	)
	if (missing.sideEffects.length !== 0) throw new Error(`${client} cold run mutated custody state`)
	const preview = requireProofControlEnvelope(
		`${client} repair preview`,
		runInstalledRuntime(pluginRoot, cacheRoot, [engine, "repair"]),
		0,
		"REPAIR_PREVIEW",
	)
	if (!preview.nextAction.includes("Ask the user to approve") || preview.sideEffects.length !== 0) {
		throw new Error(`${client} repair preview did not expose the plain-language approval boundary`)
	}
	const applied = requireProofControlEnvelope(
		`${client} acknowledged repair`,
		runInstalledRuntime(pluginRoot, cacheRoot, [engine, "repair", "--apply"]),
		0,
		"REPAIR_APPLIED",
	)
	const executableSha256 = applied.runtime?.executableSha256
	if (typeof executableSha256 !== "string") throw new Error(`${client} repair omitted runtime identity`)
	const retry = runInstalledRuntime(pluginRoot, cacheRoot, [launcher])
	if (retry.exitCode !== 0) throw new Error(`${client} agent retry failed: ${retry.stderr}`)
	JSON.parse(retry.stdout.toString())

	const journey = [
		"BUN_MISSING",
		"REPAIR_PREVIEW",
		"FIXTURE_ACKNOWLEDGED",
		"REPAIR_APPLIED",
		"launcher-retry",
	]
	if (corruptRecovery) {
		const runtimePath = join(cacheRoot, "agent-plugin-runtime", "bun", executableSha256, "bun")
		writeFileSync(runtimePath, "corrupt runtime fixture\n")
		requireProofControlEnvelope(
			`${client} corrupt run`,
			runInstalledRuntime(pluginRoot, cacheRoot, [launcher]),
			20,
			"REPAIR_REQUIRED",
		)
		const corruptPreview = requireProofControlEnvelope(
			`${client} corrupt repair preview`,
			runInstalledRuntime(pluginRoot, cacheRoot, [engine, "repair"]),
			0,
			"REPAIR_PREVIEW",
		)
		if (!corruptPreview.nextAction.includes("Ask the user to approve")) {
			throw new Error(`${client} corrupt recovery omitted the approval boundary`)
		}
		requireProofControlEnvelope(
			`${client} corrupt repair`,
			runInstalledRuntime(pluginRoot, cacheRoot, [engine, "repair", "--apply"]),
			0,
			"REPAIR_APPLIED",
		)
		const recovered = runInstalledRuntime(pluginRoot, cacheRoot, [launcher])
		if (recovered.exitCode !== 0) throw new Error(`${client} corrupt recovery retry failed`)
		JSON.parse(recovered.stdout.toString())
		journey.push(
			"REPAIR_REQUIRED",
			"REPAIR_PREVIEW",
			"FIXTURE_ACKNOWLEDGED",
			"REPAIR_APPLIED",
			"launcher-retry",
		)
	}

	const closure = runtimeClosureEvidence(pluginRoot)
	return {
		kind: "installed-payload-mechanics",
		client,
		target,
		...identity,
		version: closure.version,
		payloadHash: closure.payloadHash,
		bundleInventorySha256: createHash("sha256")
			.update(readFileSync(join(pluginRoot, "runtime", "bundle-inventory.json")))
			.digest("hex"),
		approvalPrompt: preview.nextAction,
		fixtureAcknowledged: true,
		humanApprovalClaimed: false,
		agentWorkflowProved: false,
		journey,
	}
}

function resolveCleanPathsCommit(
	repositoryRoot: string,
	paths: string[],
	errors: { status: string; dirty: string; resolve: string; invalid?: string },
): string {
	const status = Bun.spawnSync({
		cmd: ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths],
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
	})
	if (status.exitCode !== 0) throw new Error(errors.status)
	if (status.stdout.toString().trim() !== "") throw new Error(errors.dirty)
	const head = Bun.spawnSync({
		cmd: ["git", "rev-parse", "HEAD"],
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15_000,
	})
	if (head.exitCode !== 0) throw new Error(errors.resolve)
	const sourceCommit = head.stdout.toString().trim()
	if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error(errors.invalid ?? errors.resolve)
	return sourceCommit
}

/** Resolve the exact commit used by a source-bound native receipt, refusing dirty bytes. */
export function resolveCleanSourceCommit(repositoryRoot: string): string {
	return resolveCleanPathsCommit(
		repositoryRoot,
		["plugin", "runtime", "packages", "package.json", "bun.lock", "bunfig.toml", "plugin.config.json"],
		{
			status: "native receipt could not verify candidate payload source cleanliness",
			dirty:
				"native runtime qualification requires clean candidate payload sources so sourceCommit matches the installed payload bytes",
			resolve: "native receipt could not resolve source commit",
			invalid: "native receipt source commit is invalid",
		},
	)
}

/** Bind automated payload evidence to Git HEAD while allowing tooling-only worktree changes. */
export function resolveCandidatePayloadCommit(repositoryRoot: string): string {
	return resolveCleanPathsCommit(repositoryRoot, ["plugin"], {
		status: "candidate proof could not inspect plugin payload status",
		dirty: "candidate proof requires plugin payload bytes to match the candidate commit",
		resolve: "candidate proof could not resolve the source commit",
	})
}

function runHarnessInstallProof(
	repositoryRoot: string,
	temporaryRoot: string,
	executables: NativeHarnessExecutables,
	qualifyRuntimeJourney: boolean,
): HarnessInstallProof {
	const sourceCommit = qualifyRuntimeJourney
		? resolveCleanSourceCommit(repositoryRoot)
		: resolveCandidatePayloadCommit(repositoryRoot)
	const configuredSourceCommit = process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || undefined
	if (configuredSourceCommit !== undefined && configuredSourceCommit !== sourceCommit) {
		throw new Error("candidate proof source commit does not match Git HEAD")
	}
	const fixture = createFixtureRelease(repositoryRoot, temporaryRoot)
	admitGitTransport({
		source: fixture.repositoryRoot,
		transport: "local",
	})
	assertReplacementAdmission({
		target: fixture.target,
		restoration: fixture.base,
		allowedRefs: [fixture.base.requestedRef, fixture.target.requestedRef],
		managed: false,
		removable: true,
	})
	const pluginConfig = loadPluginConfig(repositoryRoot)
	const nativeIdentity = {
		repository: pluginConfig.repository,
		sourceCommit,
		runtimeLockSha256: createHash("sha256")
			.update(readFileSync(join(repositoryRoot, "runtime", "runtime.lock.json")))
			.digest("hex"),
	}
	const skips: HarnessSkip[] = [
		{
			case: "Codex Desktop discovery and approved repair/retry smoke",
			reason: "A named manual release receipt in private XDG state owns the Desktop interaction.",
		},
		{
			case: "Private SSH/HTTPS marketplace fetch and background refresh",
			reason: "Hermetic proof has no private remote; pure transport admission proves prerequisites without using credentials.",
		},
		{
			case: "Hosted Git marketplace fresh-task execution",
			reason: "A fresh Codex task requires live model access; local native JSON and installedPath bytes prove selection offline.",
		},
	]
	const { claude: claudeExecutable, codex: codexExecutable } = executables
	const claude = claudeExecutable
		? proveClaudeNative(fixture, pluginConfig.name, claudeExecutable, temporaryRoot)
		: proveClaudeFixtureCopy(fixture, pluginConfig.name, temporaryRoot)
	if (!claudeExecutable) {
		skips.push({
			case: "Native Claude marketplace installation",
			reason: "Claude CLI unavailable; isolated direct-copy cache evidence remains byte-complete.",
		})
	}
	const codex = codexExecutable
		? runCodexNative(fixture, pluginConfig.name, codexExecutable, temporaryRoot, {
				install: installCodex,
				remove: removeCodex,
				comparePayload,
				environment: codexEnvironment,
				assertReplacementAdmission,
			})
		: runCodexFixtureCopy(fixture, pluginConfig.name, temporaryRoot, comparePayload)
	if (!codexExecutable) {
		skips.push({
			case: "Native Codex marketplace installation",
			reason: "Codex CLI unavailable; isolated direct-copy cache evidence remains byte-complete.",
		})
	}
	const trustBase = runtimeClosureEvidence(join(fixture.base.checkoutRoot, "plugin"))
	const trustTarget = runtimeClosureEvidence(join(fixture.target.checkoutRoot, "plugin"))
	const sourceCandidate = runtimeClosureEvidence(join(repositoryRoot, "plugin"))
	if (
		trustBase.inventoryHash !== trustTarget.inventoryHash ||
		trustBase.payloadHash === trustTarget.payloadHash ||
		trustBase.payloadHash !== sourceCandidate.payloadHash
	) {
		throw new Error("release change did not preserve inventory while changing exact payload bytes")
	}
	const versionAgreement =
		claude.version === fixture.base.manifestVersion && codex.version === fixture.base.manifestVersion
	if (!versionAgreement) throw new Error("Claude and Codex installed versions do not agree with the tag")
	const candidatePayloadHash = sourceCandidate.payloadHash
	const capabilityEvidence = {
		candidateCommit: sourceCommit,
		fixtureCommit: fixture.base.resolvedSha,
		candidatePayloadHash,
		clients: {
			claude: proveInstalledCapabilityEvidence(
				claude.activeCachePath,
				"claude",
				sourceCommit,
				candidatePayloadHash,
			),
			codex: proveInstalledCapabilityEvidence(
				codex.installedPath,
				"codex",
				sourceCommit,
				candidatePayloadHash,
			),
		},
	}
	const runtimeJourneys = qualifyRuntimeJourney
		? {
				claude: proveNativeRuntimeJourney(
					"claude-cli",
					claude.activeCachePath,
					temporaryRoot,
					false,
					nativeIdentity,
				),
				codex: proveNativeRuntimeJourney(
					"codex-cli",
					codex.installedPath,
					temporaryRoot,
					true,
					nativeIdentity,
				),
			}
		: undefined
	return {
		ok: true,
		runId: randomUUID(),
		sideEffects: "temporary isolated homes and local Git fixture only",
		temporaryRoot,
		preflight: fixture.base,
		targetPreflight: fixture.target,
		restorationPreflight: fixture.base,
		claude,
		codex,
		capabilityEvidence,
		runtimeJourneys,
		versionAgreement,
		payloadClosureChanged: true,
		skips,
		nextAction: "Review the candidate-bound package, declaration, direct-handler, and installed-payload evidence. Fresh-client receipts separately own native activation, trust, UI, and delegation; this automated proof claims none of them.",
	}
}

/**
 * Run the complete local tagged-install proof without touching operator harness state.
 *
 * @param sourceRoot - Repository root containing canonical plugin and marketplace sources
 * @returns Correlated proof report plus retained temporary evidence paths
 * @throws {Error} When ref, manifest, inventory, native state, or byte comparison fails
 *
 * @example
 * ```typescript
 * const proof = proveHarnessInstall(process.cwd())
 * if (!proof.ok) process.exit(1)
 * ```
 */
export function proveHarnessInstall(
	sourceRoot: string,
	options: HarnessInstallProofOptions = {},
): HarnessInstallProof {
	const executables: NativeHarnessExecutables = {
		claude: Bun.which("claude") ?? undefined,
		codex: Bun.which("codex") ?? undefined,
	}
	if (options.requireNative && (!executables.claude || !executables.codex)) {
		const missing = [!executables.claude && "claude", !executables.codex && "codex"].filter(Boolean)
		throw new Error(`native harness CLIs are required; missing: ${missing.join(", ")}`)
	}
	if (options.qualifyRuntimeJourney && !options.fixtureAcknowledged) {
		throw new Error("native runtime qualification requires --fixture-acknowledged before repair --apply")
	}
	if (options.qualifyRuntimeJourney && (!executables.claude || !executables.codex)) {
		throw new Error("native runtime qualification requires both native harness CLIs")
	}
	const repositoryRoot = resolve(sourceRoot)
	pluginPayloadInventory(repositoryRoot)
	const temporaryRoot = mkdtempSync(join(tmpdir(), "harness-install-proof-"))
	try {
		return runHarnessInstallProof(
			repositoryRoot,
			temporaryRoot,
			executables,
			options.qualifyRuntimeJourney === true,
		)
	} catch (error) {
		rmSync(temporaryRoot, { recursive: true, force: true })
		throw error
	}
}

if (import.meta.main) {
	const arguments_ = process.argv.slice(2)
	if (arguments_.includes("--help") || arguments_.includes("-h")) {
		console.log(help)
		process.exit(0)
	}
	for (const argument of arguments_) {
		if (
			argument !== "--json" &&
			argument !== "--require-native" &&
			argument !== "--fixture-acknowledged" &&
			argument !== "--allow-fixture-copy"
		) {
			console.error(`Error: unknown option: ${argument}`)
			console.error("Run `bun run prove:harness-install -- --help` for usage.")
			process.exit(2)
		}
	}
	if (arguments_.includes("--require-native") && arguments_.includes("--allow-fixture-copy")) {
		console.error("Error: --require-native cannot be combined with --allow-fixture-copy")
		console.error("Run `bun run prove:harness-install -- --help` for usage.")
		process.exit(2)
	}
	if (arguments_.includes("--fixture-acknowledged") && arguments_.includes("--allow-fixture-copy")) {
		console.error("Error: --fixture-acknowledged cannot be combined with --allow-fixture-copy")
		process.exit(2)
	}
	try {
		const nativeQualification = !arguments_.includes("--allow-fixture-copy")
		const proof = proveHarnessInstall(resolve(import.meta.dir, ".."), {
			requireNative: nativeQualification,
			qualifyRuntimeJourney: nativeQualification,
			fixtureAcknowledged: arguments_.includes("--fixture-acknowledged"),
		})
		const temporaryRoot = proof.temporaryRoot
		const cleanedProof = { ...proof, evidenceRetained: false }
		const serializedProof = JSON.stringify(cleanedProof, (_key, value) =>
			redactTemporaryEvidencePath(value, temporaryRoot),
		)
		rmSync(proof.temporaryRoot, { recursive: true, force: true })
		console.log(serializedProof)
	} catch (error) {
		console.error(
			JSON.stringify({
				ok: false,
				category: "harness-install-proof",
				message: error instanceof Error ? error.message : String(error),
				retrySafe: true,
				nextAction: "Fix the reported preflight or isolated native-install failure, then rerun the same command.",
			}),
		)
		process.exit(1)
	}
}
