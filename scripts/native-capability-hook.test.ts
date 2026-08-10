import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, expect, test } from "bun:test"

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const temporaryRoots: string[] = []
const warning =
	"This plugin could not run its lifecycle mechanics proof; continuing without blocking.\n"

afterEach(() => {
	for (const temporaryRoot of temporaryRoots.splice(0)) {
		rmSync(temporaryRoot, { recursive: true, force: true })
	}
})

function installedPlugin(): { handler: string; pluginRoot: string } {
	const installationRoot = mkdtempSync(join(tmpdir(), "native-capability-hook-"))
	temporaryRoots.push(installationRoot)
	const pluginRoot = join(installationRoot, "plugin")
	mkdirSync(join(pluginRoot, "hooks", "fixture"), { recursive: true })
	cpSync(
		join(root, "plugin", "hooks", "native-capability-hook"),
		join(pluginRoot, "hooks", "native-capability-hook"),
	)
	cpSync(
		join(root, "plugin", "hooks", "fixture"),
		join(pluginRoot, "hooks", "fixture"),
		{ recursive: true },
	)
	mkdirSync(join(pluginRoot, ".claude-plugin"))
	mkdirSync(join(pluginRoot, ".codex-plugin"))
	for (const harness of ["claude", "codex"]) {
		writeFileSync(
			join(pluginRoot, `.${harness}-plugin`, "plugin.json"),
			'{"name":"fixture","displayName":"Harness Plugin Prototype","version":"0.3.0"}\n',
		)
	}
	const handler = join(pluginRoot, "hooks", "native-capability-hook")
	chmodSync(handler, 0o755)
	return { handler, pluginRoot }
}

function runHook(
	handler: string,
	event: "SessionStart" | "Stop",
	client: "claude" | "codex",
	input: string | Uint8Array,
	options: { cwd?: string; env?: Record<string, string> } = {},
) {
	return Bun.spawnSync({
		cmd: [handler, event, client],
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
		...options,
	})
}

function expectFailsOpen(result: ReturnType<typeof runHook>): void {
	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe(warning)
}

function treeSnapshot(directory: string): string[] {
	const entries: string[] = []
	function visit(current: string, relative: string): void {
		const status = statSync(current)
		if (status.isDirectory()) {
			entries.push(`d ${relative} ${status.mode & 0o7777} ${status.mtimeMs}`)
			for (const name of readdirSync(current).sort()) {
				visit(join(current, name), relative ? `${relative}/${name}` : name)
			}
			return
		}
		const digest = new Bun.CryptoHasher("sha256").update(readFileSync(current)).digest("hex")
		entries.push(`f ${relative} ${status.mode & 0o7777} ${status.mtimeMs} ${digest}`)
	}
	visit(directory, ".")
	return entries
}

function runGenerateCheck(repositoryRoot = root): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			"run",
			join(repositoryRoot, "scripts", "generate.ts"),
			"--check",
		],
		cwd: repositoryRoot,
		stdout: "pipe",
		stderr: "pipe",
	})
}

test("a clean Stop lifecycle mechanics proof is silent", () => {
	const fixture = installedPlugin()
	const before = readFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
	)

	const result = runHook(
		fixture.handler,
		"Stop",
		"claude",
		'{"stop_hook_active":false}',
	)

	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe("")
	expect(
		readFileSync(
			join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		),
	).toEqual(before)
})

test("SessionStart emits one versioned receipt only for startup and resume", () => {
	const fixture = installedPlugin()
	for (const client of ["claude", "codex"] as const) {
		for (const source of ["startup", "resume"] as const) {
			const result = runHook(
				fixture.handler,
				"SessionStart",
				client,
				JSON.stringify({ source }),
			)
			expect(result.exitCode).toBe(0)
			expect(result.stderr.toString()).toBe("")
			expect(JSON.parse(result.stdout.toString())).toEqual({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: `Harness Plugin Prototype v0.3.0 | ${client} | SessionStart:${source}`,
				},
			})
		}
		for (const source of ["clear", "compact", "fork", "future", ""] as const) {
			const result = runHook(
				fixture.handler,
				"SessionStart",
				client,
				JSON.stringify(source ? { source } : {}),
			)
			expect(result.exitCode).toBe(0)
			expect(result.stdout.toString()).toBe("")
			expect(result.stderr.toString()).toBe("")
		}
	}
})

test("a proven fixture mismatch returns the common versioned block envelope", () => {
	const fixture = installedPlugin()
	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)

	const result = runHook(
		fixture.handler,
		"Stop",
		"codex",
		'{"stop_hook_active":false}',
	)

	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toEqual({
		decision: "block",
		reason:
			"Harness Plugin Prototype v0.3.0 found a mismatch in its packaged lifecycle proof files. Do not modify the workspace. Continue once to explain how to reinstall this plugin from its trusted source; if the mismatch remains, report this plugin version.",
	})
})

test("an active Stop re-entry exits silently before fixture and version checks", () => {
	const fixture = installedPlugin()
	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)
	writeFileSync(join(fixture.pluginRoot, ".claude-plugin", "plugin.json"), "not-json\n")

	const result = runHook(
		fixture.handler,
		"Stop",
		"claude",
		'{"stop_hook_active":true}',
	)

	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe("")
})

test("Stop guard parsing accepts reordered whitespace and ignores string and nested decoys", () => {
	const fixture = installedPlugin()
	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)
	const input = `{
		"message": "a string with \\\"stop_hook_active\\\": true",
		"nested": { "stop_hook_active": true },
		"other": [1, { "stop_hook_active": true }],
		"stop_hook_active" : false
	}`

	const result = runHook(fixture.handler, "Stop", "claude", input)

	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({ decision: "block" })
})

test("ambiguous Stop guards fail open with one bounded warning", () => {
	const fixture = installedPlugin()
	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)
	const inputs = [
		"{}",
		'{"stop_hook_active":"true"}',
		'{"stop_hook_active":null}',
		'{"stop_hook_active":1}',
		'{"stop_hook_active":false,"stop_hook_active":true}',
		'{"stop_hook_active":false,"\\u0073top_hook_active":true}',
		'{"\\u0073top_hook_active":true,"stop_hook_active":false}',
		'{"nested":{"stop_hook_active":false}}',
		'{"stop_hook_active":false',
		'{"other":1 "stop_hook_active":false}',
		'{"stop_hook_active":false "other":1}',
		'{"stop_hook_active":false,}',
		'{"stop_hook_active":false,"other":}',
		'{"stop_hook_active":false,"other":tru}',
		'{"stop_hook_active":false,"other":[1,]}',
		'{"stop_hook_active":false} trailing',
		'[false]',
		'not json',
	]

	for (const client of ["claude", "codex"] as const) {
		for (const input of inputs) {
			expectFailsOpen(runHook(fixture.handler, "Stop", client, input))
		}
	}
})

test("invalid UTF-8 Stop payloads fail open before fixture mismatch blocking", () => {
	const fixture = installedPlugin()
	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)
	const prefix = Buffer.from('{"stop_hook_active":false,"x":"')
	const suffix = Buffer.from('"}')

	for (const invalidBytes of [
		Buffer.from([0x80]),
		Buffer.from([0xff]),
		Buffer.from([0xc0, 0x80]),
		Buffer.from([0xed, 0xa0, 0x80]),
		Buffer.from([0xf4, 0x90, 0x80, 0x80]),
		Buffer.from([0xe2, 0x82]),
	]) {
		const input = Buffer.concat([prefix, invalidBytes, suffix])
		for (const client of ["claude", "codex"] as const) {
			expectFailsOpen(runHook(fixture.handler, "Stop", client, input))
		}
	}

	const validUnicode = runHook(
		fixture.handler,
		"Stop",
		"claude",
		'{"stop_hook_active":false,"x":"é€🙂"}',
	)
	expect(validUnicode.stderr.toString()).toBe("")
	expect(JSON.parse(validUnicode.stdout.toString())).toMatchObject({ decision: "block" })
})

test("oversized input fails open after reading only 1 MiB plus one overflow byte", () => {
	const fixture = installedPlugin()
	const overflowInput = "x".repeat(1024 * 1024 + 1)
	expect(Buffer.byteLength(overflowInput)).toBe(1024 * 1024 + 1)

	for (const client of ["claude", "codex"] as const) {
		expectFailsOpen(runHook(fixture.handler, "Stop", client, overflowInput))
	}
})

test("near-limit hostile payloads complete within a bounded wall clock", () => {
	const fixture = installedPlugin()
	const boundMilliseconds = 10_000
	const giantString = `{"payload":"${"a".repeat(1024 * 1024 - 64)}","stop_hook_active":false}`
	const escapeDense = `{"payload":"${"\\n".repeat((1024 * 1024 - 64) / 2)}","stop_hook_active":false}`
	const manyMembers = `{${Array.from({ length: 65_536 }, (_, index) => `"k${index}":"v"`).join(",")},"stop_hook_active":false}`
	for (const input of [giantString, escapeDense, manyMembers]) {
		expect(Buffer.byteLength(input)).toBeLessThanOrEqual(1024 * 1024)
		const started = performance.now()
		const result = runHook(fixture.handler, "Stop", "claude", input)
		const elapsed = performance.now() - started
		expect(result.exitCode).toBe(0)
		expect(result.stdout.toString()).toBe("")
		expect(result.stderr.toString()).toBe("")
		expect(elapsed).toBeLessThan(boundMilliseconds)
	}

	const newlineFlood = "\n".repeat(1024 * 1024 - 1)
	const floodStarted = performance.now()
	const flood = runHook(fixture.handler, "Stop", "claude", newlineFlood)
	const floodElapsed = performance.now() - floodStarted
	expect(flood.exitCode).toBe(0)
	expect(flood.stdout.toString()).toBe("")
	expect(flood.stderr.toString()).toBe(warning)
	expect(floodElapsed).toBeLessThan(boundMilliseconds)

	const sessionStart = `{"payload":"${"a".repeat(1024 * 1024 - 64)}","source":"startup"}`
	expect(Buffer.byteLength(sessionStart)).toBeLessThanOrEqual(1024 * 1024)
	const started = performance.now()
	const result = runHook(fixture.handler, "SessionStart", "claude", sessionStart)
	const elapsed = performance.now() - started
	expect(result.exitCode).toBe(0)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		hookSpecificOutput: {
			additionalContext: "Harness Plugin Prototype v0.3.0 | claude | SessionStart:startup",
		},
	})
	expect(elapsed).toBeLessThan(boundMilliseconds)
}, 60_000)

test("a renamed manifest identity reaches the receipt and the block reason", () => {
	const fixture = installedPlugin()
	const displayName = 'Dojo "Hello" \\ Tools'
	writeFileSync(
		join(fixture.pluginRoot, ".claude-plugin", "plugin.json"),
		`${JSON.stringify({ name: "dojo-hello", displayName, version: "0.3.0" })}\n`,
	)

	for (const client of ["claude", "codex"] as const) {
		const start = runHook(fixture.handler, "SessionStart", client, '{"source":"startup"}')
		expect(start.exitCode).toBe(0)
		expect(start.stderr.toString()).toBe("")
		expect(JSON.parse(start.stdout.toString())).toMatchObject({
			hookSpecificOutput: {
				additionalContext: `${displayName} v0.3.0 | ${client} | SessionStart:startup`,
			},
		})
	}

	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)
	const stop = runHook(fixture.handler, "Stop", "claude", '{"stop_hook_active":false}')
	expect(stop.exitCode).toBe(0)
	expect(stop.stderr.toString()).toBe("")
	expect(JSON.parse(stop.stdout.toString())).toMatchObject({
		decision: "block",
		reason: expect.stringContaining(`${displayName} v0.3.0 found a mismatch`),
	})
})

test("an unreadable display name fails open instead of substituting a placeholder", () => {
	const fixture = installedPlugin()
	writeFileSync(
		join(fixture.pluginRoot, ".claude-plugin", "plugin.json"),
		'{"name":"fixture","version":"0.3.0"}\n',
	)

	const start = runHook(fixture.handler, "SessionStart", "claude", '{"source":"startup"}')
	expect(start.exitCode).toBe(0)
	expect(start.stdout.toString()).toBe("")
	expect(start.stderr.toString()).toBe(warning)

	writeFileSync(
		join(fixture.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.generated.json"),
		"drifted\n",
	)
	const stop = runHook(fixture.handler, "Stop", "claude", '{"stop_hook_active":false}')
	expect(stop.exitCode).toBe(0)
	expect(stop.stdout.toString()).toBe("")
	expect(stop.stderr.toString()).toBe(warning)
})

test("malformed SessionStart input fails open without a context marker", () => {
	const fixture = installedPlugin()
	for (const client of ["claude", "codex"] as const) {
		for (const input of [
			'{"source":"startup"',
			'{"source":"startup","source":"resume"}',
			'{"source":true}',
			'{"other":1 "source":"startup"}',
		]) {
			expectFailsOpen(runHook(fixture.handler, "SessionStart", client, input))
		}
	}
})

test("version metadata requires exactly one top-level strict semver", () => {
	const invalidManifests = [
		"{}\n",
		'{"version":"v0.3.0"}\n',
		'{"version":"01.2.3"}\n',
		'{"version":"1.2"}\n',
		'{"version":"1.2.3-01"}\n',
		'{"version":"1.2.3+"}\n',
		'{"version":"1.2.3+build+again"}\n',
		'{"version":"0.3.0","version":"0.3.1"}\n',
		'{"nested":{"version":"0.3.0"}}\n',
		'{"version":"0.3.0"\n',
	]
	for (const manifest of invalidManifests) {
		const fixture = installedPlugin()
		writeFileSync(join(fixture.pluginRoot, ".claude-plugin", "plugin.json"), manifest)
		const result = runHook(
			fixture.handler,
			"SessionStart",
			"claude",
			'{"source":"startup"}',
		)
		expect(result.exitCode).toBe(0)
		expect(result.stdout.toString()).toBe("")
		expect(result.stderr.toString()).toBe(warning)
	}

	const valid = installedPlugin()
	writeFileSync(
		join(valid.pluginRoot, ".codex-plugin", "plugin.json"),
		'{"version":"1.2.3-rc.1+build.7"}\n',
	)
	const result = runHook(
		valid.handler,
		"SessionStart",
		"codex",
		'{"source":"resume"}',
	)
	expect(result.stderr.toString()).toBe("")
	expect(JSON.parse(result.stdout.toString())).toMatchObject({
		hookSpecificOutput: {
			additionalContext:
				"Harness Plugin Prototype v1.2.3-rc.1+build.7 | codex | SessionStart:resume",
		},
	})
})

test("missing or unreadable proof files and unavailable comparison fail open", () => {
	const missing = installedPlugin()
	rmSync(
		join(missing.pluginRoot, "hooks", "fixture", "lifecycle-mechanics-proof.source.json"),
	)

	const runningAsRoot = process.getuid?.() === 0
	const unreadable = runningAsRoot ? undefined : installedPlugin()
	if (unreadable) {
		chmodSync(
			join(
				unreadable.pluginRoot,
				"hooks",
				"fixture",
				"lifecycle-mechanics-proof.generated.json",
			),
			0o000,
		)
	}

	const noComparison = installedPlugin()
	const systemPath = mkdtempSync(join(tmpdir(), "native-capability-system-path-"))
	temporaryRoots.push(systemPath)
	for (const tool of ["awk", "dd", "mktemp", "rm", "wc"]) {
		const path = Bun.which(tool)
		if (!path) throw new Error(`required test tool unavailable: ${tool}`)
		symlinkSync(path, join(systemPath, tool))
	}
	writeFileSync(
		noComparison.handler,
		readFileSync(noComparison.handler, "utf8").replace(
			"PATH=/usr/bin:/bin",
			`PATH=${systemPath}`,
		),
	)

	for (const client of ["claude", "codex"] as const) {
		for (const fixture of [missing, ...(unreadable ? [unreadable] : []), noComparison]) {
			expectFailsOpen(
				runHook(
					fixture.handler,
					"Stop",
					client,
					'{"stop_hook_active":false}',
				),
			)
		}
	}
})

test("hostile cwd and PATH cannot execute workspace or user-selected tools or mutate files", () => {
	const fixture = installedPlugin()
	const hostileRoot = mkdtempSync(join(tmpdir(), "native-capability-hostile-"))
	temporaryRoots.push(hostileRoot)
	const hostileBin = join(hostileRoot, "bin")
	mkdirSync(hostileBin)
	const marker = join(hostileRoot, "unexpected-execution")
	for (const tool of [
		"awk",
		"bun",
		"cmp",
		"curl",
		"dd",
		"git",
		"jq",
		"mktemp",
		"node",
		"npm",
		"python",
		"python3",
		"rm",
		"sh",
		"wc",
		"wget",
	]) {
		const executable = join(hostileBin, tool)
		writeFileSync(executable, `#!/bin/sh\nprintf touched >'${marker}'\nexit 97\n`)
		chmodSync(executable, 0o755)
	}
	writeFileSync(
		join(hostileRoot, "package.json"),
		'{"scripts":{"stop":"touch unexpected-workspace-script"}}\n',
	)
	writeFileSync(join(hostileRoot, "stop_hook_active"), "workspace decoy\n")
	const pluginBefore = treeSnapshot(fixture.pluginRoot)
	const workspaceBefore = treeSnapshot(hostileRoot)

	const result = runHook(
		fixture.handler,
		"Stop",
		"codex",
		'{"stop_hook_active":false}',
		{
			cwd: hostileRoot,
			env: {
				PATH: hostileBin,
				SECRET_VALUE: "must-not-appear",
				TMPDIR: join(hostileRoot, "user-selected-temp"),
			},
		},
	)

	expect(result.exitCode).toBe(0)
	expect(result.stdout.toString()).toBe("")
	expect(result.stderr.toString()).toBe("")
	expect(existsSync(marker)).toBe(false)
	expect(treeSnapshot(fixture.pluginRoot)).toEqual(pluginBefore)
	expect(treeSnapshot(hostileRoot)).toEqual(workspaceBefore)
})

test("generation owns one deterministic LF fixture projection", () => {
	const temporaryRepositoryParent = mkdtempSync(
		join(tmpdir(), "native-capability-generation-"),
	)
	temporaryRoots.push(temporaryRepositoryParent)
	const temporaryRepository = join(temporaryRepositoryParent, "repository")
	cpSync(root, temporaryRepository, { recursive: true })
	const sourcePath = join(
		temporaryRepository,
		"plugin",
		"hooks",
		"fixture",
		"lifecycle-mechanics-proof.source.json",
	)
	const projectionPath = join(
		temporaryRepository,
		"plugin",
		"hooks",
		"fixture",
		"lifecycle-mechanics-proof.generated.json",
	)
	const expected =
		'{\n  "schemaVersion": 1,\n  "purpose": "Harness Plugin Prototype lifecycle mechanics proof"\n}\n'
	expect(readFileSync(sourcePath, "utf8")).toBe(expected)
	expect(readFileSync(projectionPath, "utf8")).toBe(expected)
	expect(runGenerateCheck(temporaryRepository).exitCode).toBe(0)

	writeFileSync(projectionPath, "drifted\r\n")
	const drift = runGenerateCheck(temporaryRepository)
	expect(drift.exitCode).toBe(1)
	expect(drift.stderr.toString()).toContain(
		"plugin/hooks/fixture/lifecycle-mechanics-proof.generated.json",
	)

	writeFileSync(projectionPath, expected)
	writeFileSync(sourcePath, expected.replaceAll("\n", "\r\n"))
	const nonCanonicalSource = runGenerateCheck(temporaryRepository)
	expect(nonCanonicalSource.exitCode).toBe(1)
	expect(nonCanonicalSource.stderr.toString()).toContain(
		"plugin/hooks/fixture/lifecycle-mechanics-proof.source.json",
	)
})
