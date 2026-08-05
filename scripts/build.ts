import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { loadPluginConfig } from "./plugin-config"

const root = resolve(import.meta.dir, "..")
const sourceRoot = join(root, "runtime", "src")
const pluginRoot = join(root, "plugin")
const outputDirectory = join(pluginRoot, "runtime")
const pluginConfig = loadPluginConfig(root)

for (const manifestPath of [
	"plugin/.claude-plugin/plugin.json",
	"plugin/.codex-plugin/plugin.json",
]) {
	const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"))
	if (manifest.version !== pluginConfig.version) {
		throw new Error(`${manifestPath} version does not match plugin.config.json`)
	}
}

mkdirSync(outputDirectory, { recursive: true })
const result = await Bun.build({
	entrypoints: [join(sourceRoot, "quickjs-adapter.ts")],
	outdir: outputDirectory,
	naming: "hello-world.js",
	target: "browser",
	format: "esm",
	external: ["qjs:std"],
	minify: true,
	banner: `// Generated from runtime/src/. Edit source, then run bun run build.
// x-release-please-start-version
const PLUGIN_VERSION = ${JSON.stringify(pluginConfig.version)};
// x-release-please-end`,
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}

console.log(join(outputDirectory, "hello-world.js"))
