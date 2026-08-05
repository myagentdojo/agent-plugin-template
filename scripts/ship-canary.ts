import { resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const help = `Publish merged plugin source to public and private canary repositories.

Usage:
  bun run ship:canary -- --dry-run [--json]
  bun run ship:canary -- --execute [--json]

Options:
  --ref <git-ref>    Merged source ref to publish (default: origin/main)
  --dry-run          Prove identity, source, visibility, and target lineage without writes
  --execute          Create missing canaries, fast-forward main, and wait for CI
  --json             Emit one JSON result on stdout
  -h, --help         Show this help

Safety:
  Publishing changes GitHub repositories. The command never force-pushes.
  Active gh identity must match plugin.config.json canary.owner.
`

type Visibility = "PUBLIC" | "PRIVATE"

interface Options {
	ref: string
	dryRun: boolean
	execute: boolean
	json: boolean
}

interface Target {
	repository: string
	visibility: Visibility
	remote: string
	exists: boolean
	lineage: "missing" | "empty" | "current" | "fast-forward"
	headSha?: string
}

interface HostedRun {
	repository: string
	databaseId: number
	conclusion: string
	url: string
}

interface Preflight {
	identity: string
	sourceSha: string
	targets: Target[]
}

class CanaryError extends Error {
	constructor(
		readonly category: string,
		message: string,
		readonly nextAction: string,
		readonly retrySafe = true,
	) {
		super(message)
	}
}

function optionValue(arguments_: string[], name: string, fallback: string): string {
	const index = arguments_.indexOf(name)
	if (index === -1) return fallback
	const value = arguments_[index + 1]
	if (!value || value.startsWith("--")) {
		throw new CanaryError("usage", `${name} requires a value`, "bun run ship:canary -- --help")
	}
	return value
}

function parseOptions(arguments_: string[]): Options | null {
	if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
		console.log(help)
		return null
	}
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (argument === "--ref") {
			index += 1
			continue
		}
		if (!["--dry-run", "--execute", "--json"].includes(argument)) {
			throw new CanaryError("usage", `unknown option: ${argument}`, "bun run ship:canary -- --help")
		}
	}
	const dryRun = arguments_.includes("--dry-run")
	const execute = arguments_.includes("--execute")
	if (dryRun === execute) {
		throw new CanaryError(
			"usage",
			"choose exactly one of --dry-run or --execute",
			"bun run ship:canary -- --dry-run",
		)
	}
	return {
		ref: optionValue(arguments_, "--ref", "origin/main"),
		dryRun,
		execute,
		json: arguments_.includes("--json"),
	}
}

function processResult(command: string[], allowFailure = false): string | undefined {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		if (allowFailure) return undefined
		throw new CanaryError(
			"command_failed",
			`${command.join(" ")} failed: ${result.stderr.toString().trim()}`,
			"repair the reported command and rerun with the same arguments",
		)
	}
	return result.stdout.toString().trim()
}

function targetRemote(origin: string, repository: string): string {
	const scp = /^(?<prefix>[^:]+):[^/]+\/[^/]+(?:\.git)?$/.exec(origin)
	if (scp?.groups?.prefix) return `${scp.groups.prefix}:${repository}.git`
	const url = /^(?<prefix>(?:https?|ssh):\/\/[^/]+)\/[^/]+\/[^/]+(?:\.git)?$/.exec(origin)
	if (url?.groups?.prefix) return `${url.groups.prefix}/${repository}.git`
	throw new CanaryError(
		"remote_unsupported",
		`cannot derive canary transport from origin URL: ${origin}`,
		"use an SSH or HTTPS GitHub origin URL",
	)
}

function repositoryVisibility(repository: string): Visibility | undefined {
	const output = processResult(
		["gh", "repo", "view", repository, "--json", "visibility", "--jq", ".visibility"],
		true,
	)
	if (!output) return undefined
	if (output !== "PUBLIC" && output !== "PRIVATE") {
		throw new CanaryError(
			"visibility_unknown",
			`${repository} returned unsupported visibility ${output}`,
			`gh repo view ${repository} --json visibility`,
		)
	}
	return output
}

function buildTargets(origin: string, owner: string, publicName: string, privateName: string): Target[] {
	return [
		{ repository: `${owner}/${publicName}`, visibility: "PUBLIC" as const },
		{ repository: `${owner}/${privateName}`, visibility: "PRIVATE" as const },
	].map((candidate) => {
		const actual = repositoryVisibility(candidate.repository)
		if (actual && actual !== candidate.visibility) {
			throw new CanaryError(
				"visibility_mismatch",
				`${candidate.repository} is ${actual}; expected ${candidate.visibility}`,
				"choose a different canary repository or correct plugin.config.json",
				false,
			)
		}
		return {
			...candidate,
			remote: targetRemote(origin, candidate.repository),
			exists: Boolean(actual),
			lineage: actual ? "empty" : "missing",
		}
	})
}

function proveTargetLineage(target: Target, sourceSha: string): Target {
	if (!target.exists) return target
	const output = processResult(["git", "ls-remote", target.remote, "refs/heads/main"])
	if (!output) return target
	const [headSha, ref, ...extra] = output.split(/\s+/)
	if (!/^[0-9a-f]{40}$/.test(headSha || "") || ref !== "refs/heads/main" || extra.length > 0) {
		throw new CanaryError(
			"target_head_invalid",
			`${target.repository} returned an invalid main ref: ${output}`,
			`git ls-remote ${target.remote} refs/heads/main`,
			false,
		)
	}
	const ancestry = Bun.spawnSync({
		cmd: ["git", "merge-base", "--is-ancestor", headSha, sourceSha],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (ancestry.exitCode !== 0) {
		throw new CanaryError(
			"target_lineage_mismatch",
			`${target.repository} main ${headSha} is not an ancestor of source ${sourceSha}`,
			"choose an empty canary repository in plugin.config.json; canary history is never rewritten",
			false,
		)
	}
	return {
		...target,
		headSha,
		lineage: headSha === sourceSha ? "current" : "fast-forward",
	}
}

function createTarget(target: Target): void {
	if (target.exists) return
	const visibilityFlag = target.visibility === "PUBLIC" ? "--public" : "--private"
	processResult([
		"gh",
		"repo",
		"create",
		target.repository,
		visibilityFlag,
		"--disable-issues",
		"--disable-wiki",
		"--description",
		"Agent plugin template distribution canary",
	])
}

function publishTarget(target: Target, sourceSha: string): void {
	createTarget(target)
	processResult(["git", "push", target.remote, `${sourceSha}:refs/heads/main`])
}

async function waitForRun(target: Target, sourceSha: string): Promise<HostedRun> {
	const deadline = Date.now() + 10 * 60 * 1000
	let run: { databaseId: number; status: string; conclusion: string; url: string } | undefined
	while (Date.now() < deadline) {
		const output = processResult([
			"gh",
			"run",
			"list",
			"--repo",
			target.repository,
			"--commit",
			sourceSha,
			"--workflow",
			"Prove and package plugin",
			"--limit",
			"1",
			"--json",
			"databaseId,status,conclusion,url",
		])
		const runs = JSON.parse(output || "[]") as Array<typeof run>
		run = runs[0]
		if (run?.status === "completed") break
		await Bun.sleep(3000)
	}
	if (!run || run.status !== "completed") {
		throw new CanaryError(
			"hosted_timeout",
			`${target.repository} did not finish its hosted proof within 10 minutes`,
			`gh run list --repo ${target.repository} --commit ${sourceSha}`,
		)
	}
	if (run.conclusion !== "success") {
		throw new CanaryError(
			"hosted_failure",
			`${target.repository} hosted proof concluded ${run.conclusion}`,
			run.url,
		)
	}
	return {
		repository: target.repository,
		databaseId: run.databaseId,
		conclusion: run.conclusion,
		url: run.url,
	}
}

function preflight(options: Options): Preflight {
	const config = loadPluginConfig(root)
	const identity = processResult(["gh", "api", "user", "--jq", ".login"])
	if (identity !== config.canary.owner) {
		throw new CanaryError(
			"identity_mismatch",
			`active gh identity is ${identity}; expected ${config.canary.owner}`,
			`gh auth switch --hostname github.com --user ${config.canary.owner}`,
			false,
		)
	}
	const dirty = processResult(["git", "status", "--porcelain", "--untracked-files=no"])
	if (dirty) {
		throw new CanaryError(
			"dirty_checkout",
			"tracked changes are present",
			"commit or move the tracked changes before publishing canaries",
			false,
		)
	}
	const sourceSha = processResult(["git", "rev-parse", "--verify", `${options.ref}^{commit}`])
	const headSha = processResult(["git", "rev-parse", "--verify", "HEAD^{commit}"])
	if (headSha !== sourceSha) {
		throw new CanaryError(
			"source_not_checked_out",
			`checked-out HEAD ${headSha} does not match ${options.ref} ${sourceSha}`,
			`check out ${options.ref} in a clean worktree before publishing`,
			false,
		)
	}
	processResult(["git", "merge-base", "--is-ancestor", sourceSha || "", "origin/main"])
	processResult([process.execPath, "run", "generate:check"])
	const origin = processResult(["git", "remote", "get-url", "origin"])
	const targets = buildTargets(
		origin || "",
		config.canary.owner,
		config.canary.publicRepository,
		config.canary.privateRepository,
	).map((target) => proveTargetLineage(target, sourceSha || ""))
	return { identity: identity || "", sourceSha: sourceSha || "", targets }
}

async function publishTargets(targets: Target[], sourceSha: string): Promise<HostedRun[]> {
	const runs: HostedRun[] = []
	for (const target of targets) publishTarget(target, sourceSha)
	for (const target of targets) runs.push(await waitForRun(target, sourceSha))
	return runs
}

function emitSuccess(
	options: Options,
	preflightResult: Preflight,
	runs: HostedRun[],
	runId: string,
): void {
	const result = {
		ok: true,
		action: options.dryRun ? "preview" : "published",
		runId,
		sideEffects: options.dryRun ? "none" : "github-repositories-updated",
		identity: preflightResult.identity,
		source: { ref: options.ref, sha: preflightResult.sourceSha },
		targets: preflightResult.targets,
		runs,
		nextAction: options.dryRun
			? "bun run ship:canary -- --execute"
			: "inspect both hosted run URLs",
	}
	if (options.json) console.log(JSON.stringify(result))
	else {
		console.log(options.dryRun ? "Canary preflight passed." : "Both canaries passed hosted CI.")
		console.log(`Source: ${preflightResult.sourceSha}`)
		for (const target of preflightResult.targets) {
			console.log(`${target.visibility}: ${target.repository}`)
		}
		for (const run of runs) console.log(run.url)
	}
}

async function main(arguments_: string[], runId: string): Promise<void> {
	const options = parseOptions(arguments_)
	if (!options) return
	const preflightResult = preflight(options)
	const runs = options.execute
		? await publishTargets(preflightResult.targets, preflightResult.sourceSha)
		: []
	emitSuccess(options, preflightResult, runs, runId)
}

const arguments_ = process.argv.slice(2)
const json = arguments_.includes("--json")
const runId = crypto.randomUUID()
try {
	await main(arguments_, runId)
} catch (error) {
	const failure =
		error instanceof CanaryError
			? error
			: new CanaryError("unexpected", error instanceof Error ? error.message : String(error), "rerun with --dry-run")
	if (json) {
		console.log(
			JSON.stringify({
				ok: false,
				runId,
				category: failure.category,
				message: failure.message,
				retrySafe: failure.retrySafe,
				nextAction: failure.nextAction,
			}),
		)
	} else {
		console.error(`ship:canary: ${failure.message}`)
		console.error(`Next: ${failure.nextAction}`)
	}
	process.exitCode = failure.category === "usage" ? 2 : 1
}
