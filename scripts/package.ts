import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { validateBundleClosure } from "./build"
import { copyPluginPayload, directoryArchiveEntries } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const version = pluginConfig.version
const outputRoot = join(root, "dist")
const packageName = `${pluginConfig.name}-${version}`
const stagingRoot = mkdtempSync(join(tmpdir(), "plugin-package-"))
const packageRoot = join(stagingRoot, packageName)

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

try {
	// Missing, stale, or orphaned bundle mappings fail before packaging.
	validateBundleClosure(root)
	const sourceCommit = resolveSourceCommit()
	mkdirSync(outputRoot, { recursive: true })
	copyPluginPayload(root, packageRoot)

	const entries = directoryArchiveEntries(packageRoot, packageName)
	const epoch = new Date(0)
	for (const relativePath of entries) {
		const absolutePath = join(stagingRoot, relativePath)
		const status = statSync(absolutePath)
		chmodSync(absolutePath, status.isDirectory() ? 0o755 : status.mode & 0o111 ? 0o755 : 0o644)
		utimesSync(absolutePath, epoch, epoch)
	}

	const fileList = join(stagingRoot, "entries.bin")
	writeFileSync(fileList, Buffer.from(`${entries.join("\0")}\0`))
	const uncompressedArchive = join(stagingRoot, `${packageName}.tar`)
	const tarArguments =
		process.platform === "darwin"
			? [
					"tar",
					"-cf",
					uncompressedArchive,
					"--format",
					"ustar",
					"--uid",
					"0",
					"--gid",
					"0",
					"--uname",
					"root",
					"--gname",
					"root",
					"--no-xattrs",
					"--no-acls",
					"--no-fflags",
					"--no-mac-metadata",
					"--no-recursion",
					"--null",
					"-C",
					stagingRoot,
					"-T",
					fileList,
				]
			: [
					"tar",
					"--sort=name",
					"--mtime=@0",
					"--owner=0",
					"--group=0",
					"--numeric-owner",
					"--no-xattrs",
					"--no-acls",
					"--no-selinux",
					"--format=ustar",
					"--no-recursion",
					"--null",
					"-cf",
					uncompressedArchive,
					"-C",
					stagingRoot,
					"-T",
					fileList,
				]
	const tar = Bun.spawnSync({ cmd: tarArguments, stdout: "inherit", stderr: "inherit" })
	if (tar.exitCode !== 0) process.exit(tar.exitCode)

	const gzip = Bun.spawnSync({
		cmd: ["gzip", "-n", "-9", "-c", uncompressedArchive],
		stdout: "pipe",
		stderr: "inherit",
	})
	if (gzip.exitCode !== 0) process.exit(gzip.exitCode)

	const archive = join(outputRoot, `${packageName}.tar.gz`)
	writeFileSync(archive, gzip.stdout)
	const archiveBytes = statSync(archive).size
	const archiveDigest = new Bun.CryptoHasher("sha256")
		.update(readFileSync(archive))
		.digest("hex")
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
				evidence:
					"Checksum metadata is integrity evidence for these archive bytes, not independent publisher or builder authenticity.",
			},
			null,
			2,
		)}\n`,
	)
	console.log(JSON.stringify({ archive, checksums, archiveBytes, archiveDigest }))
} finally {
	rmSync(stagingRoot, { recursive: true, force: true })
}
