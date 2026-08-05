import {
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const packageName = "harness-native-plugin-prototype-0.1.0"

interface PackageResult {
	archive: string
	provenance: string
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

const archiveEntries = Bun.spawnSync({
	cmd: ["tar", "-tzf", second.archive],
	stdout: "pipe",
	stderr: "inherit",
})
if (archiveEntries.exitCode !== 0) process.exit(archiveEntries.exitCode)
const entries = archiveEntries.stdout.toString().trim().split("\n")
for (const required of [
	`${packageName}/.claude-plugin/plugin.json`,
	`${packageName}/.codex-plugin/plugin.json`,
	`${packageName}/skills/hello-world/SKILL.md`,
	`${packageName}/hooks/hooks.json`,
	`${packageName}/hooks/claude/hooks.json`,
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
if (entries.some((entry) => entry.endsWith(".ts") || entry.includes("/.git/"))) {
	throw new Error("package contains repository source or Git metadata")
}
if (entries.some((entry) => entry.startsWith(`${packageName}/scripts/`))) {
	throw new Error("package contains development scripts")
}

const extractedRoot = join(root, ".dev", "distribution-proof")
rmSync(extractedRoot, { recursive: true, force: true })
mkdirSync(extractedRoot, { recursive: true })
const extract = Bun.spawnSync({
	cmd: ["tar", "-xzf", second.archive, "-C", extractedRoot],
	stdout: "inherit",
	stderr: "inherit",
})
if (extract.exitCode !== 0) process.exit(extract.exitCode)

const installedRoot = join(extractedRoot, packageName)
const launcher = join(installedRoot, "bin", "hello-world")
const hello = runPackaged(launcher, ["hello", "--name", "packaged", "--json"])
if (hello.exitCode !== 0) throw new Error(hello.stderr)
const helloResult = JSON.parse(hello.stdout)
if (helloResult.message !== "Hello, packaged!" || helloResult.sideEffects !== "none") {
	throw new Error("packaged launcher returned the wrong hello contract")
}

for (const harness of ["claude", "codex"] as const) {
	const hook = runPackaged(
		launcher,
		["hook", "--harness", harness, "--event", "SessionStart"],
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

const provenance = JSON.parse(readFileSync(second.provenance, "utf8"))
if (provenance.archiveSha256 !== second.archiveDigest) {
	throw new Error("provenance digest does not match the packaged archive")
}

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
