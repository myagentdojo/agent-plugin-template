import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"
import { deterministicPluginArchive, payloadInventorySha256 } from "./plugin-files"
import { copyMarketplaceDistribution, proveHostedHarnessInstall } from "./prove-harness-install"

const root = resolve(import.meta.dir, "..")
const HOSTED_PROOF_WORKFLOW_NAME = "Prove and package plugin"
const PUBLIC_CANARY_WORKFLOW = `name: ${HOSTED_PROOF_WORKFLOW_NAME}

on:
  push:
    branches:
      - "candidate/**"

permissions:
  contents: read

jobs:
  distribution:
    name: Sanitized public distribution
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Verify marketplace distribution
        shell: bash
        run: |
          set -euo pipefail
          test -s plugin/.claude-plugin/plugin.json
          test -s plugin/.codex-plugin/plugin.json
          test -s .claude-plugin/marketplace.json
          test -s .agents/plugins/marketplace.json
          test -x plugin/bin/hello-world
          node -e 'for (const path of process.argv.slice(1)) JSON.parse(require("node:fs").readFileSync(path, "utf8"))' plugin/.claude-plugin/plugin.json plugin/.codex-plugin/plugin.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json
`
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
  Active gh and real Git transport identities must match plugin.config.json canary.actor.
`

const DEFAULT_HOSTED_RUN_DEADLINE_MS = 10 * 60 * 1000
const DEFAULT_NETWORK_COMMAND_TIMEOUT_MS = 30 * 1000
const DEFAULT_HOSTED_POLL_DELAY_MS = 3000
// Hosted sanitized candidates omit plugin.config.json, so mirror its private
// strict-semver contract at the archive-name boundary.
const strictManifestSemver =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

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
	/** Commit the hosted repository must expose at candidateRef. */
	candidateSha: string
	/** Sanitized or source repository that owns candidateSha for publication. */
	publicationRoot: string
	/** Deterministic Git identity used only for a sanitized public candidate. */
	publicationEnvironment?: Record<string, string | undefined>
	headSha?: string
	repairAction?: string
}

/** Hosted workflow evidence tied to the candidate commit. */
export interface HostedRun {
	repository: string
	databaseId: number
	conclusion: string
	url: string
	/** Candidate commit qualified by this receipt. */
	sourceSha: string
	/** Trusted workflow commit that issued the receipt. */
	workflowSha: string
	/** Authority that executed the receipt-producing workflow. */
	authority: "candidate-sanitized-workflow" | "protected-trusted-workflow"
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
	/** Package and installed-byte lineage bound to the exact candidate commit. */
	lineage: CandidateQualificationLineage
}

/** Exact package and installed-byte lineage required before promoting native claims. */
export interface CandidateQualificationLineage {
	sourceCommit: string
	archiveSha256: string
	packagedPayloadHash: string
	installedPayloadHash: string
}

/** Bind qualification lineage to checksum metadata and the independently hashed installation. */
export function bindCandidateQualificationLineage(
	expectedSourceCommit: string,
	checksums: {
		sourceCommit?: unknown
		archiveSha256?: unknown
		payloadInventorySha256?: unknown
	},
	installedPayloadHash: string,
): CandidateQualificationLineage {
	if (!/^[a-f0-9]{40}$/.test(expectedSourceCommit) || checksums.sourceCommit !== expectedSourceCommit) {
		throw new CanaryError(
			"qualification_lineage_mismatch",
			"qualification checksum source commit does not match the exact candidate",
			"use the checksums and installed payload from the exact candidate commit",
			false,
		)
	}
	if (
		typeof checksums.archiveSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(checksums.archiveSha256) ||
		typeof checksums.payloadInventorySha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(checksums.payloadInventorySha256) ||
		!/^[a-f0-9]{64}$/.test(installedPayloadHash)
	) {
		throw new CanaryError(
			"qualification_lineage_invalid",
			"qualification lineage requires complete SHA-256 package and installed-payload evidence",
			"record the archive, packaged payload, and installed payload SHA-256 values",
			false,
		)
	}
	if (installedPayloadHash !== checksums.payloadInventorySha256) {
		throw new CanaryError(
			"qualification_lineage_mismatch",
			"qualification installed payload does not match the packaged payload",
			"reinstall the exact candidate and hash the selected installed payload",
			false,
		)
	}
	return {
		sourceCommit: expectedSourceCommit,
		archiveSha256: checksums.archiveSha256,
		packagedPayloadHash: checksums.payloadInventorySha256,
		installedPayloadHash,
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
	temporaryRoot: string
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

/** Validate the exact bounded manifest version before using it in archive staging. */
export function validateLineageManifestVersion(manifestVersion: unknown): string {
	if (
		typeof manifestVersion !== "string" ||
		manifestVersion.length > 64 ||
		!strictManifestSemver.test(manifestVersion)
	) {
		throw new CanaryError(
			"install_mismatch",
			"candidate plugin manifest version must be exact semantic versioning and at most 64 characters for lineage packaging",
			"repair plugin/.claude-plugin/plugin.json before publishing a new immutable candidate ref",
			false,
		)
	}
	return manifestVersion
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
	timeout?: number,
	trimOutput = true,
): CommandOutput {
	const result = Bun.spawnSync({
		cmd: command,
		cwd,
		env: environment,
		stdin: input === undefined ? "ignore" : new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
		timeout,
	})
	const stdout = result.stdout.toString()
	const stderr = result.stderr.toString()
	return {
		exitCode: result.exitCode ?? 124,
		stdout: trimOutput ? stdout.trim() : stdout,
		stderr: trimOutput ? stderr.trim() : stderr,
	}
}

function processResult(
	command: string[],
	allowFailure = false,
	cwd = root,
	environment?: Record<string, string | undefined>,
): string | undefined {
	const result = commandOutput(command, undefined, environment, cwd)
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

function isolatedKnownHostsFile(environment: NodeJS.ProcessEnv): string | undefined {
	if (environment.CANARY_SSH_KNOWN_HOSTS_FILE) return environment.CANARY_SSH_KNOWN_HOSTS_FILE
	return /(?:^|\s)-o\s+UserKnownHostsFile=(?<path>\/[A-Za-z0-9._\/-]+)(?=\s|$)/.exec(
		environment.GIT_SSH_COMMAND || "",
	)?.groups?.path
}

function isolatedIdentityFile(environment: NodeJS.ProcessEnv): string | undefined {
	if (environment.CANARY_SSH_IDENTITY_FILE) return environment.CANARY_SSH_IDENTITY_FILE
	return /(?:^|\s)-i\s+(?<path>\/[A-Za-z0-9._\/-]+)(?=\s|$)/.exec(
		environment.GIT_SSH_COMMAND || "",
	)?.groups?.path
}

function resolveTransportIdentity(origin: string): {
	kind: TransportKind
	identity: string
	host: string
} {
	const transport = transportLocation(origin)
	if (transport.kind === "ssh") {
		const knownHostsFile = isolatedKnownHostsFile(process.env)
		const identityFile = isolatedIdentityFile(process.env)
		const identityOptions = identityFile
			? [
					"-F",
					"/dev/null",
					"-o",
					"IdentityAgent=none",
					"-i",
					identityFile,
					"-o",
					"IdentitiesOnly=yes",
				]
			: []
		const knownHostsOption = knownHostsFile
			? ["-o", `UserKnownHostsFile=${knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null"]
			: []
		const result = commandOutput([
			"ssh",
			"-T",
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=yes",
			...identityOptions,
			...knownHostsOption,
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
	const password = /^password=(?<password>[^\r\n]+)$/m.exec(credential.stdout)?.groups?.password
	if (!password) {
		throw new CanaryError(
			"transport_identity_unproven",
			`HTTPS credential helper did not report a token for ${transport.host}`,
			"configure owner-bound HTTPS Git credentials, then rerun --dry-run",
			false,
		)
	}
	const authenticated = commandOutput(
		["gh", "api", "user", "--jq", ".login"],
		undefined,
		{ ...process.env, GH_TOKEN: password },
	)
	if (authenticated.exitCode !== 0 || !authenticated.stdout) {
		throw new CanaryError(
			"transport_identity_unproven",
			`HTTPS credential for ${transport.host} did not authenticate with GitHub`,
			"repair the HTTPS credential selected by Git, then rerun --dry-run",
			false,
		)
	}
	const identity = authenticated.stdout
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

function proveCandidateRef(target: Target): Target {
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
	const admission = admitCandidateRef(target.candidateRef, target.candidateSha, headSha)
	return { ...target, headSha, candidateState: admission.state }
}

function requireGitObjectId(value: string | undefined, object: "tree" | "commit"): string {
	if (!value || !/^[a-f0-9]{40}$/.test(value)) {
		throw new CanaryError(
			"candidate_generation_failed",
			`sanitized public candidate did not produce a valid Git ${object}`,
			"inspect the local Git installation, then rerun canary qualification",
			false,
		)
	}
	return value
}

function writePublicCanaryWorkflow(repositoryRoot: string): void {
	const workflowDirectory = join(repositoryRoot, ".github", "workflows")
	mkdirSync(workflowDirectory, { recursive: true })
	writeFileSync(join(workflowDirectory, "plugin-ci.yml"), PUBLIC_CANARY_WORKFLOW)
}

export function createSanitizedPublicCandidate(sourceRoot: string, sourceSha: string): {
	sha: string
	repositoryRoot: string
	temporaryRoot: string
	environment: Record<string, string | undefined>
} {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "public-canary-candidate-"))
	const repositoryRoot = join(temporaryRoot, "marketplace")
	copyMarketplaceDistribution(sourceRoot, repositoryRoot)
	writePublicCanaryWorkflow(repositoryRoot)
	const environment = {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
		GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
		GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND,
		CANARY_SSH_IDENTITY_FILE: process.env.CANARY_SSH_IDENTITY_FILE,
		GIT_AUTHOR_NAME: "Hosted Canary",
		GIT_AUTHOR_EMAIL: "canary@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_NAME: "Hosted Canary",
		GIT_COMMITTER_EMAIL: "canary@example.invalid",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	}
	try {
		processResult(["git", "init", "--quiet"], false, repositoryRoot, environment)
		processResult(["git", "add", "--all"], false, repositoryRoot, environment)
		const tree = requireGitObjectId(
			processResult(["git", "write-tree"], false, repositoryRoot, environment),
			"tree",
		)
		const sha = requireGitObjectId(
			processResult(
				["git", "commit-tree", tree, "-m", `sanitized public canary for ${sourceSha}`],
				false,
				repositoryRoot,
				environment,
			),
			"commit",
		)
		return { sha, repositoryRoot, temporaryRoot, environment }
	} catch (error) {
		rmSync(temporaryRoot, { recursive: true, force: true })
		throw error
	}
}

function durationDescription(milliseconds: number): string {
	if (milliseconds % 60_000 === 0) {
		const minutes = milliseconds / 60_000
		return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
	}
	if (milliseconds % 1000 === 0) {
		const seconds = milliseconds / 1000
		return `${seconds} ${seconds === 1 ? "second" : "seconds"}`
	}
	return `${milliseconds} milliseconds`
}

function buildTargets(
	origin: string,
	owner: string,
	publicName: string,
	privateName: string,
	sourceSha: string,
	sourceRoot: string,
	publicCandidate: ReturnType<typeof createSanitizedPublicCandidate>,
): Target[] {
	return [
		{
			repository: `${owner}/${publicName}`,
			visibility: "PUBLIC" as const,
			candidateSha: publicCandidate.sha,
			publicationRoot: publicCandidate.repositoryRoot,
			publicationEnvironment: {
				...publicCandidate.environment,
				GH_TOKEN: process.env.GH_TOKEN,
			},
		},
		{
			repository: `${owner}/${privateName}`,
			visibility: "PRIVATE" as const,
			candidateSha: sourceSha,
			publicationRoot: sourceRoot,
		},
	].map((candidate) => {
		const candidateRef = candidateRefForSource(candidate.candidateSha)
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
		return proveCandidateRef(target)
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

function publishTarget(target: Target, candidateSha: string): void {
	if (target.candidateState === "current") return
	createTarget(target)
	try {
		processResult(
			[
				"git",
				"push",
				`--force-with-lease=${target.candidateRef}:`,
				target.remote,
				`${candidateSha}:${target.candidateRef}`,
			],
			false,
			target.publicationRoot,
			target.publicationEnvironment,
		)
	} catch (error) {
		const raced = proveCandidateRef({ ...target, exists: true })
		if (raced.candidateState === "current") return
		throw new CanaryError(
			"candidate_push_rejected",
			`${target.repository} rejected ${target.candidateRef}: ${error instanceof Error ? error.message : String(error)}`,
			`inspect the remote candidate ref and credentials; never replace, delete, or reuse candidate history`,
			false,
		)
	}
}

function positiveDuration(name: string, fallback: number): number {
	const value = process.env[name]
	if (value === undefined) return fallback
	if (!/^[1-9]\d*$/.test(value)) {
		throw new CanaryError(
			"usage",
			`${name} must be a positive integer number of milliseconds`,
			`unset ${name} or provide a positive integer`,
			false,
		)
	}
	return Number(value)
}

async function waitForRun(target: Target, sourceSha: string): Promise<HostedRun> {
	const deadlineMs = positiveDuration("CANARY_HOSTED_RUN_DEADLINE_MS", DEFAULT_HOSTED_RUN_DEADLINE_MS)
	const commandTimeoutMs = positiveDuration(
		"CANARY_NETWORK_COMMAND_TIMEOUT_MS",
		DEFAULT_NETWORK_COMMAND_TIMEOUT_MS,
	)
	const pollDelayMs = positiveDuration("CANARY_HOSTED_POLL_DELAY_MS", DEFAULT_HOSTED_POLL_DELAY_MS)
	const deadline = Date.now() + deadlineMs
	let run: { databaseId: number; status: string; conclusion: string; url: string } | undefined
	while (Date.now() < deadline) {
		const remaining = Math.max(1, deadline - Date.now())
		const result = commandOutput([
			"gh",
			"run",
			"list",
			"--repo",
			target.repository,
			"--commit",
			sourceSha,
			"--workflow",
			HOSTED_PROOF_WORKFLOW_NAME,
			"--limit",
			"1",
			"--json",
			"databaseId,status,conclusion,url",
		], undefined, undefined, root, Math.min(commandTimeoutMs, remaining))
		if (result.exitCode === 0) {
			try {
				const runs = JSON.parse(result.stdout || "[]") as Array<typeof run>
				run = runs[0]
			} catch {
				run = undefined
			}
		}
		if (run?.status === "completed") break
		const delay = Math.min(pollDelayMs, Math.max(0, deadline - Date.now()))
		if (delay > 0) await Bun.sleep(delay)
	}
	if (!run || run.status !== "completed") {
		throw new CanaryError(
			"hosted_timeout",
			`${target.repository} did not finish its hosted proof within ${durationDescription(deadlineMs)}`,
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
		sourceSha,
		workflowSha: sourceSha,
		authority: "candidate-sanitized-workflow",
	}
}

/**
 * Bind private qualification to the protected driver workflow and exact candidate source.
 *
 * @param target - Private canary target being qualified
 * @param sourceSha - Exact candidate commit inspected by trusted code
 * @param environment - GitHub Actions receipt fields supplied by the protected workflow
 * @returns SHA-bound hosted-run evidence issued by trusted code
 * @throws {CanaryError} When the workflow authority or source binding is absent
 *
 * @example
 * ```typescript
 * bindTrustedPrivateRun(target, sourceSha, process.env)
 * ```
 */
export function bindTrustedPrivateRun(
	target: Target,
	sourceSha: string,
	environment: Record<string, string | undefined> = process.env,
): HostedRun {
	const workflowRef = environment.GITHUB_WORKFLOW_REF || ""
	const workflowSha = environment.CANARY_TRUSTED_WORKFLOW_SHA || ""
	const qualifiedSourceSha = environment.CANARY_QUALIFIED_SOURCE_SHA || ""
	const runId = environment.GITHUB_RUN_ID || ""
	const repository = environment.GITHUB_REPOSITORY || ""
	const serverUrl = environment.GITHUB_SERVER_URL || ""
	if (
		environment.GITHUB_ACTIONS !== "true" ||
		!workflowRef.includes("/.github/workflows/hosted-canary.yml@") ||
		!/^[0-9a-f]{40}$/.test(workflowSha) ||
		qualifiedSourceSha !== sourceSha ||
		!/^\d+$/.test(runId) ||
		!repository ||
		!serverUrl
	) {
		throw new CanaryError(
			"trusted_workflow_unproven",
			`${target.repository} private proof is not bound to the protected hosted-canary workflow and source commit`,
			"run qualification through .github/workflows/hosted-canary.yml from protected base code",
			false,
		)
	}
	return {
		repository: target.repository,
		databaseId: Number(runId),
		conclusion: "success",
		url: `${serverUrl}/${repository}/actions/runs/${runId}`,
		sourceSha,
		workflowSha,
		authority: "protected-trusted-workflow",
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
		const manifestVersion = validateLineageManifestVersion(proof.preflight.manifestVersion)
		const manifestName = (
			JSON.parse(
				readFileSync(join(checkoutRoot, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
			) as { name?: unknown }
		).name
		if (
			typeof manifestName !== "string" ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifestName) ||
			manifestName.length > 64
		) {
			throw new CanaryError(
				"install_mismatch",
				`${target.repository} candidate plugin manifest name must be kebab-case and at most 64 characters for lineage packaging`,
				`repair plugin/.claude-plugin/plugin.json at ${target.candidateRef}; never rewrite history`,
				false,
			)
		}
		if (proof.claude.installedPayloadHash !== proof.codex.installedPayloadHash) {
			throw new CanaryError(
				"install_mismatch",
				`${target.repository} native clients installed different payload bytes`,
				`repair the native install proof and rerun from ${target.candidateRef}; never rewrite history`,
				false,
			)
		}
		const lineage = bindCandidateQualificationLineage(
			sourceSha,
			{
				sourceCommit: checkoutSha,
				archiveSha256: deterministicPluginArchive(
					checkoutRoot,
					`${manifestName}-${manifestVersion}`,
				).sha256,
				payloadInventorySha256: payloadInventorySha256(
					join(checkoutRoot, "plugin"),
					proof.preflight.inventory,
				),
			},
			proof.claude.installedPayloadHash,
		)
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
			lineage,
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
	actor?: unknown
	publicRepository?: unknown
	privateRepository?: unknown
} {
	try {
		const candidate = JSON.parse(readFileSync(join(sourceRoot, "plugin.config.json"), "utf8")) as {
			canary?: {
				owner?: unknown
				actor?: unknown
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
	evidence: CandidateInstallEvidence,
): void {
	const matches =
		evidence.repository === target.repository &&
		evidence.candidateRef === target.candidateRef &&
		evidence.checkoutSha === target.candidateSha &&
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
 * @param sourceSha - Recipient source commit bound into the deterministic public fixture
 * @param dependencies - Hosted publication, workflow, and install adapters
 * @returns Hosted runs and native install comparisons, each bound to exact candidate lineage, without unrelated distribution claims
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
): Promise<{ runs: HostedRun[]; installs: CandidateInstallEvidence[] }> {
	const adapters = dependencies ?? {
		publish: (target: Target, candidateSha: string) =>
			publishTarget(target, candidateSha),
		hostedProof: (target: Target, candidateSha: string) =>
			Promise.resolve(
				target.visibility === "PRIVATE"
					? bindTrustedPrivateRun(target, candidateSha)
					: waitForRun(target, candidateSha),
			),
		install: installCandidate,
	}
	const visibilities = targets.map((target) => target.visibility).sort().join(",")
	if (
		targets.length !== 2 ||
		visibilities !== "PRIVATE,PUBLIC" ||
		targets.find((target) => target.visibility === "PRIVATE")?.candidateSha !== sourceSha ||
		targets.some((target) => target.candidateRef !== candidateRefForSource(target.candidateSha))
	) {
		throw new CanaryError(
			"target_set_invalid",
			"hosted qualification requires exactly one public and one private canary",
			"repair plugin.config.json canary repositories, then rerun --dry-run",
			false,
		)
	}
	for (const target of targets) await adapters.publish(target, target.candidateSha)
	const runs = new Map<Visibility, HostedRun>()
	for (const target of targets.filter((candidate) => candidate.visibility === "PUBLIC")) {
		runs.set(target.visibility, await adapters.hostedProof(target, target.candidateSha))
	}
	const installs: CandidateInstallEvidence[] = []
	for (const target of targets) {
		const evidence = await adapters.install(target, target.candidateSha)
		assertCandidateInstall(target, evidence)
		// Re-bind lineage at the qualification seam so emitted claims always carry
		// checked source, archive, packaged, and installed hashes for this candidate.
		installs.push({
			...evidence,
			lineage: bindCandidateQualificationLineage(
				target.candidateSha,
				{
					sourceCommit: evidence.lineage.sourceCommit,
					archiveSha256: evidence.lineage.archiveSha256,
					payloadInventorySha256: evidence.lineage.packagedPayloadHash,
				},
				evidence.lineage.installedPayloadHash,
			),
		})
	}
	for (const target of targets.filter((candidate) => candidate.visibility === "PRIVATE")) {
		runs.set(target.visibility, await adapters.hostedProof(target, target.candidateSha))
	}
	return { runs: targets.map((target) => runs.get(target.visibility) as HostedRun), installs }
}

function preflight(options: PublishOptions): Preflight {
	const trustedConfig = loadPluginConfig(root)
	const candidateCanary = candidateCanaryTargets(options.sourceRoot)
	if (
		candidateCanary.owner !== trustedConfig.canary.owner ||
		candidateCanary.actor !== trustedConfig.canary.actor ||
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
	const untrackedDistribution = processResult(
		[
			"git",
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			"plugin",
			".claude-plugin/marketplace.json",
			".agents/plugins/marketplace.json",
		],
		false,
		options.sourceRoot,
	)
	if (untrackedDistribution) {
		throw new CanaryError(
			"dirty_checkout",
			"untracked files are present in the public marketplace distribution",
			"commit or move the untracked distribution files before publishing canaries",
			false,
		)
	}
	const ignoredDistribution = commandOutput(
		[
			"git",
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			"plugin",
			".claude-plugin/marketplace.json",
			".agents/plugins/marketplace.json",
		],
		undefined,
		undefined,
		options.sourceRoot,
		undefined,
		false,
	)
	if (ignoredDistribution.exitCode !== 0) {
		throw new CanaryError(
			"command_failed",
			"failed to inspect ignored public marketplace distribution files",
			"repair the Git checkout and rerun with the same arguments",
		)
	}
	if (ignoredDistribution.stdout) {
		throw new CanaryError(
			"dirty_checkout",
			"ignored files are present in the public marketplace distribution",
			"remove ignored distribution files or commit the intended payload before publishing canaries",
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
		trustedConfig.canary.actor,
		resolvedTransport.kind,
	)
	const transportIdentity = { ...boundTransport, host: resolvedTransport.host }
	const publicCandidate = createSanitizedPublicCandidate(options.sourceRoot, sourceSha)
	try {
		const targets = buildTargets(
			origin,
			trustedConfig.canary.owner,
			trustedConfig.canary.publicRepository,
			trustedConfig.canary.privateRepository,
			sourceSha,
			options.sourceRoot,
			publicCandidate,
		)
		return {
			identity,
			transportIdentity,
			sourceSha,
			targets,
			temporaryRoot: publicCandidate.temporaryRoot,
		}
	} catch (error) {
		rmSync(publicCandidate.temporaryRoot, { recursive: true, force: true })
		throw error
	}
}

function classify(options: ClassifyOptions): void {
	const command = commandOutput([
		"git",
		"-c",
		"core.quotePath=false",
		"diff",
		"--name-only",
		"-z",
		"--diff-filter=ACMRTD",
		"--no-renames",
		`${options.base}...${options.head}`,
	], undefined, undefined, root, undefined, false)
	if (command.exitCode !== 0) {
		throw new CanaryError(
			"command_failed",
			"git diff failed while classifying publishing-system paths",
			"repair the Git refs and rerun with the same arguments",
		)
	}
	const changedPaths = command.stdout ? command.stdout.split("\0").filter(Boolean) : []
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
		targets: preflightResult.targets.map(
			({ publicationRoot: _publicationRoot, publicationEnvironment: _environment, ...target }) =>
				target,
		),
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
	try {
		const qualification = options.execute
			? await qualifyTargets(
					preflightResult.targets,
					preflightResult.sourceSha,
					undefined,
				)
			: { runs: [], installs: [] }
		emitSuccess(options, preflightResult, qualification, runId)
	} finally {
		rmSync(preflightResult.temporaryRoot, { recursive: true, force: true })
	}
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
