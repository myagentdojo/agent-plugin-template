import { mkdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const sourceRoot = join(root, "runtime", "src")
const pluginRoot = join(root, "plugin")
const outputDirectory = join(pluginRoot, "runtime")
const pluginVersion = readFileSync(join(root, "runtime", "version.txt"), "utf8").trim()

const codexManifestPath = "plugin/.codex-plugin/plugin.json"
const codexManifest = JSON.parse(readFileSync(join(root, codexManifestPath), "utf8"))
if (codexManifest.version !== pluginVersion) {
	throw new Error(`${codexManifestPath} version does not match runtime/version.txt`)
}

const claudeManifestPath = "plugin/.claude-plugin/plugin.json"
const claudeManifest = JSON.parse(readFileSync(join(root, claudeManifestPath), "utf8"))
if ("version" in claudeManifest) {
	throw new Error(
		`${claudeManifestPath} must omit version so Git marketplace updates use the commit SHA`,
	)
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
	banner: "// Generated from runtime/src/. Edit source, then run bun run build.",
})

if (!result.success) {
	for (const log of result.logs) console.error(log)
	process.exit(1)
}

console.log(join(outputDirectory, "hello-world.js"))
