import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { compareCodeUnits, payloadInventorySha256 } from "./plugin-files"
import { requireProofControlEnvelope } from "./proof-control-envelope"
import { SUPPORTED_RUNTIME_PLATFORMS } from "./runtime-custody-config"

interface PlatformProofOptions {
	archive: string
	checksums: string
	target: string
	fixtureAcknowledged: true
}

export function currentRuntimeTarget(
	platform = process.platform,
	arch = process.arch,
): string | undefined {
	if (platform !== "darwin" && platform !== "linux") return undefined
	if (arch !== "arm64" && arch !== "x64") return undefined
	return `${platform}-${arch}`
}

function optionValue(arguments_: string[], name: string): string {
	const index = arguments_.indexOf(name)
	const value = index === -1 ? undefined : arguments_[index + 1]
	if (!value || value.startsWith("--")) throw new Error(`${name} is required`)
	return value
}

export function parsePlatformProofOptions(arguments_: string[]): PlatformProofOptions {
	const supported = new Set([
		"--archive",
		"--checksums",
		"--target",
		"--fixture-acknowledged",
	])
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (!supported.has(argument)) throw new Error(`unknown option: ${argument}`)
		if (argument !== "--fixture-acknowledged") index += 1
	}
	if (!arguments_.includes("--fixture-acknowledged")) {
		throw new Error("--fixture-acknowledged is required before repair --apply")
	}
	const target = optionValue(arguments_, "--target")
	if (!(SUPPORTED_RUNTIME_PLATFORMS as readonly string[]).includes(target)) {
		throw new Error(`unsupported target: ${target}`)
	}
	return {
		archive: resolve(optionValue(arguments_, "--archive")),
		checksums: resolve(optionValue(arguments_, "--checksums")),
		target,
		fixtureAcknowledged: true,
	}
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function regularFiles(root: string): string[] {
	const files: string[] = []
	function walk(directory: string, prefix: string): void {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
			compareCodeUnits(a.name, b.name),
		)) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
			if (entry.isDirectory()) walk(join(directory, entry.name), relativePath)
			else if (entry.isFile()) files.push(relativePath)
			else throw new Error(`extracted payload contains a non-regular entry: ${relativePath}`)
		}
	}
	walk(root, "")
	return files
}

function payloadDigest(root: string): string {
	return payloadInventorySha256(root, regularFiles(root))
}

export function networkIsolatedCommand(
	command: string[],
	platform = process.platform,
	uid = process.getuid?.(),
	gid = process.getgid?.(),
): string[] {
	if (platform === "darwin") {
		return [
			"/usr/bin/sandbox-exec",
			"-p",
			"(version 1) (allow default) (deny network*)",
			...command,
		]
	}
	if (platform === "linux" && uid !== undefined && gid !== undefined) {
		return [
			"/usr/bin/sudo",
			"-n",
			"--preserve-env=HOME,XDG_CACHE_HOME,PATH",
			"/usr/bin/unshare",
			"--net",
			`--setuid=${uid}`,
			`--setgid=${gid}`,
			"--",
			...command,
		]
	}
	throw new Error(`network isolation is unsupported on ${platform}`)
}

function runLauncher(
	launcher: string,
	arguments_: string[],
	cwd: string,
	homeRoot: string,
	cacheRoot: string,
	networkDenied: boolean,
): ReturnType<typeof Bun.spawnSync> {
	const command = [launcher, ...arguments_]
	return Bun.spawnSync({
		cmd: networkDenied ? networkIsolatedCommand(command) : command,
		cwd,
		env: {
			HOME: homeRoot,
			XDG_CACHE_HOME: cacheRoot,
			PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 180_000,
	})
}

export function proveRuntimePlatform(options: PlatformProofOptions): Record<string, unknown> {
	const actualTarget = currentRuntimeTarget()
	if (actualTarget !== options.target) {
		throw new Error(`target ${options.target} does not match host ${actualTarget ?? "unsupported"}`)
	}
	const checksums = JSON.parse(readFileSync(options.checksums, "utf8")) as Record<string, unknown>
	const archiveBytes = readFileSync(options.archive)
	if (
		checksums.archive !== basename(options.archive) ||
		checksums.archiveBytes !== archiveBytes.byteLength ||
		checksums.archiveSha256 !== sha256(archiveBytes)
	) {
		throw new Error("candidate archive does not match checksum metadata")
	}

	const isolationRoot = realpathSync(mkdtempSync(join(tmpdir(), `runtime-platform-${options.target}-`)))
	chmodSync(isolationRoot, 0o700)
	const extractedRoot = join(isolationRoot, "extracted")
	const homeRoot = join(isolationRoot, "home")
	const cacheRoot = join(isolationRoot, "cache")
	mkdirSync(extractedRoot, { mode: 0o700 })
	mkdirSync(homeRoot, { mode: 0o700 })
	mkdirSync(cacheRoot, { mode: 0o700 })
	try {
		const extract = Bun.spawnSync({
			cmd: ["tar", "-xzf", options.archive, "-C", extractedRoot],
			stdout: "pipe",
			stderr: "pipe",
		})
		if (extract.exitCode !== 0) throw new Error(`candidate extraction failed: ${extract.stderr}`)
		const roots = readdirSync(extractedRoot)
		if (roots.length !== 1) throw new Error("candidate archive must contain exactly one plugin root")
		const pluginRoot = join(extractedRoot, roots[0])
		if (checksums.payloadInventorySha256 !== payloadDigest(pluginRoot)) {
			throw new Error("extracted payload inventory does not match checksum metadata")
		}
		if (
			checksums.bundleInventorySha256 !==
			sha256(readFileSync(join(pluginRoot, "runtime", "bundle-inventory.json")))
		) {
			throw new Error("extracted bundle inventory does not match checksum metadata")
		}

		const skillA = join(pluginRoot, "bin", "skill-a")
		const skillB = join(pluginRoot, "bin", "skill-b")
		const engine = join(pluginRoot, "runtime", "runtime-exec")
		const missing = requireProofControlEnvelope(
			"cold run",
			runLauncher(skillA, [], pluginRoot, homeRoot, cacheRoot, false),
			20,
			"BUN_MISSING",
		)
		if (missing.sideEffects.length !== 0 || readdirSync(cacheRoot).length !== 0) {
			throw new Error("cold run mutated the isolated cache")
		}
		const preview = requireProofControlEnvelope(
			"repair preview",
			runLauncher(engine, ["repair"], pluginRoot, homeRoot, cacheRoot, false),
			0,
			"REPAIR_PREVIEW",
		)
		if (!preview.nextAction.includes("Ask the user to approve") || preview.sideEffects.length !== 0) {
			throw new Error("repair preview does not preserve the human-approval boundary")
		}
		const applied = requireProofControlEnvelope(
			"acknowledged repair apply",
			runLauncher(engine, ["repair", "--apply"], pluginRoot, homeRoot, cacheRoot, false),
			0,
			"REPAIR_APPLIED",
		)
		const executableSha256 = applied.runtime?.executableSha256
		if (typeof executableSha256 !== "string") {
			throw new Error("repair receipt omitted the verified executable identity")
		}
		const runtimePath = join(cacheRoot, "agent-plugin-runtime", "bun", executableSha256, "bun")
		if (!statSync(runtimePath).isFile() || sha256(readFileSync(runtimePath)) !== executableSha256) {
			throw new Error("published runtime bytes do not match the repair receipt")
		}

		const first = runLauncher(skillA, [], pluginRoot, homeRoot, cacheRoot, true)
		if (first.exitCode !== 0) {
			throw new Error(
				`skill-a failed after repair (exit ${first.exitCode}): ${first.stderr.toString() || first.stdout.toString()}`,
			)
		}
		const firstResult = JSON.parse(first.stdout.toString())
		if (firstResult.skill !== "skill-a" || firstResult.esmDependency !== "skillAOfflineProof") {
			throw new Error("skill-a returned the wrong packaged dependency proof")
		}
		const warm = runLauncher(skillB, [], pluginRoot, homeRoot, cacheRoot, true)
		if (warm.exitCode !== 0) {
			throw new Error(
				`warm skill-b failed (exit ${warm.exitCode}): ${warm.stderr.toString() || warm.stdout.toString()}`,
			)
		}
		const warmResult = JSON.parse(warm.stdout.toString())
		if (warmResult.skill !== "skill-b" || warmResult.cjsDependencyDuration !== "2 hours") {
			throw new Error("skill-b returned the wrong warm dependency proof")
		}

		return {
			ok: true,
			client: "platform-ci",
			target: options.target,
			repository: checksums.repository,
			sourceCommit: checksums.sourceCommit,
			pluginVersion: checksums.version,
			archiveSha256: checksums.archiveSha256,
			runtimeLockSha256: checksums.runtimeLockSha256,
			bundleInventorySha256: checksums.bundleInventorySha256,
			payloadInventorySha256: checksums.payloadInventorySha256,
			runtime: { version: applied.runtime?.version, executableSha256 },
			journey: ["BUN_MISSING", "REPAIR_PREVIEW", "REPAIR_APPLIED", "skill-a", "warm-skill-b"],
			fixtureAcknowledged: options.fixtureAcknowledged,
			networkDeniedForSkillRuns: true,
		}
	} finally {
		rmSync(isolationRoot, { recursive: true, force: true })
	}
}

if (import.meta.main) {
	try {
		console.log(JSON.stringify(proveRuntimePlatform(parsePlatformProofOptions(process.argv.slice(2)))))
	} catch (error) {
		console.error(
			JSON.stringify({
				ok: false,
				category: "runtime-platform-proof",
				message: error instanceof Error ? error.message : String(error),
				retrySafe: false,
				nextAction: "Fix candidate or target evidence, then rerun the same platform proof.",
			}),
		)
		process.exit(1)
	}
}
