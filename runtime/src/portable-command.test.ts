import { expect, test } from "bun:test"

import config from "../../plugin.config.json"

Object.assign(globalThis, { PLUGIN_VERSION: config.version })

const { executeCommand } = await import("./portable-command")

test("hook help requires plugin version for Codex only", () => {
	const result = executeCommand(["--help"], "", "help")

	expect(result.exitCode).toBe(0)
	expect(result.stdout).toContain(
		"hello-world hook --harness codex --event <event> --plugin-version <version>",
	)
	expect(result.stdout).toContain("hello-world hook --harness claude --event <event>")
	expect(result.stdout).toContain("Required for Codex hooks only.")
})

test("Codex hooks bind the generated command to the runtime plugin version", () => {
	const missing = executeCommand(
		["hook", "--harness", "codex", "--event", "SessionStart"],
		"{}",
		"missing-version",
	)
	const mismatch = executeCommand(
		[
			"hook",
			"--harness",
			"codex",
			"--event",
			"SessionStart",
			"--plugin-version",
			"9.9.9",
		],
		"{}",
		"wrong-version",
	)
	const matching = executeCommand(
		[
			"hook",
			"--harness",
			"codex",
			"--event",
			"SessionStart",
			"--plugin-version",
			config.version,
		],
		"{}",
		"matching-version",
	)

	expect(missing).toMatchObject({ exitCode: 2 })
	expect(missing.stderr).toContain("--plugin-version is required for codex hooks")
	expect(mismatch).toMatchObject({ exitCode: 2 })
	expect(mismatch.stderr).toContain(`--plugin-version must be ${config.version}`)
	expect(matching).toMatchObject({ exitCode: 0 })
})

test("Claude hooks remain versionless because Claude supplies no manifest version argument", () => {
	const result = executeCommand(
		["hook", "--harness", "claude", "--event", "SessionStart"],
		"{}",
		"claude-hook",
	)

	expect(result).toMatchObject({ exitCode: 0 })
})

test("hello JSON identifies the installed plugin version", () => {
	const result = executeCommand(["hello", "--json"], "", "version-proof")

	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout)).toMatchObject({
		ok: true,
		command: "hello",
		pluginVersion: config.version,
		runId: "version-proof",
	})
})
