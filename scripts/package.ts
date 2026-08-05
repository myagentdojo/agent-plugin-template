import {
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

import { copyPluginPayload } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginConfig = loadPluginConfig(root)
const version = pluginConfig.version
const outputRoot = join(root, "dist")
const packageName = `${pluginConfig.name}-${version}`
const stagingRoot = mkdtempSync(join(tmpdir(), "plugin-package-"))
const packageRoot = join(stagingRoot, packageName)

function resolveSourceCommit(): string {
	const configured = process.env.SOURCE_COMMIT || process.env.GITHUB_SHA
	if (configured) return configured
	const git = Bun.spawnSync({
		cmd: ["git", "rev-parse", "HEAD"],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	})
	return git.exitCode === 0 ? git.stdout.toString().trim() : "unknown"
}

try {
	mkdirSync(outputRoot, { recursive: true })
	const inventory = copyPluginPayload(root, packageRoot)

	const entries = inventory.map((relativePath) => `${packageName}/${relativePath}`)
	const epoch = new Date(0)
	for (const relativePath of entries) utimesSync(join(stagingRoot, relativePath), epoch, epoch)

	const fileList = join(stagingRoot, "entries.txt")
	writeFileSync(fileList, `${entries.join("\n")}\n`)
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
				sourceCommit: resolveSourceCommit(),
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
