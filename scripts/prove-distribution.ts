import {
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs"
import { basename, join, resolve } from "node:path"

import { assertDistributionChecksumIdentity } from "./distribution-checksums"
import {
	directoryArchiveEntries,
	payloadInventorySha256,
	PLUGIN_DIRECTORY,
	pluginPayloadInventory,
} from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"
import {
	proveInstalledCapabilityEvidence,
	resolveCandidatePayloadCommit,
} from "./prove-harness-install"

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const packageName = `${pluginConfig.name}-${pluginConfig.version}`
const inventory = pluginPayloadInventory(root)

interface PackageResult {
	archive: string
	checksums: string
	archiveBytes: number
	archiveDigest: string
}

function packagePlugin(): PackageResult {
	const result = Bun.spawnSync({
		cmd: ["bun", "run", "package"],
		cwd: root,
		env: { ...process.env, CI: "true" },
		stdout: "pipe",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
	return JSON.parse(result.stdout.toString().trim().split("\n").at(-1) ?? "")
}

function runPackaged(
	launcher: string,
	arguments_: string[],
	xdgCacheHome: string,
): { exitCode: number; stdout: string; stderr: string } {
	const process_ = Bun.spawnSync({
		cmd: [launcher, ...arguments_],
		env: {
			...process.env,
			PATH: "/usr/bin:/bin",
			HELLO_WORLD_RUN_ID: "packaged-offline-proof",
			XDG_CACHE_HOME: xdgCacheHome,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	})
	return {
		exitCode: process_.exitCode,
		stdout: process_.stdout.toString(),
		stderr: process_.stderr.toString(),
	}
}

const first = packagePlugin()
const second = packagePlugin()
if (first.archiveDigest !== second.archiveDigest) {
	throw new Error(`package is not deterministic: ${first.archiveDigest} != ${second.archiveDigest}`)
}

const extractedRoot = join(root, ".dev", "distribution-proof")
rmSync(extractedRoot, { recursive: true, force: true })
mkdirSync(extractedRoot, { recursive: true })
const extract = Bun.spawnSync({
	cmd: ["tar", "-xzpf", second.archive, "-C", extractedRoot],
	stdout: "inherit",
	stderr: "inherit",
})
if (extract.exitCode !== 0) process.exit(extract.exitCode)

const installedRoot = join(extractedRoot, packageName)
const entries = directoryArchiveEntries(extractedRoot, "")
	.slice(1)
	.map((entry) => entry.slice(1))
for (const required of [
	`${packageName}/.claude-plugin/plugin.json`,
	`${packageName}/.codex-plugin/plugin.json`,
	`${packageName}/assets/composer-icon.svg`,
	`${packageName}/assets/logo.svg`,
	`${packageName}/hooks/claude/hooks.json`,
	`${packageName}/hooks/codex/hooks.json`,
	`${packageName}/hooks/fixture/lifecycle-mechanics-proof.generated.json`,
	`${packageName}/hooks/fixture/lifecycle-mechanics-proof.source.json`,
	`${packageName}/hooks/native-capability-hook`,
	`${packageName}/skills/capability-tour/SKILL.md`,
	`${packageName}/skills/capability-tour/references/capability-reviewer.md`,
	`${packageName}/skills/hello-world/SKILL.md`,
	`${packageName}/skills/runtime-custody/SKILL.md`,
	`${packageName}/skills/skill-a/SKILL.md`,
	`${packageName}/skills/skill-b/SKILL.md`,
	`${packageName}/bin/hello-world`,
	`${packageName}/bin/skill-a`,
	`${packageName}/bin/skill-b`,
	`${packageName}/runtime/hello-world.js`,
	`${packageName}/runtime/runtime-exec`,
	`${packageName}/runtime/runtime-lock.sh`,
	`${packageName}/runtime/skill-catalog.sh`,
	`${packageName}/runtime/bundle-inventory.json`,
	`${packageName}/runtime/bundle-inventory.sh`,
	`${packageName}/THIRD-PARTY-NOTICES.md`,
]) {
	if (!entries.includes(required)) throw new Error(`package is missing ${required}`)
}
if (entries.some((entry) => /(?:^|\/)(?:qjs-[^/]*|quickjs-assets\.json|QUICKJS-LICENSE)(?:\/|$)/i.test(entry))) {
	throw new Error("package contains an active legacy runtime surface")
}
const expectedEntries = directoryArchiveEntries(join(root, PLUGIN_DIRECTORY), packageName)
if (JSON.stringify(entries) !== JSON.stringify(expectedEntries)) {
	throw new Error(
		`package entries do not match plugin inventory:\nexpected ${JSON.stringify(expectedEntries)}\nreceived ${JSON.stringify(entries)}`,
	)
}
if (entries.some((entry) => entry.endsWith(".ts") || entry.includes("/.git/"))) {
	throw new Error("package contains repository source or Git metadata")
}
if (entries.some((entry) => entry.startsWith(`${packageName}/scripts/`))) {
	throw new Error("package contains development scripts")
}
for (const entry of expectedEntries) {
	const installedPath = join(extractedRoot, entry)
	const status = lstatSync(installedPath)
	const isDirectory = entry.endsWith("/")
	if (status.isDirectory() !== isDirectory) {
		throw new Error(`extracted archive entry has the wrong type: ${entry}`)
	}
	let expectedMode = 0o755
	if (!isDirectory) {
		const sourcePath = join(root, PLUGIN_DIRECTORY, entry.slice(packageName.length + 1))
		expectedMode = (statSync(sourcePath).mode & 0o111) !== 0 ? 0o755 : 0o644
	}
	if ((status.mode & 0o777) !== expectedMode) {
		throw new Error(`extracted archive entry has the wrong mode: ${entry}`)
	}
	if (Math.trunc(status.mtimeMs / 1000) !== 0) {
		throw new Error(`extracted archive entry has the wrong mtime: ${entry}`)
	}
}
for (const relativePath of inventory) {
	const sourcePath = join(root, PLUGIN_DIRECTORY, relativePath)
	const installedPath = join(installedRoot, relativePath)
	if (!lstatSync(installedPath).isFile()) {
		throw new Error(`extracted payload entry is not a regular file: ${relativePath}`)
	}
	if (!readFileSync(installedPath).equals(readFileSync(sourcePath))) {
		throw new Error(`extracted payload bytes differ from plugin inventory: ${relativePath}`)
	}
}

const packagedSkills = entries
	.filter((entry) => entry.startsWith(`${packageName}/skills/`) && entry.endsWith("/SKILL.md"))
	.map((entry) => entry.slice(`${packageName}/skills/`.length, -"/SKILL.md".length))
if (JSON.stringify(packagedSkills) !== JSON.stringify([
	"capability-tour",
	"hello-world",
	"runtime-custody",
	"skill-a",
	"skill-b",
])) {
	throw new Error("package skill inventory does not preserve the exact portable and model-only closure")
}
const packagedLaunchers = entries
	.filter((entry) => entry.startsWith(`${packageName}/bin/`) && !entry.endsWith("/"))
	.map((entry) => entry.slice(`${packageName}/bin/`.length))
if (JSON.stringify(packagedLaunchers) !== JSON.stringify(["hello-world", "skill-a", "skill-b"])) {
	throw new Error("package launcher inventory does not preserve the v0.2.0 closure")
}
const catalog = JSON.parse(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8"))
const bundles = JSON.parse(
	readFileSync(join(installedRoot, "runtime", "bundle-inventory.json"), "utf8"),
)
for (const surface of [catalog.skills, bundles.bundles]) {
	const surfaceKeys = Object.keys(surface).sort()
	if (JSON.stringify(surfaceKeys) !== JSON.stringify(["hello-world", "skill-a", "skill-b"])) {
		throw new Error(
			`capability-tour entered the executable runtime closure: ${JSON.stringify(surfaceKeys)}`,
		)
	}
}

const coldXdg = join(extractedRoot, "cold-xdg")
for (const skillId of ["hello-world", "skill-a", "skill-b"]) {
	const launcher = join(installedRoot, "bin", skillId)
	const launcherText = readFileSync(launcher, "utf8")
	if (!launcherText.includes(`runtime/runtime-exec\" run ${skillId} --`)) {
		throw new Error(`packaged ${skillId} launcher is not bound to runtime custody`)
	}
	const missing = runPackaged(launcher, [], coldXdg)
	if (missing.exitCode !== 20) throw new Error(`packaged ${skillId} did not return BUN_MISSING`)
	const control = JSON.parse(missing.stdout)
	if (control.code !== "BUN_MISSING" || !Array.isArray(control.sideEffects) || control.sideEffects.length !== 0) {
		throw new Error(`packaged ${skillId} returned the wrong cold custody contract`)
	}
}
if (lstatSync(coldXdg, { throwIfNoEntry: false }) !== undefined) {
	throw new Error("packaged cold run mutated XDG state")
}

const checksums = JSON.parse(readFileSync(second.checksums, "utf8"))
const sha256 = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const sourcePayloadHash = payloadInventorySha256(join(root, PLUGIN_DIRECTORY), inventory)
const installedPayloadHash = payloadInventorySha256(installedRoot, inventory)
if (
	checksums.runtimeLockSha256 !== sha256(readFileSync(join(root, "runtime", "runtime.lock.json"))) ||
	checksums.bundleInventorySha256 !==
		sha256(readFileSync(join(installedRoot, "runtime", "bundle-inventory.json"))) ||
	checksums.payloadInventorySha256 !== sourcePayloadHash ||
	installedPayloadHash !== sourcePayloadHash
) {
	throw new Error("checksum metadata does not bind the runtime lock, bundle inventory, and payload inventory")
}
const sourceCommit = resolveCandidatePayloadCommit(root)
const configuredSourceCommit = process.env.SOURCE_COMMIT || process.env.GITHUB_SHA || undefined
if (configuredSourceCommit !== undefined && configuredSourceCommit !== sourceCommit) {
	throw new Error("distribution proof source commit does not match Git HEAD")
}
assertDistributionChecksumIdentity(checksums, {
	repository: pluginConfig.repository,
	sourceCommit,
	tag: `v${pluginConfig.version}`,
	plugin: pluginConfig.name,
	version: pluginConfig.version,
	archive: basename(second.archive),
	archiveBytes: second.archiveBytes,
	archiveSha256: second.archiveDigest,
	payloadInventorySha256: sourcePayloadHash,
})
const capabilityEvidence = {
	claude: proveInstalledCapabilityEvidence(
		installedRoot,
		"claude",
		sourceCommit,
		sourcePayloadHash,
	),
	codex: proveInstalledCapabilityEvidence(
		installedRoot,
		"codex",
		sourceCommit,
		sourcePayloadHash,
	),
}

console.log(
	JSON.stringify({
		ok: true,
		deterministic: true,
		archiveBytes: second.archiveBytes,
		archiveSha256: second.archiveDigest,
		candidateCommit: sourceCommit,
		payloadHash: sourcePayloadHash,
		installedPayloadHash,
		capabilityEvidence,
		nativeActivation: "not-proved",
		nativeDelegation: "not-proved",
		qualificationReceiptsIngested: false,
		hookIndependentSkills: [
			"hello-world",
			"skill-a",
			"skill-b",
			"runtime-custody",
			"capability-tour",
		],
		entries: entries.length,
		offlinePackageExecution: true,
		bunRequiredAtRuntime: true,
		userManagedBunRequired: false,
		runtimeAcquisition: "agent-approved-repair",
		npmPublicationRequired: false,
		platforms: ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"],
	}),
)
