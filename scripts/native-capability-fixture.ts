import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { GeneratedFile } from "./plugin-config"

const sourcePath = "plugin/hooks/fixture/lifecycle-mechanics-proof.source.json"
const projectionPath = "plugin/hooks/fixture/lifecycle-mechanics-proof.generated.json"

interface LifecycleMechanicsProof {
	schemaVersion: 1
	purpose: string
}

function loadLifecycleMechanicsProof(root: string): LifecycleMechanicsProof {
	const sourceContents = readFileSync(join(root, sourcePath), "utf8")
	const parsed = JSON.parse(sourceContents) as unknown
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("lifecycle mechanics proof source must be one JSON object")
	}
	const record = parsed as Record<string, unknown>
	if (
		Object.keys(record).sort().join("\0") !== "purpose\0schemaVersion" ||
		record.schemaVersion !== 1 ||
		typeof record.purpose !== "string" ||
		!record.purpose.trim()
	) {
		throw new Error("lifecycle mechanics proof source has an invalid fixed schema")
	}
	const source = { schemaVersion: 1 as const, purpose: record.purpose }
	if (sourceContents !== serializeLifecycleMechanicsProof(source)) {
		throw new Error(
			"lifecycle mechanics proof source must use fixed field order and LF line endings",
		)
	}
	return source
}

function serializeLifecycleMechanicsProof(source: LifecycleMechanicsProof): string {
	return `${JSON.stringify(
		{
			schemaVersion: source.schemaVersion,
			purpose: source.purpose,
		},
		null,
		2,
	)}\n`
}

/**
 * Render the lifecycle proof projection with fixed field order and LF bytes.
 *
 * @param root - Plugin Repository root containing the canonical fixture source
 * @returns The one generated payload projection
 * @throws {Error} When the canonical source is missing, malformed, or outside its fixed schema
 *
 * @example
 * ```ts
 * const [projection] = renderNativeCapabilityFixture(process.cwd())
 * ```
 */
export function renderNativeCapabilityFixture(root: string): GeneratedFile[] {
	const source = loadLifecycleMechanicsProof(root)
	return [
		{
			path: projectionPath,
			contents: serializeLifecycleMechanicsProof(source),
		},
	]
}

/**
 * Write the generated lifecycle proof projection beside its canonical source.
 *
 * @param root - Plugin Repository root receiving the projection
 * @returns The generated file written to the payload
 * @throws {Error} When source validation or projection writing fails
 *
 * @example
 * ```ts
 * writeNativeCapabilityFixture(process.cwd())
 * ```
 */
export function writeNativeCapabilityFixture(root: string): GeneratedFile[] {
	const files = renderNativeCapabilityFixture(root)
	for (const file of files) writeFileSync(join(root, file.path), file.contents)
	return files
}

/**
 * Find lifecycle proof projections whose checked-in bytes drifted.
 *
 * @param root - Plugin Repository root containing source and projection
 * @returns Repository-relative paths needing regeneration
 * @throws {Error} When the canonical source is missing or invalid
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
