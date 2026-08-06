import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

/** Canonical directory copied by development staging and release packaging. */
export const PLUGIN_DIRECTORY = "plugin"

/**
 * Order paths by JavaScript code units so inventories never depend on process locale.
 *
 * @param left - First path or entry name
 * @param right - Second path or entry name
 * @returns Negative when left sorts first, positive when right sorts first, or zero when equal
 *
 * @example
 * ```ts
 * ["ä", "Z", "a"].sort(compareCodeUnits)
 * ```
 */
export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

/**
 * List one directory tree in the exact depth-first order used by deterministic tar input.
 *
 * @param directory - Absolute directory whose entries have already passed payload validation
 * @param prefix - Archive-relative root name
 * @returns Root, directory, and file entries with directories carrying trailing slashes
 *
 * @example
 * ```ts
 * directoryArchiveEntries("/tmp/plugin", "hello-0.1.0")
 * ```
 */
export function directoryArchiveEntries(directory: string, prefix: string): string[] {
	const entries = [`${prefix}/`]
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		compareCodeUnits(left.name, right.name),
	)) {
		const relativePath = `${prefix}/${entry.name}`
		if (entry.isDirectory()) {
			entries.push(...directoryArchiveEntries(join(directory, entry.name), relativePath))
		} else {
			entries.push(relativePath)
		}
	}
	return entries
}

function unsafeEntry(relativePath: string, reason: string): Error {
	const entry = relativePath ? `${PLUGIN_DIRECTORY}/${relativePath}` : PLUGIN_DIRECTORY
	return new Error(`unsafe plugin payload entry "${entry}": ${reason}`)
}

/**
 * Discover the one deterministic set of regular files that may become a Plugin Payload.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @returns Sorted paths relative to `plugin/`, using forward slashes
 * @throws {Error} When the plugin root or any descendant is empty, a symlink, or a special file
 *
 * @example
 * ```ts
 * const files = pluginPayloadInventory(process.cwd())
 * ```
 */
export function pluginPayloadInventory(sourceRoot: string): string[] {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const pluginRootStatus = lstatSync(pluginRoot)
	if (pluginRootStatus.isSymbolicLink()) throw unsafeEntry("", "symlink")
	if (!pluginRootStatus.isDirectory()) throw unsafeEntry("", "special file (expected directory)")

	const pluginRealRoot = realpathSync(pluginRoot)
	const inventory: string[] = []

	function walk(directory: string, relativeDirectory: string): void {
		const entries = readdirSync(directory).sort(compareCodeUnits)
		if (entries.length === 0) throw unsafeEntry(relativeDirectory, "empty directory")
		for (const entry of entries) {
			const absolutePath = join(directory, entry)
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry
			const status = lstatSync(absolutePath)

			if (status.isSymbolicLink()) throw unsafeEntry(relativePath, "symlink")
			if (!status.isDirectory() && !status.isFile()) {
				throw unsafeEntry(relativePath, "special file (FIFO, device, or socket)")
			}
			if (status.isDirectory()) {
				walk(absolutePath, relativePath)
				continue
			}
			inventory.push(relativePath)
		}
	}

	// Walk from the resolved root. Every descendant is lstat'd and symlinks are
	// rejected before descent, so valid POSIX names need no per-entry realpath.
	walk(pluginRealRoot, "")
	return inventory.sort(compareCodeUnits)
}

/**
 * Copy the exact canonical plugin payload without repository tooling or source.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @param targetRoot - Empty or replaceable directory receiving plugin contents
 * @returns The validated inventory copied into the target
 * @throws {Error} When the canonical payload contains an empty directory, symlink, special file, or realpath escape
 *
 * @example
 * ```ts
 * copyPluginPayload(process.cwd(), "/tmp/installed-plugin")
 * ```
 */
export function copyPluginPayload(sourceRoot: string, targetRoot: string): string[] {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const inventory = pluginPayloadInventory(sourceRoot)
	mkdirSync(targetRoot, { recursive: true })
	for (const relativePath of inventory) {
		const sourcePath = join(pluginRoot, relativePath)
		const targetPath = join(targetRoot, relativePath)
		const sourceStatus = lstatSync(sourcePath)
		if (!sourceStatus.isFile()) throw unsafeEntry(relativePath, "changed after inventory (expected file)")
		mkdirSync(dirname(targetPath), { recursive: true })
		copyFileSync(sourcePath, targetPath)
		chmodSync(targetPath, sourceStatus.mode & 0o7777)
	}
	return inventory
}
