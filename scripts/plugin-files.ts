import { createHash } from "node:crypto"
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

/** Canonical directory copied by development staging and release packaging. */
export const PLUGIN_DIRECTORY = "plugin"

/**
 * Order paths by JavaScript code units so inventories never depend on process locale.
 *
 * @param left - First path or entry name
 * @param right - Second path or entry name
 * @returns Negative when left sorts first, positive when right sorts first, or zero when equal
 *
 * @example
 * ```ts
 * ["ä", "Z", "a"].sort(compareCodeUnits)
 * ```
 */
export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function framedLength(length: number): Buffer {
	const frame = Buffer.allocUnsafe(8)
	frame.writeBigUInt64BE(BigInt(length))
	return frame
}

/** Hash an ordered payload inventory with collision-free path/body framing. */
export function payloadInventorySha256(
	payloadRoot: string,
	inventory: readonly string[],
): string {
	const hash = createHash("sha256")
	for (const relativePath of inventory) {
		const pathBytes = Buffer.from(relativePath, "utf8")
		const fileBytes = readFileSync(join(payloadRoot, relativePath))
		hash.update(framedLength(pathBytes.byteLength))
		hash.update(pathBytes)
		hash.update(framedLength(fileBytes.byteLength))
		hash.update(fileBytes)
	}
	return hash.digest("hex")
}

/**
 * List one directory tree in the exact depth-first order used by deterministic tar input.
 *
 * @param directory - Absolute directory whose entries have already passed payload validation
 * @param prefix - Archive-relative root name
 * @returns Root, directory, and file entries with directories carrying trailing slashes
 *
 * @example
 * ```ts
 * directoryArchiveEntries("/tmp/plugin", "hello-0.1.0")
 * ```
 */
export function directoryArchiveEntries(directory: string, prefix: string): string[] {
	const entries = [`${prefix}/`]
	for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
		compareCodeUnits(left.name, right.name),
	)) {
		const relativePath = `${prefix}/${entry.name}`
		if (entry.isDirectory()) {
			entries.push(...directoryArchiveEntries(join(directory, entry.name), relativePath))
		} else {
			entries.push(relativePath)
		}
	}
	return entries
}

function unsafeEntry(relativePath: string, reason: string): Error {
	const entry = relativePath ? `${PLUGIN_DIRECTORY}/${relativePath}` : PLUGIN_DIRECTORY
	return new Error(`unsafe plugin payload entry "${entry}": ${reason}`)
}

/**
 * Discover the one deterministic set of regular files that may become a Plugin Payload.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @returns Sorted paths relative to `plugin/`, using forward slashes
 * @throws {Error} When the plugin root or any descendant is empty, a symlink, or a special file
 *
 * @example
 * ```ts
 * const files = pluginPayloadInventory(process.cwd())
 * ```
 */
export function pluginPayloadInventory(sourceRoot: string): string[] {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const pluginRootStatus = lstatSync(pluginRoot)
	if (pluginRootStatus.isSymbolicLink()) throw unsafeEntry("", "symlink")
	if (!pluginRootStatus.isDirectory()) throw unsafeEntry("", "special file (expected directory)")

	const pluginRealRoot = realpathSync(pluginRoot)
	const inventory: string[] = []

	function walk(directory: string, relativeDirectory: string): void {
		const entries = readdirSync(directory).sort(compareCodeUnits)
		if (entries.length === 0) throw unsafeEntry(relativeDirectory, "empty directory")
		for (const entry of entries) {
			const absolutePath = join(directory, entry)
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry}` : entry
			const status = lstatSync(absolutePath)

			if (status.isSymbolicLink()) throw unsafeEntry(relativePath, "symlink")
			if (!status.isDirectory() && !status.isFile()) {
				throw unsafeEntry(relativePath, "special file (FIFO, device, or socket)")
			}
			if (status.isDirectory()) {
				walk(absolutePath, relativePath)
				continue
			}
			inventory.push(relativePath)
		}
	}

	// Walk from the resolved root. Every descendant is lstat'd and symlinks are
	// rejected before descent, so valid POSIX names need no per-entry realpath.
	walk(pluginRealRoot, "")
	return inventory.sort(compareCodeUnits)
}

/**
 * Build the deterministic release archive bytes for one plugin payload.
 *
 * Release packaging and canary qualification share this builder, so the archive
 * SHA-256 bound into candidate lineage is byte-identical to the released
 * `*.tar.gz` whenever the payload bytes and package name match.
 *
 * @param sourceRoot - Repository or candidate root containing the canonical `plugin/` directory
 * @param packageName - Archive root entry name, `<plugin-name>-<version>`
 * @returns Gzipped deterministic tar bytes and their SHA-256 digest
 * @throws {Error} When the payload is unsafe or tar/gzip fails
 *
 * @example
 * ```ts
 * const { sha256 } = deterministicPluginArchive(process.cwd(), "hello-0.1.0")
 * ```
 */
export function deterministicPluginArchive(
	sourceRoot: string,
	packageName: string,
): { bytes: Buffer; sha256: string } {
	const stagingRoot = mkdtempSync(join(tmpdir(), "plugin-package-"))
	try {
		const packageRoot = join(stagingRoot, packageName)
		copyPluginPayload(sourceRoot, packageRoot)
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
						"--owner=root",
						"--group=root",
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
		const tar = Bun.spawnSync({ cmd: tarArguments, stdout: "pipe", stderr: "pipe" })
		if (tar.exitCode !== 0) {
			const diagnostics = tar.stderr.toString().trim()
			throw new Error(
				`deterministic archive tar failed with exit code ${tar.exitCode}${diagnostics ? `: ${diagnostics}` : ""}`,
			)
		}
		const gzip = Bun.spawnSync({
			cmd: ["gzip", "-n", "-9", "-c", uncompressedArchive],
			stdout: "pipe",
			stderr: "pipe",
		})
		if (gzip.exitCode !== 0) {
			const diagnostics = gzip.stderr.toString().trim()
			throw new Error(
				`deterministic archive gzip failed with exit code ${gzip.exitCode}${diagnostics ? `: ${diagnostics}` : ""}`,
			)
		}
		const bytes = Buffer.from(gzip.stdout)
		return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true })
	}
}

/**
 * Copy the exact canonical plugin payload without repository tooling or source.
 *
 * @param sourceRoot - Repository root containing the canonical `plugin/` directory
 * @param targetRoot - Empty or replaceable directory receiving plugin contents
 * @returns The validated inventory copied into the target
 * @throws {Error} When the canonical payload contains an empty directory, symlink, special file, or realpath escape
 *
 * @example
 * ```ts
 * copyPluginPayload(process.cwd(), "/tmp/installed-plugin")
 * ```
 */
export function copyPluginPayload(sourceRoot: string, targetRoot: string): string[] {
	const pluginRoot = resolve(sourceRoot, PLUGIN_DIRECTORY)
	const inventory = pluginPayloadInventory(sourceRoot)
	mkdirSync(targetRoot, { recursive: true })
	for (const relativePath of inventory) {
		const sourcePath = join(pluginRoot, relativePath)
		const targetPath = join(targetRoot, relativePath)
		const sourceStatus = lstatSync(sourcePath)
		if (!sourceStatus.isFile()) throw unsafeEntry(relativePath, "changed after inventory (expected file)")
		mkdirSync(dirname(targetPath), { recursive: true })
		copyFileSync(sourcePath, targetPath)
		chmodSync(targetPath, sourceStatus.mode & 0o7777)
	}
	return inventory
}
