import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
	appendFileSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { writeBuildReceipt } from "./build-receipt"
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
 * One checkout with a Development Installation whose links resolve to its own
 * payload, so `check` reaches the healthy branch and reports freshness.
 */
function linkedCheckout(): { checkout: string; profile: string; runner: CommandRunner } {
	const checkout = mkdtempSync(join(tmpdir(), "freshness-checkout-"))
	created.push(checkout)
	cpSync(join(import.meta.dir, "..", "plugin"), join(checkout, "plugin"), { recursive: true })
	cpSync(join(import.meta.dir, "..", "plugin.config.json"), join(checkout, "plugin.config.json"))

	const profile = mkdtempSync(join(tmpdir(), "freshness-profile-"))
	created.push(profile)
	const cache = join(
		profile,
		"plugins",
		"cache",
		`${pluginName}-dev`,
		pluginName,
		"0.1.2-linked",
	)
	mkdirSync(cache, { recursive: true })
	for (const entry of ["skills", "hooks", "assets", "runtime", "bin"]) {
		symlinkSync(join(checkout, "plugin", entry), join(cache, entry))
	}
	for (const entry of [".claude-plugin", ".codex-plugin", "THIRD-PARTY-NOTICES.md"]) {
		symlinkSync(join(checkout, "plugin", entry), join(cache, entry))
	}

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
			path: join(checkout, ".dev", "claude", "marketplace"),
		},
	]
	// An installation linked to this checkout must hold the snapshot that can
	// restore the profile, so `check` fails closed without one.
	const profileKey = createHash("sha256").update(resolve(profile)).digest("hex").slice(0, 16)
	const snapshot = join(checkout, ".dev", "claude", "restore-state", `${profileKey}.json`)
	mkdirSync(join(checkout, ".dev", "claude", "restore-state"), { recursive: true })
	writeFileSync(
		snapshot,
		JSON.stringify({
			schemaVersion: 1,
			profileRoot: resolve(profile),
			repositoryRoot: realpathSync(checkout),
			pluginName,
			prior: {},
			transactionState: "development_installed",
			sideEffects: [],
		}),
	)

	return {
		checkout,
		profile,
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

function check(checkout: string, profile: string, runner: CommandRunner) {
	return runClaudeDevelopmentInstallation({
		operation: "check",
		apply: false,
		repositoryRoot: checkout,
		environment: { CLAUDE_CONFIG_DIR: profile, HOME: profile, PATH: process.env.PATH },
		runner,
	})
}

test("check reports a payload edited since the last build as stale", async () => {
	const { checkout, profile, runner } = linkedCheckout()
	writeBuildReceipt(checkout, "succeeded")
	appendFileSync(join(checkout, "plugin", "THIRD-PARTY-NOTICES.md"), "\nedited after the build\n")

	const result = await check(checkout, profile, runner)

	expect(result.current.freshness.status).toBe("stale")
	expect(result.nextAction).toContain("/reload-plugins")
})

test("check reports a matching payload as fresh", async () => {
	const { checkout, profile, runner } = linkedCheckout()
	writeBuildReceipt(checkout, "succeeded")

	const result = await check(checkout, profile, runner)

	expect(result.current.freshness.status).toBe("fresh")
})

test("check reports a failed build rather than reporting the profile ready", async () => {
	const { checkout, profile, runner } = linkedCheckout()
	writeBuildReceipt(checkout, "failed", "bundler-failure")

	const result = await check(checkout, profile, runner)

	expect(result.current.freshness.status).toBe("build-failed")
	expect(result.nextAction).toContain("bundler-failure")
	// Reloading serves known-bad bytes, so the failure must be fixed first.
	expect(result.nextAction).not.toContain("/reload-plugins")
})

test("check reports a missing receipt as unproven rather than ready", async () => {
	const { checkout, profile, runner } = linkedCheckout()

	const result = await check(checkout, profile, runner)

	expect(result.current.freshness.status).toBe("unproven")
	expect(result.nextAction).toContain("build")
})

/**
 * Acceptance 5. Freshness is additive, so a consumer reading only the fields
 * that existed before this contract change still finds every one of them.
 */
test("the existing check contract still validates", async () => {
	const { checkout, profile, runner } = linkedCheckout()
	writeBuildReceipt(checkout, "succeeded")

	const result = await check(checkout, profile, runner)

	expect(result.schemaVersion).toBe(1)
	expect(result.contractId).toBe("plugin.development-installation")
	expect(result.ok).toBe(true)
	expect(result.current.production).toBeDefined()
	expect(result.current.development).toBe("installed")
	expect(result.current.singleSource).toBe(true)
	expect(result.current.linkedToCanonicalPayload).toBe(true)
	expect(typeof result.nextAction).toBe("string")
})

/**
 * `install` re-inspects the profile after enabling the plugin, and that second
 * inspection reads the profile rather than the receipt. Letting the result
 * re-evaluate freshness there compared the payload against the receipt the same
 * run had just written, so it reported `fresh` beside a `nextAction` describing
 * the state before the build.
 *
 * The two must describe one state. A reader that trusts the status over the
 * guidance beside it is the masking this feature exists to end.
 */
test("install reports one freshness state in both the status and its guidance", async () => {
	const { checkout, profile, runner } = linkedCheckout()
	writeBuildReceipt(checkout, "failed", "bundler-failure")
	// The re-enable branch needs a disabled installation and `--apply`; the
	// plugin reports enabled only after the enable command runs.
	let enabled = false
	const reEnabling: CommandRunner = {
		run(commandArguments: readonly string[]) {
			const line = commandArguments.join(" ")
			if (line.includes("plugin enable")) {
				enabled = true
				return { exitCode: 0, stdout: "", stderr: "" }
			}
			// `prepare` shells out to the build, and a real build rewrites the
			// receipt. Without that the pre-build and post-build reads return
			// the same value and the divergence cannot appear.
			if (line.includes("bun run build")) {
				writeBuildReceipt(checkout, "succeeded")
				return { exitCode: 0, stdout: "", stderr: "" }
			}
			const response = runner.run(commandArguments)
			if (!line.includes("plugin list")) return response
			const plugins = JSON.parse(response.stdout) as { enabled: boolean }[]
			for (const plugin of plugins) plugin.enabled = enabled
			return { ...response, stdout: JSON.stringify(plugins) }
		},
	}

	const result = await runClaudeDevelopmentInstallation({
		operation: "install",
		apply: true,
		repositoryRoot: checkout,
		environment: { CLAUDE_CONFIG_DIR: profile, HOME: profile, PATH: process.env.PATH },
		runner: reEnabling,
	})

	expect(result.current.freshness.status).toBe("build-failed")
	expect(result.nextAction).toContain("bundler-failure")
})
