import { resolve } from "node:path"

import { checkGeneratedFiles, loadPluginConfig, writeGeneratedFiles } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const arguments_ = process.argv.slice(2)
const check = arguments_.includes("--check")
const json = arguments_.includes("--json")

if (arguments_.includes("--help") || arguments_.includes("-h")) {
	console.log(`Generate native harness manifests from plugin.config.json.

Usage:
  bun run generate
  bun run generate:check

Options:
  --check       Fail when generated files differ without writing
  --json        Emit one JSON result on stdout
  -h, --help    Show this help
`)
	process.exit(0)
}
for (const argument of arguments_) {
	if (!["--check", "--json"].includes(argument)) {
		console.error(`generate: unknown option: ${argument}`)
		process.exit(2)
	}
}

const config = loadPluginConfig(root)
const drifted = checkGeneratedFiles(root, config)
if (check && drifted.length > 0) {
	console.error(`Generated manifests differ from plugin.config.json:\n${drifted.join("\n")}`)
	console.error("Run `bun run generate` and commit the generated files.")
	process.exit(1)
}
const files = check ? [] : writeGeneratedFiles(root, config)
const result = {
	ok: true,
	action: check ? "checked" : "generated",
	sideEffects: check ? "none" : "repository-files-written",
	plugin: { name: config.name, version: config.version },
	files: check ? checkGeneratedFiles(root, config) : files.map((file) => file.path),
}
if (json) console.log(JSON.stringify(result))
else console.log(check ? "Generated manifests are current." : `Generated ${files.length} manifests.`)
