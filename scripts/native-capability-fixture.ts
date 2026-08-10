import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
	type GeneratedFile,
	loadPluginConfig,
	writeGeneratedFileSet,
} from "./plugin-config"

const sourcePath = "plugin/hooks/fixture/lifecycle-mechanics-proof.source.json"
const projectionPath = "plugin/hooks/fixture/lifecycle-mechanics-proof.generated.json"

function serializeLifecycleMechanicsProof(displayName: string): string {
	return `${JSON.stringify(
		{
			schemaVersion: 1,
			purpose: `${displayName} lifecycle mechanics proof`,
		},
		null,
		2,
	)}\n`
}

/**
 * Render both lifecycle proof fixture files for one configured display name.
 *
 * The purpose string derives from the plugin's display name, so initialized
 * templates regenerate an identity-correct fixture instead of keeping the
 * template's product name.
 *
 * @param displayName - Validated human-readable plugin title
 * @returns The source and projection payload files with identical LF bytes
 *
 * @example
 * ```ts
 * const [source, projection] = renderNativeCapabilityFixtureFor("Dojo Hello")
 * ```
 */
export function renderNativeCapabilityFixtureFor(displayName: string): GeneratedFile[] {
	const contents = serializeLifecycleMechanicsProof(displayName)
	return [
		{ path: sourcePath, contents },
		{ path: projectionPath, contents },
	]
}

/**
 * Render the lifecycle proof fixture files with fixed field order and LF bytes.
 *
 * @param root - Plugin Repository root containing plugin.config.json
 * @returns The generated source and projection payload files
 * @throws {Error} When plugin.config.json is missing or violates its contract
 *
 * @example
 * ```ts
 * const [source, projection] = renderNativeCapabilityFixture(process.cwd())
 * ```
 */
export function renderNativeCapabilityFixture(root: string): GeneratedFile[] {
	return renderNativeCapabilityFixtureFor(loadPluginConfig(root).displayName)
}

/**
 * Write the generated lifecycle proof source and projection into the payload.
 *
 * @param root - Plugin Repository root receiving the fixture files
 * @returns The generated files written to the payload
 * @throws {Error} When configuration validation or fixture writing fails
 *
 * @example
 * ```ts
 * writeNativeCapabilityFixture(process.cwd())
 * ```
 */
export function writeNativeCapabilityFixture(root: string): GeneratedFile[] {
	return writeGeneratedFileSet(root, renderNativeCapabilityFixture(root))
}

/**
 * Find lifecycle proof fixture files whose checked-in bytes drifted.
 *
 * @param root - Plugin Repository root containing source and projection
 * @returns Repository-relative paths needing regeneration
 * @throws {Error} When plugin.config.json is missing or invalid
 *
 * @example
 * ```ts
 * const drifted = checkNativeCapabilityFixture(process.cwd())
 * ```
 */
export function checkNativeCapabilityFixture(root: string): string[] {
	return renderNativeCapabilityFixture(root)
		.filter((file) => {
			const path = join(root, file.path)
			return !existsSync(path) || readFileSync(path, "utf8") !== file.contents
		})
		.map((file) => file.path)
}
