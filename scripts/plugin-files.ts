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

const USTAR_BLOCK_BYTES = 512

function writeUstarText(header: Buffer, offset: number, width: number, value: string): void {
	const bytes = Buffer.from(value, "utf8")
	if (bytes.length > width) throw new Error(`USTAR field exceeds ${width} bytes: ${value}`)
	bytes.copy(header, offset)
}

function writeUstarOctal(header: Buffer, offset: number, width: number, value: number): void {
	const octal = value.toString(8)
	if (octal.length > width - 1) throw new Error(`USTAR numeric field exceeds ${width} bytes`)
	writeUstarText(header, offset, width, `${octal.padStart(width - 1, "0")}\0`)
}

function splitUstarPath(relativePath: string): { name: string; prefix: string } {
	if (Buffer.byteLength(relativePath, "utf8") <= 100) return { name: relativePath, prefix: "" }
	for (
		let slash = relativePath.lastIndexOf("/");
		slash > 0;
		slash = relativePath.lastIndexOf("/", slash - 1)
	) {
		const prefix = relativePath.slice(0, slash)
		const name = relativePath.slice(slash + 1)
		if (
			name.length > 0 &&
			Buffer.byteLength(name, "utf8") <= 100 &&
			Buffer.byteLength(prefix, "utf8") <= 155
		) {
			return { name, prefix }
		}
	}
	throw new Error(`USTAR path cannot be represented: ${relativePath}`)
}

function ustarHeader(
	relativePath: string,
	status: { isDirectory(): boolean; mode: number; size: number },
): Buffer {
	const header = Buffer.alloc(USTAR_BLOCK_BYTES)
	const { name, prefix } = splitUstarPath(relativePath)
	writeUstarText(header, 0, 100, name)
	writeUstarOctal(header, 100, 8, status.mode & 0o777)
	writeUstarOctal(header, 108, 8, 0)
	writeUstarOctal(header, 116, 8, 0)
	writeUstarOctal(header, 124, 12, status.isDirectory() ? 0 : status.size)
	writeUstarOctal(header, 136, 12, 0)
	header.fill(0x20, 148, 156)
	header[156] = status.isDirectory() ? 0x35 : 0x30
	writeUstarText(header, 257, 6, "ustar\0")
	writeUstarText(header, 263, 2, "00")
	writeUstarText(header, 265, 32, "root")
	writeUstarText(header, 297, 32, "root")
	writeUstarOctal(header, 329, 8, 0)
	writeUstarOctal(header, 337, 8, 0)
	writeUstarText(header, 345, 155, prefix)
	let checksum = 0
	for (const byte of header) checksum += byte
	writeUstarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
	return header
}

function deterministicUstar(stagingRoot: string, entries: readonly string[]): Buffer {
	const chunks: Buffer[] = []
	for (const relativePath of entries) {
		const absolutePath = join(stagingRoot, relativePath)
		const status = statSync(absolutePath)
		chunks.push(ustarHeader(relativePath, status))
		if (status.isDirectory()) continue
		const contents = readFileSync(absolutePath)
		chunks.push(contents)
		const padding = (USTAR_BLOCK_BYTES - (contents.length % USTAR_BLOCK_BYTES)) % USTAR_BLOCK_BYTES
		if (padding > 0) chunks.push(Buffer.alloc(padding))
	}
	chunks.push(Buffer.alloc(USTAR_BLOCK_BYTES * 2))
	return Buffer.concat(chunks)
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
		const uncompressedArchive = deterministicUstar(stagingRoot, entries)
		const gzip = Bun.spawnSync({
			cmd: ["gzip", "-n", "-9", "-c"],
			stdin: uncompressedArchive,
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
