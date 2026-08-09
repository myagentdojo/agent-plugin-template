import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { compareCodeUnits } from "./plugin-files"

/** Single owner for files Release Please may modify during publication admission. */
export const RELEASE_PROJECTION_PATHS = [
	".claude-plugin/marketplace.json",
	".github/.release-please-manifest.json",
	"CHANGELOG.md",
	"package.json",
	"plugin.config.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
] as const

export const RELEASE_PROJECTION_PATH_SET = new Set<string>(RELEASE_PROJECTION_PATHS)

const CHANGELOG_HEADER = "# Changelog\n\n"
const SEMANTIC_VERSION = "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?"

const jsonVersionPaths = new Set([
	"package.json",
	"plugin.config.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
])

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
		} else return undefined
		return JSON.stringify(value)
	} catch {
		return undefined
	}
}

/** Compare one file after removing only its Release Please-owned version projection. */
export function isReleaseProjectionVersionOnlyChange(
	path: string,
	before: string,
	after: string,
	expectedVersion?: string,
): boolean {
	if (!RELEASE_PROJECTION_PATH_SET.has(path)) return false
	if (path === "CHANGELOG.md") {
		const beforeBody = before === "" ? "" : before.startsWith(CHANGELOG_HEADER) ? before.slice(CHANGELOG_HEADER.length) : undefined
		if (beforeBody === undefined || !after.startsWith(CHANGELOG_HEADER)) return false
		const afterBody = after.slice(CHANGELOG_HEADER.length)
		if (!afterBody.endsWith(beforeBody)) return false
		const added = beforeBody === "" ? afterBody : afterBody.slice(0, -beforeBody.length)
		const headings = added.match(/^## .+$/gm) ?? []
		if (headings.length !== 1) return false
		if (!added.startsWith(`${headings[0]}\n`) || /^# [^#]/m.test(added)) return false
		const match = headings[0].match(
			new RegExp(`^## (?:\\[(${SEMANTIC_VERSION})\\]\\([^\\n)]+\\)|(${SEMANTIC_VERSION}))(?: \\(\\d{4}-\\d{2}-\\d{2}\\))?$`),
		)
		const version = match?.[1] ?? match?.[2]
		return version !== undefined && (expectedVersion === undefined || version === expectedVersion)
	}
	const normalizedBefore = normalizedJsonVersion(path, before)
	const normalizedAfter = normalizedJsonVersion(path, after)
	return normalizedBefore !== undefined && normalizedBefore === normalizedAfter
}

export interface ReleaseProjectionFile {
	filename: string
	status: string
	sha?: string
}

/** Validate the exact changed-file set, statuses, and version-only bytes. */
export function validateReleaseProjection(
	files: ReleaseProjectionFile[],
	readVersions: (path: string) => { before: string; after: string; afterSha?: string },
	actualChangedFiles?: string[],
): { changedFiles: string[]; projectionDigest: string } {
	const sorted = [...files].sort((left, right) => compareCodeUnits(left.filename, right.filename))
	const changedFiles = sorted.map((file) => file.filename)
	if (actualChangedFiles !== undefined) {
		const actual = [...actualChangedFiles].sort(compareCodeUnits)
		if (JSON.stringify(actual) !== JSON.stringify(changedFiles)) {
			throw new Error("release projection does not match the candidate changed-file set")
		}
	}
	let expectedVersion: string | undefined
	if (sorted.some((file) => file.filename === "CHANGELOG.md")) {
		try {
			const manifest = JSON.parse(
				readVersions(".github/.release-please-manifest.json").after,
			) as Record<string, unknown>
			expectedVersion = typeof manifest["."] === "string" ? manifest["."] : undefined
		} catch {
			expectedVersion = undefined
		}
		if (!expectedVersion) throw new Error("release projection cannot resolve the current changelog version")
	}
	if (sorted.length === 0) throw new Error("release projection is empty")
	if (new Set(sorted.map((file) => file.filename)).size !== sorted.length) {
		throw new Error("release projection contains duplicate paths")
	}
	for (const file of sorted) {
		if (!RELEASE_PROJECTION_PATH_SET.has(file.filename)) {
			throw new Error(`release projection contains unsupported path: ${file.filename}`)
		}
		if (file.status !== "modified") {
			throw new Error(`release projection contains unsupported status: ${file.filename} ${file.status}`)
		}
		const versions = readVersions(file.filename)
		if (versions.afterSha !== undefined && file.sha !== versions.afterSha) {
			throw new Error(`release projection does not match the reviewed head blob: ${file.filename}`)
		}
		if (!isReleaseProjectionVersionOnlyChange(file.filename, versions.before, versions.after, expectedVersion)) {
			throw new Error(`release projection changed non-version behavior: ${file.filename}`)
		}
	}
	const canonical = JSON.stringify(sorted)
	return {
		changedFiles,
		projectionDigest: createHash("sha256").update(canonical).digest("hex"),
	}
}

function gitFile(ref: string, path: string): string {
	const result = Bun.spawnSync({
		cmd: ["git", "show", `${ref}:${path}`],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		throw new Error(`cannot read ${path} at ${ref}: ${result.stderr.toString().trim()}`)
	}
	return result.stdout.toString()
}

function gitObjectId(ref: string, path: string): string {
	const result = Bun.spawnSync({
		cmd: ["git", "rev-parse", "--verify", `${ref}:${path}`],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		throw new Error(`cannot resolve ${path} at ${ref}: ${result.stderr.toString().trim()}`)
	}
	return result.stdout.toString().trim()
}

function gitChangedFiles(base: string, head: string): string[] {
	const result = Bun.spawnSync({
		cmd: ["git", "diff", "--name-only", "-z", base, head, "--"],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		throw new Error(`cannot resolve candidate changed files: ${result.stderr.toString().trim()}`)
	}
	return result.stdout.toString().split("\0").filter((path) => path.length > 0)
}

if (import.meta.main) {
	const arguments_ = process.argv.slice(2)
	const value = (name: string): string => {
		const index = arguments_.indexOf(name)
		const result = index === -1 ? undefined : arguments_[index + 1]
		if (!result || result.startsWith("--")) throw new Error(`${name} is required`)
		return result
	}
	try {
		const base = value("--base")
		const head = value("--head")
		const projectionPath = value("--projection")
		const files = JSON.parse(readFileSync(projectionPath, "utf8")) as ReleaseProjectionFile[]
		const result = validateReleaseProjection(files, (path) => ({
			before: gitFile(base, path),
			after: gitFile(head, path),
			afterSha: gitObjectId(head, path),
		}), gitChangedFiles(base, head))
		console.log(JSON.stringify({ ok: true, ...result }))
	} catch (error) {
		console.error(`release:projection: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
