import * as fileSystem from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, test } from "bun:test"

import { copyPluginPayload, pluginPayloadInventory } from "./plugin-files"

const temporaryRoots: string[] = []

function pluginFixture(): { sourceRoot: string; pluginRoot: string; targetRoot: string } {
	const sourceRoot = fileSystem.mkdtempSync(join(tmpdir(), "plugin-payload-"))
	temporaryRoots.push(sourceRoot)
	const pluginRoot = join(sourceRoot, "plugin")
	fileSystem.mkdirSync(pluginRoot)
	fileSystem.writeFileSync(join(pluginRoot, "a-safe.txt"), "safe\n")
	return { sourceRoot, pluginRoot, targetRoot: join(sourceRoot, "copied") }
}

function expectUnsafeEntryRejected(
	entry: string,
	setup: (fixture: ReturnType<typeof pluginFixture>) => void,
	reason: "symlink" | "special file",
): void {
	const fixture = pluginFixture()
	setup(fixture)

	expect(() => copyPluginPayload(fixture.sourceRoot, fixture.targetRoot)).toThrow(
		new RegExp(`${entry}.*${reason}`),
	)
	expect(fileSystem.existsSync(fixture.targetRoot)).toBe(false)
}

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		fileSystem.rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

test("copy rejects an internal symlink before copying payload content", () => {
	expectUnsafeEntryRejected(
		"z-internal-link",
		({ pluginRoot }) => fileSystem.symlinkSync("a-safe.txt", join(pluginRoot, "z-internal-link")),
		"symlink",
	)
})

test("copy rejects an external symlink before copying payload content", () => {
	expectUnsafeEntryRejected(
		"z-external-link",
		({ sourceRoot, pluginRoot }) => {
			const externalPath = join(sourceRoot, "outside.txt")
			fileSystem.writeFileSync(externalPath, "outside\n")
			fileSystem.symlinkSync(externalPath, join(pluginRoot, "z-external-link"))
		},
		"symlink",
	)
})

test("copy rejects a dangling symlink before copying payload content", () => {
	expectUnsafeEntryRejected(
		"z-dangling-link",
		({ pluginRoot }) =>
			fileSystem.symlinkSync("missing.txt", join(pluginRoot, "z-dangling-link")),
		"symlink",
	)
})

test("copy rejects a nested realpath escape before copying payload content", () => {
	expectUnsafeEntryRejected(
		"nested/z-escape",
		({ sourceRoot, pluginRoot }) => {
			const externalDirectory = join(sourceRoot, "outside")
			fileSystem.mkdirSync(externalDirectory)
			fileSystem.writeFileSync(join(externalDirectory, "escaped.txt"), "escaped\n")
			fileSystem.mkdirSync(join(pluginRoot, "nested"))
			fileSystem.symlinkSync(externalDirectory, join(pluginRoot, "nested", "z-escape"))
		},
		"symlink",
	)
})

const mkfifoSync = (
	fileSystem as typeof fileSystem & { mkfifoSync?: (path: string, mode?: number) => void }
).mkfifoSync

if (mkfifoSync) {
	test("copy rejects a FIFO before copying payload content", () => {
		expectUnsafeEntryRejected(
			"z-pipe",
			({ pluginRoot }) => mkfifoSync(join(pluginRoot, "z-pipe"), 0o600),
			"special file",
		)
	})
} else {
	test.skip("copy rejects a FIFO (mkfifoSync unavailable in this runtime)", () => {})
}

test("copy preserves every regular file path, mode, and byte", () => {
	const { sourceRoot, pluginRoot, targetRoot } = pluginFixture()
	fileSystem.chmodSync(join(pluginRoot, "a-safe.txt"), 0o640)
	fileSystem.mkdirSync(join(pluginRoot, "nested", "deeper"), { recursive: true })
	fileSystem.writeFileSync(join(pluginRoot, "nested", "binary.dat"), Buffer.from([0, 1, 2, 255]))
	fileSystem.writeFileSync(join(pluginRoot, "nested", "deeper", "run"), "#!/bin/sh\n")
	fileSystem.chmodSync(join(pluginRoot, "nested", "deeper", "run"), 0o751)
	const expectedInventory = ["a-safe.txt", "nested/binary.dat", "nested/deeper/run"]

	expect(copyPluginPayload(sourceRoot, targetRoot)).toEqual(expectedInventory)
	for (const relativePath of expectedInventory) {
		const sourcePath = join(pluginRoot, relativePath)
		const targetPath = join(targetRoot, relativePath)
		expect(fileSystem.readFileSync(targetPath)).toEqual(fileSystem.readFileSync(sourcePath))
		expect(fileSystem.statSync(targetPath).mode & 0o7777).toBe(
			fileSystem.statSync(sourcePath).mode & 0o7777,
		)
	}
})

test("inventory order is stable and sorted", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	fileSystem.writeFileSync(join(pluginRoot, "z-last.txt"), "last\n")
	fileSystem.mkdirSync(join(pluginRoot, "middle"))
	fileSystem.writeFileSync(join(pluginRoot, "middle", "first.txt"), "first\n")
	const expected = ["a-safe.txt", "middle/first.txt", "z-last.txt"]

	expect(pluginPayloadInventory(sourceRoot)).toEqual(expected)
	expect(pluginPayloadInventory(sourceRoot)).toEqual(expected)
})

test("inventory includes an unexpected regular file", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	fileSystem.writeFileSync(join(pluginRoot, "unexpected.extra"), "include me\n")

	expect(pluginPayloadInventory(sourceRoot)).toEqual(["a-safe.txt", "unexpected.extra"])
})
