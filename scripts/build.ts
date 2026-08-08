import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"
import { compareCodeUnits, loadSkillCatalog, shellQuote } from "./runtime-custody-config"

const nodeBuiltins = new Set(builtinModules)
const managedBundlePattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)-[a-f0-9]{16}\.js$/
const permissiveLicenses = new Set([
	"MIT",
	"ISC",
	"Apache-2.0",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"0BSD",
])
const lifecycleScripts = ["preinstall", "install", "postinstall"] as const

/** Precise reason one skill bundle was rejected before materialization. */
export type BundleValidationCode =
	| "missing-entry"
	| "unresolved-import"
	| "parent-resolution"
	| "native-addon"
	| "computed-dynamic-import"
	| "computed-require"
	| "bare-specifier"
	| "unexpected-output"
	| "bundler-failure"

/** Typed bundle rejection carrying the failing skill and escape class. */
export class BundleValidationError extends Error {
	readonly code: BundleValidationCode
	readonly skillId: string

	constructor(skillId: string, code: BundleValidationCode, message: string) {
		super(`bundle ${skillId}: ${message}`)
		this.name = "BundleValidationError"
		this.code = code
		this.skillId = skillId
	}
}

/** Precise reason one dependency was rejected from the pure-JavaScript closure. */
export type DependencyAdmissionCode =
	| "trusted-dependencies"
	| "store-missing"
	| "lifecycle-script"
	| "native-addon"
	| "optional-dependencies"
	| "unresolved-peer"
	| "license"

/** Typed dependency rejection carrying the failing package and admission rule. */
export class DependencyAdmissionError extends Error {
	readonly code: DependencyAdmissionCode

	constructor(code: DependencyAdmissionCode, message: string) {
		super(`dependency admission: ${message}`)
		this.name = "DependencyAdmissionError"
		this.code = code
	}
}

/** One admitted third-party package with its notice metadata. */
export interface AdmittedDependency {
	name: string
	version: string
	license: string
	licenseText?: string
}

/** One materialized bundle identity owned by the generated inventory. */
export interface BundleRecord {
	/** Payload-relative digest-named bundle path. */
	path: string
	bytes: number
	sha256: string
}

/** Result of one complete workspace bundle build and materialization. */
export interface BundleClosureResult {
	bundles: Record<string, BundleRecord>
	notices: BundleRecord
}

interface BundleArtifact {
	skillId: string
	fileName: string
	bytes: number
	sha256: string
	contents: Uint8Array
}

function sha256Hex(contents: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(contents).digest("hex")
}

/**
 * Collect every string-literal module specifier used by bundle text.
 *
 * @param code - JavaScript bundle text
 * @returns Sorted unique specifiers from static imports, side-effect imports, dynamic imports, and requires
 *
 * @example
 * ```ts
 * collectModuleSpecifiers('import ms from "ms"') // ["ms"]
 * ```
 */
export function collectModuleSpecifiers(code: string): string[] {
	const patterns = [
		/\bfrom\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g,
		/\bimport\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/g,
		/\bimport\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g,
		/\brequire\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/g,
	]
	const specifiers = new Set<string>()
	for (const pattern of patterns) {
		for (const match of code.matchAll(pattern)) specifiers.add(match[2])
	}
	return [...specifiers].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function allowedRuntimeSpecifier(specifier: string): boolean {
	return (
		specifier.startsWith("node:") || specifier.startsWith("bun:") || nodeBuiltins.has(specifier)
	)
}

/**
 * Reject bundle text that still reaches outside the closed artifact at runtime.
 *
 * @param skillId - Skill whose bundle is validated
 * @param code - Final JavaScript bundle text
 * @throws {BundleValidationError} On computed dynamic imports, computed requires, or non-built-in specifiers
 *
 * @example
 * ```ts
 * validateBundleText("skill-a", 'import { join } from "node:path"')
 * ```
 */
export function validateBundleText(skillId: string, code: string): void {
	// Every dynamic-load call site must be a single immediately-closed string
	// literal: any other argument shape (concatenation, identifier, member
	// expression, template) is a runtime-computed load the closure cannot prove.
	const literalCallTail = /^\s*(["'])(?:(?!\1)[^\\]|\\.)*\1\s*\)/
	for (const match of code.matchAll(/\bimport\s*\(/g)) {
		if (!literalCallTail.test(code.slice(match.index + match[0].length))) {
			throw new BundleValidationError(
				skillId,
				"computed-dynamic-import",
				`bundle retains a computed dynamic import near "${code.slice(match.index, match.index + 40)}"`,
			)
		}
	}
	for (const match of code.matchAll(/\b(?:__require|require)\s*\(/g)) {
		if (!literalCallTail.test(code.slice(match.index + match[0].length))) {
			throw new BundleValidationError(
				skillId,
				"computed-require",
				`bundle retains a computed runtime require near "${code.slice(match.index, match.index + 40)}"`,
			)
		}
	}
	for (const specifier of collectModuleSpecifiers(code)) {
		if (specifier.startsWith("./") || specifier.startsWith("../")) continue
		if (!allowedRuntimeSpecifier(specifier)) {
			throw new BundleValidationError(
				skillId,
				"bare-specifier",
				`bundle retains the bare specifier "${specifier}"; only node: and bun: built-ins may remain`,
			)
		}
	}
}

function isInsideDirectory(path: string, directory: string): boolean {
	return path === directory || path.startsWith(`${directory}/`)
}

/**
 * Bundle one workspace skill into a single validated ESM artifact in private staging.
 *
 * @param repositoryRoot - Repository root that bounds every dependency resolution
 * @param skillId - Catalog skill identity
 * @param workspace - Repository-relative workspace package path
 * @param stagingDirectory - Private staging directory outside the payload
 * @returns Digest-named artifact bytes ready for materialization
 * @throws {BundleValidationError} On any dependency, output, or bundle-text escape
 *
 * @example
 * ```ts
 * const artifact = await bundleWorkspaceSkill(root, "skill-a", "packages/skill-a", staging)
 * ```
 */
export async function bundleWorkspaceSkill(
	repositoryRoot: string,
	skillId: string,
	workspace: string,
	stagingDirectory: string,
): Promise<BundleArtifact> {
	const realRoot = realpathSync(repositoryRoot)
	const workspaceRoot = join(realRoot, workspace)
	const workspaceManifest = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"))
	const entryPoint = join(workspaceRoot, String(workspaceManifest.main ?? ""))
	if (!workspaceManifest.main || !existsSync(entryPoint)) {
		throw new BundleValidationError(
			skillId,
			"missing-entry",
			`workspace ${workspace} does not declare an existing "main" entry`,
		)
	}

	const violations: BundleValidationError[] = []
	const closedResolution: import("bun").BunPlugin = {
		name: "closed-dependency-resolution",
		setup(builder) {
			builder.onResolve({ filter: /\.node$/ }, (args) => {
				violations.push(
					new BundleValidationError(
						skillId,
						"native-addon",
						`native addon "${args.path}" imported from ${relative(realRoot, args.importer)}`,
					),
				)
				return { path: args.path, external: true }
			})
			// Validation only: Bun's own condition-aware resolver performs the real
			// resolution so require and import conditions stay correct.
			builder.onResolve({ filter: /^[^./]/ }, (args) => {
				const specifier = args.path
				if (allowedRuntimeSpecifier(specifier)) return undefined
				let resolved: string
				try {
					resolved = Bun.resolveSync(specifier, dirname(args.importer))
				} catch {
					violations.push(
						new BundleValidationError(
							skillId,
							"unresolved-import",
							`unresolved bare import "${specifier}" from ${relative(realRoot, args.importer)}`,
						),
					)
					return { path: specifier, external: true }
				}
				const realResolved = realpathSync(resolved)
				if (resolved.endsWith(".node") || realResolved.endsWith(".node")) {
					violations.push(
						new BundleValidationError(
							skillId,
							"native-addon",
							`native addon "${specifier}" imported from ${relative(realRoot, args.importer)}`,
						),
					)
					return { path: specifier, external: true }
				}
				if (!isInsideDirectory(realResolved, realRoot)) {
					violations.push(
						new BundleValidationError(
							skillId,
							"parent-resolution",
							`"${specifier}" resolved outside the repository: ${realResolved}`,
						),
					)
					return { path: specifier, external: true }
				}
				return undefined
			})
			builder.onResolve({ filter: /^[./]/ }, (args) => {
				if (!args.importer) return undefined
				let realResolved: string
				try {
					realResolved = realpathSync(Bun.resolveSync(args.path, dirname(args.importer)))
				} catch {
					// Unresolvable relative/absolute paths surface as the bundler's own error.
					return undefined
				}
				if (!isInsideDirectory(realResolved, realRoot)) {
					violations.push(
						new BundleValidationError(
							skillId,
							"parent-resolution",
							`"${args.path}" resolved outside the repository: ${realResolved}`,
						),
					)
					return { path: args.path, external: true }
				}
				return undefined
			})
		},
	}

	const outputDirectory = join(stagingDirectory, skillId)
	mkdirSync(outputDirectory, { recursive: true })
	let result: Awaited<ReturnType<typeof Bun.build>>
	try {
		result = await Bun.build({
			entrypoints: [entryPoint],
			outdir: outputDirectory,
			naming: `${skillId}.js`,
			target: "bun",
			format: "esm",
			splitting: false,
			sourcemap: "none",
			minify: false,
			env: "disable",
			plugins: [closedResolution],
		})
	} catch (error) {
		if (violations.length > 0) throw violations[0]
		const messages =
			error instanceof AggregateError ? error.errors.map((entry) => String(entry)) : [String(error)]
		throw new BundleValidationError(skillId, "bundler-failure", messages.join("\n"))
	}
	if (violations.length > 0) throw violations[0]
	if (!result.success) {
		throw new BundleValidationError(
			skillId,
			"bundler-failure",
			result.logs.map((log) => String(log)).join("\n"),
		)
	}

	const outputs = readdirSync(outputDirectory, { recursive: true }) as string[]
	const nativeOutputs = outputs.filter((output) => output.endsWith(".node"))
	if (nativeOutputs.length > 0) {
		throw new BundleValidationError(
			skillId,
			"native-addon",
			`bundle emitted native addon artifacts: ${nativeOutputs.join(", ")}`,
		)
	}
	if (outputs.length !== 1 || outputs[0] !== `${skillId}.js`) {
		throw new BundleValidationError(
			skillId,
			"unexpected-output",
			`bundle must emit exactly one JavaScript artifact; received ${JSON.stringify(outputs.sort())}`,
		)
	}

	const contents = new Uint8Array(readFileSync(join(outputDirectory, `${skillId}.js`)))
	validateBundleText(skillId, new TextDecoder().decode(contents))
	const sha256 = sha256Hex(contents)
	return {
		skillId,
		fileName: `${skillId}-${sha256.slice(0, 16)}.js`,
		bytes: contents.byteLength,
		sha256,
		contents,
	}
}

function parseFrozenLock(root: string): { packages: Record<string, unknown[]> } {
	const lockPath = join(root, "bun.lock")
	if (!existsSync(lockPath)) {
		throw new DependencyAdmissionError(
			"store-missing",
			"bun.lock is missing; run bun install to freeze the dependency closure",
		)
	}
	const lockText = readFileSync(lockPath, "utf8")
	return JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1"))
}

function dependencyStoreDirectory(root: string, name: string, version: string): string {
	for (const storeName of [`${name}@${version}`, `${name.replace("/", "+")}@${version}`]) {
		const candidate = join(root, "node_modules", ".bun", storeName, "node_modules", name)
		if (existsSync(join(candidate, "package.json"))) return candidate
	}
	throw new DependencyAdmissionError(
		"store-missing",
		`${name}@${version} is not present in the isolated store; run bun install --frozen-lockfile`,
	)
}

function findNativeArtifact(directory: string, prefix = ""): string | undefined {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) {
			const nested = findNativeArtifact(join(directory, entry.name), relativePath)
			if (nested) return nested
			continue
		}
		if (entry.name.endsWith(".node") || entry.name === "binding.gyp") return relativePath
	}
	return undefined
}

function readLicenseText(directory: string): string | undefined {
	for (const entry of readdirSync(directory)) {
		if (/^(license|licence|copying)(\.(md|txt))?$/i.test(entry)) {
			return readFileSync(join(directory, entry), "utf8")
		}
	}
	return undefined
}

/**
 * Admit only pure-JavaScript, lifecycle-free, permissively licensed dependencies from the frozen lock.
 *
 * @param root - Repository root containing bun.lock and the isolated store
 * @returns Admitted third-party packages sorted by name
 * @throws {DependencyAdmissionError} When any dependency violates the closed admission contract
 *
 * @example
 * ```ts
 * const dependencies = admitDependencyClosure(process.cwd())
 * ```
 */
export function admitDependencyClosure(root: string): AdmittedDependency[] {
	const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
	if (rootManifest.trustedDependencies !== undefined) {
		throw new DependencyAdmissionError(
			"trusted-dependencies",
			"package.json must not declare trustedDependencies",
		)
	}

	const lock = parseFrozenLock(root)
	const lockedNames = new Set<string>()
	const npmDependencies: Array<{ name: string; version: string }> = []
	for (const value of Object.values(lock.packages ?? {})) {
		const identity = String(value[0])
		const separator = identity.lastIndexOf("@")
		const name = identity.slice(0, separator)
		const reference = identity.slice(separator + 1)
		lockedNames.add(name)
		if (!reference.startsWith("workspace:")) npmDependencies.push({ name, version: reference })
	}

	const admitted: AdmittedDependency[] = []
	for (const { name, version } of npmDependencies.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	)) {
		const packageDirectory = dependencyStoreDirectory(root, name, version)
		const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"))
		for (const script of lifecycleScripts) {
			if (manifest.scripts?.[script] !== undefined) {
				throw new DependencyAdmissionError(
					"lifecycle-script",
					`${name}@${version} declares lifecycle script "${script}"`,
				)
			}
		}
		if (manifest.gypfile === true) {
			throw new DependencyAdmissionError(
				"native-addon",
				`${name}@${version} declares a native gyp build`,
			)
		}
		const nativeArtifact = findNativeArtifact(packageDirectory)
		if (nativeArtifact) {
			throw new DependencyAdmissionError(
				"native-addon",
				`${name}@${version} ships the native artifact ${nativeArtifact}`,
			)
		}
		if (Object.keys(manifest.optionalDependencies ?? {}).length > 0) {
			throw new DependencyAdmissionError(
				"optional-dependencies",
				`${name}@${version} declares optionalDependencies, which may carry undeclared native artifacts`,
			)
		}
		for (const peerName of Object.keys(manifest.peerDependencies ?? {})) {
			if (manifest.peerDependenciesMeta?.[peerName]?.optional === true) continue
			if (!lockedNames.has(peerName)) {
				throw new DependencyAdmissionError(
					"unresolved-peer",
					`${name}@${version} has unresolved peer "${peerName}"`,
				)
			}
		}
		if (typeof manifest.license !== "string" || !permissiveLicenses.has(manifest.license)) {
			throw new DependencyAdmissionError(
				"license",
				`${name}@${version} license ${JSON.stringify(manifest.license ?? null)} is not in the permissive allowlist`,
			)
		}
		admitted.push({
			name,
			version,
			license: manifest.license,
			licenseText: readLicenseText(packageDirectory),
		})
	}
	return admitted
}

/**
 * Render deterministic third-party notices from the admitted dependency closure.
 *
 * @param dependencies - Admitted packages sorted by name
 * @returns Markdown notices carrying package name, version, license, and text
 *
 * @example
 * ```ts
 * renderThirdPartyNotices(admitDependencyClosure(root))
 * ```
 */
export function renderThirdPartyNotices(dependencies: AdmittedDependency[]): string {
	const sections = dependencies.map((dependency) => {
		const heading = `## ${dependency.name}@${dependency.version} (${dependency.license})`
		const text = dependency.licenseText?.trimEnd()
		return text ? `${heading}\n\n${text}\n` : `${heading}\n\nLicense text not distributed by the package.\n`
	})
	return `# Third-Party Notices\n\nGenerated from bun.lock. Edit workspace dependencies, run bun install, then bun run build.\n\n${sections.join("\n")}`
}

/**
 * Render the deterministic shell projection of the bundle inventory.
 *
 * The custody engine (plugin/runtime/runtime-exec) sources this projection to
 * resolve a skill's digest-named bundle without parsing JSON in shell. It is
 * owned by the same build that writes bundle-inventory.json.
 *
 * @param bundles - Materialized bundle records keyed by skill id
 * @returns POSIX shell projection defining runtime_inventory_select_bundle
 *
 * @example
 * ```ts
 * renderBundleInventoryProjection(closure.bundles)
 * ```
 */
export function renderBundleInventoryProjection(bundles: Record<string, BundleRecord>): string {
	const cases = Object.keys(bundles)
		.sort(compareCodeUnits)
		.map((skillId) => {
			const record = bundles[skillId]
			return `	${skillId})
		RUNTIME_BUNDLE_PATH=${shellQuote(record.path)}
		RUNTIME_BUNDLE_BYTES=${shellQuote(String(record.bytes))}
		RUNTIME_BUNDLE_SHA256=${shellQuote(record.sha256)}
		;;`
		})
	return `#!/bin/sh
# Generated from bundle-inventory.json by scripts/build.ts. Edit workspace sources, then run bun run build.
runtime_inventory_select_bundle() {
	case "$1" in
${cases.join("\n")}
	*) return 1 ;;
	esac
}
`
}

function serializeInventory(result: BundleClosureResult): string {
	return `${JSON.stringify(
		{ schemaVersion: 1, bundles: result.bundles, notices: result.notices },
		null,
		2,
	)}\n`
}

/**
 * Build, validate, and materialize every catalog workspace bundle plus inventory and notices.
 *
 * Bundles are produced in private external staging; the checked-in payload changes
 * only after the complete candidate closure validates.
 *
 * @param root - Repository root owning catalog, workspaces, and payload
 * @returns Materialized bundle records and notice identity
 * @throws {BundleValidationError | DependencyAdmissionError} When any candidate fails validation
 *
 * @example
 * ```ts
 * const closure = await buildWorkspaceBundles(process.cwd())
 * ```
 */
export async function buildWorkspaceBundles(root: string): Promise<BundleClosureResult> {
	const catalog = loadSkillCatalog(root)
	const workspaceSkills = Object.entries(catalog.skills)
		.filter(([, skill]) => skill.workspace !== undefined)
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

	const dependencies = admitDependencyClosure(root)
	const noticesText = renderThirdPartyNotices(dependencies)

	const stagingDirectory = mkdtempSync(join(tmpdir(), "skill-bundle-staging-"))
	const artifacts: BundleArtifact[] = []
	try {
		for (const [skillId, skill] of workspaceSkills) {
			artifacts.push(
				await bundleWorkspaceSkill(root, skillId, skill.workspace as string, stagingDirectory),
			)
		}
	} finally {
		rmSync(stagingDirectory, { recursive: true, force: true })
	}

	// The complete candidate closure is validated; only now touch checked-in output.
	const runtimeDirectory = join(root, "plugin", "runtime")
	mkdirSync(runtimeDirectory, { recursive: true })
	const activeFileNames = new Set(artifacts.map((artifact) => artifact.fileName))
	for (const entry of readdirSync(runtimeDirectory)) {
		if (managedBundlePattern.test(entry) && !activeFileNames.has(entry)) {
			rmSync(join(runtimeDirectory, entry))
		}
	}
	const bundles: Record<string, BundleRecord> = {}
	for (const artifact of artifacts) {
		writeFileSync(join(runtimeDirectory, artifact.fileName), artifact.contents)
		bundles[artifact.skillId] = {
			path: `runtime/${artifact.fileName}`,
			bytes: artifact.bytes,
			sha256: artifact.sha256,
		}
	}
	const result: BundleClosureResult = {
		bundles,
		notices: {
			path: "THIRD-PARTY-NOTICES.md",
			bytes: Buffer.byteLength(noticesText),
			sha256: sha256Hex(noticesText),
		},
	}
	writeFileSync(join(root, "plugin", "THIRD-PARTY-NOTICES.md"), noticesText)
	writeFileSync(join(runtimeDirectory, "bundle-inventory.json"), serializeInventory(result))
	writeFileSync(
		join(runtimeDirectory, "bundle-inventory.sh"),
		renderBundleInventoryProjection(bundles),
	)
	return result
}

/**
 * Fail before packaging when catalog, inventory, bundles, or notices disagree.
 *
 * @param root - Repository root containing catalog and checked-in payload
 * @throws {Error} On missing, stale, or orphaned bundle mappings or stale notices
 *
 * @example
 * ```ts
 * validateBundleClosure(process.cwd())
 * ```
 */
export function validateBundleClosure(root: string): void {
	const catalog = loadSkillCatalog(root)
	const runtimeDirectory = join(root, "plugin", "runtime")
	const inventoryPath = join(runtimeDirectory, "bundle-inventory.json")
	if (!existsSync(inventoryPath)) {
		throw new Error("bundle closure: bundle-inventory.json is missing; run bun run build")
	}
	const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
		schemaVersion: number
		bundles: Record<string, BundleRecord>
		notices: BundleRecord
	}
	if (inventory.schemaVersion !== 1) {
		throw new Error("bundle closure: bundle-inventory.json schemaVersion must be 1")
	}

	const workspaceSkillIds = new Set(
		Object.entries(catalog.skills)
			.filter(([, skill]) => skill.workspace !== undefined)
			.map(([skillId]) => skillId),
	)
	for (const [skillId, skill] of Object.entries(catalog.skills)) {
		if (!existsSync(join(root, "plugin", "skills", skillId, "SKILL.md"))) {
			throw new Error(`bundle closure: missing SKILL.md for ${skillId}`)
		}
		if (skill.workspace === undefined) {
			if (!existsSync(join(root, "plugin", skill.entry))) {
				throw new Error(`bundle closure: missing entry ${skill.entry} for ${skillId}`)
			}
			continue
		}
		if (inventory.bundles[skillId] === undefined) {
			throw new Error(`bundle closure: missing bundle mapping for ${skillId}; run bun run build`)
		}
	}
	for (const [skillId, record] of Object.entries(inventory.bundles)) {
		if (!workspaceSkillIds.has(skillId)) {
			throw new Error(`bundle closure: orphaned mapping for ${skillId}; run bun run build`)
		}
		// The recorded path must be exactly the digest-derived name inside
		// plugin/runtime; anything else could pass digest checks while packaging
		// ships a payload without the executable bundle.
		if (!/^[a-f0-9]{64}$/.test(record.sha256)) {
			throw new Error(`bundle closure: invalid bundle digest for ${skillId}; run bun run build`)
		}
		if (record.path !== `runtime/${skillId}-${record.sha256.slice(0, 16)}.js`) {
			throw new Error(
				`bundle closure: invalid bundle path ${record.path} for ${skillId}; run bun run build`,
			)
		}
		const bundlePath = join(root, "plugin", record.path)
		if (!existsSync(bundlePath)) {
			throw new Error(`bundle closure: missing bundle file ${record.path} for ${skillId}`)
		}
		const contents = readFileSync(bundlePath)
		if (contents.byteLength !== record.bytes || sha256Hex(new Uint8Array(contents)) !== record.sha256) {
			throw new Error(`bundle closure: stale bundle for ${skillId}; run bun run build`)
		}
	}
	const activePaths = new Set(
		Object.values(inventory.bundles).map((record) => record.path.replace(/^runtime\//, "")),
	)
	for (const entry of readdirSync(runtimeDirectory)) {
		if (managedBundlePattern.test(entry) && !activePaths.has(entry)) {
			throw new Error(`bundle closure: orphaned bundle ${entry}; run bun run build`)
		}
	}
	const projectionPath = join(runtimeDirectory, "bundle-inventory.sh")
	if (!existsSync(projectionPath)) {
		throw new Error("bundle closure: bundle-inventory.sh is missing; run bun run build")
	}
	if (readFileSync(projectionPath, "utf8") !== renderBundleInventoryProjection(inventory.bundles)) {
		throw new Error("bundle closure: stale bundle inventory projection; run bun run build")
	}
	if (inventory.notices.path !== "THIRD-PARTY-NOTICES.md") {
		throw new Error(
			`bundle closure: invalid notices path ${inventory.notices.path}; run bun run build`,
		)
	}
	const noticesPath = join(root, "plugin", inventory.notices.path)
	if (!existsSync(noticesPath)) {
		throw new Error(`bundle closure: missing third-party notices ${inventory.notices.path}`)
	}
	const noticesContents = readFileSync(noticesPath)
	if (
		noticesContents.byteLength !== inventory.notices.bytes ||
		sha256Hex(new Uint8Array(noticesContents)) !== inventory.notices.sha256
	) {
		throw new Error("bundle closure: stale third-party notices; run bun run build")
	}
}

async function buildHelloWorldRuntime(root: string, version: string): Promise<string> {
	const sourceRoot = join(root, "runtime", "src")
	const outputDirectory = join(root, "plugin", "runtime")
	mkdirSync(outputDirectory, { recursive: true })
	const result = await Bun.build({
		entrypoints: [join(sourceRoot, "quickjs-adapter.ts")],
		outdir: outputDirectory,
		naming: "hello-world.js",
		target: "browser",
		format: "esm",
		external: ["qjs:std"],
		minify: true,
		banner: `// Generated from runtime/src/. Edit source, then run bun run build.
// x-release-please-start-version
const PLUGIN_VERSION = ${JSON.stringify(version)};
// x-release-please-end`,
	})
	if (!result.success) {
		for (const log of result.logs) console.error(log)
		process.exit(1)
	}
	return join(outputDirectory, "hello-world.js")
}

async function main(): Promise<void> {
	const root = resolve(import.meta.dir, "..")
	const pluginConfig = loadPluginConfig(root)
	for (const manifestPath of [
		"plugin/.claude-plugin/plugin.json",
		"plugin/.codex-plugin/plugin.json",
	]) {
		const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"))
		if (manifest.version !== pluginConfig.version) {
			throw new Error(`${manifestPath} version does not match plugin.config.json`)
		}
	}

	const helloWorldPath = await buildHelloWorldRuntime(root, pluginConfig.version)

	const install = Bun.spawnSync({
		cmd: [process.execPath, "install", "--frozen-lockfile"],
		cwd: root,
		stdout: "inherit",
		stderr: "inherit",
	})
	if (install.exitCode !== 0) process.exit(install.exitCode)

	const closure = await buildWorkspaceBundles(root)
	validateBundleClosure(root)
	console.log(helloWorldPath)
	console.log(
		JSON.stringify({
			ok: true,
			action: "built",
			sideEffects: "repository-files-written",
			bundles: closure.bundles,
			notices: closure.notices,
		}),
	)
}

if (import.meta.main) await main()
