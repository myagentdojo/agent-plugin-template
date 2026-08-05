import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { copyPluginPayload } from "./plugin-files"

const root = resolve(import.meta.dir, "..")
const version = readFileSync(join(root, "runtime", "version.txt"), "utf8").trim()
const outputRoot = join(root, "dist")
const packageName = `harness-native-plugin-prototype-${version}`
const stagingRoot = mkdtempSync(join(tmpdir(), "plugin-package-"))
const packageRoot = join(stagingRoot, packageName)

function archiveEntries(directory: string, prefix: string): string[] {
	const entries = [prefix]
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const relativePath = `${prefix}/${entry.name}`
		entries.push(relativePath)
		if (entry.isDirectory()) {
			entries.push(...archiveEntries(join(directory, entry.name), relativePath).slice(1))
		}
	}
	return entries
}

try {
	mkdirSync(outputRoot, { recursive: true })
	copyPluginPayload(root, packageRoot)

	const entries = archiveEntries(packageRoot, packageName)
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
	const provenance = join(outputRoot, `${packageName}.provenance.json`)
	writeFileSync(
		provenance,
		`${JSON.stringify(
			{
				plugin: "harness-native-plugin-prototype",
				version,
				archive: `${packageName}.tar.gz`,
				archiveBytes,
				archiveSha256: archiveDigest,
			},
			null,
			2,
		)}\n`,
	)
	console.log(JSON.stringify({ archive, provenance, archiveBytes, archiveDigest }))
} finally {
	rmSync(stagingRoot, { recursive: true, force: true })
}
