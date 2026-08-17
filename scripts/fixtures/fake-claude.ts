import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"

interface FakePlugin {
	id: string
	version: string
	scope: string
	enabled: boolean
	installPath: string
}

interface FakeMarketplace {
	name: string
	source: "directory"
	path: string
	installLocation: string
}

interface FakeState {
	plugins: FakePlugin[]
	marketplaces: FakeMarketplace[]
	commands: string[][]
	failCommands?: string[]
	failAfterCommands?: string[]
	installVersions?: Record<string, string>
}

const statePath = process.env.FAKE_CLAUDE_STATE
if (!statePath) throw new Error("FAKE_CLAUDE_STATE is required")
const state = (await Bun.file(statePath).json()) as FakeState
const arguments_ = process.argv.slice(2)
state.commands.push(arguments_)

async function persist(): Promise<void> {
	await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

const commandText = arguments_.join(" ")
const failureIndex = state.failCommands?.indexOf(commandText) ?? -1
if (failureIndex >= 0) {
	state.failCommands?.splice(failureIndex, 1)
	await persist()
	process.stderr.write(`injected failure: ${commandText}\n`)
	process.exit(70)
}
const failureAfterIndex = state.failAfterCommands?.indexOf(commandText) ?? -1
if (failureAfterIndex >= 0) state.failAfterCommands?.splice(failureAfterIndex, 1)

function optionValue(option: string): string | undefined {
	const index = arguments_.indexOf(option)
	return index >= 0 ? arguments_[index + 1] : undefined
}

function marketplaceManifest(root: string): any {
	return JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"))
}

function pluginSource(marketplace: FakeMarketplace, pluginName: string): string {
	const manifest = marketplaceManifest(marketplace.path)
	const plugin = manifest.plugins.find((entry: { name?: string }) => entry.name === pluginName)
	if (!plugin) throw new Error("fake marketplace plugin missing")
	if (typeof plugin.source === "string") return resolve(marketplace.path, plugin.source)
	const match = /printf '%s\\n' '([^']+)'/.exec(plugin.source.command)
	if (!match || plugin.source.mode !== "link") throw new Error("fake command source invalid")
	return match[1]
}

function installPlugin(pluginId: string, scope: string): void {
	const separator = pluginId.lastIndexOf("@")
	const pluginName = pluginId.slice(0, separator)
	const marketplaceName = pluginId.slice(separator + 1)
	const marketplace = state.marketplaces.find((entry) => entry.name === marketplaceName)
	if (!marketplace) throw new Error("fake marketplace missing")
	const sourceRoot = pluginSource(marketplace, pluginName)
	const manifest = JSON.parse(
		readFileSync(join(sourceRoot, ".claude-plugin", "plugin.json"), "utf8"),
	)
	const linked = marketplaceName.endsWith("-dev")
	const version =
		state.installVersions?.[pluginId] ?? (linked ? `${manifest.version}-fake-link` : manifest.version)
	const installPath = join(
		process.env.CLAUDE_CONFIG_DIR!,
		"plugins",
		"cache",
		marketplaceName,
		pluginName,
		version,
	)
	rmSync(installPath, { recursive: true, force: true })
	mkdirSync(installPath, { recursive: true })
	if (linked) {
		for (const entry of readdirSync(sourceRoot)) {
			symlinkSync(join(sourceRoot, entry), join(installPath, entry))
		}
	} else {
		cpSync(sourceRoot, installPath, { recursive: true })
	}
	state.plugins = state.plugins.filter((entry) => !(entry.id === pluginId && entry.scope === scope))
	state.plugins.push({
		id: pluginId,
		version,
		scope,
		enabled: false,
		installPath,
	})
}

if (arguments_[0] === "--version") {
	console.log("2.1.233 (Claude Code)")
} else if (commandText === "plugin list --json") {
	console.log(JSON.stringify(state.plugins))
} else if (commandText === "plugin marketplace list --json") {
	console.log(JSON.stringify(state.marketplaces))
} else if (arguments_[0] === "plugin" && arguments_[1] === "validate") {
	console.log("valid")
} else if (
	arguments_[0] === "plugin" &&
	arguments_[1] === "marketplace" &&
	arguments_[2] === "add"
) {
	const source = resolve(arguments_[3])
	const manifest = marketplaceManifest(source)
	state.marketplaces = state.marketplaces.filter((entry) => entry.name !== manifest.name)
	state.marketplaces.push({
		name: manifest.name,
		source: "directory",
		path: source,
		installLocation: source,
	})
} else if (
	arguments_[0] === "plugin" &&
	arguments_[1] === "marketplace" &&
	arguments_[2] === "remove"
) {
	const name = arguments_[3]
	state.marketplaces = state.marketplaces.filter((entry) => entry.name !== name)
	state.plugins = state.plugins.filter((entry) => !entry.id.endsWith(`@${name}`))
} else if (arguments_[0] === "plugin" && arguments_[1] === "install") {
	installPlugin(arguments_[2], optionValue("--scope") ?? "user")
} else if (arguments_[0] === "plugin" && arguments_[1] === "uninstall") {
	const id = arguments_[2]
	const scope = optionValue("--scope") ?? "user"
	state.plugins = state.plugins.filter((entry) => !(entry.id === id && entry.scope === scope))
} else if (
	arguments_[0] === "plugin" &&
	(arguments_[1] === "enable" || arguments_[1] === "disable")
) {
	const id = arguments_[2]
	const scope = optionValue("--scope") ?? "user"
	const plugin = state.plugins.find((entry) => entry.id === id && entry.scope === scope)
	if (!plugin) throw new Error("fake plugin missing")
	plugin.enabled = arguments_[1] === "enable"
} else if (arguments_[0] === "plugin" && arguments_[1] === "details") {
	console.log("fake component inventory")
} else {
	await persist()
	process.stderr.write(`unsupported fake Claude command: ${commandText}\n`)
	process.exit(64)
}

await persist()
if (failureAfterIndex >= 0) {
	process.stderr.write(`injected post-mutation failure: ${commandText}\n`)
	process.exit(70)
}
