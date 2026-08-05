import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

const help = `Validate release metadata and workflow invariants.

Usage:
  bun run release:validate [--json]
  bun run release:validate --help

Options:
  --json       Emit one JSON result to stdout.
  -h, --help   Show this help.

Side effects: none. Reads repository files only.
`

const arguments_ = process.argv.slice(2)
if (arguments_.includes("--help") || arguments_.includes("-h")) {
	process.stdout.write(help)
	process.exit(0)
}

const unknown = arguments_.filter((argument) => argument !== "--json")
if (unknown.length > 0) {
	console.error(`release:validate: unknown option: ${unknown[0]}`)
	console.error("Run `bun run release:validate -- --help` for usage.")
	process.exit(2)
}

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(join(root, path), "utf8"))
}

function fail(message: string): never {
	console.error(`release:validate: ${message}`)
	process.exit(1)
}

const packageJson = readJson("package.json")
const pluginConfig = readJson("plugin.config.json")
const claudeMarketplace = readJson(".claude-plugin/marketplace.json")
const claudeManifest = readJson("plugin/.claude-plugin/plugin.json")
const codexManifest = readJson("plugin/.codex-plugin/plugin.json")
const releaseManifest = readJson(".github/.release-please-manifest.json")
const releaseConfig = readJson(".github/release-please-config.json")
const generatedRuntime = readFileSync(join(root, "plugin/runtime/hello-world.js"), "utf8")
const releaseWorkflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8")
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")

const version = pluginConfig.version
const releasedVersion = releaseManifest["."]
const releaseState = releasedVersion === undefined ? "bootstrap" : "released"
const releaseManifestKeys = Object.keys(releaseManifest)
const versionSurfaces = [
	["package.json", packageJson.version],
	["Claude marketplace metadata", claudeMarketplace.metadata?.version],
	["Claude manifest", claudeManifest.version],
	["Codex manifest", codexManifest.version],
] as const

for (const [name, actual] of versionSurfaces) {
	if (actual !== version) fail(`${name} version ${String(actual)} does not match plugin.config.json ${version}`)
}

if (releaseState === "bootstrap") {
	if (releaseManifestKeys.length !== 0) fail("bootstrap release-please manifest must be empty")
	if (version !== "0.1.0") fail("an empty release-please manifest is valid only while bootstrapping v0.1.0")
} else if (releasedVersion !== version) {
	fail(`release-please manifest version ${String(releasedVersion)} does not match plugin.config.json ${version}`)
} else if (releaseManifestKeys.length !== 1) {
	fail("release-please manifest must contain only the root package version")
}

if (/^## Changelog$/m.test(changelog)) {
	fail("CHANGELOG.md must not contain a duplicate Changelog heading")
}
if (releaseState === "bootstrap" && changelog.trim() !== "# Changelog") {
	fail("bootstrap CHANGELOG.md must contain only its top-level heading")
}

if (packageJson.private !== true || "publish" in (packageJson.scripts ?? {})) {
	fail("package.json must remain private and must not define an npm publish script")
}

const packageRelease = releaseConfig.packages?.["."]
if (packageRelease?.["release-type"] !== "node") fail("release type must be node")
if (packageRelease?.["initial-version"] !== "0.1.0") {
	fail("initial release version must be pinned to 0.1.0")
}
if (releaseConfig["include-component-in-tag"] !== false) {
	fail("release tags must use the single-plugin vX.Y.Z form")
}
if (packageRelease?.["changelog-path"] !== "CHANGELOG.md") {
	fail("release-please must own CHANGELOG.md")
}

const expectedExtraFiles = new Set([
	"plugin.config.json::$.version",
	".claude-plugin/marketplace.json::$.metadata.version",
	"plugin/.claude-plugin/plugin.json::$.version",
	"plugin/.codex-plugin/plugin.json::$.version",
	"plugin/runtime/hello-world.js::generic",
])
const configuredExtraFiles = new Set(
	(packageRelease?.["extra-files"] ?? []).map((entry: Record<string, string>) =>
		entry.type === "generic"
			? `${entry.path}::generic`
			: `${entry.path}::${entry.jsonpath}`,
	),
)
for (const expected of expectedExtraFiles) {
	if (!configuredExtraFiles.has(expected)) fail(`release-please extra-files is missing ${expected}`)
}

for (const marker of [
	"x-release-please-start-version",
	`const PLUGIN_VERSION = ${JSON.stringify(version)};`,
	"x-release-please-end",
]) {
	if (!generatedRuntime.includes(marker)) fail(`generated runtime is missing ${marker}`)
}

const actionReferences = [...releaseWorkflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)].map(
	(match) => match[1],
)
if (actionReferences.length === 0 || actionReferences.some((reference) => !/^[a-f0-9]{40}$/.test(reference))) {
	fail("release workflow actions must be pinned to full commit SHAs")
}
for (const required of [
	"bun run prove:all",
	"git diff --exit-code -- plugin/runtime/hello-world.js",
	"ubuntu-24.04-arm",
	"macos-15-intel",
	"needs: package",
	"actions: read",
	"release_tag:",
	"inputs.release_tag || github.sha",
	"gh release upload",
	"actions/attest",
	"github.event.repository.private == false",
]) {
	if (!releaseWorkflow.includes(required)) fail(`release workflow is missing ${required}`)
}

const result = {
	ok: true,
	version,
	releaseState,
	changelog: "CHANGELOG.md",
	tag: `v${version}`,
	npmPublicationRequired: false,
	versionSurfaces: [
		...versionSurfaces.map(([name]) => name),
		...(releaseState === "released" ? ["release-please manifest"] : []),
	],
}
if (arguments_.includes("--json")) console.log(JSON.stringify(result))
else console.log(`Release metadata valid for v${version}. No npm publication required.`)
