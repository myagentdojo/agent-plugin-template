import { cpSync, mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** Canonical directory copied by development staging and release packaging. */
export const PLUGIN_DIRECTORY = "plugin"

/**
 * Copy the exact canonical plugin payload without repository tooling or source.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @param targetRoot - Empty or replaceable directory receiving plugin contents
 *
 * @example
 * ```ts
 * copyPluginPayload(process.cwd(), "/tmp/installed-plugin")
 * ```
 */
export function copyPluginPayload(sourceRoot: string, targetRoot: string): void {
	const pluginRoot = join(sourceRoot, PLUGIN_DIRECTORY)
	mkdirSync(targetRoot, { recursive: true })
	for (const entry of readdirSync(pluginRoot).sort()) {
		cpSync(join(pluginRoot, entry), join(targetRoot, entry), { recursive: true })
	}
}
