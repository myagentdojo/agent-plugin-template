import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { bunCommandRunner } from "./command-runner"

test("Bun command adapter → preserves working directory, environment, stdin, and raw output", () => {
	const workingRoot = mkdtempSync(join(tmpdir(), "command-runner-"))
	try {
		const result = bunCommandRunner.run(
			[
				process.execPath,
				"-e",
				"process.stdout.write(JSON.stringify({ cwd: process.cwd(), marker: process.env.RUNNER_MARKER, input: await Bun.stdin.text() }) + '  ')",
			],
			{
				workingDirectory: workingRoot,
				environment: { ...process.env, RUNNER_MARKER: "visible" },
				input: "typed input",
				trimOutput: false,
			},
		)

		expect(result.exitCode, result.stderr).toBe(0)
		expect(result.stdout.endsWith("  ")).toBe(true)
		expect(JSON.parse(result.stdout.trim())).toEqual({
			cwd: realpathSync(workingRoot),
			marker: "visible",
			input: "typed input",
		})
	} finally {
		rmSync(workingRoot, { recursive: true, force: true })
	}
})

test("Bun command adapter → gives a timed-out child a stable exit code", () => {
	const result = bunCommandRunner.run(
		[process.execPath, "-e", "await Bun.sleep(1000)"],
		{ timeout: 10 },
	)

	expect(result.exitCode).toBe(124)
})

test("Bun command adapter → timeout wins when the child handles SIGTERM", () => {
	const result = bunCommandRunner.run(
		[
			process.execPath,
			"-e",
			'process.on("SIGTERM", () => process.exit(0)); await Bun.sleep(1000)',
		],
		{ timeout: 50 },
	)

	expect(result.exitCode).toBe(124)
})

test("Bun command adapter → distinguishes signal termination from timeout", () => {
	const result = bunCommandRunner.run(["sh", "-c", "kill -TERM $$"])

	expect(result.exitCode).toBe(143)
})
