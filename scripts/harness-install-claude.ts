import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { provePostMutationRecovery } from "./harness-install-recovery"
import { QUALIFICATION_CLIENT_HARNESSES } from "./harness-identity"
import { CLAUDE_DISABLED_BY_DEFAULT_COMPATIBILITY } from "./plugin-config"
import type {
	ClaudeInstall,
	ClaudeProof,
	ClaudeScope,
	ClaudeScopeProof,
	FixtureRelease,
	TaggedCheckout,
} from "./prove-harness-install"

/**
 * Claude-shaped native operations kept injectable across local and hosted install proofs.
 *
 * The surface follows Claude's scoped marketplace lifecycle instead of mirroring Codex JSON APIs.
 */
export interface ClaudeDriverDependencies {
	addMarketplace: (
		executable: string,
		marketplaceRoot: string,
		scope: ClaudeScope,
		environment: Record<string, string | undefined>,
		cwd: string,
	) => void
	command: (
		commandArguments: string[],
		options: { cwd: string; env: Record<string, string | undefined> },
	) => void
	comparePayload: (checkout: TaggedCheckout, installedPath: string) => string[]
	environment: (home: string) => Record<string, string | undefined>
	findInstall: (
		executable: string,
		environment: Record<string, string | undefined>,
		cwd: string,
		pluginId: string,
		scope: ClaudeScope,
	) => ClaudeInstall
	replaceInstall: (
		executable: string,
		pluginId: string,
		marketplaceName: string,
		marketplaceRoot: string,
		scope: ClaudeScope,
		environment: Record<string, string | undefined>,
		cwd: string,
	) => ClaudeInstall
}

/**
 * Prove Claude's scoped install, replacement, rollback, and recovery lifecycle.
 *
 * @param fixture - Immutable base and target release checkouts
 * @param pluginName - Shared plugin and marketplace identity
 * @param claudeExecutable - Native Claude CLI executable
 * @param temporaryRoot - Isolated proof root
 * @param dependencies - Claude-specific native operations
 * @returns Native Claude proof with one result per supported scope
 * @throws {Error} When native state, bytes, or recovery differ from the captured release
 */
export function proveClaudeNative(
	fixture: FixtureRelease,
	pluginName: string,
	claudeExecutable: string,
	temporaryRoot: string,
	dependencies: ClaudeDriverDependencies,
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
		const environment = dependencies.environment(home)
		dependencies.addMarketplace(
			claudeExecutable,
			fixture.base.checkoutRoot,
			scope,
			environment,
			project,
		)
		dependencies.command([claudeExecutable, "plugin", "install", pluginId, "--scope", scope], {
			cwd: project,
			env: environment,
		})
		const initial = dependencies.findInstall(
			claudeExecutable,
			environment,
			project,
			pluginId,
			scope,
		)
		if (initial.enabled) throw new Error("Claude installed a default-disabled plugin as enabled")
		const initialInventory = dependencies.comparePayload(fixture.base, initial.activeCachePath)
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

		const upgraded = dependencies.replaceInstall(
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
		const rolledBack = dependencies.replaceInstall(
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
		const restoredAfterFailure = provePostMutationRecovery(priorRecovery, {
			harness: QUALIFICATION_CLIENT_HARNESSES["claude-cli"],
			mutate: () => {
				dependencies.command(
					[claudeExecutable, "plugin", "uninstall", pluginId, "--keep-data", "--scope", scope],
					{ cwd: project, env: environment },
				)
				dependencies.command(
					[claudeExecutable, "plugin", "marketplace", "remove", marketplaceName, "--scope", scope],
					{ cwd: project, env: environment },
				)
			},
			restore: () => {
				dependencies.addMarketplace(
					claudeExecutable,
					fixture.base.checkoutRoot,
					scope,
					environment,
					project,
				)
				dependencies.command(
					[claudeExecutable, "plugin", "install", pluginId, "--scope", scope],
					{
						cwd: project,
						env: environment,
					},
				)
				const restored = dependencies.findInstall(
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
						payloadInventory: dependencies.comparePayload(
							fixture.base,
							restored.activeCachePath,
						),
						enabled: restored.enabled,
						scope: restored.scope,
						persistentData: readFileSync(markerPath, "utf8"),
					},
				}
			},
		})
		const failureRestored = true
		dependencies.command([claudeExecutable, "plugin", "enable", pluginId, "--scope", scope], {
			cwd: project,
			env: environment,
		})
		const activeAfterFailure = dependencies.findInstall(
			claudeExecutable,
			environment,
			project,
			pluginId,
			scope,
		)
		const orphanedCachePath = join(dirname(activeAfterFailure.activeCachePath), "0.0.0-orphaned")
		mkdirSync(orphanedCachePath, { recursive: true })
		writeFileSync(join(orphanedCachePath, "orphan-marker.txt"), "not active\n")
		const hostSelected = dependencies.findInstall(
			claudeExecutable,
			environment,
			project,
			pluginId,
			scope,
		)
		if (hostSelected.activeCachePath === orphanedCachePath) {
			throw new Error("Claude proof selected an orphaned cache directory")
		}
		const inventory = dependencies.comparePayload(fixture.base, hostSelected.activeCachePath)
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
		mode: "native-local-marketplace",
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
