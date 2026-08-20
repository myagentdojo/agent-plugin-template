import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
