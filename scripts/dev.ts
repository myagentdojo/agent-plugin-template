import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
	ClaudeDevelopmentInstallationError,
	claudeWatchSources,
	runClaudeDevelopmentInstallation,
	type ClaudeDevelopmentErrorAction,
	type ClaudeDevelopmentOperation,
} from "./claude-development-installation"
import {
	HARNESS_IDENTITIES,
	QUALIFICATION_CLIENT_HARNESSES,
	type HarnessId,
} from "./harness-identity"
import { copyPluginPayload } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

export { claudeWatchSources }

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const pluginName = pluginConfig.name
const developmentMarketplaceName = `${pluginName}-dev`
const developmentRoot = join(root, ".dev", "codex-marketplace")
const stagedPluginRoot = join(developmentRoot, "plugins", pluginName)

const topLevelHelp = `Develop the complete Plugin Payload through each native harness.

Usage:
  bun run dev -- claude <check|install|restore|watch> [options]
  bun run dev -- codex [--check] [--no-launch] [--dry-run] [--json]
  bun run dev -- --help

Commands:
  claude              Manage one persistent live-linked Claude Development Installation
  codex               Build, stage, reinstall, and optionally launch Codex

Run \`bun run dev -- claude --help\` for the Claude lifecycle and safety contract.
`

const claudeHelp = `Manage one persistent live-linked Claude Code Development Installation.

Usage:
  bun run dev -- claude check [--json] [--no-input]
  bun run dev -- claude install [--apply] [--json] [--no-input]
  bun run dev -- claude restore [--apply] [--json] [--no-input]
  bun run dev -- claude watch [--json] [--no-input]

Actions:
  check               Build, validate, and inspect without changing Claude profile state
  install             Preview production-to-development replacement; --apply executes it
  restore             Preview exact prior-state restoration; --apply executes it
  watch               Build once, then watch sources; never launches Claude

Options:
  --apply              Authorize the previewed install or restore mutation
  --json               Emit one stable machine result on stdout
  --no-input           Assert the non-interactive path; this command never prompts
  -h, --help           Show this help

Examples:
  bun run dev -- claude check --json --no-input
  bun run dev -- claude install
  bun run dev -- claude install --apply
  bun run dev:claude
  bun run dev -- claude restore --apply

Safety:
  Production and development identities are never retained together. Install and
  restore fail closed on ambiguous or non-user state. Persistent mutations require
  --apply. Build and watch write repository output but do not change Claude settings.
`

const codexHelp = `Usage: bun run dev -- codex [options]

Options:
  --check             Build and stage only; do not change Codex profile state
  --no-launch         Prepare Codex but do not launch it
  --dry-run           Print the plan without writes or harness commands
  --json              Emit the dry-run plan as JSON
  -h, --help          Show this help
`

interface ClaudeInvocation {
	harness: "claude"
	operation: ClaudeDevelopmentOperation
	apply: boolean
	json: boolean
	noInput: boolean
}

interface CodexInvocation {
	harness: "codex"
	check: boolean
	launch: boolean
	dryRun: boolean
	json: boolean
}

type Invocation = ClaudeInvocation | CodexInvocation

class UsageError extends Error {}

function parseClaude(arguments_: string[]): ClaudeInvocation {
	const operation = arguments_[0] as ClaudeDevelopmentOperation | undefined
	if (!operation || !["check", "install", "restore", "watch"].includes(operation)) {
		throw new UsageError("claude requires check, install, restore, or watch")
	}
	let apply = false
	let json = false
	let noInput = false
	const seen = new Set<string>()
	for (const argument of arguments_.slice(1)) {
		if (seen.has(argument)) throw new UsageError(`${argument} may be provided once`)
		seen.add(argument)
		switch (argument) {
			case "--apply":
				apply = true
				break
			case "--json":
				json = true
				break
			case "--no-input":
				noInput = true
				break
			default:
				throw new UsageError(`unknown Claude option: ${argument}`)
		}
	}
	if (apply && !["install", "restore"].includes(operation)) {
		throw new UsageError("--apply is supported only by claude install and claude restore")
	}
	return { harness: "claude", operation, apply, json, noInput }
}

function parseCodex(arguments_: string[]): CodexInvocation {
	const flags = new Set(arguments_)
	for (const flag of flags) {
		if (!["--check", "--no-launch", "--dry-run", "--json"].includes(flag)) {
			throw new UsageError(`unknown Codex option: ${flag}`)
		}
	}
	if (flags.has("--json") && !flags.has("--dry-run")) {
		throw new UsageError("Codex --json requires --dry-run")
	}
	return {
		harness: "codex",
		check: flags.has("--check"),
		launch: !flags.has("--no-launch") && !flags.has("--check"),
		dryRun: flags.has("--dry-run"),
		json: flags.has("--json"),
	}
}

function parseInvocation(arguments_: string[]): Invocation {
	const harness = arguments_[0] as HarnessId | undefined
	if (!harness || !Object.hasOwn(HARNESS_IDENTITIES, harness)) {
		throw new UsageError("expected the claude or codex harness")
	}
	return harness === QUALIFICATION_CLIENT_HARNESSES["claude-cli"]
		? parseClaude(arguments_.slice(1))
		: parseCodex(arguments_.slice(1))
}

function run(command: string[], environment = process.env): void {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: root,
		env: environment,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
}

function build(): void {
	run(["bun", "run", "build"])
}

function cachebuster(): string {
	return new Date().toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14)
}

function stageCodexPlugin(): string {
	rmSync(stagedPluginRoot, { recursive: true, force: true })
	mkdirSync(stagedPluginRoot, { recursive: true })
	copyPluginPayload(root, stagedPluginRoot)

	const manifestPath = join(stagedPluginRoot, ".codex-plugin", "plugin.json")
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
	manifest.version = `${manifest.version}+codex.local-${cachebuster()}`
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

	const marketplace = {
		name: developmentMarketplaceName,
		interface: { displayName: `${pluginConfig.displayName} Development` },
		plugins: [
			{
				name: pluginName,
				source: { source: "local", path: `./plugins/${pluginName}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: "Developer Tools",
			},
		],
	}
	const marketplacePath = join(developmentRoot, ".agents", "plugins", "marketplace.json")
	mkdirSync(join(developmentRoot, ".agents", "plugins"), { recursive: true })
	writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
	return manifest.version
}

function codexMarketplaceExists(): boolean {
	const result = Bun.spawnSync({
		cmd: ["codex", "plugin", "marketplace", "list", "--json"],
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		process.stderr.write(result.stderr)
		process.exit(result.exitCode)
	}
	const output = JSON.parse(result.stdout.toString())
	const marketplace = output.marketplaces.find(
		(marketplace: { name?: string }) => marketplace.name === developmentMarketplaceName,
	)
	if (!marketplace) return false
	if (resolve(marketplace.root) !== resolve(developmentRoot)) {
		throw new Error(
			`Codex marketplace ${developmentMarketplaceName} already points at ${marketplace.root}. Remove or rename that marketplace before continuing.`,
		)
	}
	return true
}

function runCodex(options: CodexInvocation): void {
	build()
	const version = stageCodexPlugin()
	console.log(`Staged complete plugin ${version}`)
	if (options.check) {
		console.log("Codex development check passed: no Codex profile changed.")
		return
	}

	if (!codexMarketplaceExists()) {
		run(["codex", "plugin", "marketplace", "add", developmentRoot])
	}
	run(["codex", "plugin", "add", `${pluginName}@${developmentMarketplaceName}`, "--json"])
	console.error("Codex installed the staged skills, hooks, manifests, and runtime.")
	console.error("A fresh task is the reload boundary.")
	if (options.launch) run(["codex"])
}

function developmentFailure(
	runId: string,
	invocation: ClaudeInvocation,
	error: ClaudeDevelopmentInstallationError,
): Record<string, unknown> {
	const action: ClaudeDevelopmentErrorAction = error.action
	return {
		schemaVersion: 1,
		contractId: "plugin.development-installation",
		runId,
		ok: false,
		harness: "claude",
		operation: invocation.operation,
		mode:
			invocation.operation === "check"
				? "inspect"
				: invocation.operation === "watch"
					? "watch"
					: invocation.apply
						? "apply"
						: "preview",
		changed: error.changed,
		transactionState: error.transactionState,
		retrySafety: error.retrySafety,
		sideEffects: error.sideEffects,
		error: {
			name: error.name,
			code: error.code,
			action,
			retryable: error.retrySafety === "safe",
			errorFamily: error.errorFamily,
			hintVersion: 1,
			severity: error.transactionState === "unknown" ? "critical" : "error",
			recoverability:
				error.transactionState === "unknown"
					? "inspect"
					: error.retrySafety === "safe"
						? "retry"
						: "manual",
			safeToRetrySameInput: error.retrySafety === "safe",
		},
		message: error.message,
		nextAction: error.nextAction,
	}
}

async function main(arguments_: string[]): Promise<number> {
	if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h") {
		process.stdout.write(topLevelHelp)
		return 0
	}
	if (
		arguments_[0] === QUALIFICATION_CLIENT_HARNESSES["claude-cli"] &&
		(arguments_.length === 1 || arguments_.includes("--help") || arguments_.includes("-h"))
	) {
		process.stdout.write(claudeHelp)
		return 0
	}
	if (
		arguments_[0] === QUALIFICATION_CLIENT_HARNESSES["codex-cli"] &&
		(arguments_.includes("--help") || arguments_.includes("-h"))
	) {
		process.stdout.write(codexHelp)
		return 0
	}

	const runId = randomUUID()
	let invocation: Invocation
	try {
		invocation = parseInvocation(arguments_)
	} catch (error) {
		const message = error instanceof Error ? error.message : "invalid command usage"
		process.stderr.write(`dev: ${message}\n`)
		return 2
	}

	if (invocation.harness === QUALIFICATION_CLIENT_HARNESSES["claude-cli"]) {
		try {
			const output = await runClaudeDevelopmentInstallation({
				operation: invocation.operation,
				apply: invocation.apply,
				runId,
				repositoryRoot: root,
				environment: process.env,
			})
			if (invocation.json) process.stdout.write(`${JSON.stringify(output)}\n`)
			else process.stdout.write(`${output.transactionState}: ${output.nextAction}\n`)
			return 0
		} catch (error) {
			const failure =
				error instanceof ClaudeDevelopmentInstallationError
					? error
					: new ClaudeDevelopmentInstallationError(
							"INTERNAL_FAILURE",
							"Unexpected development lifecycle failure; native state was not proven",
							{
								action: "ESCALATE",
								errorFamily: "internal",
								retrySafety: "inspect_required",
								nextAction:
									"Report this run id with the command that produced it; the lifecycle proved no native state.",
							},
						)
			if (invocation.json)
				process.stdout.write(`${JSON.stringify(developmentFailure(runId, invocation, failure))}\n`)
			process.stderr.write(`dev: ${failure.code}: ${failure.message} [run ${runId}]\n`)
			return 1
		}
	}

	if (invocation.dryRun) {
		const plan = {
			harness: invocation.harness,
			build: "bun run build",
			source: stagedPluginRoot,
			install: `codex plugin add ${pluginName}@${developmentMarketplaceName}`,
			reload: "Start a fresh Codex task after reinstall",
		}
		if (invocation.json) console.log(JSON.stringify(plan))
		else console.log(Object.values(plan).join("\n"))
		return 0
	}
	runCodex(invocation)
	return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
