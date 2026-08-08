const acceptedTitleTypes = ["feat", "fix", "perf", "breaking (!)"] as const
const generatedPayloadPaths = new Set([
	".agents/plugins/marketplace.json",
	".claude-plugin/marketplace.json",
	"plugin.config.json",
	"runtime/runtime.lock.json",
	"runtime/skill-catalog.json",
])
import {
	RELEASE_PROJECTION_PATH_SET,
	isReleaseProjectionVersionOnlyChange,
} from "./release-projection"
const releasableTitle =
	/^(?:(?:feat|fix|perf)(?:\([a-z0-9._/-]+\))?!?|[a-z][a-z0-9-]*(?:\([a-z0-9._/-]+\))?!): .+$/

/** One base-to-head path plus the projection analysis performed by the caller. */
export interface ReleaseImpactChangedFile {
	/** Repository-relative path reported by git. */
	path: string
	/** True when the file differs only in its Release Please-owned version projection. */
	versionOnly?: boolean
}

/** Trusted pull request identity used to recognize Release Please automation. */
export interface ReleaseImpactPullRequestIdentity {
	/** Pull request head branch reported by GitHub. */
	headRef?: string
	/** Pull request author login reported by GitHub. */
	authorLogin?: string
	/** Repository-configured Release Please automation login. */
	expectedAutomationLogin?: string
}

/** Inputs needed to decide whether a pull request title can carry its payload diff. */
export interface ReleaseImpactInput {
	/** Pull request title evaluated as the future squash-merge commit. */
	title: string
	/** Base-to-head files, with version-only evidence where applicable. */
	changedFiles: readonly ReleaseImpactChangedFile[]
	/** Trusted GitHub identity; absent or incomplete identity disables the release exemption. */
	pullRequestIdentity?: ReleaseImpactPullRequestIdentity
}

/** Stable policy result emitted by the release-impact gate. */
export interface ReleaseImpactResult {
	/** True when the diff changes canonical payload or its source. */
	payloadChanged: boolean
	/** True when every change belongs to the version-only Release Please projection. */
	isReleasePleaseProjection: boolean
	/** True when the title produces a Release Please version. */
	titleIsReleasable: boolean
	/** True when the pull request may pass this gate. */
	ok: boolean
	/** Payload-owned paths that caused title policy evaluation. */
	changedPayloadPaths: string[]
	/** Human-readable title classes accepted for payload changes. */
	acceptedTitleTypes: string[]
}

interface CliOptions {
	base?: string
	head?: string
	prHeadRef?: string
	prAuthorLogin?: string
	expectedReleasePleaseLogin?: string
	help: boolean
}

class ReleaseImpactError extends Error {
	constructor(
		readonly category: "usage" | "git_diff" | "release_impact" | "unexpected",
		message: string,
		readonly nextAction: string,
		readonly retrySafe = true,
	) {
		super(message)
	}
}

const help = `Gate installable payload changes on a releasable pull request title.

Usage:
  PR_TITLE="fix: repair the hook" bun run scripts/release-impact.ts --base <sha> --head <sha>

Options:
  --base <git-ref>                        Pull request base commit; defaults to BASE_SHA
  --head <git-ref>                        Pull request head commit; defaults to HEAD_SHA
  --pr-head-ref <branch>                  Trusted pull request head branch
  --pr-author-login <login>               Trusted pull request author login
  --expected-release-please-login <login> Expected Release Please automation login
  -h, --help                              Show this help

Release Please exemption:
  Requires all three identity options and a release-please--branches-- head ref.
  Missing or mismatched identity disables the exemption.

Test input:
  CHANGED_FILES_JSON may provide [{"path":"...","versionOnly":true}] instead of git refs.

Output: one JSON result on stdout. Diagnostics use stderr.
Side effects: none.
`

function isPayloadPath(path: string): boolean {
	return (
		path.startsWith("plugin/") ||
		path.startsWith("runtime/src/") ||
		path.startsWith("packages/") ||
		path === "bun.lock" ||
		path === "bunfig.toml" ||
		generatedPayloadPaths.has(path)
	)
}

/**
 * Compare one projection file after removing only its Release Please-owned version field.
 *
 * @param path - Repository-relative projection path
 * @param before - File contents at the pull request merge base
 * @param after - File contents at the pull request head
 * @returns True when no installable behavior differs after projection normalization
 *
 * @example
 * ```typescript
 * isReleasePleaseVersionOnlyChange("plugin.config.json", before, after)
 * ```
 */
export function isReleasePleaseVersionOnlyChange(
	path: string,
	before: string,
	after: string,
): boolean {
	return isReleaseProjectionVersionOnlyChange(path, before, after)
}

/**
 * Decide whether a pull request title carries the release impact of its changed paths.
 *
 * @param input - Pull request title and base-to-head changed-file evidence
 * @returns Stable policy result for CI and direct tests
 *
 * @example
 * ```typescript
 * classifyReleaseImpact({
 *   title: "fix: repair the hook",
 *   changedFiles: [{ path: "plugin/hooks/claude/hooks.json" }],
 * })
 * ```
 */
export function classifyReleaseImpact(input: ReleaseImpactInput): ReleaseImpactResult {
	const changedPayloadPaths = input.changedFiles
		.filter((file) => isPayloadPath(file.path))
		.map((file) => file.path)
	const payloadChanged = changedPayloadPaths.length > 0
	const identity = input.pullRequestIdentity
	const isReleasePleasePullRequest =
		Boolean(identity?.expectedAutomationLogin) &&
		identity?.authorLogin === identity?.expectedAutomationLogin &&
		identity?.headRef?.startsWith("release-please--branches--") === true
	const isReleasePleaseProjection =
		isReleasePleasePullRequest &&
		payloadChanged &&
		input.changedFiles.length > 0 &&
		input.changedFiles.every(
			(file) => RELEASE_PROJECTION_PATH_SET.has(file.path) && file.versionOnly === true,
		)
	const titleIsReleasable = releasableTitle.test(input.title)

	return {
		payloadChanged,
		isReleasePleaseProjection,
		titleIsReleasable,
		ok: !payloadChanged || isReleasePleaseProjection || titleIsReleasable,
		changedPayloadPaths,
		acceptedTitleTypes: [...acceptedTitleTypes],
	}
}

function optionValue(arguments_: string[], name: string): string | undefined {
	const index = arguments_.indexOf(name)
	if (index === -1) return undefined
	const value = arguments_[index + 1]
	if (!value || value.startsWith("--")) {
		throw new ReleaseImpactError(
			"usage",
			`${name} requires a value`,
			"bun run scripts/release-impact.ts --help",
		)
	}
	return value
}

function parseOptions(arguments_: string[]): CliOptions {
	if (arguments_.includes("--help") || arguments_.includes("-h")) {
		return { help: true }
	}
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (
			argument === "--base" ||
			argument === "--head" ||
			argument === "--pr-head-ref" ||
			argument === "--pr-author-login" ||
			argument === "--expected-release-please-login"
		) {
			index += 1
			continue
		}
		throw new ReleaseImpactError(
			"usage",
			`unknown option: ${argument}`,
			"bun run scripts/release-impact.ts --help",
		)
	}
	return {
		base: optionValue(arguments_, "--base") ?? process.env.BASE_SHA,
		head: optionValue(arguments_, "--head") ?? process.env.HEAD_SHA,
		prHeadRef: optionValue(arguments_, "--pr-head-ref"),
		prAuthorLogin: optionValue(arguments_, "--pr-author-login"),
		expectedReleasePleaseLogin: optionValue(arguments_, "--expected-release-please-login"),
		help: false,
	}
}

function gitOutput(arguments_: string[], allowFailure = false): string | undefined {
	const result = Bun.spawnSync({
		cmd: ["git", ...arguments_],
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode === 0) return result.stdout.toString()
	if (allowFailure) return undefined
	throw new ReleaseImpactError(
		"git_diff",
		result.stderr.toString().trim() || `git ${arguments_[0]} failed`,
		"fetch the pull request base and head commits, then rerun the gate",
	)
}

function gitChangedFiles(base: string, head: string): ReleaseImpactChangedFile[] {
	const mergeBase = gitOutput(["merge-base", base, head])?.trim()
	if (!mergeBase) {
		throw new ReleaseImpactError(
			"git_diff",
			"git did not resolve a merge base",
			"fetch the pull request base and head commits, then rerun the gate",
		)
	}
	const changedPaths = (gitOutput(["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`, "--"]) ?? "")
		.split("\0")
		.filter(Boolean)
	return changedPaths.map((path) => {
		if (!RELEASE_PROJECTION_PATH_SET.has(path)) return { path }
		const before = gitOutput(["show", `${mergeBase}:${path}`], true)
		const after = gitOutput(["show", `${head}:${path}`], true)
		return {
			path,
			versionOnly:
				before !== undefined &&
				after !== undefined &&
				isReleasePleaseVersionOnlyChange(path, before, after),
		}
	})
}

function environmentChangedFiles(value: string): ReleaseImpactChangedFile[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new ReleaseImpactError(
			"usage",
			"CHANGED_FILES_JSON must be valid JSON",
			"provide a JSON array of changed path objects",
		)
	}
	if (
		!Array.isArray(parsed) ||
		!parsed.every(
			(file) =>
				file &&
				typeof file === "object" &&
				typeof (file as ReleaseImpactChangedFile).path === "string" &&
				((file as ReleaseImpactChangedFile).versionOnly === undefined ||
					typeof (file as ReleaseImpactChangedFile).versionOnly === "boolean"),
		)
	) {
		throw new ReleaseImpactError(
			"usage",
			"CHANGED_FILES_JSON must contain changed path objects",
			"provide a JSON array of {path, versionOnly?} objects",
		)
	}
	return parsed as ReleaseImpactChangedFile[]
}

function changedFiles(options: CliOptions): ReleaseImpactChangedFile[] {
	if (process.env.CHANGED_FILES_JSON) {
		return environmentChangedFiles(process.env.CHANGED_FILES_JSON)
	}
	if (!options.base || !options.head) {
		throw new ReleaseImpactError(
			"usage",
			"--base and --head are required when CHANGED_FILES_JSON is absent",
			"pass --base and --head or set BASE_SHA and HEAD_SHA",
		)
	}
	return gitChangedFiles(options.base, options.head)
}

function gateFailure(result: ReleaseImpactResult): ReleaseImpactError {
	const paths = result.changedPayloadPaths.join(", ")
	return new ReleaseImpactError(
		"release_impact",
		`Installable payload changed at ${paths}. Use feat, fix, perf, or a breaking (!) title.`,
		"change the pull request title to a releasable Conventional Commit class",
	)
}

function emitFailure(error: ReleaseImpactError, runId: string, result?: ReleaseImpactResult): void {
	console.log(
		JSON.stringify({
			...(result ?? { ok: false }),
			runId,
			category: error.category,
			message: error.message,
			retrySafe: error.retrySafe,
			nextAction: error.nextAction,
			sideEffects: "none",
		}),
	)
	console.error(`release-impact: ${error.message}`)
	console.error(`Next: ${error.nextAction}`)
}

function main(arguments_: string[]): void {
	const runId = crypto.randomUUID()
	try {
		const options = parseOptions(arguments_)
		if (options.help) {
			console.log(help)
			return
		}
		const title = process.env.PR_TITLE
		if (!title) {
			throw new ReleaseImpactError(
				"usage",
				"PR_TITLE is required",
				"set PR_TITLE to the pull request title and rerun the gate",
			)
		}
		const result = classifyReleaseImpact({
			title,
			changedFiles: changedFiles(options),
			pullRequestIdentity: {
				headRef: options.prHeadRef,
				authorLogin: options.prAuthorLogin,
				expectedAutomationLogin: options.expectedReleasePleaseLogin,
			},
		})
		if (!result.ok) {
			emitFailure(gateFailure(result), runId, result)
			process.exitCode = 1
			return
		}
		console.log(JSON.stringify({ ...result, runId, sideEffects: "none" }))
	} catch (error) {
		const failure =
			error instanceof ReleaseImpactError
				? error
				: new ReleaseImpactError(
						"unexpected",
						error instanceof Error ? error.message : String(error),
						"inspect the reported failure before rerunning the gate",
					)
		emitFailure(failure, runId)
		process.exitCode = failure.category === "usage" ? 2 : 1
	}
}

if (import.meta.main) main(process.argv.slice(2))
