import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { GeneratedFile } from "./plugin-config"
import { compareCodeUnits } from "./plugin-files"

interface RuntimeAsset {
	archiveName: string
	url: string
	archiveBytes: number
	archiveSha256: string
	executablePath: string
	executableBytes: number
	executableSha256: string
}

interface RuntimeProfile {
	version: string
	assets: Record<string, RuntimeAsset>
}

interface RuntimeLock {
	schemaVersion: number
	profiles: Record<string, RuntimeProfile>
}

/** One logical skill registration owning entry, runtime, and optional workspace identity. */
export interface SkillCatalogEntry {
	/** Logical payload-relative bundle identity. */
	entry: string
	/** Runtime profile key that must exist in the runtime lock. */
	runtimeProfile: string
	/** Repository-relative workspace package that authors this skill's bundle. */
	workspace?: string
}

/** The one logical skill catalog owning every runtime-custody skill registration. */
export interface SkillCatalog {
	schemaVersion: number
	skills: Record<string, SkillCatalogEntry>
}

export const SUPPORTED_RUNTIME_PLATFORMS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
] as const
const lowercaseSha256 = /^[a-f0-9]{64}$/
const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Single-quote a projection value, rejecting values that cannot be quoted safely. */
export function shellQuote(value: string): string {
	if (value.includes("'")) throw new Error("runtime projection values must not contain single quotes")
	return `'${value}'`
}

function loadJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T
}

function validateRuntimeLock(lock: RuntimeLock): void {
	if (lock.schemaVersion !== 1) throw new Error("runtime lock schemaVersion must be 1")
	if (!isRecord(lock.profiles)) throw new Error("runtime lock profiles must be an object")
	if (Object.keys(lock.profiles).join(",") !== "bun") {
		throw new Error("runtime lock must contain only the bun profile")
	}
	const profile = lock.profiles.bun
	if (!isRecord(profile) || typeof profile.version !== "string" || !semanticVersion.test(profile.version)) {
		throw new Error("runtime lock bun version must be an exact semantic version")
	}
	if (!isRecord(profile.assets)) throw new Error("runtime lock bun assets must be an object")
	if (
		Object.keys(profile.assets).sort(compareCodeUnits).join(",") !==
		[...SUPPORTED_RUNTIME_PLATFORMS].sort(compareCodeUnits).join(",")
	) {
		throw new Error("runtime lock must contain exactly the four supported platforms")
	}
	for (const platform of SUPPORTED_RUNTIME_PLATFORMS) {
		const asset = profile.assets[platform]
		if (
			!asset ||
			!Number.isSafeInteger(asset.archiveBytes) ||
			asset.archiveBytes <= 0 ||
			!Number.isSafeInteger(asset.executableBytes) ||
			asset.executableBytes <= 0 ||
			!lowercaseSha256.test(asset.archiveSha256) ||
			!lowercaseSha256.test(asset.executableSha256)
		) {
			throw new Error(`runtime lock asset metadata is invalid for ${platform}`)
		}
		const upstreamPlatform = platform.replace("arm64", "aarch64")
		const upstreamAsset = platform.endsWith("-x64")
			? `${upstreamPlatform}-baseline`
			: upstreamPlatform
		const expectedArchive = `bun-${upstreamAsset}.zip`
		const expectedUrl =
			`https://github.com/oven-sh/bun/releases/download/bun-v${profile.version}/${expectedArchive}`
		if (
			asset.archiveName !== expectedArchive ||
			asset.url !== expectedUrl ||
			asset.executablePath !== `bun-${upstreamAsset}/bun`
		) {
			throw new Error(`runtime lock asset identity is invalid for ${platform}`)
		}
	}
}

function validateSkillCatalog(catalog: SkillCatalog, lock: RuntimeLock): void {
	if (catalog.schemaVersion !== 1) throw new Error("skill catalog schemaVersion must be 1")
	if (!isRecord(catalog.skills)) throw new Error("skill catalog skills must be an object")
	if (Object.keys(catalog.skills).length === 0) throw new Error("skill catalog must not be empty")
	for (const [skillId, skill] of Object.entries(catalog.skills)) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId)) {
			throw new Error(`skill catalog id is invalid: ${skillId}`)
		}
		if (!/^runtime\/[a-z0-9]+(?:-[a-z0-9]+)*\.js$/.test(skill.entry)) {
			throw new Error(`skill catalog entry is invalid for ${skillId}`)
		}
		if (!Object.hasOwn(lock.profiles, skill.runtimeProfile)) {
			throw new Error(`skill catalog profile is unknown for ${skillId}`)
		}
		if (
			skill.workspace !== undefined &&
			!/^packages\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.workspace)
		) {
			throw new Error(`skill catalog workspace is invalid for ${skillId}`)
		}
	}
}

/**
 * Load and validate the one logical skill catalog against the runtime lock.
 *
 * @param root - Plugin Repository root containing canonical runtime custody JSON
 * @returns The validated closed skill catalog
 * @throws {Error} When catalog or lock data violates the closed production contract
 *
 * @example
 * ```ts
 * const catalog = loadSkillCatalog(process.cwd())
 * ```
 */
export function loadSkillCatalog(root: string): SkillCatalog {
	return loadRuntimeCustodyConfig(root).catalog
}

function loadRuntimeCustodyConfig(root: string): {
	lock: RuntimeLock
	catalog: SkillCatalog
} {
	const lock = loadJson<RuntimeLock>(join(root, "runtime", "runtime.lock.json"))
	const catalog = loadJson<SkillCatalog>(join(root, "runtime", "skill-catalog.json"))
	validateRuntimeLock(lock)
	validateSkillCatalog(catalog, lock)
	return { lock, catalog }
}

function renderLockProjection(lock: RuntimeLock): string {
	const profile = lock.profiles.bun
	const cases = SUPPORTED_RUNTIME_PLATFORMS.map((platform) => {
		const asset = profile.assets[platform]
		return `	${platform})
		RUNTIME_ASSET_ARCHIVE_NAME=${shellQuote(asset.archiveName)}
		RUNTIME_ASSET_URL=${shellQuote(asset.url)}
		RUNTIME_ASSET_ARCHIVE_BYTES=${shellQuote(String(asset.archiveBytes))}
		RUNTIME_ASSET_ARCHIVE_SHA256=${shellQuote(asset.archiveSha256)}
		RUNTIME_ASSET_EXECUTABLE_PATH=${shellQuote(asset.executablePath)}
		RUNTIME_ASSET_EXECUTABLE_BYTES=${shellQuote(String(asset.executableBytes))}
		RUNTIME_ASSET_EXECUTABLE_SHA256=${shellQuote(asset.executableSha256)}
		;;`
	})
	return `#!/bin/sh
# Generated from runtime/runtime.lock.json. Edit the source, then run bun run generate.
RUNTIME_LOCK_PROFILE='bun'
RUNTIME_LOCK_VERSION=${shellQuote(profile.version)}

runtime_lock_select_asset() {
	case "$1" in
${cases.join("\n")}
	*) return 1 ;;
	esac
}
`
}

function renderCatalogProjection(catalog: SkillCatalog): string {
	const cases = Object.entries(catalog.skills)
		.sort(([left], [right]) => compareCodeUnits(left, right))
		.map(
			([skillId, skill]) => `	${skillId})
		RUNTIME_SKILL_ENTRY=${shellQuote(skill.entry)}
		RUNTIME_SKILL_PROFILE=${shellQuote(skill.runtimeProfile)}
		;;`,
		)
	return `#!/bin/sh
# Generated from runtime/skill-catalog.json. Edit the source, then run bun run generate.
runtime_catalog_select_skill() {
	case "$1" in
${cases.join("\n")}
	*) return 1 ;;
	esac
}
`
}

function renderLauncher(skillId: string): string {
	return `#!/bin/sh
# Generated from runtime/skill-catalog.json. Edit the source, then run bun run generate.
set -eu
case "$0" in
*/*) launcher_dir=\${0%/*} ;;
*) launcher_dir=. ;;
esac
plugin_root=$(CDPATH='' cd -- "$launcher_dir/.." && pwd -P)
exec "$plugin_root/runtime/runtime-exec" run ${skillId} -- "$@"
`
}

/**
 * Render every runtime-custody projection from the reviewed lock and closed skill catalog.
 *
 * @param root - Plugin Repository root containing canonical runtime custody JSON
 * @returns Deterministic payload files owned by the canonical runtime sources
 * @throws {Error} When lock or catalog data violates the closed production contract
 *
 * @example
 * ```ts
 * const files = renderRuntimeCustodyFiles(process.cwd())
 * ```
 */
export function renderRuntimeCustodyFiles(root: string): GeneratedFile[] {
	const { lock, catalog } = loadRuntimeCustodyConfig(root)
	return [
		{
			path: "plugin/runtime/runtime-lock.sh",
			contents: renderLockProjection(lock),
		},
		{
			path: "plugin/runtime/skill-catalog.sh",
			contents: renderCatalogProjection(catalog),
		},
		...Object.keys(catalog.skills)
			.sort(compareCodeUnits)
			.map((skillId) => ({
				path: `plugin/bin/${skillId}`,
				contents: renderLauncher(skillId),
			})),
	]
}

/**
 * Write runtime-custody projections and preserve launcher executability.
 *
 * @param root - Plugin Repository root receiving generated payload files
 * @returns Generated files written to the payload
 *
 * @example
 * ```ts
 * writeRuntimeCustodyFiles(process.cwd())
 * ```
 */
export function writeRuntimeCustodyFiles(root: string): GeneratedFile[] {
	const files = renderRuntimeCustodyFiles(root)
	for (const file of files) {
		const path = join(root, file.path)
		writeFileSync(path, file.contents)
		if (file.path.startsWith("plugin/bin/")) chmodSync(path, 0o755)
	}
	return files
}

/**
 * Find runtime-custody projections whose bytes or executable mode drifted.
 *
 * @param root - Plugin Repository root containing checked-in generated payload files
 * @returns Repository-relative paths that need regeneration
 *
 * @example
 * ```ts
 * const drifted = checkRuntimeCustodyFiles(process.cwd())
 * ```
 */
export function checkRuntimeCustodyFiles(root: string): string[] {
	return renderRuntimeCustodyFiles(root)
		.filter((file) => {
			const path = join(root, file.path)
			if (!existsSync(path) || readFileSync(path, "utf8") !== file.contents) return true
			return file.path.startsWith("plugin/bin/") && (statSync(path).mode & 0o111) === 0
		})
		.map((file) => file.path)
}
