import { resolve } from "node:path"

import {
	checkNativeCapabilityFixture,
	writeNativeCapabilityFixture,
} from "./native-capability-fixture"
import { checkGeneratedFiles, loadPluginConfig, writeGeneratedFiles } from "./plugin-config"
import {
	checkRuntimeCustodyFiles,
	writeRuntimeCustodyFiles,
} from "./runtime-custody-config"

const root = resolve(import.meta.dir, "..")
const arguments_ = process.argv.slice(2)
const check = arguments_.includes("--check")
const json = arguments_.includes("--json")

if (arguments_.includes("--help") || arguments_.includes("-h")) {
	console.log(`Generate native manifests, hook declarations, lifecycle proof fixture, and runtime-custody projections from canonical sources.

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
if (check) {
	const drifted = [
		...checkGeneratedFiles(root, config),
		...checkNativeCapabilityFixture(root),
		...checkRuntimeCustodyFiles(root),
	]
	if (drifted.length > 0) {
		console.error(`Generated files differ from canonical sources:\n${drifted.join("\n")}`)
		console.error("Run `bun run generate` and commit the generated files.")
		process.exit(1)
	}
}
const files = check
	? []
	: [
			...writeGeneratedFiles(root, config),
			...writeNativeCapabilityFixture(root),
			...writeRuntimeCustodyFiles(root),
		]
const result = {
	ok: true,
	action: check ? "checked" : "generated",
	sideEffects: check ? "none" : "repository-files-written",
	plugin: { name: config.name, version: config.version },
	files: check ? [] : files.map((file) => file.path),
}
if (json) console.log(JSON.stringify(result))
else console.log(check ? "Generated files are current." : `Generated ${files.length} files.`)
