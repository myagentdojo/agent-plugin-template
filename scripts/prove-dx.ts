import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { pluginPayloadInventory } from "./plugin-files"

const root = resolve(import.meta.dir, "..")
pluginPayloadInventory(root)

function dryRun(harness: "claude" | "codex"): Record<string, string> {
	const result = Bun.spawnSync({
		cmd: ["bun", "run", "scripts/dev.ts", harness, "--dry-run", "--json"],
		cwd: root,
		stdout: "pipe",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
	return JSON.parse(result.stdout.toString())
}

const claude = dryRun("claude")
const codex = dryRun("codex")

if (
	!claude.install.includes("--plugin-dir") ||
	!claude.install.includes("--settings") ||
	!claude.reload.includes("/reload-plugins")
) {
	throw new Error("Claude plan does not use the native source-load and reload boundary")
}
if (!codex.install.includes("plugin add") || !codex.reload.includes("fresh Codex task")) {
	throw new Error("Codex plan does not use the native cached-install and fresh-task boundary")
}

const claudeManifest = JSON.parse(
	readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
)
const codexManifest = JSON.parse(
	readFileSync(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
)
if (claudeManifest.version !== codexManifest.version) {
	throw new Error("native manifest versions do not match")
}
if (claudeManifest.hooks !== undefined || codexManifest.hooks !== undefined) {
	throw new Error("runtime lifecycle hooks must not be active in native manifests")
}
if (existsSync(join(root, "plugin", "hooks"))) {
	throw new Error("plugin payload must not carry runtime lifecycle hook definitions")
}

for (const marketplacePath of [
	join(root, ".agents", "plugins", "marketplace.json"),
	join(root, ".claude-plugin", "marketplace.json"),
]) {
	const marketplace = readFileSync(marketplacePath, "utf8")
	if (!marketplace.includes("./plugin")) {
		throw new Error(`${marketplacePath} does not point at the canonical plugin subtree`)
	}
}

const mainWorkflow = readFileSync(join(root, ".github", "workflows", "plugin-ci.yml"), "utf8")
for (const required of [
	"push:",
	"main",
	"bun run prove:distribution",
	"git diff --exit-code -- plugin/",
]) {
	if (!mainWorkflow.includes(required)) throw new Error(`main workflow is missing ${required}`)
}

console.log(
	JSON.stringify({
		ok: true,
		development: {
			claude: "canonical plugin/ + Bun watcher + /reload-plugins",
			codex: "full staged copy + cachebuster + reinstall + fresh task",
		},
		production: "release PR + proof + tag + GitHub Release + harness update",
		boundaries: [
			"one canonical installable plugin/ subtree",
			"no symlinks",
			"no npm publication",
			"Claude live reload is explicit",
			"Codex reload means a fresh task",
		],
	}),
)
