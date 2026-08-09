import {
	mkdirSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

import { copyPluginPayload } from "./plugin-files"
import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const pluginRoot = join(root, "plugin")
const pluginConfig = loadPluginConfig(root)
const pluginName = pluginConfig.name
const productionPluginId = `${pluginName}@${pluginName}`
const claudeSessionSettings = JSON.stringify({
	enabledPlugins: { [productionPluginId]: false },
})
const developmentMarketplaceName = `${pluginName}-dev`
const developmentRoot = join(root, ".dev", "codex-marketplace")
const stagedPluginRoot = join(developmentRoot, "plugins", pluginName)

export const claudeWatchSources = [
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
] as const

const help = `Usage: bun run dev -- <command> [options]

Commands:
  claude              Build, watch, and launch Claude against this checkout
  codex               Build, stage, reinstall, and launch Codex

Options:
  --check             Build and stage only; do not change harness state
  --no-launch         Prepare the harness but do not launch it
  --dry-run           Print the plan without writes or harness commands
  --json              Emit the dry-run plan as JSON
  -h, --help          Show this help

Examples:
  bun run dev:claude
  bun run dev:codex
  bun run dev -- codex --check
  bun run dev -- claude --dry-run --json
`

type Harness = "claude" | "codex"

interface Options {
	harness: Harness
	check: boolean
	launch: boolean
	dryRun: boolean
	json: boolean
}

function fail(message: string): never {
	console.error(`Error: ${message}`)
	console.error("Run `bun run dev -- --help` for usage.")
	process.exit(2)
}

function parseOptions(arguments_: string[]): Options | null {
	if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
		console.log(help)
		return null
	}

	const harness = arguments_[0]
	if (harness !== "claude" && harness !== "codex") fail(`unknown command: ${harness}`)

	const flags = new Set(arguments_.slice(1))
	for (const flag of flags) {
		if (!["--check", "--no-launch", "--dry-run", "--json"].includes(flag)) {
			fail(`unknown option: ${flag}`)
		}
	}
	if (flags.has("--json") && !flags.has("--dry-run")) {
		fail("--json requires --dry-run")
	}

	return {
		harness,
		check: flags.has("--check"),
		launch: !flags.has("--no-launch") && !flags.has("--check"),
		dryRun: flags.has("--dry-run"),
		json: flags.has("--json"),
	}
}

function run(command: string[], environment = process.env): void {
	const result = Bun.spawnSync({
		cmd: command,
		cwd: root,
		env: environment,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	})
	if (result.exitCode !== 0) process.exit(result.exitCode)
}

function build(): void {
	run(["bun", "run", "build"])
}

function cachebuster(): string {
	return new Date().toISOString().replaceAll(/[-:TZ.]/g, "").slice(0, 14)
}

function stageCodexPlugin(): string {
	rmSync(stagedPluginRoot, { recursive: true, force: true })
	mkdirSync(stagedPluginRoot, { recursive: true })
	copyPluginPayload(root, stagedPluginRoot)

	const manifestPath = join(stagedPluginRoot, ".codex-plugin", "plugin.json")
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
	manifest.version = `${manifest.version}+codex.local-${cachebuster()}`
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

	const marketplace = {
		name: developmentMarketplaceName,
		interface: { displayName: `${pluginConfig.displayName} Development` },
		plugins: [
			{
				name: pluginName,
				source: { source: "local", path: `./plugins/${pluginName}` },
				policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
				category: "Developer Tools",
			},
		],
	}
	const marketplacePath = join(developmentRoot, ".agents", "plugins", "marketplace.json")
	mkdirSync(join(developmentRoot, ".agents", "plugins"), { recursive: true })
	writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`)
	return manifest.version
}

function codexMarketplaceExists(): boolean {
	const result = Bun.spawnSync({
		cmd: ["codex", "plugin", "marketplace", "list", "--json"],
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	})
	if (result.exitCode !== 0) {
		process.stderr.write(result.stderr)
		process.exit(result.exitCode)
	}
	const output = JSON.parse(result.stdout.toString())
	const marketplace = output.marketplaces.find(
		(marketplace: { name?: string }) => marketplace.name === developmentMarketplaceName,
	)
	if (!marketplace) return false
	if (resolve(marketplace.root) !== resolve(developmentRoot)) {
		throw new Error(
			`Codex marketplace ${developmentMarketplaceName} already points at ${marketplace.root}. Remove or rename that marketplace before continuing.`,
		)
	}
	return true
}

async function runClaude(options: Options): Promise<void> {
	build()
	if (options.check) {
		console.log("Claude development check passed: canonical plugin build is current.")
		return
	}
	if (!options.launch) {
		console.log(
			`Claude source is ready. Launch with: claude --settings ${JSON.stringify(claudeSessionSettings)} --plugin-dir ${JSON.stringify(pluginRoot)}`,
		)
		return
	}

	let rebuildTimer: ReturnType<typeof setTimeout> | undefined
	const watchers = claudeWatchSources.map(({ relativePath, recursive }) =>
		watch(join(root, relativePath), { recursive }, () => {
			if (rebuildTimer) clearTimeout(rebuildTimer)
			rebuildTimer = setTimeout(() => {
				console.error("\nPlugin source changed. Rebuilding portable distribution...")
				build()
				console.error("Build complete. Run /reload-plugins in Claude Code.\n")
			}, 100)
		}),
	)

	const claude = Bun.spawn(
		["claude", "--settings", claudeSessionSettings, "--plugin-dir", pluginRoot],
		{
			cwd: root,
			env: process.env,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		},
	)
	const exitCode = await claude.exited
	for (const watcher of watchers) watcher.close()
	process.exitCode = exitCode
}

function runCodex(options: Options): void {
	build()
	const version = stageCodexPlugin()
	console.log(`Staged complete plugin ${version}`)
	if (options.check) {
		console.log("Codex development check passed: no Codex profile changed.")
		return
	}

	if (!codexMarketplaceExists()) {
		run(["codex", "plugin", "marketplace", "add", developmentRoot])
	}
	run(["codex", "plugin", "add", `${pluginName}@${developmentMarketplaceName}`, "--json"])
	console.error("Codex installed the staged skills, hooks, manifests, and runtime.")
	console.error("A fresh task is the reload boundary.")
	if (options.launch) run(["codex"])
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2))
	if (!options) return

	if (options.dryRun) {
		const plan = {
			harness: options.harness,
			build: "bun run build",
			source: options.harness === "claude" ? pluginRoot : stagedPluginRoot,
			install:
				options.harness === "claude"
					? `claude --settings ${JSON.stringify(claudeSessionSettings)} --plugin-dir ${JSON.stringify(pluginRoot)}`
					: `codex plugin add ${pluginName}@${developmentMarketplaceName}`,
			reload:
				options.harness === "claude"
					? "Run /reload-plugins after the watcher rebuilds"
					: "Start a fresh Codex task after reinstall",
		}
		if (options.json) console.log(JSON.stringify(plan))
		else console.log(Object.values(plan).join("\n"))
	} else if (options.harness === "claude") {
		await runClaude(options)
	} else {
		runCodex(options)
	}
}

if (import.meta.main) await main()
