import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

/** Single owner for files Release Please may modify during publication admission. */
export const RELEASE_PROJECTION_PATHS = [
	".claude-plugin/marketplace.json",
	".github/.release-please-manifest.json",
	"CHANGELOG.md",
	"package.json",
	"plugin.config.json",
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
	"plugin/hooks/codex/hooks.json",
	"plugin/runtime/hello-world.js",
] as const

export const RELEASE_PROJECTION_PATH_SET = new Set<string>(RELEASE_PROJECTION_PATHS)

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
): boolean {
	if (!RELEASE_PROJECTION_PATH_SET.has(path)) return false
	if (path === "CHANGELOG.md") return true
	if (path === "plugin/hooks/codex/hooks.json") {
		const normalize = (contents: string): string =>
			contents.replace(/--plugin-version\s+[^"\s]+/g, "--plugin-version VERSION")
		return normalize(before) === normalize(after)
	}
	if (path === "plugin/runtime/hello-world.js") {
		const normalize = (contents: string): string =>
			contents.replace(/const PLUGIN_VERSION = "[^"]+";/g, 'const PLUGIN_VERSION = "VERSION";')
		return normalize(before) === normalize(after)
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
	readVersions: (path: string) => { before: string; after: string },
): { changedFiles: string[]; projectionDigest: string } {
	const sorted = [...files].sort((left, right) => left.filename.localeCompare(right.filename))
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
		if (!isReleaseProjectionVersionOnlyChange(file.filename, versions.before, versions.after)) {
			throw new Error(`release projection changed non-version behavior: ${file.filename}`)
		}
	}
	const canonical = JSON.stringify(sorted)
	return {
		changedFiles: sorted.map((file) => file.filename),
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
		}))
		console.log(JSON.stringify({ ok: true, ...result }))
	} catch (error) {
		console.error(`release:projection: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
