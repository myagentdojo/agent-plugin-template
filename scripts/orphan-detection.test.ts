import { afterEach, expect, test } from "bun:test"
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	ClaudeDevelopmentInstallationError,
	runClaudeDevelopmentInstallation,
} from "./claude-development-installation"
import type { CommandRunner } from "./command-runner"
import { loadPluginConfig } from "./plugin-config"

const repositoryRoot = join(import.meta.dir, "..")
const pluginName = loadPluginConfig(repositoryRoot).name

const created: string[] = []
const restoreReadable: string[] = []

afterEach(() => {
	// A test that locks a directory to prove the unverifiable path would
	// otherwise leave a tree rmSync cannot descend into.
	for (const directory of restoreReadable.splice(0)) chmodSync(directory, 0o700)
	for (const directory of created.splice(0)) {
		rmSync(directory, { force: true, recursive: true })
	}
})

function profileRoot(): string {
	const profile = mkdtempSync(join(tmpdir(), "orphan-profile-"))
	created.push(profile)
	return profile
}

function versionDirectory(profile: string): string {
	const version = join(
		profile,
		"plugins",
		"cache",
		`${pluginName}-dev`,
		pluginName,
		"0.1.2-fake",
	)
	mkdirSync(version, { recursive: true })
	return version
}

function unlistedClaudeRunner(): CommandRunner {
	return {
		run(commandArguments: readonly string[]) {
			if (commandArguments.join(" ").includes("--version")) {
				return { exitCode: 0, stdout: "2.1.233", stderr: "" }
			}
			return { exitCode: 0, stdout: "[]", stderr: "" }
		},
	}
}

async function check(profile: string) {
	return runClaudeDevelopmentInstallation({
		operation: "check",
		apply: false,
		repositoryRoot,
		environment: { CLAUDE_CONFIG_DIR: profile, HOME: profile, PATH: process.env.PATH },
		runner: unlistedClaudeRunner(),
	})
}

async function codeFrom(operation: "check" | "install", profile: string): Promise<string> {
	try {
		await runClaudeDevelopmentInstallation({
			operation,
			apply: false,
			repositoryRoot,
			environment: { CLAUDE_CONFIG_DIR: profile, HOME: profile, PATH: process.env.PATH },
			runner: unlistedClaudeRunner(),
		})
	} catch (error) {
		if (error instanceof ClaudeDevelopmentInstallationError) return error.code
		throw error
	}
	return "NO_ERROR"
}

test("check names an unlisted cache whose links dangle", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	for (const entry of ["skills", "runtime"]) {
		symlinkSync(join("/nonexistent-removed-worktree/plugin", entry), join(version, entry))
	}

	await expect(check(profile)).rejects.toMatchObject({
		code: "DEVELOPMENT_CACHE_ORPHANED",
		action: "FIX_INPUT",
	})
})

test("check names an unlisted cache whose links still resolve", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	const livePayload = join(profile, "live-payload")
	mkdirSync(livePayload, { recursive: true })
	symlinkSync(livePayload, join(version, "skills"))
	writeFileSync(
		join(version, ".claude-plugin-link"),
		JSON.stringify({ target: "/some/other/checkout/plugin" }),
	)

	await expect(check(profile)).rejects.toMatchObject({ code: "DEVELOPMENT_CACHE_ORPHANED" })
})

test("check names an unlisted cache holding no links at all", async () => {
	const profile = profileRoot()
	versionDirectory(profile)

	await expect(check(profile)).rejects.toMatchObject({ code: "DEVELOPMENT_CACHE_ORPHANED" })
})

test("check separates a cache it could not read from one proven clean", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	restoreReadable.push(version)
	chmodSync(version, 0o000)

	await expect(check(profile)).rejects.toMatchObject({
		code: "DEVELOPMENT_CACHE_UNVERIFIABLE",
		action: "INSPECT_STATE",
		retrySafety: "inspect_required",
	})
})

test("install refuses the same orphaned cache check refuses", async () => {
	const profile = profileRoot()
	versionDirectory(profile)

	expect(await codeFrom("install", profile)).toBe("DEVELOPMENT_CACHE_ORPHANED")
})

test("check tolerates the residue restore leaves with --keep-data", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	const payload = join(repositoryRoot, "plugin")
	symlinkSync(join(payload, "skills"), join(version, "skills"))
	writeFileSync(join(version, ".claude-plugin-link"), JSON.stringify({ target: payload }))
	writeFileSync(join(version, ".orphaned_at"), new Date(0).toISOString())

	const result = await check(profile)

	expect(result.transactionState).toBe("ready")
	expect(result.current.development).toBe("absent")
})

test("install reclaims the residue restore leaves rather than locking itself out", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	const payload = join(repositoryRoot, "plugin")
	symlinkSync(join(payload, "skills"), join(version, "skills"))
	writeFileSync(join(version, ".claude-plugin-link"), JSON.stringify({ target: payload }))

	expect(await codeFrom("install", profile)).toBe("NO_ERROR")
})

test("a cache whose marker names another checkout stays an orphan", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	const foreignPayload = join(profile, "other-checkout", "plugin")
	mkdirSync(foreignPayload, { recursive: true })
	symlinkSync(foreignPayload, join(version, "skills"))
	writeFileSync(join(version, ".claude-plugin-link"), JSON.stringify({ target: foreignPayload }))

	await expect(check(profile)).rejects.toMatchObject({ code: "DEVELOPMENT_CACHE_ORPHANED" })
})

test("check still names the orphan when the link marker is unreadable", async () => {
	const profile = profileRoot()
	const version = versionDirectory(profile)
	writeFileSync(join(version, ".claude-plugin-link"), "{ not json")

	await expect(check(profile)).rejects.toMatchObject({ code: "DEVELOPMENT_CACHE_ORPHANED" })
})

test("check stays ready when the profile holds no development cache", async () => {
	const profile = profileRoot()

	const result = await check(profile)

	expect(result.transactionState).toBe("ready")
	expect(result.current.development).toBe("absent")
})

test("a failing command reports its first output line as the cause", async () => {
	const profile = profileRoot()
	const refusingRunner: CommandRunner = {
		run(commandArguments: readonly string[]) {
			if (commandArguments.join(" ").includes("--version")) {
				return { exitCode: 0, stdout: "2.1.233", stderr: "" }
			}
			return {
				exitCode: 1,
				stdout: "",
				stderr: "\n-y/--yes is ignored inside a Claude Code session\nrun it in your own terminal\n",
			}
		},
	}

	const run = runClaudeDevelopmentInstallation({
		operation: "check",
		apply: false,
		repositoryRoot,
		environment: { CLAUDE_CONFIG_DIR: profile, HOME: profile, PATH: process.env.PATH },
		runner: refusingRunner,
	})

	await expect(run).rejects.toThrow(/-y\/--yes is ignored inside a Claude Code session/)
	await expect(run).rejects.not.toThrow(/run it in your own terminal/)
})

/**
 * A version bump leaves the previous cache directory behind. Claude Code marks
 * it with `.orphaned_at` and stops listing it, so it becomes files nothing
 * reads inside the profile this lifecycle owns.
 *
 * Detection above runs only when Claude lists no installation, so the common
 * case — a superseded directory sitting beside the installed one — reported a
 * clean profile. The orphan is defined by its registration, not by its links:
 * every link in a superseded directory still resolves, because both versions
 * point at the same live payload.
 */
function installedVersionDirectory(profile: string, version: string): string {
	const directory = join(
		profile,
		"plugins",
		"cache",
		`${pluginName}-dev`,
		pluginName,
		version,
	)
	mkdirSync(directory, { recursive: true })
	// A foreign payload keeps the fixture off this checkout's restoration
	// snapshot, which lives in the checkout that captured it. The superseded
	// directory is defined by its registration, not by where its links point.
	const payload = join(profile, "other-checkout", "plugin")
	mkdirSync(join(payload, "skills"), { recursive: true })
	writeFileSync(join(directory, ".claude-plugin-link"), JSON.stringify({ target: payload }))
	symlinkSync(join(payload, "skills"), join(directory, "skills"))
	return directory
}

function listedRunner(installPath: string): CommandRunner {
	const plugins = [
		{
			id: `${pluginName}@${pluginName}-dev`,
			version: "0.2.0",
			scope: "user",
			enabled: true,
			installPath,
		},
	]
	const marketplaces = [
		{ name: `${pluginName}-dev`, source: "directory", path: join(repositoryRoot, ".dev", "claude", "marketplace") },
	]
	return {
		run(commandArguments: readonly string[]) {
			const line = commandArguments.join(" ")
			if (line.includes("--version")) return { exitCode: 0, stdout: "2.1.233", stderr: "" }
			if (line.includes("marketplace list"))
				return { exitCode: 0, stdout: JSON.stringify(marketplaces), stderr: "" }
			if (line.includes("plugin list"))
				return { exitCode: 0, stdout: JSON.stringify(plugins), stderr: "" }
			return { exitCode: 0, stdout: "[]", stderr: "" }
		},
	}
}

async function codeFromRunner(
	operation: "check" | "install",
	profile: string,
	runner: CommandRunner,
): Promise<string> {
	try {
		await runClaudeDevelopmentInstallation({
			operation,
			apply: false,
			repositoryRoot,
			environment: { CLAUDE_CONFIG_DIR: profile, HOME: profile, PATH: process.env.PATH },
			runner,
		})
	} catch (error) {
		if (error instanceof ClaudeDevelopmentInstallationError) return error.code
		throw error
	}
	return "NO_ERROR"
}

test("check names a superseded version directory beside the installed one", async () => {
	const profile = profileRoot()
	const installed = installedVersionDirectory(profile, "0.2.0-fake")
	const superseded = installedVersionDirectory(profile, "0.1.2-fake")
	// Claude Code's own marker for a cache it has stopped listing.
	writeFileSync(join(superseded, ".orphaned_at"), String(Date.now()))

	const code = await codeFromRunner("check", profile, listedRunner(installed))

	expect(code).toBe("DEVELOPMENT_CACHE_SUPERSEDED")
})

test("check stays silent when the installed version stands alone", async () => {
	const profile = profileRoot()
	const installed = installedVersionDirectory(profile, "0.2.0-fake")

	const code = await codeFromRunner("check", profile, listedRunner(installed))

	// The link points at a foreign payload, so the mismatch is the expected
	// outcome here. What matters is that no superseded directory is reported.
	expect(code).toBe("DEVELOPMENT_LINK_MISMATCH")
})
