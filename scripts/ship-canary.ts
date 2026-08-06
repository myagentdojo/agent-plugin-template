import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"
import { proveHostedHarnessInstall } from "./prove-harness-install"

const root = resolve(import.meta.dir, "..")
const help = `Qualify publishing-system changes through public and private Git canaries.

Usage:
  bun run ship:canary -- --classify --base <git-ref> --head <git-ref> [--json]
  bun run ship:canary -- --dry-run [--ref <git-ref>] [--json]
  bun run ship:canary -- --execute [--ref <git-ref>] [--source-root <path>] [--json]

Options:
  --classify         Classify base-to-head paths without repository writes
  --base <git-ref>   Base ref for --classify
  --head <git-ref>   Head ref for --classify
  --ref <git-ref>    Source ref to qualify (default: origin/main)
  --source-root <path>  Candidate checkout to inspect as data (default: repository root)
  --dry-run          Prove identities, source, visibility, and immutable refs without writes
  --execute          Publish immutable candidate refs, wait for CI, and prove harness installs
  --json             Emit one JSON result on stdout
  -h, --help         Show this help

Safety:
  Publishing changes GitHub repositories. Candidate refs use create-only compare-and-swap and are never replaced or deleted.
  Active gh and real Git transport identities must match plugin.config.json canary.owner.
`

type Visibility = "PUBLIC" | "PRIVATE"
type TransportKind = "ssh" | "https"
type CandidateState = "repository-missing" | "missing" | "current"

interface PublishOptions {
	mode: "publish"
	ref: string
	dryRun: boolean
	execute: boolean
	json: boolean
	sourceRoot: string
}

interface ClassifyOptions {
	mode: "classify"
	base: string
	head: string
	json: boolean
}

type Options = PublishOptions | ClassifyOptions

/** Exact root files whose changes alter how the template publishes or proves a plugin. */
export const PUBLISHING_SYSTEM_PATHS = [
	"package.json",
	"plugin.config.json",
	".github/release-please-config.json",
] as const

const PUBLISHING_SYSTEM_PATH_PREFIXES = ["scripts/", ".github/workflows/"] as const

/** One hosted repository target and its immutable candidate-ref admission state. */
export interface Target {
	repository: string
	visibility: Visibility
	remote: string
	exists: boolean
	candidateRef: string
	candidateState: CandidateState
	headSha?: string
	repairAction?: string
}

/** Hosted workflow evidence tied to the candidate commit. */
export interface HostedRun {
	repository: string
	databaseId: number
	conclusion: string
	url: string
}

/** Native harness installation evidence derived from one hosted candidate ref. */
export interface CandidateInstallEvidence {
	repository: string
	candidateRef: string
	checkoutSha: string
	manifestVersion: string
	claude: {
		mode: "native-hosted-marketplace"
		version: string
		cachedPayloadMatches: boolean
	}
	codex: {
		mode: "native-hosted-marketplace"
		version: string
		cachedPayloadMatches: boolean
	}
}

/** Injectable hosted-I/O seams keep qualification behavior unit-testable without real repositories. */
export interface QualificationDependencies {
	publish: (target: Target, sourceSha: string) => void | Promise<void>
	hostedProof: (target: Target, sourceSha: string) => Promise<HostedRun>
	install: (target: Target, sourceSha: string) => CandidateInstallEvidence | Promise<CandidateInstallEvidence>
}

interface Preflight {
	identity: string
	transportIdentity: { kind: TransportKind; identity: string; host: string }
	sourceSha: string
	targets: Target[]
}

interface CommandOutput {
	exitCode: number
	stdout: string
	stderr: string
}

interface TransportLocation {
	kind: TransportKind
	host: string
	user?: string
	path: string
}

/** Structured failure with a concrete repair and same-input retry policy. */
export class CanaryError extends Error {
	constructor(
		readonly category: string,
		message: string,
		readonly nextAction: string,
		readonly retrySafe = true,
	) {
		super(message)
	}
}

/**
 * Classify whether changed paths alter the template publishing system.
 *
 * @param changedPaths - Base-to-head repository-relative paths
 * @returns Hosted-canary requirement plus the exact triggering paths
 *
 * @example
 * ```typescript
 * classifyPublishingSystemChanges(["scripts/package.ts"])
 * ```
 */
export function classifyPublishingSystemChanges(changedPaths: string[]): {
	required: boolean
	triggeringPaths: string[]
} {
	const publishingPaths = new Set<string>(PUBLISHING_SYSTEM_PATHS)
	const triggeringPaths = [
		...new Set(
			changedPaths.filter(
				(path) =>
					publishingPaths.has(path) ||
					PUBLISHING_SYSTEM_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
			),
		),
	]
	return { required: triggeringPaths.length > 0, triggeringPaths }
}

/**
 * Derive the never-reused candidate branch for one source commit.
 *
 * @param sourceSha - Full source commit SHA
 * @returns Fully qualified candidate branch ref
 * @throws {CanaryError} When the source is not a full lowercase commit SHA
 *
 * @example
 * ```typescript
 * candidateRefForSource("1".repeat(40))
 * ```
 */
export function candidateRefForSource(sourceSha: string): string {
	if (!/^[0-9a-f]{40}$/.test(sourceSha)) {
		throw new CanaryError(
			"source_sha_invalid",
			`candidate source must be a full commit SHA: ${sourceSha}`,
			"resolve and pass a full lowercase Git commit SHA",
			false,
		)
	}
	return `refs/heads/candidate/${sourceSha}`
}

/**
 * Admit a candidate ref only when absent or already bound to the same source commit.
 *
 * @param candidateRef - Fully qualified candidate branch ref
 * @param sourceSha - Intended immutable source commit
 * @param existingSha - Current remote value, when the ref exists
 * @returns Candidate ref and safe publication state
 * @throws {CanaryError} When the ref name or existing commit conflicts
 *
 * @example
 * ```typescript
 * admitCandidateRef(candidateRefForSource(sha), sha, sha)
 * ```
 */
export function admitCandidateRef(
	candidateRef: string,
	sourceSha: string,
	existingSha?: string,
): { candidateRef: string; state: "missing" | "current" } {
	const expectedRef = candidateRefForSource(sourceSha)
	if (candidateRef !== expectedRef) {
		throw new CanaryError(
			"candidate_ref_invalid",
			`candidate ref ${candidateRef} does not belong to source ${sourceSha}`,
			`use ${expectedRef}; never rewrite history or reuse another candidate ref`,
			false,
		)
	}
	if (!existingSha) return { candidateRef, state: "missing" }
	if (existingSha !== sourceSha) {
		throw new CanaryError(
			"candidate_ref_conflict",
			`immutable candidate ref ${candidateRef} resolves to ${existingSha}, not ${sourceSha}`,
			`inspect ${candidateRef} and choose the source SHA's own ref; never rewrite history, delete, or reuse candidate refs`,
			false,
		)
	}
	return { candidateRef, state: "current" }
}

/**
 * Require both the GitHub CLI and real Git transport identities to match the canary owner.
 *
 * @param ghIdentity - Active GitHub CLI login
 * @param transportIdentity - Login reported by SSH or the HTTPS credential helper
 * @param expectedOwner - Configured canary owner
 * @param kind - Git transport used by origin and derived canary remotes
 * @returns Bound transport identity safe for mutation
 * @throws {CanaryError} When either identity differs from the owner
 *
 * @example
 * ```typescript
 * bindTransportIdentity("owner", "owner", "owner", "ssh")
 * ```
 */
export function bindTransportIdentity(
	ghIdentity: string,
	transportIdentity: string,
	expectedOwner: string,
	kind: TransportKind,
): { kind: TransportKind; identity: string } {
	if (ghIdentity !== expectedOwner) {
		throw new CanaryError(
			"identity_mismatch",
			`active gh identity is ${ghIdentity}; expected ${expectedOwner}`,
			`gh auth switch --hostname github.com --user ${expectedOwner}`,
			false,
		)
	}
	if (transportIdentity !== expectedOwner) {
		throw new CanaryError(
			"transport_identity_mismatch",
			`Git transport identity is ${transportIdentity}; active gh identity is ${ghIdentity}; expected ${expectedOwner}`,
			`repair the ${kind.toUpperCase()} credentials selected by origin, then rerun --dry-run`,
			false,
		)
	}
	return { kind, identity: transportIdentity }
}

function optionValue(arguments_: string[], name: string, fallback?: string): string {
	const index = arguments_.indexOf(name)
	if (index === -1) {
		if (fallback !== undefined) return fallback
		throw new CanaryError("usage", `${name} is required`, "bun run ship:canary -- --help")
	}
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
	const classify = arguments_.includes("--classify")
	const valueOptions = classify ? ["--base", "--head"] : ["--ref", "--source-root"]
	const flags = classify
		? ["--classify", "--json"]
		: ["--dry-run", "--execute", "--json"]
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (valueOptions.includes(argument)) {
			index += 1
			continue
		}
		if (!flags.includes(argument)) {
			throw new CanaryError("usage", `unknown option: ${argument}`, "bun run ship:canary -- --help")
		}
	}
	if (classify) {
		return {
			mode: "classify",
			base: optionValue(arguments_, "--base"),
			head: optionValue(arguments_, "--head"),
			json: arguments_.includes("--json"),
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
		mode: "publish",
		ref: optionValue(arguments_, "--ref", "origin/main"),
		dryRun,
		execute,
		json: arguments_.includes("--json"),
		sourceRoot: resolve(root, optionValue(arguments_, "--source-root", ".")),
	}
}

function commandOutput(
	command: string[],
	input?: string,
	environment?: Record<string, string | undefined>,
	cwd = root,
): CommandOutput {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
		env: environment,
		stdin: input === undefined ? "ignore" : new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	}
}

function processResult(command: string[], allowFailure = false, cwd = root): string | undefined {
	const result = commandOutput(command, undefined, undefined, cwd)
	if (result.exitCode !== 0) {
		if (allowFailure) return undefined
		throw new CanaryError(
			"command_failed",
			`${command.join(" ")} failed: ${result.stderr}`,
			"repair the reported command and rerun with the same arguments",
		)
	}
	return result.stdout
}

function transportLocation(origin: string): TransportLocation {
	const scp = /^(?<user>[^@/:]+)@(?<host>[^:]+):(?<path>[^/]+\/[^/]+(?:\.git)?)$/.exec(origin)
	if (scp?.groups?.user && scp.groups.host && scp.groups.path) {
		return {
			kind: "ssh",
			user: scp.groups.user,
			host: scp.groups.host,
			path: scp.groups.path,
		}
	}
	let url: URL
	try {
		url = new URL(origin)
	} catch {
		throw new CanaryError(
			"remote_unsupported",
			`cannot derive canary transport from origin URL: ${origin}`,
			"use an SSH or HTTPS GitHub origin URL",
			false,
		)
	}
	if (url.protocol === "ssh:") {
		return {
			kind: "ssh",
			user: url.username || "git",
			host: url.hostname,
			path: url.pathname.replace(/^\//, ""),
		}
	}
	if (url.protocol === "https:") {
		return {
			kind: "https",
			host: url.hostname,
			path: url.pathname.replace(/^\//, ""),
		}
	}
	throw new CanaryError(
		"remote_unsupported",
		`cannot derive canary transport from origin URL: ${origin}`,
		"use an SSH or HTTPS GitHub origin URL",
		false,
	)
}

function targetRemote(origin: string, repository: string): string {
	const transport = transportLocation(origin)
	if (transport.kind === "ssh") return `${transport.user || "git"}@${transport.host}:${repository}.git`
	return `https://${transport.host}/${repository}.git`
}

function resolveTransportIdentity(origin: string): {
	kind: TransportKind
	identity: string
	host: string
} {
	const transport = transportLocation(origin)
	if (transport.kind === "ssh") {
		const result = commandOutput([
			"ssh",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			`${transport.user || "git"}@${transport.host}`,
		])
		const greeting = `${result.stdout}\n${result.stderr}`
		const identity = /Hi (?<identity>[A-Za-z0-9-]+)!/.exec(greeting)?.groups?.identity
		if ((result.exitCode !== 0 && result.exitCode !== 1) || !identity) {
			throw new CanaryError(
				"transport_identity_unproven",
				`SSH transport did not prove a GitHub identity for ${transport.host}`,
				`ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes ${transport.user || "git"}@${transport.host}`,
				false,
			)
		}
		return { kind: "ssh", identity, host: transport.host }
	}
	const credential = commandOutput(
		["git", "credential", "fill"],
		`protocol=https\nhost=${transport.host}\npath=${transport.path}\n\n`,
		{ ...process.env, GIT_TERMINAL_PROMPT: "0" },
	)
	if (credential.exitCode !== 0) {
		throw new CanaryError(
			"transport_identity_unproven",
			`HTTPS credential helper did not resolve credentials for ${transport.host}`,
			"configure a Git credential helper for the origin URL, then rerun --dry-run",
			false,
		)
	}
	const identity = /^username=(?<identity>[^\r\n]+)$/m.exec(credential.stdout)?.groups?.identity
	if (!identity) {
		throw new CanaryError(
			"transport_identity_unproven",
			`HTTPS credential helper did not report a username for ${transport.host}`,
			"configure owner-bound HTTPS Git credentials, then rerun --dry-run",
			false,
		)
	}
	return { kind: "https", identity, host: transport.host }
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

function proveCandidateRef(target: Target, sourceSha: string): Target {
	if (!target.exists) return target
	const output = processResult([
		"git",
		"ls-remote",
		"--refs",
		target.remote,
		target.candidateRef,
	])
	if (!output) return target
	const [headSha, ref, ...extra] = output.split(/\s+/)
	if (!/^[0-9a-f]{40}$/.test(headSha || "") || ref !== target.candidateRef || extra.length > 0) {
		throw new CanaryError(
			"candidate_ref_invalid",
			`${target.repository} returned an invalid candidate ref: ${output}`,
			`git ls-remote --refs ${target.remote} ${target.candidateRef}`,
			false,
		)
	}
	const admission = admitCandidateRef(target.candidateRef, sourceSha, headSha)
	return { ...target, headSha, candidateState: admission.state }
}

function buildTargets(
	origin: string,
	owner: string,
	publicName: string,
	privateName: string,
	sourceSha: string,
): Target[] {
	const candidateRef = candidateRefForSource(sourceSha)
	return [
		{ repository: `${owner}/${publicName}`, visibility: "PUBLIC" as const },
		{ repository: `${owner}/${privateName}`, visibility: "PRIVATE" as const },
	].map((candidate) => {
		const actual = repositoryVisibility(candidate.repository)
		if (actual && actual !== candidate.visibility) {
			throw new CanaryError(
				"visibility_mismatch",
				`${candidate.repository} is ${actual}; expected ${candidate.visibility}`,
				"choose a different canary repository or correct plugin.config.json; never rewrite repository history",
				false,
			)
		}
		const exists = Boolean(actual)
		const target: Target = {
			...candidate,
			remote: targetRemote(origin, candidate.repository),
			exists,
			candidateRef,
			candidateState: exists ? "missing" : "repository-missing",
			repairAction: exists
				? undefined
				: `create ${candidate.repository} as ${candidate.visibility}, then add ${candidateRef} without an initial branch`,
		}
		return proveCandidateRef(target, sourceSha)
	})
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

function publishTarget(target: Target, sourceSha: string, sourceRoot: string): void {
	if (target.candidateState === "current") return
	createTarget(target)
	try {
		processResult(
			[
				"git",
				"push",
				`--force-with-lease=${target.candidateRef}:`,
				target.remote,
				`${sourceSha}:${target.candidateRef}`,
			],
			false,
			sourceRoot,
		)
	} catch (error) {
		const raced = proveCandidateRef({ ...target, exists: true }, sourceSha)
		if (raced.candidateState === "current") return
		throw new CanaryError(
			"candidate_push_rejected",
			`${target.repository} rejected ${target.candidateRef}: ${error instanceof Error ? error.message : String(error)}`,
			`inspect the remote candidate ref and credentials; never replace, delete, or reuse candidate history`,
			false,
		)
	}
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
			`inspect runs for ${target.candidateRef}; never rewrite or reuse the candidate ref`,
			false,
		)
	}
	if (run.conclusion !== "success") {
		throw new CanaryError(
			"hosted_failure",
			`${target.repository} hosted proof concluded ${run.conclusion}`,
			`${run.url}; repair the proof and rerun it from ${target.candidateRef}; never rewrite history`,
			false,
		)
	}
	return {
		repository: target.repository,
		databaseId: run.databaseId,
		conclusion: run.conclusion,
		url: run.url,
	}
}

function installCandidate(target: Target, sourceSha: string): CandidateInstallEvidence {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "hosted-canary-install-"))
	const checkoutRoot = join(temporaryRoot, "candidate")
	let proof: ReturnType<typeof proveHostedHarnessInstall> | undefined
	try {
		const branch = target.candidateRef.replace(/^refs\/heads\//, "")
		processResult([
			"git",
			"clone",
			"--quiet",
			"--branch",
			branch,
			"--single-branch",
			target.remote,
			checkoutRoot,
		])
		const checkoutSha = processResult(["git", "-C", checkoutRoot, "rev-parse", "HEAD"]) || ""
		if (checkoutSha !== sourceSha) {
			throw new CanaryError(
				"install_mismatch",
				`${target.repository} candidate checkout resolved to ${checkoutSha}, not ${sourceSha}`,
				`inspect ${target.candidateRef}; never rewrite history or reuse the ref`,
				false,
			)
		}
		proof = proveHostedHarnessInstall(
			checkoutRoot,
			target.remote,
			target.candidateRef.replace(/^refs\/heads\//, ""),
			sourceSha,
		)
		const manifestVersion = proof.preflight.manifestVersion
		return {
			repository: target.repository,
			candidateRef: target.candidateRef,
			checkoutSha,
			manifestVersion,
			claude: {
				mode: proof.claude.mode,
				version: proof.claude.version,
				cachedPayloadMatches: proof.claude.inventory.join("\n") === proof.preflight.inventory.join("\n"),
			},
			codex: {
				mode: proof.codex.mode,
				version: proof.codex.version,
				cachedPayloadMatches: proof.codex.inventory.join("\n") === proof.preflight.inventory.join("\n"),
			},
		}
	} catch (error) {
		if (error instanceof CanaryError) throw error
		throw new CanaryError(
			"install_mismatch",
			`${target.repository} native candidate installation failed: ${error instanceof Error ? error.message : String(error)}`,
			`repair the native install proof and rerun from ${target.candidateRef}; never rewrite history`,
			false,
		)
	} finally {
		if (proof?.temporaryRoot) rmSync(proof.temporaryRoot, { recursive: true, force: true })
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
}

function candidateCanaryTargets(sourceRoot: string): {
	owner?: unknown
	publicRepository?: unknown
	privateRepository?: unknown
} {
	try {
		const candidate = JSON.parse(readFileSync(join(sourceRoot, "plugin.config.json"), "utf8")) as {
			canary?: {
				owner?: unknown
				publicRepository?: unknown
				privateRepository?: unknown
			}
		}
		return candidate.canary ?? {}
	} catch (error) {
		throw new CanaryError(
			"candidate_config_invalid",
			`candidate plugin.config.json is unreadable: ${error instanceof Error ? error.message : String(error)}`,
			"repair the candidate metadata in the unprivileged pull-request checkout",
			false,
		)
	}
}

function assertCandidateInstall(
	target: Target,
	sourceSha: string,
	evidence: CandidateInstallEvidence,
): void {
	const matches =
		evidence.repository === target.repository &&
		evidence.candidateRef === target.candidateRef &&
		evidence.checkoutSha === sourceSha &&
		evidence.claude.mode === "native-hosted-marketplace" &&
		evidence.codex.mode === "native-hosted-marketplace" &&
		evidence.claude.version === evidence.manifestVersion &&
		evidence.codex.version === evidence.manifestVersion &&
		evidence.claude.cachedPayloadMatches &&
		evidence.codex.cachedPayloadMatches
	if (!matches) {
		throw new CanaryError(
			"install_mismatch",
			`${target.repository} did not match candidate commit, version, and cached payload through both native harness flows`,
			`repair the native install proof and rerun from ${target.candidateRef}; never rewrite history`,
			false,
		)
	}
}

/**
 * Publish, prove, and install both hosted targets through injectable I/O seams.
 *
 * @param targets - Public and private immutable candidate targets
 * @param sourceSha - Source commit every proof must bind
 * @param dependencies - Hosted publication, workflow, and install adapters
 * @returns Hosted runs and native install comparisons without unrelated distribution claims
 * @throws {CanaryError} When hosted or native qualification fails
 *
 * @example
 * ```typescript
 * await qualifyTargets(targets, sha, dependencies)
 * ```
 */
export async function qualifyTargets(
	targets: Target[],
	sourceSha: string,
	dependencies?: QualificationDependencies,
	sourceRoot = root,
): Promise<{ runs: HostedRun[]; installs: CandidateInstallEvidence[] }> {
	const adapters = dependencies ?? {
		publish: (target: Target, candidateSha: string) =>
			publishTarget(target, candidateSha, sourceRoot),
		hostedProof: waitForRun,
		install: installCandidate,
	}
	const visibilities = targets.map((target) => target.visibility).sort().join(",")
	if (targets.length !== 2 || visibilities !== "PRIVATE,PUBLIC") {
		throw new CanaryError(
			"target_set_invalid",
			"hosted qualification requires exactly one public and one private canary",
			"repair plugin.config.json canary repositories, then rerun --dry-run",
			false,
		)
	}
	for (const target of targets) await adapters.publish(target, sourceSha)
	const runs: HostedRun[] = []
	for (const target of targets) runs.push(await adapters.hostedProof(target, sourceSha))
	const installs: CandidateInstallEvidence[] = []
	for (const target of targets) {
		const evidence = await adapters.install(target, sourceSha)
		assertCandidateInstall(target, sourceSha, evidence)
		installs.push(evidence)
	}
	return { runs, installs }
}

function preflight(options: PublishOptions): Preflight {
	const trustedConfig = loadPluginConfig(root)
	const candidateCanary = candidateCanaryTargets(options.sourceRoot)
	if (
		candidateCanary.owner !== trustedConfig.canary.owner ||
		candidateCanary.publicRepository !== trustedConfig.canary.publicRepository ||
		candidateCanary.privateRepository !== trustedConfig.canary.privateRepository
	) {
		throw new CanaryError(
			"canary_target_mismatch",
			"candidate canary targets differ from the trusted driver checkout",
			"restore plugin.config.json canary targets to the trusted base values",
			false,
		)
	}
	const identity = processResult(["gh", "api", "user", "--jq", ".login"]) || ""
	const dirty = processResult(
		["git", "status", "--porcelain", "--untracked-files=no"],
		false,
		options.sourceRoot,
	)
	if (dirty) {
		throw new CanaryError(
			"dirty_checkout",
			"tracked changes are present",
			"commit or move the tracked changes before publishing canaries",
			false,
		)
	}
	const sourceSha =
		processResult(["git", "rev-parse", "--verify", `${options.ref}^{commit}`], false, options.sourceRoot) || ""
	const headSha = processResult(
		["git", "rev-parse", "--verify", "HEAD^{commit}"],
		false,
		options.sourceRoot,
	)
	if (headSha !== sourceSha) {
		throw new CanaryError(
			"source_not_checked_out",
			`checked-out HEAD ${headSha} does not match ${options.ref} ${sourceSha}`,
			`check out ${options.ref} in a clean worktree before publishing`,
			false,
		)
	}
	const origin = processResult(["git", "remote", "get-url", "origin"]) || ""
	const resolvedTransport = resolveTransportIdentity(origin)
	const boundTransport = bindTransportIdentity(
		identity,
		resolvedTransport.identity,
		trustedConfig.canary.owner,
		resolvedTransport.kind,
	)
	const transportIdentity = { ...boundTransport, host: resolvedTransport.host }
	const targets = buildTargets(
		origin,
		trustedConfig.canary.owner,
		trustedConfig.canary.publicRepository,
		trustedConfig.canary.privateRepository,
		sourceSha,
	)
	return { identity, transportIdentity, sourceSha, targets }
}

function classify(options: ClassifyOptions): void {
	const output = processResult([
		"git",
		"diff",
		"--name-only",
		"--diff-filter=ACMRD",
		"--no-renames",
		`${options.base}...${options.head}`,
	])
	const changedPaths = output ? output.split("\n").filter(Boolean) : []
	const canaries = classifyPublishingSystemChanges(changedPaths)
	const result = {
		ok: true,
		action: "classified",
		sideEffects: "none",
		base: options.base,
		head: options.head,
		changedPaths,
		canaries,
		hermeticProof: "required",
	}
	if (options.json) console.log(JSON.stringify(result))
	else {
		console.log(canaries.required ? "Hosted canaries required." : "Hosted canaries not required.")
		for (const path of canaries.triggeringPaths) console.log(path)
	}
}

function emitSuccess(
	options: PublishOptions,
	preflightResult: Preflight,
	qualification: { runs: HostedRun[]; installs: CandidateInstallEvidence[] },
	runId: string,
): void {
	const result = {
		ok: true,
		action: options.dryRun ? "preview" : "qualified",
		runId,
		sideEffects: options.dryRun ? "none" : "github-candidate-refs-added",
		identity: preflightResult.identity,
		transportIdentity: preflightResult.transportIdentity,
		source: { ref: options.ref, sha: preflightResult.sourceSha },
		targets: preflightResult.targets,
		runs: qualification.runs,
		installs: qualification.installs,
		nextAction: options.dryRun
			? `bun run ship:canary -- --execute --ref ${options.ref}`
			: "inspect both hosted run URLs and native install evidence",
	}
	if (options.json) console.log(JSON.stringify(result))
	else {
		console.log(options.dryRun ? "Canary preflight passed." : "Both Git canaries qualified.")
		console.log(`Source: ${preflightResult.sourceSha}`)
		for (const target of preflightResult.targets) {
			console.log(`${target.visibility}: ${target.repository} ${target.candidateRef}`)
		}
		for (const run of qualification.runs) console.log(run.url)
	}
}

async function main(arguments_: string[], runId: string): Promise<void> {
	const options = parseOptions(arguments_)
	if (!options) return
	if (options.mode === "classify") {
		classify(options)
		return
	}
	const preflightResult = preflight(options)
	const qualification = options.execute
		? await qualifyTargets(
				preflightResult.targets,
				preflightResult.sourceSha,
				undefined,
				options.sourceRoot,
			)
		: { runs: [], installs: [] }
	emitSuccess(options, preflightResult, qualification, runId)
}

if (import.meta.main) {
	const arguments_ = process.argv.slice(2)
	const json = arguments_.includes("--json")
	const runId = crypto.randomUUID()
	try {
		await main(arguments_, runId)
	} catch (error) {
		const failure =
			error instanceof CanaryError
				? error
				: new CanaryError(
						"unexpected",
						error instanceof Error ? error.message : String(error),
						"rerun with --dry-run",
					)
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
}
