import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join, resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"
import { payloadInventorySha256, pluginPayloadInventory, PLUGIN_DIRECTORY } from "./plugin-files"

/**
 * Receipt location, outside the canonical payload.
 *
 * Do not move this inside `plugin/`. Two independent guards reject a stray
 * entry there: `verifyLinkedPayload` requires every `plugin/` entry to have a
 * matching symlink in the installed cache, and those links are created by
 * Claude Code's own `plugin install`, which this repository cannot extend, so
 * an unlinked file reports the installation as no longer canonical.
 * `validateBunOnlyPayload` separately rejects any unrecognized payload surface.
 * The release archive is also compared byte for byte across two builds, so a
 * timestamp inside the payload would fail determinism by construction.
 */
export const BUILD_RECEIPT_RELATIVE_PATH = join(".dev", "claude", "build-receipt.json")

/** Contract version for the receipt document itself, independent of the check contract. */
export const BUILD_RECEIPT_SCHEMA_VERSION = 1

/** Outcome of the build attempt the receipt describes. */
export type BuildReceiptOutcome = "succeeded" | "failed"

/** One build attempt, recorded where a later session can read it. */
export interface BuildReceipt {
	schemaVersion: number
	contractId: "plugin.build-receipt"
	/** ISO 8601 instant the build attempt finished. */
	completedAt: string
	outcome: BuildReceiptOutcome
	/** Absolute path of the checkout that produced the payload. */
	checkoutPath: string
	/** Branch name, or undefined in a detached HEAD. */
	branch?: string
	/** Head commit at build time, or undefined outside a git checkout. */
	headCommit?: string
	/** Plugin version from plugin.config.json. */
	pluginVersion: string
	/**
	 * Digest of the payload this build produced.
	 *
	 * Absent on a failed build whose payload could not be inventoried.
	 */
	payloadDigest?: string
	/** Single-line reason, present only when the outcome is failed. */
	failureReason?: string
}

/** Why a receipt could not be believed. */
export type FreshnessStatus =
	| "fresh"
	| "stale"
	| "build-failed"
	| "unproven"

/** Freshness as reported to a session, derived by verification rather than trust. */
export interface Freshness {
	status: FreshnessStatus
	/** Human-readable reason, always present so a session never has to infer one. */
	reason: string
	/** Receipt fields echoed for context, absent when no readable receipt exists. */
	receipt?: {
		completedAt: string
		outcome: BuildReceiptOutcome
		checkoutPath: string
		branch?: string
		headCommit?: string
		pluginVersion: string
		failureReason?: string
	}
}

function gitValue(checkoutPath: string, args: readonly string[]): string | undefined {
	const result = Bun.spawnSync({
		cmd: ["git", ...args],
		cwd: checkoutPath,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) return undefined
	const value = result.stdout.toString().trim()
	return value.length > 0 ? value : undefined
}

function currentBranch(checkoutPath: string): string | undefined {
	const branch = gitValue(checkoutPath, ["rev-parse", "--abbrev-ref", "HEAD"])
	return branch === "HEAD" ? undefined : branch
}

/**
 * Digest the payload as it exists on disk right now.
 *
 * @param checkoutPath - Repository root containing the canonical `plugin/` directory
 * @returns The payload digest, or undefined when the payload cannot be inventoried
 */
export function currentPayloadDigest(checkoutPath: string): string | undefined {
	try {
		const inventory = pluginPayloadInventory(checkoutPath)
		return payloadInventorySha256(resolve(checkoutPath, PLUGIN_DIRECTORY), inventory)
	} catch {
		return undefined
	}
}

/**
 * Absolute path of the receipt for one checkout.
 *
 * @param checkoutPath - Repository root
 * @returns Absolute receipt path outside the plugin payload
 *
 * @example
 * ```ts
 * buildReceiptPath(process.cwd())
 * ```
 */
export function buildReceiptPath(checkoutPath: string): string {
	return join(checkoutPath, BUILD_RECEIPT_RELATIVE_PATH)
}

/**
 * Record one build attempt where a later session can read it.
 *
 * Written for a failed build as well as a successful one, because a failed
 * build that leaves no trace is the invisibility this receipt exists to end.
 * Never throws: a build must not fail because its receipt could not be written,
 * and an unwritten receipt already reports as unproven.
 *
 * @param checkoutPath - Repository root that produced the payload
 * @param outcome - Whether the build attempt succeeded
 * @param failureReason - Single-line reason, recorded only for a failed build
 * @returns The receipt written, or undefined when writing failed
 *
 * @example
 * ```ts
 * writeBuildReceipt(root, "succeeded")
 * ```
 */
/**
 * The version, or `"unknown"` when plugin.config.json cannot be read.
 *
 * The field is required, and a reader rejects a receipt without it, so an
 * unreadable configuration has to yield a value rather than omit the field.
 */
function readPluginVersion(checkoutPath: string): string {
	try {
		return loadPluginConfig(checkoutPath).version
	} catch {
		return "unknown"
	}
}

export function writeBuildReceipt(
	checkoutPath: string,
	outcome: BuildReceiptOutcome,
	failureReason?: string,
): BuildReceipt | undefined {
	try {
		const receipt: BuildReceipt = {
			schemaVersion: BUILD_RECEIPT_SCHEMA_VERSION,
			contractId: "plugin.build-receipt",
			completedAt: new Date().toISOString(),
			outcome,
			checkoutPath: resolve(checkoutPath),
			// An invalid plugin.config.json is a build failure this receipt must
			// still record. Reading it inside the guard below would return
			// without writing, so the failure most likely to break a build would
			// leave `check` reporting `unproven` instead of `build-failed`.
			pluginVersion: readPluginVersion(checkoutPath),
		}
		const branch = currentBranch(checkoutPath)
		if (branch) receipt.branch = branch
		const headCommit = gitValue(checkoutPath, ["rev-parse", "HEAD"])
		if (headCommit) receipt.headCommit = headCommit
		const payloadDigest = currentPayloadDigest(checkoutPath)
		if (payloadDigest) receipt.payloadDigest = payloadDigest
		if (outcome === "failed" && failureReason) {
			receipt.failureReason = failureReason.split("\n", 1)[0]?.slice(0, 500)
		}

		const path = buildReceiptPath(checkoutPath)
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
		const temporaryPath = `${path}.${randomUUID()}.tmp`
		writeFileSync(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
		renameSync(temporaryPath, path)
		return receipt
	} catch {
		return undefined
	}
}

function parseReceipt(value: unknown): BuildReceipt | undefined {
	if (typeof value !== "object" || value === null) return undefined
	const candidate = value as Record<string, unknown>
	if (candidate.contractId !== "plugin.build-receipt") return undefined
	if (typeof candidate.completedAt !== "string") return undefined
	if (candidate.outcome !== "succeeded" && candidate.outcome !== "failed") return undefined
	if (typeof candidate.checkoutPath !== "string") return undefined
	if (typeof candidate.pluginVersion !== "string") return undefined
	// A receipt from another schema can still carry a matching digest, so
	// accepting any number would let it pass verification and report `fresh`.
	if (candidate.schemaVersion !== BUILD_RECEIPT_SCHEMA_VERSION) return undefined
	const receipt: BuildReceipt = {
		schemaVersion: candidate.schemaVersion,
		contractId: "plugin.build-receipt",
		completedAt: candidate.completedAt,
		outcome: candidate.outcome,
		checkoutPath: candidate.checkoutPath,
		pluginVersion: candidate.pluginVersion,
	}
	if (typeof candidate.branch === "string") receipt.branch = candidate.branch
	if (typeof candidate.headCommit === "string") receipt.headCommit = candidate.headCommit
	if (typeof candidate.payloadDigest === "string") receipt.payloadDigest = candidate.payloadDigest
	if (typeof candidate.failureReason === "string") receipt.failureReason = candidate.failureReason
	return receipt
}

/**
 * Read one build receipt, treating every unreadable shape as absent.
 *
 * @param checkoutPath - Repository root whose receipt to read
 * @returns The receipt, or undefined when missing, unreadable, or malformed
 */
export function readBuildReceipt(checkoutPath: string): BuildReceipt | undefined {
	const path = buildReceiptPath(checkoutPath)
	if (!existsSync(path)) return undefined
	try {
		return parseReceipt(JSON.parse(readFileSync(path, "utf8")))
	} catch {
		return undefined
	}
}

function echoed(receipt: BuildReceipt): Freshness["receipt"] {
	const echo: NonNullable<Freshness["receipt"]> = {
		completedAt: receipt.completedAt,
		outcome: receipt.outcome,
		checkoutPath: receipt.checkoutPath,
		pluginVersion: receipt.pluginVersion,
	}
	if (receipt.branch) echo.branch = receipt.branch
	if (receipt.headCommit) echo.headCommit = receipt.headCommit
	if (receipt.failureReason) echo.failureReason = receipt.failureReason
	return echo
}

/**
 * Report whether the payload on disk is the payload the last build produced.
 *
 * The receipt is evidence that can lie: it may describe a payload edited by
 * hand afterwards, or a build that crashed after writing it. Freshness is
 * therefore never reported on the receipt's own word. `fresh` requires a
 * successful build whose recorded digest still matches the payload; every other
 * combination reports stale, failed, or unproven.
 *
 * @param checkoutPath - Repository root serving the live payload
 * @returns Freshness with a reason a session can show a human unchanged
 *
 * @example
 * ```ts
 * const freshness = evaluateFreshness(process.cwd())
 * ```
 */
export function evaluateFreshness(checkoutPath: string): Freshness {
	const receipt = readBuildReceipt(checkoutPath)
	if (!receipt) {
		return {
			status: "unproven",
			reason:
				"No readable build receipt, so the build that produced this payload is unknown. Run bun run build to record one.",
		}
	}

	if (receipt.outcome === "failed") {
		const detail = receipt.failureReason ? `: ${receipt.failureReason}` : ""
		return {
			status: "build-failed",
			reason: `The last build failed at ${receipt.completedAt}${detail}. The payload on disk is from an earlier build, so this session may be serving code that is not on screen.`,
			receipt: echoed(receipt),
		}
	}

	const digest = currentPayloadDigest(checkoutPath)
	if (!digest) {
		return {
			status: "unproven",
			reason:
				"The payload could not be inventoried, so the receipt cannot be verified against it.",
			receipt: echoed(receipt),
		}
	}
	if (!receipt.payloadDigest) {
		return {
			status: "unproven",
			reason: "The receipt records no payload digest, so freshness cannot be verified.",
			receipt: echoed(receipt),
		}
	}
	if (receipt.payloadDigest !== digest) {
		return {
			status: "stale",
			reason: `The payload changed after the build at ${receipt.completedAt}. Run bun run build, then reload plugins, or this session serves the earlier build.`,
			receipt: echoed(receipt),
		}
	}

	return {
		status: "fresh",
		reason: `The payload matches the successful build at ${receipt.completedAt}.`,
		receipt: echoed(receipt),
	}
}
