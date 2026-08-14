import { describe, expect, test } from "bun:test"

import {
	HARNESS_IDENTITIES,
	QUALIFICATION_CLIENT_HARNESSES,
	type HarnessId,
	type QualificationClient,
} from "./harness-identity"

describe("harness identities", () => {
	test("preserve canonical paths, environment variables, and display names", () => {
		const expected = {
			claude: {
				hooksDeclarationPath: "./hooks/claude/hooks.json",
				manifestDirectory: ".claude-plugin",
				pluginRootEnvVar: "CLAUDE_PLUGIN_ROOT",
				displayName: "Claude",
			},
			codex: {
				hooksDeclarationPath: "./hooks/codex/hooks.json",
				manifestDirectory: ".codex-plugin",
				pluginRootEnvVar: "PLUGIN_ROOT",
				displayName: "Codex",
			},
		} as const satisfies Record<HarnessId, (typeof HARNESS_IDENTITIES)[HarnessId]>

		expect(HARNESS_IDENTITIES).toEqual(expected)
		expect(Object.keys(HARNESS_IDENTITIES).sort()).toEqual(["claude", "codex"])
		expect(HARNESS_IDENTITIES.codex.pluginRootEnvVar).not.toBe("CODEX_PLUGIN_ROOT")
	})
})

describe("qualification clients", () => {
	test("map every client to its canonical harness", () => {
		const expected = {
			"claude-cli": "claude",
			"codex-cli": "codex",
			"codex-desktop": "codex",
		} as const satisfies Record<QualificationClient, HarnessId>

		expect(QUALIFICATION_CLIENT_HARNESSES).toEqual(expected)
		expect(Object.keys(QUALIFICATION_CLIENT_HARNESSES).sort()).toEqual([
			"claude-cli",
			"codex-cli",
			"codex-desktop",
		])
	})
})
