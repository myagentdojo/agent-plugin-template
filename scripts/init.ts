import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
	renderNativeCapabilityFixtureFor,
	writeNativeCapabilityFixture,
} from "./native-capability-fixture"
import { type PluginConfig, loadPluginConfig, renderGeneratedFiles, writeGeneratedFiles } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const runId = crypto.randomUUID()
const initialVersion = "0.1.0"
const help = `Initialize an agent plugin repository from the template metadata.

Usage:
  bun run init -- --name <kebab-name> [options]

Required:
  --name <name>           Plugin and marketplace identifier

Options:
  --display-name <text>   Human-readable name; derived from --name by default
  --description <text>    Shared plugin description
  --author <text>         Publisher name
  --repository <url>      Canonical GitHub HTTPS source repository
  --canary-actor <login>  GitHub user whose credentials publish canaries (default: repository owner)
  --dry-run               Preview metadata and generated files without writes
  --force                 Reinitialize an already initialized repository
  --json                  Emit one JSON result on stdout
  -h, --help              Show this help

Examples:
  bun run init -- --name dojo-hello --display-name "Dojo Hello" --author "My Agent Dojo" --repository https://github.com/myagentdojo/dojo-hello
  bun run init -- --name private-dojo --repository https://github.com/myagentdojo/private-dojo --dry-run --json

Side effects: writes plugin metadata, generated files, and reset release state.
`

interface Options {
	name: string
	displayName?: string
	description?: string
	author?: string
	repository?: string
	canaryActor?: string
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
		"--canary-actor",
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
		canaryActor: optionValue(arguments_, "--canary-actor"),
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

function validateDisplayName(value: string): string {
	if (!value.trim() || value.length > 30 || /[\u0000-\u001F\u007F]/.test(value)) {
		fail("--display-name must be non-empty, single-line text of at most 30 characters")
	}
	return value
}

function githubRepository(url: string): { owner: string; repository: string } | undefined {
	const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url)
	if (!match) return undefined
	return { owner: match[1], repository: match[2] }
}

function readResetFile(repositoryRoot: string, path: string): string {
	try {
		return readFileSync(resolve(repositoryRoot, path), "utf8")
	} catch {
		fail(`cannot read release reset file ${path}`)
	}
}

function parseResetJson(repositoryRoot: string, path: string): Record<string, any> {
	try {
		return JSON.parse(readResetFile(repositoryRoot, path))
	} catch (error) {
		if (error instanceof SyntaxError) fail(`release reset file ${path} is not valid JSON`)
		throw error
	}
}

function releaseResetFiles(root: string, name: string): Array<{ path: string; contents: string }> {
	const releaseConfig = parseResetJson(root, ".github/release-please-config.json")
	releaseConfig.packages["."]["package-name"] = name
	const packageJson = parseResetJson(root, "package.json")
	packageJson.version = initialVersion

	return [
		{
			path: ".github/release-please-config.json",
			contents: `${JSON.stringify(releaseConfig, null, 2)}\n`,
		},
		{ path: "package.json", contents: `${JSON.stringify(packageJson, null, 2)}\n` },
		{ path: ".github/.release-please-manifest.json", contents: "{}\n" },
		{ path: "CHANGELOG.md", contents: "" },
	]
}

const options = parseOptions(process.argv.slice(2))
if (!options) process.exit(0)

const current = loadPluginConfig(root)
if (!current.template && !options.force) fail("repository is already initialized; pass --force to replace its metadata")

const repository = options.repository ?? current.repository
const github = githubRepository(repository)
if (!github) fail("--repository must be a canonical GitHub HTTPS repository")
const configuredDisplayName = validateDisplayName(
	options.displayName ?? displayName(options.name),
)
const config: PluginConfig = {
	...current,
	template: false,
	name: options.name,
	displayName: configuredDisplayName,
	version: initialVersion,
	description: options.description ?? current.description,
	author: { name: options.author ?? current.author.name },
	repository,
	canary: {
		owner: github.owner,
		actor: options.canaryActor ?? github.owner,
		publicRepository: `${github.repository}-public-canary`,
		privateRepository: `${github.repository}-private-canary`,
	},
}
const generatedFiles = renderGeneratedFiles(config)
const fixtureFiles = renderNativeCapabilityFixtureFor(config.displayName)
const resetFiles = releaseResetFiles(root, config.name)
if (!options.dryRun) {
	writeFileSync(resolve(root, "plugin.config.json"), `${JSON.stringify(config, null, 2)}\n`)
	writeGeneratedFiles(root, config)
	writeNativeCapabilityFixture(root)
	for (const file of resetFiles) writeFileSync(resolve(root, file.path), file.contents)
}

const result = {
	ok: true,
	action: options.dryRun ? "preview" : "initialized",
	runId,
	sideEffects: options.dryRun ? "none" : "repository-files-written",
	plugin: { name: config.name, version: config.version },
	files: [
		"plugin.config.json",
		...generatedFiles.map((file) => file.path),
		...fixtureFiles.map((file) => file.path),
		...resetFiles.map((file) => file.path),
	],
	nextAction: options.dryRun ? "rerun without --dry-run" : "bun run prove:all",
}
if (options.json) console.log(JSON.stringify(result))
else {
	console.log(`${options.dryRun ? "Would initialize" : "Initialized"} ${config.displayName} (${config.name})`)
	console.log(`Next: ${result.nextAction}`)
}
