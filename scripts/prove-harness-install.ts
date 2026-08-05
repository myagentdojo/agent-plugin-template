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
	proveCodexFixtureCopy as runCodexFixtureCopy,
	proveCodexNative as runCodexNative,
} from "./harness-install-codex"
import { copyPluginPayload, pluginPayloadInventory } from "./plugin-files"
import {
	CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY,
	loadPluginConfig,
	type PluginConfig,
	writeGeneratedFiles,
} from "./plugin-config"

const help = `Prove tagged plugin installation in isolated Claude and Codex homes.

Usage:
  bun run prove:harness-install [--allow-fixture-copy] [--json]
  bun run prove:harness-install --help

Options:
  --json       Emit the proof report as JSON. This is also the default output.
  --require-native  Explicitly require both native CLIs (the default).
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
	trust: {
		pluginEnabled: boolean
		hookDefinitionPresent: boolean
		hookTrusted: false
		preTrustExecution: "skipped"
		separateFromEnablement: true
		interactiveAcceptance: string
	}
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
	versionAgreement: true
	trustDefinitionChanged: true
	skips: HarnessSkip[]
	nextAction: string
}

export interface HarnessInstallProofOptions {
	/** Require both real harness CLIs; fixture copies cannot qualify CI or release. */
	requireNative?: boolean
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

function writeFixtureSource(sourceRoot: string, repositoryRoot: string): PluginConfig {
	mkdirSync(repositoryRoot, { recursive: true })
	copyPluginPayload(sourceRoot, join(repositoryRoot, "plugin"))
	for (const relativePath of [
		".claude-plugin/marketplace.json",
		".agents/plugins/marketplace.json",
		"plugin.config.json",
	]) {
		const targetPath = join(repositoryRoot, relativePath)
		mkdirSync(dirname(targetPath), { recursive: true })
		cpSync(join(sourceRoot, relativePath), targetPath)
	}
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
	const runtimePath = join(repositoryRoot, "plugin", "runtime", "hello-world.js")
	writeFileSync(
		runtimePath,
		readFileSync(runtimePath, "utf8").replace(
			`const PLUGIN_VERSION = "${config.version}";`,
			`const PLUGIN_VERSION = "${targetConfig.version}";`,
		),
	)
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

function claudeEnvironment(home: string): Record<string, string | undefined> {
	return { ...process.env, CLAUDE_CONFIG_DIR: home, CI: "1", NO_COLOR: "1" }
}

function codexEnvironment(home: string): Record<string, string | undefined> {
	return { ...process.env, CODEX_HOME: home, CI: "1", NO_COLOR: "1" }
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
		const dataRoot = join(home, "plugins", "data", pluginId)
		const markerPath = join(dataRoot, "u6-marker.txt")
		mkdirSync(dataRoot, { recursive: true })
		writeFileSync(markerPath, `${scope} marker\n`)

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
		command(
			[claudeExecutable, "plugin", "uninstall", pluginId, "--keep-data", "--scope", scope],
			{ cwd: project, env: environment },
		)
		command(
			[claudeExecutable, "plugin", "marketplace", "remove", marketplaceName, "--scope", scope],
			{ cwd: project, env: environment },
		)
		let failureRestored = false
		try {
			throw new Error("injected Claude failure after marketplace removal")
		} catch {
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
			command([claudeExecutable, "plugin", "enable", pluginId, "--scope", scope], {
				cwd: project,
				env: environment,
			})
			const restoredAfterFailure = findClaudeInstall(
				claudeExecutable,
				environment,
				project,
				pluginId,
				scope,
			)
			failureRestored =
				restoredAfterFailure.version === fixture.base.manifestVersion &&
				restoredAfterFailure.enabled &&
				readFileSync(markerPath, "utf8") === `${scope} marker\n`
		}
		if (!failureRestored) throw new Error(`Claude ${scope} failure restoration did not recover state`)
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
	claude: { mode: "native-hosted-marketplace"; version: string; inventory: string[] }
	codex: { mode: "native-hosted-marketplace"; version: string; inventory: string[] }
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
		if (codexInstall.add.version !== claudeManifest.version) {
			throw new Error("Codex hosted install reported the wrong manifest version")
		}
		const codexInventory = comparePayload(expected, codexInstall.add.installedPath)
		return {
			temporaryRoot,
			preflight: expected,
			claude: {
				mode: "native-hosted-marketplace",
				version: claudeInstall.version,
				inventory: claudeInventory,
			},
			codex: {
				mode: "native-hosted-marketplace",
				version: codexInstall.add.version,
				inventory: codexInventory,
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
 * Bind Codex trust review to the version-bearing hook command and executable closure bytes.
 *
 * @param pluginRoot - Installed plugin payload root
 * @returns Exact definition and executable-closure hashes used for review comparison
 * @throws {Error} When the hook definition omits the installed manifest version
 *
 * @example
 * ```typescript
 * const evidence = codexHookTrustEvidence(installedPath)
 * ```
 */
export function codexHookTrustEvidence(pluginRoot: string): {
	version: string
	command: string
	definitionHash: string
	executableClosureHash: string
} {
	const manifest = JSON.parse(
		readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
	)
	const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "codex", "hooks.json"), "utf8"))
	const commandDefinition = hooks.hooks.SessionStart[0].hooks[0].command as string
	if (!commandDefinition.includes(`--plugin-version ${manifest.version}`)) {
		throw new Error("Codex hook definition does not carry the installed plugin version")
	}
	const closure = [
		"bin/hello-world",
		"runtime/hello-world.js",
		...readdirSync(join(pluginRoot, "runtime"))
			.filter((entry) => entry.startsWith("qjs-"))
			.map((entry) => `runtime/${entry}`),
	].sort()
	const closureHash = createHash("sha256")
	for (const relativePath of closure) {
		closureHash.update(relativePath)
		closureHash.update("\0")
		closureHash.update(readFileSync(join(pluginRoot, relativePath)))
	}
	return {
		version: manifest.version,
		command: commandDefinition,
		definitionHash: createHash("sha256").update(commandDefinition).digest("hex"),
		executableClosureHash: closureHash.digest("hex"),
	}
}

function runHarnessInstallProof(
	repositoryRoot: string,
	temporaryRoot: string,
	options: HarnessInstallProofOptions,
): HarnessInstallProof {
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
	const skips: HarnessSkip[] = [
		{
			case: "Codex interactive /hooks trust acceptance",
			reason: "Trust acceptance requires a human interactive task; proof records enabled plus untrusted pre-task state instead.",
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
	const claudeExecutable = Bun.which("claude")
	const codexExecutable = Bun.which("codex")
	if (options.requireNative && (!claudeExecutable || !codexExecutable)) {
		const missing = [!claudeExecutable && "claude", !codexExecutable && "codex"].filter(Boolean)
		throw new Error(`native harness CLIs are required; missing: ${missing.join(", ")}`)
	}
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
	const trustBase = codexHookTrustEvidence(join(fixture.base.checkoutRoot, "plugin"))
	const trustTarget = codexHookTrustEvidence(join(fixture.target.checkoutRoot, "plugin"))
	if (
		trustBase.definitionHash === trustTarget.definitionHash ||
		trustBase.executableClosureHash === trustTarget.executableClosureHash
	) {
		throw new Error("Codex release change did not invalidate exact-definition trust evidence")
	}
	const versionAgreement =
		claude.version === fixture.base.manifestVersion && codex.version === fixture.base.manifestVersion
	if (!versionAgreement) throw new Error("Claude and Codex installed versions do not agree with the tag")
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
		versionAgreement,
		trustDefinitionChanged: true,
		skips,
		nextAction: "Review the JSON evidence; run hosted and interactive qualifications only when their paths changed.",
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
	const repositoryRoot = resolve(sourceRoot)
	pluginPayloadInventory(repositoryRoot)
	const temporaryRoot = mkdtempSync(join(tmpdir(), "harness-install-proof-"))
	try {
		return runHarnessInstallProof(repositoryRoot, temporaryRoot, options)
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
		if (argument !== "--json" && argument !== "--require-native" && argument !== "--allow-fixture-copy") {
			console.error(`Error: unknown option: ${argument}`)
			console.error("Run `bun run prove:harness-install -- --help` for usage.")
			process.exit(2)
		}
	}
	try {
		const proof = proveHarnessInstall(resolve(import.meta.dir, ".."), {
			requireNative: !arguments_.includes("--allow-fixture-copy"),
		})
		const temporaryRoot = proof.temporaryRoot
		const serializedProof = JSON.stringify(proof, (_key, value) =>
			redactTemporaryEvidencePath(value, temporaryRoot),
		)
		rmSync(proof.temporaryRoot, { recursive: true, force: true })
		console.log(serializedProof.replace('"ok":true', '"ok":true,"evidenceRetained":false'))
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
