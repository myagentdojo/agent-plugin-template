import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, test } from "bun:test"

import { assertCodexReportedVersion, proveCodexNative } from "./harness-install-codex"
import type { CodexInstallState, FixtureRelease } from "./prove-harness-install"

const temporaryRoots: string[] = []

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test("Codex hosted install rejects either stale reported version surface", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-hosted-version-"))
	temporaryRoots.push(root)
	for (const [addVersion, listedVersion] of [
		["0.1.0", "0.2.0"],
		["0.2.0", "0.1.0"],
	] as const) {
		expect(() =>
			assertCodexReportedVersion(
				installedState(root, addVersion, listedVersion, "hosted"),
				"0.2.0",
				"hosted install",
			),
		).toThrow("Codex hosted install reported the wrong tagged manifest version")
	}
})

function installedState(
	root: string,
	addVersion: string,
	listedVersion: string,
	runtime: string,
): CodexInstallState {
	const installedPath = join(root, `${addVersion}-${listedVersion}-${runtime}`)
	mkdirSync(join(installedPath, "runtime"), { recursive: true })
	mkdirSync(join(installedPath, ".codex-plugin"), { recursive: true })
	writeFileSync(join(installedPath, "runtime", "hello-world.js"), runtime)
	writeFileSync(
		join(installedPath, ".codex-plugin", "plugin.json"),
		JSON.stringify({
			name: "plugin",
			version: listedVersion,
			hooks: "./hooks/codex/hooks.json",
		}),
	)
	return {
		marketplaceAdd: { marketplaceName: "plugin", installedRoot: root, alreadyAdded: false },
		add: {
			pluginId: "plugin@plugin",
			name: "plugin",
			marketplaceName: "plugin",
			version: addVersion,
			installedPath,
			authPolicy: "ON_INSTALL",
		},
		marketplace: {
			marketplaces: [
				{
					name: "plugin",
					root,
					marketplaceSource: { sourceType: "local", source: root },
				},
			],
		},
		list: { installed: [], available: [] },
		plugin: {
			pluginId: "plugin@plugin",
			name: "plugin",
			marketplaceName: "plugin",
			version: listedVersion,
			installed: true,
			enabled: true,
			source: { source: "local", path: root },
			marketplaceSource: { sourceType: "local", source: root },
			installPolicy: "AVAILABLE",
			authPolicy: "ON_INSTALL",
		},
	}
}

test.each([
	{ phase: "install", installIndex: 0, expected: "0.1.0", stale: "0.2.0" },
	{ phase: "upgrade", installIndex: 1, expected: "0.2.0", stale: "0.1.0" },
	{ phase: "rollback", installIndex: 2, expected: "0.1.0", stale: "0.2.0" },
	{ phase: "interrupted-state restoration", installIndex: 3, expected: "0.1.0", stale: "0.2.0" },
] as const)("Codex $phase rejects stale add and list versions", ({ phase, installIndex, expected, stale }) => {
	const root = mkdtempSync(join(tmpdir(), "codex-upgrade-version-"))
	temporaryRoots.push(root)
	const fixture: FixtureRelease = {
		repositoryRoot: root,
		base: {
			requestedRef: "v0.1.0",
			resolvedSha: "1".repeat(40),
			checkoutRoot: join(root, "base"),
			manifestVersion: "0.1.0",
			inventory: [],
		},
		target: {
			requestedRef: "v0.2.0",
			resolvedSha: "2".repeat(40),
			checkoutRoot: join(root, "target"),
			manifestVersion: "0.2.0",
			inventory: [],
		},
	}
	const validInstalls = [
		installedState(root, "0.1.0", "0.1.0", "base"),
		installedState(root, "0.2.0", "0.2.0", "target"),
		installedState(root, "0.1.0", "0.1.0", "base"),
		installedState(root, "0.1.0", "0.1.0", "base"),
	]
	for (const surface of ["add", "list"] as const) {
		const installs = validInstalls.map((state, index) =>
			index !== installIndex
				? state
				: installedState(
						root,
						surface === "add" ? stale : expected,
						surface === "list" ? stale : expected,
						installIndex === 1 ? "target" : "base",
					),
		)
		expect(() =>
			proveCodexNative(fixture, "plugin", "codex", root, {
				install: () => installs.shift() as CodexInstallState,
				remove: () => {},
				comparePayload: () => [],
				environment: () => ({}),
				assertReplacementAdmission: () => undefined,
			}),
		).toThrow(`Codex ${phase} reported the wrong tagged manifest version`)
	}
})

function fixtureRelease(root: string): FixtureRelease {
	return {
		repositoryRoot: root,
		base: {
			requestedRef: "v0.1.0",
			resolvedSha: "1".repeat(40),
			checkoutRoot: join(root, "base"),
			manifestVersion: "0.1.0",
			inventory: [],
		},
		target: {
			requestedRef: "v0.2.0",
			resolvedSha: "2".repeat(40),
			checkoutRoot: join(root, "target"),
			manifestVersion: "0.2.0",
			inventory: [],
		},
	}
}

test("Codex recovery injects a post-removal failure and restores exact prior state", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-recovery-"))
	temporaryRoots.push(root)
	const installs = [
		installedState(root, "0.1.0", "0.1.0", "base"),
		installedState(root, "0.2.0", "0.2.0", "target"),
		installedState(root, "0.1.0", "0.1.0", "base"),
		installedState(root, "0.1.0", "0.1.0", "base"),
	]
	let removals = 0
	const proof = proveCodexNative(fixtureRelease(root), "plugin", "codex", root, {
		install: () => installs.shift() as CodexInstallState,
		remove: () => {
			removals += 1
		},
		comparePayload: () => [],
		environment: () => ({}),
		assertReplacementAdmission: () => undefined,
	})

	expect(removals).toBe(3)
	expect(installs).toHaveLength(0)
	expect(proof.localRefresh.failureRestored).toBe(true)
	expect(proof.configuredRef).toBe("v0.1.0")
})

test("Codex recovery rejects a restored marketplace source that differs from prior state", () => {
	const root = mkdtempSync(join(tmpdir(), "codex-recovery-source-"))
	temporaryRoots.push(root)
	const restored = installedState(root, "0.1.0", "0.1.0", "base")
	restored.plugin.marketplaceSource.source = "/wrong/source"
	const installs = [
		installedState(root, "0.1.0", "0.1.0", "base"),
		installedState(root, "0.2.0", "0.2.0", "target"),
		installedState(root, "0.1.0", "0.1.0", "base"),
		restored,
	]

	expect(() =>
		proveCodexNative(fixtureRelease(root), "plugin", "codex", root, {
			install: () => installs.shift() as CodexInstallState,
			remove: () => {},
			comparePayload: () => [],
			environment: () => ({}),
			assertReplacementAdmission: () => undefined,
		}),
	).toThrow("Codex recovery did not restore prior source")
})
