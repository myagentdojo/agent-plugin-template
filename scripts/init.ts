import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { type PluginConfig, loadPluginConfig, renderGeneratedFiles, writeGeneratedFiles } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const runId = crypto.randomUUID()
const help = `Initialize an agent plugin repository from the template metadata.

Usage:
  bun run init -- --name <kebab-name> [options]

Required:
  --name <name>           Plugin and marketplace identifier

Options:
  --display-name <text>   Human-readable name; derived from --name by default
  --description <text>    Shared plugin description
  --author <text>         Publisher name
  --repository <url>      Absolute HTTPS source repository
  --dry-run               Preview metadata and generated files without writes
  --force                 Reinitialize an already initialized repository
  --json                  Emit one JSON result on stdout
  -h, --help              Show this help

Examples:
  bun run init -- --name dojo-hello --display-name "Dojo Hello" --author "My Agent Dojo" --repository https://github.com/myagentdojo/dojo-hello
  bun run init -- --name private-dojo --repository https://github.com/myagentdojo/private-dojo --dry-run --json

Side effects: writes plugin.config.json and four generated manifest files.
`

interface Options {
	name: string
	displayName?: string
	description?: string
	author?: string
	repository?: string
	dryRun: boolean
	force: boolean
	json: boolean
}

function fail(message: string): never {
	if (process.argv.includes("--json")) {
		console.log(
			JSON.stringify({
				ok: false,
				category: "usage",
				message,
				runId,
				retrySafe: true,
				nextAction: "bun run init -- --help",
			}),
		)
		process.exit(2)
	}
	console.error(`init: ${message}`)
	console.error("Run `bun run init -- --help` for usage.")
	process.exit(2)
}

function optionValue(arguments_: string[], name: string): string | undefined {
	const index = arguments_.indexOf(name)
	if (index === -1) return undefined
	const value = arguments_[index + 1]
	if (!value || value.startsWith("--")) fail(`${name} requires a value`)
	return value
}

function parseOptions(arguments_: string[]): Options | null {
	if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
		console.log(help)
		return null
	}
	const supported = new Set([
		"--name",
		"--display-name",
		"--description",
		"--author",
		"--repository",
		"--dry-run",
		"--force",
		"--json",
	])
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index]
		if (!supported.has(argument)) fail(`unknown option: ${argument}`)
		if (!["--dry-run", "--force", "--json"].includes(argument)) index += 1
	}
	const name = optionValue(arguments_, "--name")
	if (!name) fail("--name is required")
	return {
		name,
		displayName: optionValue(arguments_, "--display-name"),
		description: optionValue(arguments_, "--description"),
		author: optionValue(arguments_, "--author"),
		repository: optionValue(arguments_, "--repository"),
		dryRun: arguments_.includes("--dry-run"),
		force: arguments_.includes("--force"),
		json: arguments_.includes("--json"),
	}
}

function displayName(name: string): string {
	return name
		.split("-")
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ")
}

function githubRepository(url: string): { owner: string; repository: string } | undefined {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
	if (!match) return undefined
	return { owner: match[1], repository: match[2] }
}

const options = parseOptions(process.argv.slice(2))
if (!options) process.exit(0)

const current = loadPluginConfig(root)
if (!current.template && !options.force) fail("repository is already initialized; pass --force to replace its metadata")

const repository = options.repository ?? current.repository
const github = githubRepository(repository)
const config: PluginConfig = {
	...current,
	template: false,
	name: options.name,
	displayName: options.displayName ?? displayName(options.name),
	description: options.description ?? current.description,
	author: { name: options.author ?? current.author.name },
	repository,
	canary: github
		? {
				owner: github.owner,
				publicRepository: `${github.repository}-public-canary`,
				privateRepository: `${github.repository}-private-canary`,
			}
		: current.canary,
}
const files = renderGeneratedFiles(config)
if (!options.dryRun) {
	writeFileSync(resolve(root, "plugin.config.json"), `${JSON.stringify(config, null, 2)}\n`)
	writeGeneratedFiles(root, config)
}

const result = {
	ok: true,
	action: options.dryRun ? "preview" : "initialized",
	runId,
	sideEffects: options.dryRun ? "none" : "repository-files-written",
	plugin: { name: config.name, version: config.version },
	files: ["plugin.config.json", ...files.map((file) => file.path)],
	nextAction: options.dryRun ? "rerun without --dry-run" : "bun run prove:all",
}
if (options.json) console.log(JSON.stringify(result))
else {
	console.log(`${options.dryRun ? "Would initialize" : "Initialized"} ${config.displayName} (${config.name})`)
	console.log(`Next: ${result.nextAction}`)
}
