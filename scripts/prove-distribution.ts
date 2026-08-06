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
	PLUGIN_DIRECTORY,
	pluginPayloadInventory,
} from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

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
	standardInput = "",
): { exitCode: number; stdout: string; stderr: string } {
	const process_ = Bun.spawnSync({
		cmd: [launcher, ...arguments_],
		env: {
			...process.env,
			PATH: "/usr/bin:/bin",
			HELLO_WORLD_RUN_ID: "packaged-offline-proof",
		},
		stdin: Buffer.from(standardInput),
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
	`${packageName}/skills/hello-world/SKILL.md`,
	`${packageName}/hooks/claude/hooks.json`,
	`${packageName}/hooks/codex/hooks.json`,
	`${packageName}/bin/hello-world`,
	`${packageName}/runtime/hello-world.js`,
	`${packageName}/runtime/qjs-darwin-arm64`,
	`${packageName}/runtime/qjs-darwin-x86_64`,
	`${packageName}/runtime/qjs-linux-aarch64`,
	`${packageName}/runtime/qjs-linux-x86_64`,
	`${packageName}/runtime/quickjs-assets.json`,
	`${packageName}/QUICKJS-LICENSE`,
]) {
	if (!entries.includes(required)) throw new Error(`package is missing ${required}`)
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

const launcher = join(installedRoot, "bin", "hello-world")
const version = runPackaged(launcher, ["--version"])
if (version.exitCode !== 0 || version.stdout.trim() !== pluginConfig.version) {
	throw new Error("packaged launcher version does not match plugin.config.json")
}
const hello = runPackaged(launcher, ["hello", "--name", "packaged", "--json"])
if (hello.exitCode !== 0) throw new Error(hello.stderr)
const helloResult = JSON.parse(hello.stdout)
if (helloResult.message !== "Hello, packaged!" || helloResult.sideEffects !== "none") {
	throw new Error("packaged launcher returned the wrong hello contract")
}

for (const harness of ["claude", "codex"] as const) {
	const hookArguments = ["hook", "--harness", harness, "--event", "SessionStart"]
	if (harness === "codex") hookArguments.push("--plugin-version", pluginConfig.version)
	const hook = runPackaged(
		launcher,
		hookArguments,
		'{"session_id":"packaged-offline-proof"}\n',
	)
	if (hook.exitCode !== 0 || !hook.stderr.includes(`hello-world hook: ${harness} SessionStart`)) {
		throw new Error(`packaged ${harness} hook contract failed`)
	}
}

const assetManifest = JSON.parse(
	readFileSync(join(installedRoot, "runtime", "quickjs-assets.json"), "utf8"),
)
for (const asset of Object.values(assetManifest.assets) as Array<{
	file: string
	sha256: string
	bytes: number
}>) {
	const assetPath = join(installedRoot, "runtime", asset.file)
	if (statSync(assetPath).size !== asset.bytes) throw new Error(`${asset.file} size mismatch`)
	const digest = new Bun.CryptoHasher("sha256")
		.update(readFileSync(assetPath))
		.digest("hex")
	if (digest !== asset.sha256) throw new Error(`${asset.file} digest mismatch`)
}

const checksums = JSON.parse(readFileSync(second.checksums, "utf8"))
const sourceCommit = process.env.SOURCE_COMMIT ?? process.env.GITHUB_SHA ?? Bun.spawnSync({
	cmd: ["git", "rev-parse", "HEAD"],
	cwd: root,
	stdout: "pipe",
	stderr: "inherit",
}).stdout.toString().trim()
assertDistributionChecksumIdentity(checksums, {
	repository: pluginConfig.repository,
	sourceCommit,
	tag: `v${pluginConfig.version}`,
	plugin: pluginConfig.name,
	version: pluginConfig.version,
	archive: basename(second.archive),
	archiveBytes: second.archiveBytes,
	archiveSha256: second.archiveDigest,
})

console.log(
	JSON.stringify({
		ok: true,
		deterministic: true,
		archiveBytes: second.archiveBytes,
		archiveSha256: second.archiveDigest,
		entries: entries.length,
		offlinePackageExecution: true,
		bunRequiredAtRuntime: false,
		npmPublicationRequired: false,
		platforms: ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"],
	}),
)
