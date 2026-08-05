import { createHash } from "node:crypto"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { copyPluginPayload } from "./plugin-files"
import type {
	CodexInstallState,
	CodexProof,
	FixtureRelease,
	ReplacementAdmissionInput,
	TaggedCheckout,
} from "./prove-harness-install"

export interface CodexDriverDependencies {
	install: (
		executable: string,
		marketplaceRoot: string,
		pluginId: string,
		environment: Record<string, string | undefined>,
		cwd: string,
	) => CodexInstallState
	remove: (
		executable: string,
		pluginId: string,
		marketplaceName: string,
		environment: Record<string, string | undefined>,
		cwd: string,
	) => void
	comparePayload: (checkout: TaggedCheckout, installedPath: string) => string[]
	environment: (home: string) => Record<string, string | undefined>
	assertReplacementAdmission: (input: ReplacementAdmissionInput) => unknown
}

function digestFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

/** Execute Codex add, upgrade, rollback, and restoration through native JSON commands. */
export function proveCodexNative(
	fixture: FixtureRelease,
	pluginName: string,
	codexExecutable: string,
	temporaryRoot: string,
	dependencies: CodexDriverDependencies,
): CodexProof {
	const marketplaceName = pluginName
	const pluginId = `${pluginName}@${marketplaceName}`
	const home = join(temporaryRoot, "codex", "home")
	const project = join(temporaryRoot, "codex", "project")
	mkdirSync(home, { recursive: true })
	mkdirSync(project, { recursive: true })
	const environment = dependencies.environment(home)
	const initial = dependencies.install(
		codexExecutable,
		fixture.base.checkoutRoot,
		pluginId,
		environment,
		project,
	)
	if (initial.add.version !== fixture.base.manifestVersion) {
		throw new Error("Codex install reported the wrong tagged manifest version")
	}
	const initialInventory = dependencies.comparePayload(fixture.base, initial.add.installedPath)
	const initialRuntimeDigest = digestFile(join(initial.add.installedPath, "runtime", "hello-world.js"))

	dependencies.assertReplacementAdmission({
		target: fixture.target,
		restoration: fixture.base,
		allowedRefs: [fixture.base.requestedRef, fixture.target.requestedRef],
		managed: false,
		removable: true,
	})
	dependencies.remove(codexExecutable, pluginId, marketplaceName, environment, project)
	const upgraded = dependencies.install(
		codexExecutable,
		fixture.target.checkoutRoot,
		pluginId,
		environment,
		project,
	)
	const upgradedInventory = dependencies.comparePayload(fixture.target, upgraded.add.installedPath)
	const upgradedRuntimeDigest = digestFile(join(upgraded.add.installedPath, "runtime", "hello-world.js"))
	if (initialRuntimeDigest === upgradedRuntimeDigest) {
		throw new Error("Codex local reinstall did not change installed bytes")
	}

	dependencies.remove(codexExecutable, pluginId, marketplaceName, environment, project)
	let restored = dependencies.install(
		codexExecutable,
		fixture.base.checkoutRoot,
		pluginId,
		environment,
		project,
	)
	const restoredInventory = dependencies.comparePayload(fixture.base, restored.add.installedPath)
	if (restored.plugin.enabled !== initial.plugin.enabled) {
		throw new Error("Codex rollback did not restore the prior enabled state")
	}
	dependencies.remove(codexExecutable, pluginId, marketplaceName, environment, project)
	restored = dependencies.install(
		codexExecutable,
		fixture.base.checkoutRoot,
		pluginId,
		environment,
		project,
	)
	const recoveredInventory = dependencies.comparePayload(fixture.base, restored.add.installedPath)
	const failureRestored =
		restored.add.version === fixture.base.manifestVersion &&
		restored.plugin.enabled === initial.plugin.enabled &&
		recoveredInventory.join("\n") === restoredInventory.join("\n")
	if (!failureRestored) {
		throw new Error("Codex interrupted-state restoration did not recover version, enablement, and payload")
	}
	const marketplaceState = restored.marketplace.marketplaces.find(
		(entry: { name?: string }) => entry.name === marketplaceName,
	)
	if (!marketplaceState) throw new Error("Codex marketplace JSON omitted the active marketplace")
	if (marketplaceState.marketplaceSource?.sourceType !== "local") {
		throw new Error("Codex local proof did not report a local marketplace cache source")
	}
	const hookSource = readFileSync(
		join(restored.add.installedPath, "hooks", "codex", "hooks.json"),
		"utf8",
	)
	if (!hookSource.includes(`--plugin-version ${fixture.base.manifestVersion}`)) {
		throw new Error("Codex installed hook is not bound to the tagged plugin version")
	}
	return {
		mode: "native-local-marketplace",
		version: restored.add.version,
		installedPath: restored.add.installedPath,
		inventory: recoveredInventory,
		requestedRef: fixture.base.requestedRef,
		resolvedSha: fixture.base.resolvedSha,
		marketplaceIdentity: marketplaceName,
		configuredSource: fixture.repositoryRoot,
		configuredRef: fixture.base.requestedRef,
		installedMarketplaceRoot: marketplaceState.root,
		enabled: restored.plugin.enabled,
		installPolicy: restored.plugin.installPolicy,
		authPolicy: restored.plugin.authPolicy,
		marketplaceCacheVersion: "local",
		jsonEvidence: {
			marketplaceAdd: restored.marketplaceAdd,
			marketplaceList: restored.marketplace,
			pluginAdd: restored.add,
			pluginList: restored.list,
		},
		localRefresh: {
			initialInstalledPath: initial.add.installedPath,
			upgradedInstalledPath: upgraded.add.installedPath,
			initialInventory,
			upgradedInventory,
			bytesChanged: true,
			rolledBack: true,
			enabledStateRestored: true,
			failureRestored,
		},
		trust: {
			pluginEnabled: restored.plugin.enabled,
			hookDefinitionPresent: true,
			hookTrusted: false,
			preTrustExecution: "skipped",
			separateFromEnablement: true,
			interactiveAcceptance: "skipped: /hooks trust acceptance requires a human interactive task",
		},
	}
}

/** Development-only byte-copy fallback. Never qualifies CI or release. */
export function proveCodexFixtureCopy(
	fixture: FixtureRelease,
	pluginName: string,
	temporaryRoot: string,
	comparePayload: CodexDriverDependencies["comparePayload"],
): CodexProof {
	const installedPath = join(
		temporaryRoot,
		"codex-fixture-home",
		"plugins",
		"cache",
		pluginName,
		pluginName,
		fixture.base.manifestVersion,
	)
	copyPluginPayload(fixture.base.checkoutRoot, installedPath)
	return {
		mode: "fixture-copy",
		version: fixture.base.manifestVersion,
		installedPath,
		inventory: comparePayload(fixture.base, installedPath),
		requestedRef: fixture.base.requestedRef,
		resolvedSha: fixture.base.resolvedSha,
		marketplaceIdentity: pluginName,
		configuredSource: fixture.repositoryRoot,
		configuredRef: fixture.base.requestedRef,
		installedMarketplaceRoot: fixture.base.checkoutRoot,
		enabled: true,
		installPolicy: "AVAILABLE",
		authPolicy: "ON_INSTALL",
		marketplaceCacheVersion: "local",
		jsonEvidence: null,
		localRefresh: {
			bytesChanged: false,
			rolledBack: false,
			enabledStateRestored: false,
			failureRestored: false,
		},
		trust: {
			pluginEnabled: true,
			hookDefinitionPresent: true,
			hookTrusted: false,
			preTrustExecution: "skipped",
			separateFromEnablement: true,
			interactiveAcceptance: "skipped: Codex CLI unavailable",
		},
	}
}
