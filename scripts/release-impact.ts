const acceptedTitleTypes = ["feat", "fix", "perf", "breaking (!)"] as const
const generatedPayloadPaths = new Set([
	".agents/plugins/marketplace.json",
	".claude-plugin/marketplace.json",
	"plugin.config.json",
])
const releasePleaseProjectionPaths = new Set([
	"package.json",
	"plugin.config.json",
	".claude-plugin/marketplace.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
	"plugin/runtime/hello-world.js",
	"plugin/hooks/codex/hooks.json",
	".github/.release-please-manifest.json",
	"CHANGELOG.md",
])
const jsonVersionPaths = new Set([
	"package.json",
	"plugin.config.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
])
const releasableTitle =
	/^(?:(?:feat|fix|perf)(?:\([a-z0-9._/-]+\))?!?|[a-z][a-z0-9-]*(?:\([a-z0-9._/-]+\))?!): .+$/

/** One base-to-head path plus the projection analysis performed by the caller. */
export interface ReleaseImpactChangedFile {
	/** Repository-relative path reported by git. */
	path: string
	/** True when the file differs only in its Release Please-owned version projection. */
	versionOnly?: boolean
}

/** Inputs needed to decide whether a pull request title can carry its payload diff. */
export interface ReleaseImpactInput {
	/** Pull request title evaluated as the future squash-merge commit. */
	title: string
	/** Base-to-head files, with version-only evidence where applicable. */
	changedFiles: readonly ReleaseImpactChangedFile[]
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
  --base <git-ref>   Pull request base commit; defaults to BASE_SHA
  --head <git-ref>   Pull request head commit; defaults to HEAD_SHA
  -h, --help         Show this help

Test input:
  CHANGED_FILES_JSON may provide [{"path":"...","versionOnly":true}] instead of git refs.

Output: one JSON result on stdout. Diagnostics use stderr.
Side effects: none.
`

function isPayloadPath(path: string): boolean {
	return (
		path.startsWith("plugin/") ||
		path.startsWith("runtime/src/") ||
		generatedPayloadPaths.has(path)
	)
}

function normalizedJsonVersion(path: string, contents: string): string | undefined {
	try {
		const value = JSON.parse(contents) as Record<string, unknown>
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
		if (path === ".claude-plugin/marketplace.json") {
			const metadata = value.metadata
			if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
			delete (metadata as Record<string, unknown>).version
		} else if (path === ".github/.release-please-manifest.json") {
			delete value["."]
		} else if (jsonVersionPaths.has(path)) {
			delete value.version
		} else {
			return undefined
		}
		return JSON.stringify(value)
	} catch {
		return undefined
	}
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
	if (!releasePleaseProjectionPaths.has(path)) return false
	if (path === "CHANGELOG.md") return true
	if (path === "plugin/hooks/codex/hooks.json") {
		const normalize = (contents: string): string =>
			contents.replace(/--plugin-version\s+[^"\s]+/g, "--plugin-version VERSION")
		return normalize(before) === normalize(after)
	}
	if (path === "plugin/runtime/hello-world.js") {
		const normalize = (contents: string): string =>
			contents.replace(
				/const PLUGIN_VERSION = "[^"]+";/g,
				'const PLUGIN_VERSION = "VERSION";',
			)
		return normalize(before) === normalize(after)
	}
	const normalizedBefore = normalizedJsonVersion(path, before)
	const normalizedAfter = normalizedJsonVersion(path, after)
	return normalizedBefore !== undefined && normalizedBefore === normalizedAfter
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
	const isReleasePleaseProjection =
		payloadChanged &&
		input.changedFiles.length > 0 &&
		input.changedFiles.every(
			(file) => releasePleaseProjectionPaths.has(file.path) && file.versionOnly === true,
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
			`${name} requires a git ref`,
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
		if (argument === "--base" || argument === "--head") {
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
	const changedPaths = (gitOutput(["diff", "--name-only", "-z", `${base}...${head}`, "--"]) ?? "")
		.split("\0")
		.filter(Boolean)
	return changedPaths.map((path) => {
		if (!releasePleaseProjectionPaths.has(path)) return { path }
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
		const result = classifyReleaseImpact({ title, changedFiles: changedFiles(options) })
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
