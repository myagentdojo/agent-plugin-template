/**
 * Captured harness state that recovery must reproduce without approximation.
 *
 * @example
 * ```typescript
 * const snapshot: HarnessRecoverySnapshot = {
 *   source: "/detached/v1.0.0",
 *   ref: "v1.0.0",
 *   version: "1.0.0",
 *   payloadInventory: ["plugin.json"],
 *   enabled: false,
 * }
 * ```
 */
export interface HarnessRecoverySnapshot {
	/** Exact marketplace source selected before mutation. */
	source: string
	/** Immutable release ref selected before mutation. */
	ref: string
	/** Manifest version reported before mutation. */
	version: string
	/** Byte-verified payload inventory from before mutation. */
	payloadInventory: string[]
	/** Harness enablement state from before mutation. */
	enabled: boolean
	/** Claude installation scope when the harness has scopes. */
	scope?: "user" | "project" | "local"
	/** Exact persistent marker contents when the harness owns persistent data. */
	persistentData?: string
}

/**
 * Harness-specific destructive and recovery operations used by the shared fault proof.
 *
 * Claude and Codex are the two production adapters. Keeping the failure boundary here prevents
 * either caller from bypassing the recovery handler with a normal reinstall.
 *
 * @example
 * ```typescript
 * const adapter: HarnessRecoveryAdapter<string> = {
 *   harness: "Codex",
 *   mutate: () => removePlugin(),
 *   restore: () => ({ value: "restored", snapshot: restoredSnapshot }),
 * }
 * ```
 */
export interface HarnessRecoveryAdapter<T> {
	/** Harness name used in actionable failures. */
	harness: "Claude" | "Codex"
	/** Complete destructive phase after which the fault is injected. */
	mutate: () => void
	/** Real restoration path whose result is compared with prior state. */
	restore: () => { value: T; snapshot: HarnessRecoverySnapshot }
}

class InjectedPostMutationFailure extends Error {
	constructor(harness: "Claude" | "Codex") {
		super(`${harness} injected post-mutation failure`)
		this.name = "InjectedPostMutationFailure"
	}
}

function injectPostMutationFailure(harness: "Claude" | "Codex"): never {
	throw new InjectedPostMutationFailure(harness)
}

/**
 * Reject a recovery result that differs from any captured identity or state field.
 *
 * @param prior - Exact state captured before destructive mutation
 * @param restored - State captured after the recovery handler finishes
 * @param harness - Harness name used in mismatch diagnostics
 * @throws {Error} When any restored field differs from the captured state
 *
 * @example
 * ```typescript
 * assertExactHarnessRecovery(priorSnapshot, restoredSnapshot, "Claude")
 * ```
 */
export function assertExactHarnessRecovery(
	prior: HarnessRecoverySnapshot,
	restored: HarnessRecoverySnapshot,
	harness: "Claude" | "Codex",
): void {
	for (const field of [
		"source",
		"ref",
		"version",
		"enabled",
		"scope",
		"persistentData",
	] as const) {
		if (restored[field] !== prior[field]) {
			throw new Error(`${harness} recovery did not restore prior ${field}`)
		}
	}
	if (JSON.stringify(restored.payloadInventory) !== JSON.stringify(prior.payloadInventory)) {
		throw new Error(`${harness} recovery did not restore prior payloadInventory`)
	}
}

/**
 * Prove recovery by faulting after mutation and entering the adapter's restoration handler.
 *
 * A successful mutation can never reach `restore` without the injected failure. The catch block
 * is the recovery boundary being exercised, and it returns only after exact snapshot comparison.
 *
 * @param prior - Exact state captured before mutation
 * @param adapter - Harness-specific destructive and restoration operations
 * @returns Restored harness value after exact-state validation
 * @throws {Error} When mutation fails unexpectedly, restoration fails, or restored state differs
 *
 * @example
 * ```typescript
 * const restored = provePostMutationRecovery(priorSnapshot, adapter)
 * ```
 */
export function provePostMutationRecovery<T>(
	prior: HarnessRecoverySnapshot,
	adapter: HarnessRecoveryAdapter<T>,
): T {
	try {
		adapter.mutate()
		injectPostMutationFailure(adapter.harness)
	} catch (error) {
		if (!(error instanceof InjectedPostMutationFailure)) throw error
		const restored = adapter.restore()
		assertExactHarnessRecovery(prior, restored.snapshot, adapter.harness)
		return restored.value
	}
}
