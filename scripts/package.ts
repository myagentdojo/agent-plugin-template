import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { validateBunOnlyPayload } from "./build"
import {
	deterministicPluginArchive,
	payloadInventorySha256,
	pluginPayloadInventory,
} from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const version = pluginConfig.version
const outputRoot = join(root, "dist")
const packageName = `${pluginConfig.name}-${version}`

function resolveSourceCommit(): string {
	const sourceCommit = process.env.SOURCE_COMMIT
	const githubSha = process.env.GITHUB_SHA
	const configuredSource =
		sourceCommit !== undefined
			? { name: "SOURCE_COMMIT", value: sourceCommit }
			: githubSha !== undefined
				? { name: "GITHUB_SHA", value: githubSha }
				: undefined
	const configuredCommit = configuredSource
		? validateSourceCommit(configuredSource.value, configuredSource.name)
		: undefined
	const git = Bun.spawnSync({
		cmd: ["git", "rev-parse", "HEAD"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (git.exitCode === 0) {
		const gitHead = validateSourceCommit(git.stdout.toString().trim(), "git HEAD")
		if (configuredCommit && configuredCommit !== gitHead) {
			throw new Error(`${configuredSource?.name} does not match git HEAD`)
		}
		return gitHead
	}
	if (configuredCommit) return configuredCommit
	throw new Error("Unable to resolve the package source commit from git or an explicit input")
}

function validateSourceCommit(value: string, source: string): string {
	if (!/^[0-9a-f]{40}$/.test(value)) {
		throw new Error(`${source} must be exactly 40 lowercase hexadecimal characters`)
	}
	return value
}

function sha256(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function payloadInventoryDigest(): string {
	return payloadInventorySha256(join(root, "plugin"), pluginPayloadInventory(root))
}

// Missing, stale, or orphaned bundle mappings fail before packaging.
validateBunOnlyPayload(root)
const sourceCommit = resolveSourceCommit()
const runtimeLockSha256 = sha256(readFileSync(join(root, "runtime", "runtime.lock.json")))
const bundleInventorySha256 = sha256(
	readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json")),
)
const payloadInventoryDigestValue = payloadInventoryDigest()
mkdirSync(outputRoot, { recursive: true })

const archiveArtifact = deterministicPluginArchive(root, packageName)
const archive = join(outputRoot, `${packageName}.tar.gz`)
writeFileSync(archive, archiveArtifact.bytes)
const archiveBytes = archiveArtifact.bytes.length
const archiveDigest = archiveArtifact.sha256
const checksums = join(outputRoot, `${packageName}.checksums.json`)
writeFileSync(
	checksums,
	`${JSON.stringify(
		{
			repository: pluginConfig.repository,
			sourceCommit,
			tag: `v${version}`,
			plugin: pluginConfig.name,
			version,
			archive: `${packageName}.tar.gz`,
			archiveBytes,
			archiveSha256: archiveDigest,
			runtimeLockSha256,
			bundleInventorySha256,
			payloadInventorySha256: payloadInventoryDigestValue,
			evidence:
				"Checksum metadata is integrity evidence for these archive bytes, not independent publisher or builder authenticity.",
		},
		null,
		2,
	)}\n`,
)
console.log(JSON.stringify({ archive, checksums, archiveBytes, archiveDigest }))
