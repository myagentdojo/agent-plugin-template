import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/** Canonical directory copied by development staging and release packaging. */
export const PLUGIN_DIRECTORY = "plugin"

function unsafeEntry(relativePath: string, reason: string): Error {
	const entry = relativePath ? `${PLUGIN_DIRECTORY}/${relativePath}` : PLUGIN_DIRECTORY
	return new Error(`unsafe plugin payload entry "${entry}": ${reason}`)
}

function assertRealpathContained(
	pluginRealRoot: string,
	absolutePath: string,
	relativePath: string,
): void {
	const resolvedPath = realpathSync(absolutePath)
	const pathFromPluginRoot = relative(pluginRealRoot, resolvedPath)
	if (
		pathFromPluginRoot === ".." ||
		pathFromPluginRoot.startsWith(`..${sep}`) ||
		isAbsolute(pathFromPluginRoot)
	) {
		throw unsafeEntry(relativePath, `realpath escapes plugin root (${resolvedPath})`)
	}
}

/**
 * Discover the one deterministic set of regular files that may become a Plugin Payload.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @returns Sorted paths relative to `plugin/`, using forward slashes
 * @throws {Error} When the plugin root or any descendant is a symlink, special file, or realpath escape
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
		for (const entry of readdirSync(directory).sort()) {
			const absolutePath = join(directory, entry)
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry
			const status = lstatSync(absolutePath)

			if (status.isSymbolicLink()) throw unsafeEntry(relativePath, "symlink")
			if (!status.isDirectory() && !status.isFile()) {
				throw unsafeEntry(relativePath, "special file (FIFO, device, or socket)")
			}
			assertRealpathContained(pluginRealRoot, absolutePath, relativePath)
			if (status.isDirectory()) {
				walk(absolutePath, relativePath)
				continue
			}
			inventory.push(relativePath)
		}
	}

	walk(pluginRoot, "")
	return inventory.sort()
}

/**
 * Copy the exact canonical plugin payload without repository tooling or source.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @param targetRoot - Empty or replaceable directory receiving plugin contents
 * @returns The validated inventory copied into the target
 * @throws {Error} When the canonical payload contains a symlink, special file, or realpath escape
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
		mkdirSync(dirname(targetPath), { recursive: true })
		copyFileSync(sourcePath, targetPath)
		chmodSync(targetPath, lstatSync(sourcePath).mode & 0o7777)
	}
	return inventory
}
