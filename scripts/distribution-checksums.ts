/**
 * Independently derived identity that checksum metadata must bind to archive bytes.
 *
 * @example
 * ```typescript
 * const identity: DistributionChecksumIdentity = {
 *   repository: "https://github.com/example/plugin",
 *   sourceCommit: "a".repeat(40),
 *   tag: "v1.0.0",
 *   plugin: "example-plugin",
 *   version: "1.0.0",
 *   archive: "example-plugin-1.0.0.tar.gz",
 *   archiveBytes: 1024,
 *   archiveSha256: "b".repeat(64),
 *   payloadInventorySha256: "c".repeat(64),
 * }
 * ```
 */
export interface DistributionChecksumIdentity {
	/** Canonical source repository from plugin configuration. */
	repository: string
	/** Exact Git commit used to package the payload. */
	sourceCommit: string
	/** Immutable release tag corresponding to the version. */
	tag: string
	/** Canonical plugin name from configuration. */
	plugin: string
	/** Semantic version projected into the package. */
	version: string
	/** Basename of the archive whose bytes were measured. */
	archive: string
	/** Measured archive size in bytes. */
	archiveBytes: number
	/** Measured SHA-256 digest of the archive. */
	archiveSha256: string
	/** Canonical path-and-byte digest of the complete plugin payload. */
	payloadInventorySha256: string
}

/**
 * Bind checksum evidence to every independently known package identity field.
 *
 * @param checksums - Parsed checksum metadata emitted beside the archive
 * @param expected - Identity derived independently from configuration, Git, and archive bytes
 * @throws {Error} When any emitted identity field differs from independent evidence
 *
 * @example
 * ```typescript
 * assertDistributionChecksumIdentity(checksums, expectedIdentity)
 * ```
 */
export function assertDistributionChecksumIdentity(
	checksums: Record<string, unknown>,
	expected: DistributionChecksumIdentity,
): void {
	for (const field of [
		"repository",
		"sourceCommit",
		"tag",
		"plugin",
		"version",
		"archive",
		"archiveBytes",
		"archiveSha256",
		"payloadInventorySha256",
	] as const) {
		if (checksums[field] !== expected[field]) {
			throw new Error(`checksum ${field} does not match the packaged archive identity`)
		}
	}
}
