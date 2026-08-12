import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

import {
	CodexProductionUpdateError,
	runCodexProductionUpdate,
} from "./codex-production-update"

/**
 * Rendered command contract for the production Plugin Installation update workflow.
 *
 * @example
 * ```ts
 * process.stdout.write(UPDATE_HELP)
 * ```
 */
export const UPDATE_HELP = `Select and verify one immutable Codex Plugin Release.

Usage:
  bun run update -- --harness codex [--target latest|vX.Y.Z] [--apply] [--json] [--no-input]
  bun run update -- --help

Flow:
  Preview by default. Inspect the current Marketplace and Plugin Installation,
  select one stable immutable Release, and preflight update plus recovery.
  Add --apply to authorize the previewed remove, repin, install, and verify transaction.

Examples:
  bun run update -- --harness codex
  bun run update -- --harness codex --target v1.2.3 --apply
  bun run update -- --harness codex --target latest --apply --json --no-input

Options:
  --harness codex       Update one Codex CLI Marketplace installation.
  --target <release>    Select latest stable Release or an explicit immutable vX.Y.Z tag.
  --apply               Authorize the previewed mutation. Omit for read-only preview.
  --json                Emit one stable machine result on stdout.
  --no-input            Disable prompts and fail when authority or input is absent.
  -h, --help            Show this help.

Side effects:
  Preview: GitHub and Git reads plus temporary detached checkouts.
  Apply: removes and reinstalls one Codex Marketplace and Plugin Installation.

Codex distinction:
  codex plugin marketplace upgrade refreshes the configured ref.
  This command selects a newer immutable Release, then repins the Marketplace.
`

/** Stable retry judgment for the production update transaction. */
export type UpdateRetrySafety = "safe" | "unsafe" | "inspect_required"

/** Stable transaction states exposed to scripts and agents. */
export type UpdateTransactionState =
	| "blocked"
	| "previewed"
	| "no_op"
	| "updated"
	| "restored"
	| "unknown"

/** Machine-readable failed update result emitted without raw subprocess output. */
export interface UpdateFailureResult {
	/** Contract revision for additive consumer validation. */
	schemaVersion: 1
	/** Package-owned result vocabulary. */
	contractId: "plugin.production-update"
	/** Correlation identifier for one invocation. */
	runId: string
	/** Discriminator for failed results. */
	ok: false
	/** Stable failure family. */
	category: string
	/** Safe human summary without credentials or command output. */
	message: string
	/** Whether the Plugin Installation changed during this run. */
	changed: boolean
	/** Terminal transaction state. */
	transactionState: UpdateTransactionState
	/** Same-input retry judgment. */
	retrySafety: UpdateRetrySafety
	/** Bounded side effects completed before failure. */
	sideEffects: string[]
	/** One current safe continuation. */
	nextAction: string
}

interface UpdateInvocation {
	harness?: string
	target: string
	apply: boolean
	json: boolean
	noInput: boolean
}

class UsageError extends Error {}

function valueAfter(arguments_: string[], index: number, option: string): string {
	const value = arguments_[index + 1]
	if (!value || value.startsWith("--")) throw new UsageError(`${option} requires a value`)
	return value
}

function parseInvocation(arguments_: string[]): UpdateInvocation {
	const invocation: UpdateInvocation = {
		target: "latest",
		apply: false,
		json: false,
		noInput: false,
	}
	const seen = new Set<string>()
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (seen.has(argument)) throw new UsageError(`${argument} may be provided once`)
		switch (argument) {
			case "--harness":
				seen.add(argument)
				invocation.harness = valueAfter(arguments_, index, argument)
				index += 1
				break
			case "--target":
				seen.add(argument)
				invocation.target = valueAfter(arguments_, index, argument)
				index += 1
				break
			case "--apply":
				seen.add(argument)
				invocation.apply = true
				break
			case "--json":
				seen.add(argument)
				invocation.json = true
				break
			case "--no-input":
				seen.add(argument)
				invocation.noInput = true
				break
			default:
				throw new UsageError(`unknown option: ${argument}`)
		}
	}
	return invocation
}

function failureResult(runId: string, category: string, message: string): UpdateFailureResult {
	return {
		schemaVersion: 1,
		contractId: "plugin.production-update",
		runId,
		ok: false,
		category,
		message,
		changed: false,
		transactionState: "blocked",
		retrySafety: "safe",
		sideEffects: [],
		nextAction: "bun run update -- --help",
	}
}

function operationalFailureResult(
	runId: string,
	error: CodexProductionUpdateError,
): UpdateFailureResult {
	return {
		schemaVersion: 1,
		contractId: "plugin.production-update",
		runId,
		ok: false,
		category: error.category,
		message: error.message,
		changed: error.changed,
		transactionState: error.transactionState,
		retrySafety: error.retrySafety,
		sideEffects: error.sideEffects,
		nextAction: error.nextAction,
	}
}

/**
 * Execute the thin update command dispatcher.
 *
 * @param arguments_ - Public arguments after the package script separator
 * @returns POSIX process exit status
 *
 * @example
 * ```ts
 * process.exit(main(["--harness", "codex"]))
 * ```
 */
export function main(arguments_: string[]): number {
	if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
		process.stdout.write(UPDATE_HELP)
		return 0
	}
	const runId = randomUUID()
	try {
		const invocation = parseInvocation(arguments_)
		if (invocation.harness !== "codex") throw new UsageError("--harness must be codex")
		if (
			invocation.target !== "latest" &&
			!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(invocation.target)
		) {
			throw new UsageError("--target must be latest or an immutable vX.Y.Z tag")
		}
		const result = runCodexProductionUpdate({
			target: invocation.target,
			apply: invocation.apply,
			runId,
			repositoryRoot: resolve(import.meta.dir, ".."),
			environment: process.env,
		})
		if (invocation.json) process.stdout.write(`${JSON.stringify(result)}\n`)
		else {
			const status =
				result.transactionState === "no_op" ? "Unchanged" : result.mode === "preview" ? "Preview" : "Updated"
			process.stdout.write(
				`${status}: ${result.prior.ref} -> ${result.selectedRelease.tag}\n${result.nextAction}\n`,
			)
		}
		return 0
	} catch (error) {
		if (error instanceof CodexProductionUpdateError) {
			const result = operationalFailureResult(runId, error)
			if (arguments_.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`)
			process.stderr.write(`update: ${error.category}: ${error.message} [run ${runId}]\n`)
			return 1
		}
		if (!(error instanceof UsageError)) {
			const result: UpdateFailureResult = {
				schemaVersion: 1,
				contractId: "plugin.production-update",
				runId,
				ok: false,
				category: "internal",
				message: "Unexpected update failure; native state was not proven changed",
				changed: false,
				transactionState: "blocked",
				retrySafety: "inspect_required",
				sideEffects: [],
				nextAction: "Inspect the current Codex Plugin Installation before retrying.",
			}
			if (arguments_.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`)
			process.stderr.write(`update: internal: unexpected failure [run ${runId}]\n`)
			return 1
		}
		const message = error instanceof Error ? error.message : "invalid command usage"
		const result = failureResult(runId, "usage", message)
		if (arguments_.includes("--json")) process.stdout.write(`${JSON.stringify(result)}\n`)
		process.stderr.write(`update: ${message}\n`)
		return 2
	}
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
