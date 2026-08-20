import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runClaudeDevelopmentInstallation } from "./claude-development-installation"
import type { CommandRunner } from "./command-runner"
import { loadPluginConfig } from "./plugin-config"

const repositoryRoot = join(import.meta.dir, "..")
const pluginName = loadPluginConfig(repositoryRoot).name
const created: string[] = []

afterEach(() => {
	for (const directory of created.splice(0)) rmSync(directory, { force: true, recursive: true })
})

/**
 * The restoration snapshot lives inside the checkout that captured it, so a
 * second checkout never holds one for an installation it did not create.
 * `check` there must report the mismatch it can see rather than refusing for
 * want of a snapshot that was never its to hold.
 *
 * An installation linked to *this* checkout keeps the opposite contract: a
 * missing snapshot means its production state cannot be restored, and
 * `dev.test.ts` pins that as a fail-closed case.
 */
function profileLinkedToAnotherCheckout(): { root: string; runner: CommandRunner } {
	const root = mkdtempSync(join(tmpdir(), "no-snapshot-"))
	created.push(root)
	const cache = join(
		root,
		"plugins",
		"cache",
		`${pluginName}-dev`,
		pluginName,
		"0.1.2-fake",
	)
	mkdirSync(cache, { recursive: true })
	// Links resolve to a payload this checkout does not own, which is the shape
	// a second checkout sees.
	const foreignPayload = join(root, "other-checkout", "plugin")
	mkdirSync(join(foreignPayload, "skills"), { recursive: true })
	symlinkSync(join(foreignPayload, "skills"), join(cache, "skills"))
	const plugins = [
		{
			id: `${pluginName}@${pluginName}-dev`,
			version: "0.1.2",
			scope: "user",
			enabled: true,
			installPath: cache,
		},
	]
	const marketplaces = [
		{
			name: `${pluginName}-dev`,
			source: "directory",
			path: join(repositoryRoot, ".dev", "claude", "marketplace"),
		},
	]
	return {
		root,
		runner: {
			run(commandArguments: readonly string[]) {
				const line = commandArguments.join(" ")
				if (line.includes("--version")) return { exitCode: 0, stdout: "2.1.233", stderr: "" }
				if (line.includes("marketplace list"))
					return { exitCode: 0, stdout: JSON.stringify(marketplaces), stderr: "" }
				if (line.includes("plugin list"))
					return { exitCode: 0, stdout: JSON.stringify(plugins), stderr: "" }
				return { exitCode: 0, stdout: "[]", stderr: "" }
			},
		},
	}
}

test("check names the link mismatch rather than a snapshot it never held", async () => {
	const { root, runner } = profileLinkedToAnotherCheckout()

	const run = runClaudeDevelopmentInstallation({
		operation: "check",
		apply: false,
		repositoryRoot,
		environment: { CLAUDE_CONFIG_DIR: root, HOME: root, PATH: process.env.PATH },
		runner,
	})

	await expect(run).rejects.toMatchObject({ code: "DEVELOPMENT_LINK_MISMATCH" })
})
