import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"
import { compareCodeUnits, pluginPayloadInventory } from "./plugin-files"
import { checkRuntimeCustodyFiles, loadSkillCatalog, shellQuote } from "./runtime-custody-config"

const nodeBuiltins = new Set(builtinModules)
const admittedBunBuiltins = new Set(["bun", "bun:sqlite"])
const runtimeEscapeBuiltins = new Set(["module", "node:module", "vm", "node:vm"])
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
	| "unsupported-entry"
	| "entry-escape"
	| "unresolved-import"
	| "unadmitted-import"
	| "parent-resolution"
	| "native-addon"
	| "computed-dynamic-import"
	| "computed-require"
	| "runtime-loader"
	| "dynamic-code-generation"
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
	| "lock-invalid"
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

interface InstallResult {
	exitCode: number | null
	signalCode?: string
	stderr?: Uint8Array
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

const bundleTranspiler = new Bun.Transpiler({ loader: "js" })

/**
 * Preserve JavaScript tokens while blanking comments and literal bodies.
 *
 * The validator only needs to distinguish executable loader identifiers from
 * the same words in strings, comments, templates, and regular expressions. A
 * same-length mask keeps call-site offsets aligned with the original bundle.
 */
function executableCodeMask(code: string): string {
	const masked = Array<string>(code.length).fill(" ")
	for (let index = 0; index < code.length; index++) {
		if (/\s/.test(code[index])) masked[index] = code[index]
	}
	let index = 0

	const copy = (start: number, end: number): void => {
		for (let cursor = start; cursor < end; cursor++) masked[cursor] = code[cursor]
	}
	const identifierStart = (character: string): boolean => /[A-Za-z_$]/.test(character)
	const identifierPart = (character: string): boolean => /[A-Za-z0-9_$]/.test(character)
	const regexPrefixKeywords = new Set([
		"await",
		"case",
		"delete",
		"do",
		"else",
		"in",
		"instanceof",
		"new",
		"return",
		"throw",
		"typeof",
		"void",
		"yield",
	])
	const controlConditionKeywords = new Set(["catch", "for", "if", "switch", "while", "with"])
	const directStatementBlockKeywords = new Set(["catch", "do", "else", "finally", "try"])

	const skipQuoted = (quote: string): void => {
		masked[index] = quote
		index++
		while (index < code.length) {
			if (code[index] === "\\") {
				index += 2
				continue
			}
			if (code[index] === quote) {
				masked[index] = quote
				index++
				return
			}
			index++
		}
	}

	const skipRegex = (): void => {
		index++
		let inClass = false
		while (index < code.length) {
			if (code[index] === "\\") {
				index += 2
				continue
			}
			if (code[index] === "[") inClass = true
			else if (code[index] === "]") inClass = false
			else if (code[index] === "/" && !inClass) {
				index++
				while (/[A-Za-z]/.test(code[index] ?? "")) index++
				return
			}
			if (code[index] === "\n" || code[index] === "\r") return
			index++
		}
	}

	const scanTemplate = (): void => {
		index++
		while (index < code.length) {
			if (code[index] === "\\") {
				index += 2
				continue
			}
			if (code[index] === "`") {
				index++
				return
			}
			if (code[index] === "$" && code[index + 1] === "{") {
				copy(index, index + 2)
				index += 2
				scanCode(true)
				continue
			}
			index++
		}
	}

	const scanCode = (stopAtTemplateBrace: boolean): void => {
		let braceDepth = 0
		let regexAllowed = true
		let pendingControlCondition = false
		let pendingControlBlock = false
		let pendingDirectStatementBlock = false
		let pendingFunctionDeclaration = false
		let pendingClassDeclarationDepth: number | null = null
		let declarationBodyReady = false
		const controlConditionParens: boolean[] = []
		const functionParameterParens: boolean[] = []
		const statementBlockBraces: boolean[] = []
		while (index < code.length) {
			const character = code[index]
			if (/\s/.test(character)) {
				index++
				continue
			}
			if (character === "'" || character === '"') {
				skipQuoted(character)
				pendingControlBlock = false
				regexAllowed = false
				continue
			}
			if (character === "`") {
				scanTemplate()
				pendingControlBlock = false
				regexAllowed = false
				continue
			}
			if (character === "/" && code[index + 1] === "/") {
				index += 2
				while (index < code.length && code[index] !== "\n") index++
				continue
			}
			if (character === "/" && code[index + 1] === "*") {
				index += 2
				while (index < code.length && !(code[index] === "*" && code[index + 1] === "/"))
					index++
				index = Math.min(code.length, index + 2)
				continue
			}
			if (character === "/" && regexAllowed) {
				skipRegex()
				pendingControlBlock = false
				regexAllowed = false
				continue
			}
			if (identifierStart(character)) {
				const start = index++
				while (identifierPart(code[index] ?? "")) index++
				copy(start, index)
				const identifier = code.slice(start, index)
				let before = start - 1
				while (before >= 0 && /\s/.test(masked[before])) before--
				const isMemberIdentifier = masked[before] === "." || masked[before] === "#"
				if (!(pendingControlCondition && identifier === "await")) {
					pendingControlCondition =
						!isMemberIdentifier && controlConditionKeywords.has(identifier)
				}
				pendingDirectStatementBlock =
					!isMemberIdentifier && directStatementBlockKeywords.has(identifier)
				if (
					!isMemberIdentifier &&
					(identifier === "function" || identifier === "class") &&
					/(?:^|[;{}])\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?$/.test(
						masked.slice(0, start).join(""),
					)
				) {
					pendingFunctionDeclaration = identifier === "function"
					pendingClassDeclarationDepth =
						identifier === "class" ? controlConditionParens.length : null
				}
				pendingControlBlock = false
				regexAllowed = !isMemberIdentifier && regexPrefixKeywords.has(identifier)
				continue
			}
			if (/[0-9]/.test(character)) {
				const start = index++
				while (/[A-Za-z0-9_.]/.test(code[index] ?? "")) index++
				copy(start, index)
				pendingControlBlock = false
				regexAllowed = false
				continue
			}
			if (character === "{") {
				let before = index - 1
				while (before >= 0 && /\s/.test(masked[before])) before--
				let isLabeledBlock = false
				if (
					masked[before] === ":" &&
					(statementBlockBraces.length === 0 || statementBlockBraces.at(-1) === true)
				) {
					let labelEnd = before - 1
					while (labelEnd >= 0 && /\s/.test(masked[labelEnd])) labelEnd--
					let labelStart = labelEnd
					while (labelStart >= 0 && identifierPart(masked[labelStart])) labelStart--
					let boundary = labelStart
					while (boundary >= 0 && /\s/.test(masked[boundary])) boundary--
					isLabeledBlock =
						labelStart < labelEnd && (boundary < 0 || /[;{}]/.test(masked[boundary]))
				}
				masked[index++] = character
				braceDepth++
				const isDeclarationBlock =
					declarationBodyReady ||
					pendingClassDeclarationDepth === controlConditionParens.length
				const isStandaloneBlock = before < 0 || /[;{}]/.test(masked[before])
				statementBlockBraces.push(
					pendingControlBlock ||
					pendingDirectStatementBlock ||
						isDeclarationBlock ||
						isStandaloneBlock ||
						isLabeledBlock,
				)
				pendingControlBlock = false
				pendingDirectStatementBlock = false
				if (isDeclarationBlock) {
					declarationBodyReady = false
					pendingClassDeclarationDepth = null
				}
				regexAllowed = true
				continue
			}
			if (character === "}") {
				masked[index++] = character
				if (stopAtTemplateBrace && braceDepth === 0) return
				braceDepth = Math.max(0, braceDepth - 1)
				pendingControlBlock = false
				regexAllowed = statementBlockBraces.pop() ?? false
				continue
			}
			if ((character === "+" || character === "-") && code[index + 1] === character) {
				copy(index, index + 2)
				index += 2
				pendingControlBlock = false
				regexAllowed = false
				continue
			}
			if (character === "(") {
				masked[index++] = character
				controlConditionParens.push(pendingControlCondition)
				functionParameterParens.push(pendingFunctionDeclaration)
				pendingFunctionDeclaration = false
				pendingControlCondition = false
				pendingDirectStatementBlock = false
				pendingControlBlock = false
				regexAllowed = true
				continue
			}
			if (character === ")") {
				masked[index++] = character
				pendingControlCondition = false
				pendingControlBlock = controlConditionParens.pop() ?? false
				if (functionParameterParens.pop() ?? false) declarationBodyReady = true
				regexAllowed = pendingControlBlock
				continue
			}
			masked[index++] = character
			pendingControlCondition = false
			pendingControlBlock = false
			pendingDirectStatementBlock = false
			regexAllowed = !/[)\]]/.test(character)
		}
	}

	scanCode(false)
	return masked.join("")
}

function isPropertyLabel(code: string, start: number, length: number): boolean {
	let after = start + length
	while (after < code.length && /\s/.test(code[after])) after++
	return code[after] === ":"
}

function isMethodDeclarationTail(tail: string): boolean {
	let cursor = 0
	while (/\s/.test(tail[cursor] ?? "")) cursor++
	if (tail[cursor] !== "(") return false
	let depth = 0
	for (; cursor < tail.length; cursor++) {
		if (tail[cursor] === "(") depth++
		else if (tail[cursor] === ")") {
			depth--
			if (depth === 0) {
				cursor++
				while (/\s/.test(tail[cursor] ?? "")) cursor++
				return tail[cursor] === "{"
			}
		}
	}
	return false
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
	const specifiers = new Set(bundleTranspiler.scanImports(code).map((entry) => entry.path))
	const executable = executableCodeMask(code)
	for (const match of executable.matchAll(/\b__require\(\s*(["'])(?:(?!\1)[^\\]|\\.)*\1\s*\)/g)) {
		const raw = /^__require\(\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*\)/.exec(
			code.slice(match.index),
		)
		if (raw) specifiers.add(raw[2])
	}
	return [...specifiers].sort(compareCodeUnits)
}

function allowedRuntimeSpecifier(specifier: string): boolean {
	if (specifier.startsWith("node:")) return nodeBuiltins.has(specifier.slice("node:".length))
	return nodeBuiltins.has(specifier) || admittedBunBuiltins.has(specifier)
}

/**
 * Reject detectable static and computed import/require text patterns that escape the bundle contract.
 *
 * @param skillId - Skill whose bundle is validated
 * @param code - Final JavaScript bundle text
 * @throws {BundleValidationError} On detected loader escapes, computed loads, or non-built-in specifiers
 *
 * @example
 * ```ts
 * validateBundleText("skill-a", 'import { join } from "node:path"')
 * ```
 */
export function validateBundleText(skillId: string, code: string): void {
	const executable = executableCodeMask(code)
	const codeGeneration = /\b(?:eval|Function)\b|\.\s*constructor\b/g
	for (const match of executable.matchAll(codeGeneration)) {
		if (isPropertyLabel(executable, match.index, match[0].length)) continue
		if (match[0] === "Function") {
			const before = executable.slice(0, match.index)
			const after = executable.slice(match.index + match[0].length)
			if (/\binstanceof\s*$/.test(before)) continue
			if (
				/^\s*\.\s*prototype\b(?:\s*\.\s*(?:call|apply|bind|name|length))?\s*(?:[;,)\]}]|$)/.test(
					after,
				)
			) {
				continue
			}
		}
		throw new BundleValidationError(
			skillId,
			"dynamic-code-generation",
			"bundle retains runtime code generation or an escaping reference; eval and callable Function are not allowed",
		)
	}
	if (/\b(?:createRequire|getBuiltinModule)\b/.test(executable)) {
		throw new BundleValidationError(
			skillId,
			"runtime-loader",
			"bundle retains a runtime module-loader escape; createRequire and getBuiltinModule are not allowed",
		)
	}
	if (
		/\{[^{}]*\b(?:__require|require)\s*:[^{}]*\}\s*=\s*(?:import\.meta|globalThis)\b/.test(
			executable,
		)
	) {
		throw new BundleValidationError(
			skillId,
			"runtime-loader",
			"bundle retains a destructured runtime module-loader escape",
		)
	}
	if (
		/\{[^{}]*\[[^{}]*\}\s*=\s*(?:import\.meta|globalThis)\b/.test(executable)
	) {
		throw new BundleValidationError(
			skillId,
			"runtime-loader",
			"bundle retains a computed-key destructured ambient runtime escape",
		)
	}
	for (const match of executable.matchAll(/\b(?:import\s*\.\s*meta|globalThis)\b/g)) {
		const tail = executable.slice(match.index + match[0].length)
		if (/^\s*(?:\?\s*)?\.\s*[A-Za-z_$]/.test(tail)) continue
		throw new BundleValidationError(
			skillId,
			"runtime-loader",
			`bundle retains a computed or escaping ambient runtime reference near "${code.slice(match.index, match.index + 48)}"`,
		)
	}
	// Every dynamic-load call site must be a single immediately-closed string
	// literal: any other argument shape (concatenation, identifier, member
	// expression, template) is a runtime-computed load the closure cannot prove.
	const literalCallTail = /^\s*(["'])(?:(?!\1)[^\\]|\\.)*\1\s*\)/
	for (const match of executable.matchAll(/\bimport\s*\(/g)) {
		if (!literalCallTail.test(executable.slice(match.index + match[0].length))) {
			throw new BundleValidationError(
				skillId,
				"computed-dynamic-import",
				`bundle retains a computed dynamic import near "${code.slice(match.index, match.index + 40)}"`,
			)
		}
	}
	for (const match of executable.matchAll(/\b(?:__require|require)\b/g)) {
		if (isPropertyLabel(executable, match.index, match[0].length)) continue
		let before = match.index - 1
		while (before >= 0 && /\s/.test(executable[before])) before--
		if (executable[before] === ".") {
			const owner = executable.slice(0, before)
			if (/\b(?:globalThis|import\s*\.\s*meta)\s*(?:\?\s*)?$/.test(owner)) {
				throw new BundleValidationError(
					skillId,
					"runtime-loader",
					`bundle retains an ambient runtime module loader near "${code.slice(Math.max(0, match.index - 16), match.index + 32)}"`,
				)
			}
			continue
		}
		const tail = executable.slice(match.index + match[0].length)
		if (isMethodDeclarationTail(tail)) continue
		const callOpen = /^\s*\(/.exec(tail)
		if (!callOpen || !literalCallTail.test(tail.slice(callOpen[0].length))) {
			throw new BundleValidationError(
				skillId,
				"computed-require",
				`bundle retains a computed runtime require or escaping reference near "${code.slice(match.index, match.index + 40)}"`,
			)
		}
	}
	for (const specifier of collectModuleSpecifiers(code)) {
		if (specifier.startsWith("./") || specifier.startsWith("../")) continue
		if (runtimeEscapeBuiltins.has(specifier)) {
			throw new BundleValidationError(
				skillId,
				specifier.endsWith("vm") ? "dynamic-code-generation" : "runtime-loader",
				`bundle retains the runtime escape built-in "${specifier}"; node:vm and node:module are not admitted`,
			)
		}
		if (!allowedRuntimeSpecifier(specifier)) {
			throw new BundleValidationError(
				skillId,
				"bare-specifier",
				`bundle retains the bare specifier "${specifier}"; only known Node built-ins and admitted Bun runtime modules may remain`,
			)
		}
	}
}

function isInsideDirectory(path: string, directory: string): boolean {
	return path === directory || path.startsWith(`${directory}/`)
}

interface AdmittedModuleOwner {
	root: string
	bareImports: Set<string>
	packageImports: string[]
}

interface CatalogRuntimeSkill {
	entry: string
	workspace?: string
}

function isOwnedHelloWorldAdapter(skillId: string, skill: CatalogRuntimeSkill): boolean {
	return (
		skillId === "hello-world" &&
		skill.workspace === undefined &&
		skill.entry === "runtime/hello-world.js"
	)
}

function barePackageName(specifier: string): string {
	if (!specifier.startsWith("@")) return specifier.split("/", 1)[0]
	return specifier.split("/", 2).join("/")
}

function matchesPackageImport(pattern: string, specifier: string): boolean {
	if (pattern === specifier) return true
	const wildcard = pattern.indexOf("*")
	if (wildcard === -1) return false
	const prefix = pattern.slice(0, wildcard)
	const suffix = pattern.slice(wildcard + 1)
	return (
		specifier.length >= prefix.length + suffix.length &&
		specifier.startsWith(prefix) &&
		specifier.endsWith(suffix)
	)
}

function createClosedResolutionPlugin(
	realRoot: string,
	skillId: string,
	violations: BundleValidationError[],
	allowedModuleRoots: string[],
	moduleOwners: AdmittedModuleOwner[],
): import("bun").BunPlugin {
	const ownersBySpecificity = [...moduleOwners].sort(
		(left, right) => right.root.length - left.root.length,
	)
	const importerOwners = new Map<string, AdmittedModuleOwner | undefined>()
	return {
		name: "closed-dependency-resolution",
		setup(builder) {
			const rejectedLoad = { contents: "export default {};", loader: "js" as const }
			function resolvedPathViolation(
				requestedPath: string,
				realResolved: string,
			): BundleValidationError | undefined {
				if (requestedPath.endsWith(".node") || realResolved.endsWith(".node")) {
					return new BundleValidationError(
						skillId,
						"native-addon",
						`native addon resolved to ${realResolved}`,
					)
				}
				if (!isInsideDirectory(realResolved, realRoot)) {
					return new BundleValidationError(
						skillId,
						"parent-resolution",
						`module resolved outside the repository: ${realResolved}`,
					)
				}
				if (!allowedModuleRoots.some((root) => isInsideDirectory(realResolved, root))) {
					return new BundleValidationError(
						skillId,
						"unadmitted-import",
						`module is outside the workspace production dependency graph: ${relative(realRoot, realResolved)}`,
					)
				}
				return undefined
			}
			builder.onResolve({ filter: /^(?:\.{1,2}\/|\/)/ }, (args) => {
				let realResolved: string
				try {
					realResolved = realpathSync(
						Bun.resolveSync(args.path, args.resolveDir || dirname(args.importer)),
					)
				} catch {
					return undefined
				}
				const violation = resolvedPathViolation(args.path, realResolved)
				if (violation) {
					violations.push(violation)
					return { path: args.path, external: true }
				}
				return undefined
			})
			// Validation only: Bun's own condition-aware resolver still performs the
			// build resolution. This probe fails closed before Bun loads a bare asset;
			// onLoad below repeats containment against Bun's actual resolved file path.
			builder.onResolve({ filter: /^[^./]/ }, (args) => {
				const specifier = args.path
				if (allowedRuntimeSpecifier(specifier)) return undefined
				let realResolved: string
				try {
					realResolved = realpathSync(Bun.resolveSync(specifier, dirname(args.importer)))
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
				let importer = args.importer
				try {
					importer = realpathSync(importer)
				} catch {
					// The resolver probe above already proved the importer's directory exists.
				}
				let owner = importerOwners.get(importer)
				if (!importerOwners.has(importer)) {
					owner = ownersBySpecificity.find((candidate) =>
						isInsideDirectory(importer, candidate.root),
					)
					importerOwners.set(importer, owner)
				}
				const declaredImport =
					owner?.bareImports.has(barePackageName(specifier)) ||
					(specifier.startsWith("#") &&
						owner?.packageImports.some((pattern) => matchesPackageImport(pattern, specifier)))
				if (!declaredImport) {
					violations.push(
						new BundleValidationError(
							skillId,
							"unadmitted-import",
							`bare import "${specifier}" is not declared by ${relative(realRoot, importer)}`,
						),
					)
					return { path: specifier, external: true }
				}
				const violation = resolvedPathViolation(specifier, realResolved)
				if (violation) {
					violations.push(violation)
					return { path: specifier, external: true }
				}
				return undefined
			})
			builder.onLoad(
				{
					filter: /\.(?:[cm]?[jt]sx?|css|jsonc?|json5|toml|ya?ml|txt|wasm|node|html)$/,
					namespace: "file",
				},
				(args) => {
					const realResolved = realpathSync(args.path)
					const violation = resolvedPathViolation(args.path, realResolved)
					if (violation) {
						violations.push(violation)
						// Do not hand a rejected file back to Bun's loader. The accumulated
						// typed violation is thrown immediately after the build.
						return rejectedLoad
					}
					return undefined
				},
			)
		},
	}
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
	let workspaceManifest: { main?: string }
	try {
		workspaceManifest = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
			main?: string
		}
	} catch (error) {
		throw new BundleValidationError(
			skillId,
			"missing-entry",
			`workspace ${workspace} package.json is missing, unreadable, or invalid: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const entryPoint = join(workspaceRoot, workspaceManifest.main ?? "")
	if (
		typeof workspaceManifest.main !== "string" ||
		!workspaceManifest.main ||
		!existsSync(entryPoint)
	) {
		throw new BundleValidationError(
			skillId,
			"missing-entry",
			`workspace ${workspace} does not declare an existing "main" entry`,
		)
	}
	// The closed-resolution plugin below bounds every *imported* module to the
	// repository, but Bun.build never routes the entrypoint through onResolve, so
	// a "main" of "../../../x.js" or a symlinked entry would escape that boundary
	// and be packaged as a valid skill. Resolve symlinks and require the real
	// entry to stay inside the workspace before bundling.
	const realEntryPoint = realpathSync(entryPoint)
	const realWorkspaceRoot = realpathSync(workspaceRoot)
	if (!isInsideDirectory(realEntryPoint, realWorkspaceRoot)) {
		throw new BundleValidationError(
			skillId,
			"entry-escape",
			`workspace ${workspace} "main" resolves outside the workspace: ${realEntryPoint}`,
		)
	}

	const violations: BundleValidationError[] = []
	const moduleAdmission = workspaceModuleAdmission(realRoot, workspace, realWorkspaceRoot)
	const closedResolution = createClosedResolutionPlugin(
		realRoot,
		skillId,
		violations,
		moduleAdmission.roots,
		moduleAdmission.owners,
	)

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

interface FrozenLockWorkspace {
	name?: string
	version?: string
	dependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface FrozenLockPackageMetadata {
	dependencies?: Record<string, string>
}

interface FrozenLock {
	workspaces: Record<string, FrozenLockWorkspace>
	packages: Record<string, unknown>
}

interface ParsedLockPackage {
	key: string
	name: string
	reference: string
	metadata: FrozenLockPackageMetadata
}

function parseFrozenLock(root: string): FrozenLock {
	const lockPath = join(root, "bun.lock")
	if (!existsSync(lockPath)) {
		throw new DependencyAdmissionError(
			"store-missing",
			"bun.lock is missing; run bun install to freeze the dependency closure",
		)
	}
	const lockText = readFileSync(lockPath, "utf8")
	try {
		const parsed = Bun.JSONC.parse(lockText) as Partial<FrozenLock>
		return {
			workspaces: parsed.workspaces ?? {},
			packages: parsed.packages ?? {},
		}
	} catch (error) {
		throw new DependencyAdmissionError(
			"lock-invalid",
			`bun.lock is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

function parseLockPackage(key: string, value: unknown): ParsedLockPackage {
	if (!Array.isArray(value)) {
		throw new DependencyAdmissionError(
			"lock-invalid",
			`bun.lock package ${JSON.stringify(key)} is not an array entry`,
		)
	}
	const identity = String(value[0] ?? "")
	const separator = identity.lastIndexOf("@")
	if (separator <= 0 || separator === identity.length - 1) {
		throw new DependencyAdmissionError(
			"lock-invalid",
			`bun.lock package ${JSON.stringify(key)} has malformed identity ${JSON.stringify(identity)}`,
		)
	}
	return {
		key,
		name: identity.slice(0, separator),
		reference: identity.slice(separator + 1),
		metadata: (value[2] ?? {}) as FrozenLockPackageMetadata,
	}
}

function parseNpmAlias(requested: string): { name: string; range: string } | undefined {
	if (!requested.startsWith("npm:")) return undefined
	const identity = requested.slice("npm:".length)
	if (!identity || identity.endsWith("@")) {
		throw new DependencyAdmissionError(
			"lock-invalid",
			`malformed npm alias ${JSON.stringify(requested)}`,
		)
	}
	const separator = identity.lastIndexOf("@")
	if (separator <= 0) return { name: identity, range: "*" }
	return { name: identity.slice(0, separator), range: identity.slice(separator + 1) }
}

function resolveLockDependency(
	lock: FrozenLock,
	packages: Map<string, ParsedLockPackage>,
	name: string,
	requested: string,
	parent?: ParsedLockPackage,
	boundEntry?: ParsedLockPackage,
): ParsedLockPackage {
	const npmAlias = parseNpmAlias(requested)
	const expectedName = npmAlias?.name ?? name
	const expectedRange = npmAlias?.range ?? requested
	const satisfies = (entry: ParsedLockPackage | undefined): entry is ParsedLockPackage => {
		if (entry?.name !== expectedName) return false
		if (requested.startsWith("workspace:")) return entry.reference.startsWith("workspace:")
		if (!entry.reference.startsWith("workspace:")) {
			return Bun.semver.satisfies(entry.reference, expectedRange)
		}
		const workspace = lock.workspaces[entry.reference.slice("workspace:".length)]
		return (
			workspace?.name === entry.name &&
			typeof workspace.version === "string" &&
			Bun.semver.satisfies(workspace.version, expectedRange)
		)
	}
	if (boundEntry) {
		if (satisfies(boundEntry)) return boundEntry
		throw new DependencyAdmissionError(
			"lock-invalid",
			`bun.lock selection ${boundEntry.key} does not satisfy ${name}@${requested}`,
		)
	}
	if (parent) {
		const nested = packages.get(`${parent.key}/${name}`)
		if (satisfies(nested)) return nested
		const hoisted = packages.get(name)
		if (satisfies(hoisted)) return hoisted
		throw new DependencyAdmissionError(
			"lock-invalid",
			`bun.lock cannot resolve ${name}@${requested} from ${parent.key}`,
		)
	}
	const direct = packages.get(name)
	if (requested.startsWith("workspace:") && satisfies(direct)) return direct
	if (direct?.name === expectedName && direct.reference === expectedRange) return direct
	if (satisfies(direct)) return direct
	if (npmAlias) {
		throw new DependencyAdmissionError(
			"lock-invalid",
			`bun.lock cannot resolve npm alias ${name}@${requested} by its lock key`,
		)
	}
	const candidates = [...packages.values()].filter((entry) => entry.name === expectedName)
	const exact = candidates.filter((entry) => entry.reference === expectedRange)
	if (exact.length === 1) return exact[0]
	const satisfying = candidates.filter(satisfies)
	if (satisfying.length === 1) return satisfying[0]
	throw new DependencyAdmissionError(
		"lock-invalid",
		`bun.lock cannot resolve ${name}@${requested} to one package entry`,
	)
}

interface ResolvedWorkspaceDependencyGraph {
	workspacePaths: Set<string>
	packages: Map<string, ParsedLockPackage>
}

function requiredWorkspaceDependencies(
	lock: FrozenLock,
	packages: Map<string, ParsedLockPackage>,
	workspace: FrozenLockWorkspace,
): Array<[string, string]> {
	for (const [name, peerRange] of Object.entries(workspace.peerDependencies ?? {})) {
		if (workspace.peerDependenciesMeta?.[name]?.optional === true) continue
		const dependencyRange = workspace.dependencies?.[name]
		if (dependencyRange === undefined) continue
		const selected = resolveLockDependency(lock, packages, name, dependencyRange)
		resolveLockDependency(lock, packages, name, peerRange, undefined, selected)
	}
	return [
		...Object.entries(workspace.dependencies ?? {}),
		...Object.entries(workspace.peerDependencies ?? {}).filter(
			([name]) => workspace.peerDependenciesMeta?.[name]?.optional !== true,
		),
	]
}

function resolveWorkspaceDependencyGraph(
	lock: FrozenLock,
	packages: Map<string, ParsedLockPackage>,
	workspacePath: string,
): ResolvedWorkspaceDependencyGraph {
	const workspace = lock.workspaces[workspacePath]
	if (!workspace) {
		throw new DependencyAdmissionError(
			"lock-invalid",
			`catalog workspace ${JSON.stringify(workspacePath)} is absent from bun.lock`,
		)
	}
	const workspacePaths = new Set([workspacePath])
	const reachablePackages = new Map<string, ParsedLockPackage>()
	const pending: Array<{
		name: string
		requested: string
		parent?: ParsedLockPackage
	}> = requiredWorkspaceDependencies(lock, packages, workspace).map(([name, requested]) => ({
		name,
		requested,
	}))

	while (pending.length > 0) {
		const dependency = pending.pop() as {
			name: string
			requested: string
			parent?: ParsedLockPackage
		}
		const locked = resolveLockDependency(
			lock,
			packages,
			dependency.name,
			dependency.requested,
			dependency.parent,
		)
		if (locked.reference.startsWith("workspace:")) {
			const dependencyWorkspacePath = locked.reference.slice("workspace:".length)
			if (workspacePaths.has(dependencyWorkspacePath)) continue
			workspacePaths.add(dependencyWorkspacePath)
			const dependencyWorkspace = lock.workspaces[dependencyWorkspacePath]
			if (!dependencyWorkspace) {
				throw new DependencyAdmissionError(
					"lock-invalid",
					`package ${locked.name} refers to missing workspace ${JSON.stringify(dependencyWorkspacePath)}`,
				)
			}
			pending.push(
				...requiredWorkspaceDependencies(lock, packages, dependencyWorkspace).map(
					([name, requested]) => ({
						name,
						requested,
					}),
				),
			)
			continue
		}
		if (reachablePackages.has(locked.key)) continue
		reachablePackages.set(locked.key, locked)
		pending.push(
			...Object.entries(locked.metadata.dependencies ?? {}).map(([name, requested]) => ({
				name,
				requested,
				parent: locked,
			})),
		)
	}
	return { workspacePaths, packages: reachablePackages }
}

function moduleOwner(root: string): AdmittedModuleOwner {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
		name?: string
		dependencies?: Record<string, string>
		peerDependencies?: Record<string, string>
		imports?: Record<string, unknown>
	}
	return {
		root,
		bareImports: new Set([
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.peerDependencies ?? {}),
			...(manifest.name ? [manifest.name] : []),
		]),
		packageImports: Object.keys(manifest.imports ?? {}).filter((specifier) =>
			specifier.startsWith("#"),
		),
	}
}

function workspaceModuleAdmission(
	realRoot: string,
	workspacePath: string,
	realWorkspaceRoot: string,
): { roots: string[]; owners: AdmittedModuleOwner[] } {
	if (!existsSync(join(realRoot, "bun.lock"))) {
		return {
			roots: [realWorkspaceRoot],
			owners: [moduleOwner(realWorkspaceRoot)],
		}
	}
	const lock = parseFrozenLock(realRoot)
	if (!lock.workspaces[workspacePath]) {
		return {
			roots: [realWorkspaceRoot],
			owners: [moduleOwner(realWorkspaceRoot)],
		}
	}
	const packages = new Map(
		Object.entries(lock.packages).map(([key, value]) => [key, parseLockPackage(key, value)]),
	)
	const graph = resolveWorkspaceDependencyGraph(lock, packages, workspacePath)
	const roots = [
		...new Set([
			...[...graph.workspacePaths].map((path) => realpathSync(join(realRoot, path))),
			...[...graph.packages.values()].map((entry) =>
				realpathSync(dependencyStoreDirectory(realRoot, entry.name, entry.reference)),
			),
		]),
	]
	return {
		roots,
		owners: roots.map(moduleOwner),
	}
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
	for (const entry of readdirSync(directory).sort(compareCodeUnits)) {
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
	for (const workspace of Object.keys(lock.workspaces).sort(compareCodeUnits)) {
		if (!workspace) continue
		const manifestPath = join(root, workspace, "package.json")
		if (!existsSync(manifestPath)) {
			throw new DependencyAdmissionError(
				"lock-invalid",
				`bun.lock workspace ${JSON.stringify(workspace)} has no package.json`,
			)
		}
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
		if (manifest.trustedDependencies !== undefined) {
			throw new DependencyAdmissionError(
				"trusted-dependencies",
				`${workspace}/package.json must not declare trustedDependencies`,
			)
		}
	}

	const packages = new Map(
		Object.entries(lock.packages).map(([key, value]) => [key, parseLockPackage(key, value)]),
	)
	const catalog = loadSkillCatalog(root)
	const graphs: ResolvedWorkspaceDependencyGraph[] = []
	for (const skill of Object.values(catalog.skills)) {
		if (skill.workspace === undefined) continue
		graphs.push(resolveWorkspaceDependencyGraph(lock, packages, skill.workspace))
	}

	const reachablePackages = new Map<string, ParsedLockPackage>()
	const graphsByPackage = new Map<string, ResolvedWorkspaceDependencyGraph[]>()
	for (const graph of graphs) {
		for (const [key, locked] of graph.packages) {
			reachablePackages.set(key, locked)
			const packageGraphs = graphsByPackage.get(key) ?? []
			packageGraphs.push(graph)
			graphsByPackage.set(key, packageGraphs)
		}
	}

	const admitted: AdmittedDependency[] = []
	const admittedIdentities = new Set<string>()
	for (const locked of [...reachablePackages.values()].sort(
		(left, right) =>
		compareCodeUnits(left.name, right.name) || compareCodeUnits(left.reference, right.reference),
	)) {
		const { name, reference: version } = locked
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
		for (const [peerName, peerRange] of Object.entries(
			(manifest.peerDependencies ?? {}) as Record<string, string>,
		)) {
			if (manifest.peerDependenciesMeta?.[peerName]?.optional === true) continue
			let selectedPeer: ParsedLockPackage
			try {
				selectedPeer = resolveLockDependency(lock, packages, peerName, peerRange, locked)
			} catch {
				throw new DependencyAdmissionError(
					"unresolved-peer",
					`${name}@${version} has unresolved peer "${peerName}" for ${peerRange}`,
				)
			}
			for (const graph of graphsByPackage.get(locked.key) ?? []) {
				const peerReachable = selectedPeer.reference.startsWith("workspace:")
					? graph.workspacePaths.has(selectedPeer.reference.slice("workspace:".length))
					: graph.packages.has(selectedPeer.key)
				if (!peerReachable) {
					throw new DependencyAdmissionError(
						"unresolved-peer",
						`${name}@${version} has unresolved peer "${peerName}" for ${peerRange}`,
					)
				}
			}
		}
		if (typeof manifest.license !== "string" || !permissiveLicenses.has(manifest.license)) {
			throw new DependencyAdmissionError(
				"license",
				`${name}@${version} license ${JSON.stringify(manifest.license ?? null)} is not in the permissive allowlist`,
			)
		}
		const identity = `${name}@${version}`
		if (!admittedIdentities.has(identity)) {
			admittedIdentities.add(identity)
		admitted.push({
			name,
			version,
			license: manifest.license,
			licenseText: readLicenseText(packageDirectory),
		})
	}
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
		return text
			? `${heading}\n\n${text}\n`
			: `${heading}\n\nLicense text not distributed by the package.\n`
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
			return `	${shellQuote(skillId)})
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
	for (const [skillId, skill] of Object.entries(catalog.skills)) {
		if (skill.workspace === undefined && !isOwnedHelloWorldAdapter(skillId, skill)) {
			throw new BundleValidationError(
				skillId,
				"unsupported-entry",
				"non-workspace runtime entries are unsupported; add a workspace bundle or use the owned hello-world adapter",
			)
		}
	}
	const workspaceSkills = Object.entries(catalog.skills)
		.filter(([, skill]) => skill.workspace !== undefined)
		.sort(([left], [right]) => compareCodeUnits(left, right))

	const dependencies = admitDependencyClosure(root)
	const noticesText = renderThirdPartyNotices(dependencies)

	const stagingDirectory = mkdtempSync(join(tmpdir(), "skill-bundle-staging-"))
	const artifacts: BundleArtifact[] = []
	try {
		const helloWorld = catalog.skills["hello-world"]
		if (helloWorld && isOwnedHelloWorldAdapter("hello-world", helloWorld)) {
			artifacts.push(await buildHelloWorldRuntime(root, stagingDirectory))
		}
		for (const [skillId, skill] of workspaceSkills) {
			artifacts.push(
				await bundleWorkspaceSkill(root, skillId, skill.workspace as string, stagingDirectory),
			)
		}
	} finally {
		rmSync(stagingDirectory, { recursive: true, force: true })
	}

	const artifactsBySkill = new Map(artifacts.map((artifact) => [artifact.skillId, artifact]))
	const bundles: Record<string, BundleRecord> = {}
	for (const [skillId, skill] of Object.entries(catalog.skills).sort(([left], [right]) =>
		compareCodeUnits(left, right),
	)) {
		const artifact = artifactsBySkill.get(skillId)
		if (!artifact) {
			throw new BundleValidationError(
				skillId,
				"unsupported-entry",
				"catalog runtime entry has no generated artifact",
			)
	}
		bundles[skillId] = {
			path: skill.workspace === undefined ? skill.entry : `runtime/${artifact.fileName}`,
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

	// The complete candidate closure now exists in memory and private staging.
	// Only this materialization phase touches checked-in package input (R7).
	const runtimeDirectory = join(root, "plugin", "runtime")
	mkdirSync(runtimeDirectory, { recursive: true })
	const activeFileNames = new Set(artifacts.map((artifact) => artifact.fileName))
	for (const entry of readdirSync(runtimeDirectory)) {
		if (managedBundlePattern.test(entry) && !activeFileNames.has(entry)) {
			rmSync(join(runtimeDirectory, entry))
		}
	}
	for (const artifact of artifacts) {
		writeFileSync(join(runtimeDirectory, artifact.fileName), artifact.contents)
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

	for (const [skillId, skill] of Object.entries(catalog.skills)) {
		if (skill.workspace === undefined && !isOwnedHelloWorldAdapter(skillId, skill)) {
			throw new Error(
				`bundle closure: unsupported non-workspace runtime entry for ${skillId}; add a workspace bundle`,
			)
		}
		if (!existsSync(join(root, "plugin", "skills", skillId, "SKILL.md"))) {
			throw new Error(`bundle closure: missing SKILL.md for ${skillId}`)
		}
		if (inventory.bundles[skillId] === undefined) {
			throw new Error(`bundle closure: missing bundle mapping for ${skillId}; run bun run build`)
		}
	}
	for (const [skillId, record] of Object.entries(inventory.bundles)) {
		const skill = catalog.skills[skillId]
		if (!skill) {
			throw new Error(`bundle closure: orphaned mapping for ${skillId}; run bun run build`)
		}
		// The recorded path must be exactly the digest-derived name inside
		// plugin/runtime; anything else could pass digest checks while packaging
		// ships a payload without the executable bundle.
		if (!/^[a-f0-9]{64}$/.test(record.sha256)) {
			throw new Error(`bundle closure: invalid bundle digest for ${skillId}; run bun run build`)
		}
		const expectedPath =
			skill.workspace === undefined
				? skill.entry
				: `runtime/${skillId}-${record.sha256.slice(0, 16)}.js`
		if (record.path !== expectedPath) {
			throw new Error(
				`bundle closure: invalid bundle path ${record.path} for ${skillId}; run bun run build`,
			)
		}
		const bundlePath = join(root, "plugin", record.path)
		if (!existsSync(bundlePath)) {
			throw new Error(`bundle closure: missing bundle file ${record.path} for ${skillId}`)
		}
		const contents = readFileSync(bundlePath)
		if (
			contents.byteLength !== record.bytes ||
			sha256Hex(new Uint8Array(contents)) !== record.sha256
		) {
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

const forbiddenRuntimePaths = [
	/^runtime\/qjs-/,
	/^runtime\/quickjs-assets\.json$/,
	/^QUICKJS-LICENSE$/,
]
const capabilityHookFiles = [
	"hooks/claude/hooks.json",
	"hooks/codex/hooks.json",
	"hooks/fixture/lifecycle-mechanics-proof.generated.json",
	"hooks/fixture/lifecycle-mechanics-proof.source.json",
	"hooks/native-capability-hook",
].sort(compareCodeUnits)
const capabilityAssetFiles = ["assets/composer-icon.svg", "assets/logo.svg"].sort(compareCodeUnits)
const modelOnlySkillFiles = [
	"skills/capability-tour/SKILL.md",
	"skills/capability-tour/references/capability-reviewer.md",
	"skills/runtime-custody/SKILL.md",
]
const allowedPayloadSurfaces = new Set([
	".claude-plugin",
	".codex-plugin",
	"THIRD-PARTY-NOTICES.md",
	"assets",
	"bin",
	"hooks",
	"runtime",
	"skills",
])
const requiredCapabilities = [
	"Execute verified Bun code",
	"Download Bun after approval",
	"Write private runtime cache",
	"Use network during repair",
]

/**
 * Admit the complete installable payload only when it is one current Bun closure.
 *
 * @param root - Repository root containing canonical sources and plugin payload
 * @throws {Error} On generated drift, missing members, legacy runtime surfaces, or incomplete disclosure
 */
export function validateBunOnlyPayload(root: string): void {
	validateBundleClosure(root)
	const catalog = loadSkillCatalog(root)
	const inventory = pluginPayloadInventory(root)
	const inventorySet = new Set(inventory)
	for (const path of inventory) {
		const surface = path.split("/", 1)[0]
		if (!allowedPayloadSurfaces.has(surface)) {
			throw new Error(`Bun payload closure: unsupported payload surface ${surface}/`)
		}
	}
	const required = [
		".claude-plugin/plugin.json",
		".codex-plugin/plugin.json",
		"THIRD-PARTY-NOTICES.md",
		"runtime/bundle-inventory.json",
		"runtime/bundle-inventory.sh",
		"runtime/runtime-exec",
		"runtime/runtime-lock.sh",
		"runtime/skill-catalog.sh",
		...capabilityHookFiles,
		...capabilityAssetFiles,
		...modelOnlySkillFiles,
	]
	const bundleInventory = JSON.parse(
		readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	) as { bundles: Record<string, BundleRecord> }
	for (const [skillId, skill] of Object.entries(catalog.skills)) {
		required.push(`bin/${skillId}`, `skills/${skillId}/SKILL.md`)
		required.push(
			skill.workspace === undefined
				? skill.entry
				: (bundleInventory.bundles[skillId]?.path ?? `runtime/${skillId}-MISSING.js`),
		)
	}
	for (const path of required) {
		if (!inventorySet.has(path)) throw new Error(`Bun payload closure: missing ${path}`)
	}
	const hookFiles = inventory.filter((path) => path.startsWith("hooks/"))
	if (hookFiles.join("\0") !== capabilityHookFiles.join("\0")) {
		throw new Error("Bun payload closure: hook sidecar inventory does not match the capability contract")
	}
	const assetFiles = inventory.filter((path) => path.startsWith("assets/"))
	if (assetFiles.join("\0") !== capabilityAssetFiles.join("\0")) {
		throw new Error("Bun payload closure: asset sidecar inventory does not match the capability contract")
	}
	const catalogSkillFiles = Object.keys(catalog.skills)
		.sort(compareCodeUnits)
		.map((skillId) => `skills/${skillId}/SKILL.md`)
	const expectedSkillFiles = [...modelOnlySkillFiles, ...catalogSkillFiles].sort(compareCodeUnits)
	const skillFiles = inventory.filter((path) => path.startsWith("skills/"))
	if (skillFiles.join("\0") !== expectedSkillFiles.join("\0")) {
		throw new Error("Bun payload closure: skill sidecar inventory does not match the catalog and model-only allowlist")
	}

	const drifted = checkRuntimeCustodyFiles(root)
	if (drifted.length > 0) {
		throw new Error(`Bun payload closure: stale generated file ${drifted[0]}`)
	}
	const launchers = inventory
		.filter((path) => path.startsWith("bin/"))
		.map((path) => path.slice("bin/".length))
	const expectedLaunchers = Object.keys(catalog.skills).sort(compareCodeUnits)
	if (launchers.join("\0") !== expectedLaunchers.join("\0")) {
		throw new Error("Bun payload closure: launcher inventory does not match the skill catalog")
	}
	for (const path of [
		"runtime/runtime-exec",
		"hooks/native-capability-hook",
		...expectedLaunchers.map((id) => `bin/${id}`),
	]) {
		if ((statSync(join(root, "plugin", path)).mode & 0o111) === 0) {
			throw new Error(`Bun payload closure: ${path} is not executable`)
		}
	}
	for (const path of inventory) {
		if (forbiddenRuntimePaths.some((pattern) => pattern.test(path))) {
			throw new Error(`Bun payload closure: legacy runtime surface ${path}`)
		}
		if (/\.(?:js|json|md|sh)$/.test(path) || path.startsWith("bin/")) {
			const text = readFileSync(join(root, "plugin", path), "utf8")
			if (/qjs:std|QuickJS/i.test(text)) {
				throw new Error(`Bun payload closure: legacy runtime claim in ${path}`)
			}
		}
	}
	// The expected inventory is complete: manifest sidecars, generated runtime
	// scripts, capability sidecars, and catalog-derived launchers, skills, and
	// bundles. Anything outside that exact set never ships.
	const expectedInventory = new Set(required)
	for (const path of inventory) {
		if (!expectedInventory.has(path)) {
			throw new Error(`Bun payload closure: unexpected payload file ${path}`)
		}
	}
	for (const manifestPath of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] as const) {
		const manifest = JSON.parse(readFileSync(join(root, "plugin", manifestPath), "utf8")) as {
			hooks?: unknown
			description?: unknown
			interface?: { capabilities?: unknown }
			[key: string]: unknown
		}
		const expectedHooks =
			manifestPath === ".claude-plugin/plugin.json"
				? "./hooks/claude/hooks.json"
				: "./hooks/codex/hooks.json"
		if (manifest.hooks !== expectedHooks) {
			throw new Error(`Bun payload closure: invalid hook declaration in ${manifestPath}`)
		}
		for (const forbidden of [
			"agents",
			"apps",
			"channels",
			"commands",
			"connectors",
			"extensions",
			"lspServers",
			"mcpServers",
			"monitors",
			"outputStyles",
			"settings",
			"themes",
		]) {
			if (manifest[forbidden] !== undefined) {
				throw new Error(`Bun payload closure: unsupported component ${forbidden} in ${manifestPath}`)
			}
		}
		if (typeof manifest.description !== "string" || !manifest.description.includes("Bun")) {
			throw new Error(`Bun payload closure: ${manifestPath} does not disclose Bun execution`)
		}
		if (manifestPath === ".codex-plugin/plugin.json") {
			const capabilities = manifest.interface?.capabilities
			if (
				!Array.isArray(capabilities) ||
				requiredCapabilities.some((item) => !capabilities.includes(item))
			) {
				throw new Error("Bun payload closure: Codex capability disclosure is incomplete")
			}
		}
	}
}

export async function buildHelloWorldRuntime(
	root: string,
	stagingDirectory: string,
): Promise<BundleArtifact> {
	const skillId = "hello-world"
	const sourceRoot = join(root, "runtime", "src")
	const outputDirectory = join(stagingDirectory, skillId)
	mkdirSync(outputDirectory, { recursive: true })
	const violations: BundleValidationError[] = []
	let result: Awaited<ReturnType<typeof Bun.build>>
	try {
		result = await Bun.build({
			entrypoints: [join(sourceRoot, "bun-proof-adapter.ts")],
			outdir: outputDirectory,
			naming: "hello-world.js",
			target: "bun",
			format: "esm",
			splitting: false,
			sourcemap: "none",
			minify: true,
			env: "disable",
			plugins: [
				createClosedResolutionPlugin(
					realpathSync(root),
					skillId,
					violations,
					[realpathSync(join(root, "runtime", "src"))],
					[],
				),
			],
			banner: "// Generated from runtime/src/. Edit source, then run bun run build.",
		})
	} catch (error) {
		if (violations.length > 0) throw violations[0]
		throw error
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
	if (outputs.length !== 1 || outputs[0] !== "hello-world.js") {
		throw new BundleValidationError(
			skillId,
			"unexpected-output",
			`bundle must emit exactly one JavaScript artifact; received ${JSON.stringify(outputs.sort())}`,
		)
	}
	const contents = new Uint8Array(readFileSync(join(outputDirectory, "hello-world.js")))
	validateBundleText(skillId, new TextDecoder().decode(contents))
	return {
		skillId,
		fileName: "hello-world.js",
		bytes: contents.byteLength,
		sha256: sha256Hex(contents),
		contents,
	}
}

/** Reject every install outcome except an ordinary zero exit. */
export function assertSuccessfulInstall(install: InstallResult): void {
	if (install.exitCode === 0) return
	const detail = install.signalCode
		? `terminated by signal ${install.signalCode}`
		: `exited with code ${String(install.exitCode)}`
	const stderr = install.stderr ? new TextDecoder().decode(install.stderr).trim() : ""
	throw new Error(`bun install ${detail}${stderr ? `: ${stderr}` : ""}`)
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

	const install = Bun.spawnSync({
		cmd: [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	assertSuccessfulInstall(install)

	const closure = await buildWorkspaceBundles(root)
	validateBundleClosure(root)
	console.log(
		JSON.stringify({
			ok: true,
			action: "built",
			sideEffects: "repository-files-written",
			helloWorldRuntime: join(root, "plugin", "runtime", "hello-world.js"),
			bundles: closure.bundles,
			notices: closure.notices,
		}),
	)
}

if (import.meta.main) await main()
