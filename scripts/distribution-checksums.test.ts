import { expect, test } from "bun:test"

import {
	assertDistributionChecksumIdentity,
	type DistributionChecksumIdentity,
} from "./distribution-checksums"

const expected: DistributionChecksumIdentity = {
	repository: "https://github.com/example/plugin",
	sourceCommit: "a".repeat(40),
	tag: "v1.2.3",
	plugin: "example-plugin",
	version: "1.2.3",
	archive: "example-plugin-1.2.3.tar.gz",
	archiveBytes: 1234,
	archiveSha256: "b".repeat(64),
	payloadInventorySha256: "e".repeat(64),
}

test.each([
	["repository", "https://github.com/wrong/plugin"],
	["sourceCommit", "c".repeat(40)],
	["tag", "v9.9.9"],
	["plugin", "wrong-plugin"],
	["version", "9.9.9"],
	["archive", "wrong.tar.gz"],
	["archiveBytes", 9999],
	["archiveSha256", "d".repeat(64)],
	["payloadInventorySha256", "f".repeat(64)],
] as const)("distribution proof rejects mismatched %s", (field, value) => {
	expect(() =>
		assertDistributionChecksumIdentity({ ...expected, [field]: value }, expected),
	).toThrow(`checksum ${field} does not match the packaged archive identity`)
})

test("distribution proof accepts an exact checksum identity", () => {
	expect(() => assertDistributionChecksumIdentity(structuredClone(expected), expected)).not.toThrow()
})
