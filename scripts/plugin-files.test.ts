import * as fileSystem from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, test } from "bun:test"

import {
	compareCodeUnits,
	copyPluginPayload,
	deterministicPluginArchive,
	directoryArchiveEntries,
	payloadInventorySha256,
	pluginPayloadInventory,
} from "./plugin-files"

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

test("copy rejects a nested symlink escape before copying payload content", () => {
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

test("copy rejects a Unix-domain socket before copying payload content", async () => {
	const fixture = pluginFixture()
	const socketPath = join(fixture.pluginRoot, "z-socket")
	const server = createServer()
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject)
			server.listen(socketPath, () => {
				server.off("error", reject)
				resolve()
			})
		})
		expect(() => copyPluginPayload(fixture.sourceRoot, fixture.targetRoot)).toThrow(
			/z-socket.*special file/,
		)
		expect(fileSystem.existsSync(fixture.targetRoot)).toBe(false)
	} finally {
		if (server.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		}
	}
})

test("copy rejects an empty payload directory instead of silently dropping it", () => {
	const fixture = pluginFixture()
	fileSystem.mkdirSync(join(fixture.pluginRoot, "empty"))

	expect(() => copyPluginPayload(fixture.sourceRoot, fixture.targetRoot)).toThrow(
		/empty.*empty directory/,
	)
	expect(fileSystem.existsSync(fixture.targetRoot)).toBe(false)
})

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

test("inventory and archive order use locale-independent code-unit comparison", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	for (const name of ["Z-upper.txt", "ä-localized.txt"]) {
		fileSystem.writeFileSync(join(pluginRoot, name), `${name}\n`)
	}

	expect(["ä-localized.txt", "a-safe.txt", "Z-upper.txt"].sort(compareCodeUnits)).toEqual([
		"Z-upper.txt",
		"a-safe.txt",
		"ä-localized.txt",
	])
	expect(pluginPayloadInventory(sourceRoot)).toEqual([
		"Z-upper.txt",
		"a-safe.txt",
		"ä-localized.txt",
	])
	expect(directoryArchiveEntries(pluginRoot, "plugin-0.1.0")).toEqual([
		"plugin-0.1.0/",
		"plugin-0.1.0/Z-upper.txt",
		"plugin-0.1.0/a-safe.txt",
		"plugin-0.1.0/ä-localized.txt",
	])
})

test("inventory and archive entries preserve newline-bearing names without line parsing", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	const unusualName = "line\nbreak.txt"
	fileSystem.writeFileSync(join(pluginRoot, unusualName), "unusual\n")

	expect(pluginPayloadInventory(sourceRoot)).toContain(unusualName)
	expect(directoryArchiveEntries(pluginRoot, "plugin-0.1.0")).toContain(
		`plugin-0.1.0/${unusualName}`,
	)
})

test("inventory includes an unexpected regular file", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	fileSystem.writeFileSync(join(pluginRoot, "unexpected.extra"), "include me\n")

	expect(pluginPayloadInventory(sourceRoot)).toEqual(["a-safe.txt", "unexpected.extra"])
})

test("payload digest frames path and body bytes without cross-record ambiguity", () => {
	const first = pluginFixture()
	const second = pluginFixture()
	fileSystem.writeFileSync(join(first.pluginRoot, "a-safe.txt"), Buffer.from("b\0c\0d"))
	fileSystem.writeFileSync(join(second.pluginRoot, "a-safe.txt"), Buffer.from("b\0"))
	fileSystem.writeFileSync(join(second.pluginRoot, "c"), "d")

	expect(payloadInventorySha256(first.pluginRoot, ["a-safe.txt"])).not.toBe(
		payloadInventorySha256(second.pluginRoot, ["a-safe.txt", "c"]),
	)
})

test("archive order keeps each directory beside its descendants", () => {
	const { pluginRoot } = pluginFixture()
	fileSystem.mkdirSync(join(pluginRoot, "runtime"))
	fileSystem.writeFileSync(join(pluginRoot, "runtime", "a.js"), "runtime\n")
	fileSystem.writeFileSync(join(pluginRoot, "runtime.txt"), "sibling\n")

	expect(directoryArchiveEntries(pluginRoot, "plugin-0.1.0")).toEqual([
		"plugin-0.1.0/",
		"plugin-0.1.0/a-safe.txt",
		"plugin-0.1.0/runtime/",
		"plugin-0.1.0/runtime/a.js",
		"plugin-0.1.0/runtime.txt",
	])
})

test("in-process USTAR bytes are platform canonical", () => {
	const { sourceRoot } = pluginFixture()
	const first = deterministicPluginArchive(sourceRoot, "plugin-0.1.0")
	const second = deterministicPluginArchive(sourceRoot, "plugin-0.1.0")
	const header = Buffer.from(Bun.gunzipSync(first.bytes)).subarray(0, 512)
	const headerText = (offset: number) =>
		header.subarray(offset, offset + 32).toString("utf8").replace(/\0.*$/, "")

	expect(first.bytes).toEqual(second.bytes)
	expect(first.sha256).toBe(
		"116a569020e91b24e5994dae842f0a4fe3bfd90bb0ee7f20c4c66f3e38b805ae",
	)
	expect(headerText(265)).toBe("root")
	expect(headerText(297)).toBe("root")
})

test("USTAR prefix fields preserve representable long paths", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	const directory = `nested-${"p".repeat(80)}`
	const file = `${"f".repeat(30)}.txt`
	fileSystem.mkdirSync(join(pluginRoot, directory))
	fileSystem.writeFileSync(join(pluginRoot, directory, file), "long path\n")

	const archive = deterministicPluginArchive(sourceRoot, "plugin-0.1.0")
	const listing = Bun.spawnSync({
		cmd: ["tar", "-tzf", "-"],
		stdin: archive.bytes,
		stdout: "pipe",
		stderr: "pipe",
	})

	expect(listing.exitCode, listing.stderr.toString()).toBe(0)
	expect(listing.stdout.toString()).toContain(`plugin-0.1.0/${directory}/${file}\n`)
})

test("USTAR packaging rejects an unrepresentable path component", () => {
	const { sourceRoot, pluginRoot } = pluginFixture()
	const file = "x".repeat(101)
	fileSystem.writeFileSync(join(pluginRoot, file), "too long\n")

	expect(() => deterministicPluginArchive(sourceRoot, "plugin-0.1.0")).toThrow(
		"USTAR path cannot be represented",
	)
})
