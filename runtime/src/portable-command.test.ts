import { expect, test } from "bun:test"

const { executeCommand } = await import("./portable-command")

test("help exposes only the portable command surface", () => {
	const result = executeCommand(["--help"], "help")

	expect(result.exitCode).toBe(0)
	expect(result.stdout).toContain("hello-world hello [--name <name>] [--json]")
	expect(result.stdout).not.toContain("hook")
})

test("runtime lifecycle hook commands are not active", () => {
	const result = executeCommand(["hook"], "no-hooks")
	expect(result).toMatchObject({ exitCode: 2 })
	expect(result.stderr).toContain("unknown command: hook")
})

test("hello JSON reports the portable result without a release-version literal", () => {
	const result = executeCommand(["hello", "--json"], "version-proof")

	expect(result.exitCode).toBe(0)
	expect(JSON.parse(result.stdout)).toMatchObject({
		ok: true,
		command: "hello",
		runId: "version-proof",
	})
})
