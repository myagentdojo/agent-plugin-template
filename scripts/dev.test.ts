import { expect, test } from "bun:test"

import { claudeWatchSources } from "./dev"

test("Claude development watches workspace, runtime, manifest, and lock inputs", () => {
	expect(claudeWatchSources).toEqual([
		{ relativePath: "runtime", recursive: true },
		{ relativePath: "packages", recursive: true },
		{ relativePath: "plugin/skills", recursive: true },
		{ relativePath: "plugin/hooks", recursive: true },
		{ relativePath: "plugin/assets", recursive: true },
		{ relativePath: "plugin/.claude-plugin", recursive: true },
		{ relativePath: "plugin/.codex-plugin", recursive: true },
		{ relativePath: "package.json", recursive: false },
		{ relativePath: "bun.lock", recursive: false },
		{ relativePath: "bunfig.toml", recursive: false },
		{ relativePath: "plugin.config.json", recursive: false },
	])
})
