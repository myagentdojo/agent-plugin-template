import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { expect, test } from "bun:test"

import { type PluginConfig, renderGeneratedFiles } from "./plugin-config"
import { copyPluginPayload, pluginPayloadInventory } from "./plugin-files"

const root = resolve(import.meta.dir, "..")
const config = JSON.parse(readFileSync(join(root, "plugin.config.json"), "utf8")) as PluginConfig

test("generation projects one exact native hook declaration per supported client", () => {
	const generated = new Map(
		renderGeneratedFiles(config).map((file) => [file.path, JSON.parse(file.contents)]),
	)

	expect(generated.get("plugin/hooks/claude/hooks.json")).toEqual({
		hooks: {
			SessionStart: [
				{
					hooks: [
						{
							type: "command",
							command:
								'"${CLAUDE_PLUGIN_ROOT}/hooks/native-capability-hook" SessionStart claude',
						},
					],
				},
			],
			Stop: [
				{
					hooks: [
						{
							type: "command",
							command: '"${CLAUDE_PLUGIN_ROOT}/hooks/native-capability-hook" Stop claude',
						},
					],
				},
			],
		},
	})
	expect(generated.get("plugin/hooks/codex/hooks.json")).toEqual({
		hooks: {
			SessionStart: [
				{
					hooks: [
						{
							type: "command",
							command:
								'"${PLUGIN_ROOT}/hooks/native-capability-hook" SessionStart codex',
						},
					],
				},
			],
			Stop: [
				{
					hooks: [
						{
							type: "command",
							command: '"${PLUGIN_ROOT}/hooks/native-capability-hook" Stop codex',
						},
					],
				},
			],
		},
	})
})

test("version-only generation leaves exact hook definitions unchanged", () => {
	const nextVersion = structuredClone(config)
	nextVersion.version = "99.0.0"
	const hookFiles = (value: PluginConfig) =>
		renderGeneratedFiles(value)
			.filter((file) => file.path.startsWith("plugin/hooks/"))
			.map((file) => ({ path: file.path, contents: file.contents }))

	expect(hookFiles(nextVersion)).toEqual(hookFiles(config))
})

test("checked-in manifests expose one coherent tour identity and relative native surfaces", () => {
	const claudeManifest = JSON.parse(
		readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
	)
	const codexManifest = JSON.parse(
		readFileSync(join(root, "plugin", ".codex-plugin", "plugin.json"), "utf8"),
	)

	expect(config.name).toBe("harness-native-plugin-prototype")
	expect(config.defaultPrompts).toEqual(["Run the native plugin capability tour."])
	expect(claudeManifest).toMatchObject({
		name: config.name,
		displayName: config.displayName,
		description: config.description,
		hooks: "./hooks/claude/hooks.json",
	})
	expect(codexManifest).toMatchObject({
		name: config.name,
		description: config.description,
		hooks: "./hooks/codex/hooks.json",
		interface: {
			displayName: config.displayName,
			shortDescription: config.shortDescription,
			longDescription: config.longDescription,
			capabilities: config.capabilities,
			defaultPrompt: config.defaultPrompts,
			brandColor: "#3B5CCC",
			composerIcon: "./assets/composer-icon.svg",
			logo: "./assets/logo.svg",
		},
	})
	for (const manifest of [claudeManifest, codexManifest]) {
		expect(manifest.hooks.startsWith("./")).toBe(true)
		expect(existsSync(join(root, "plugin", manifest.hooks))).toBe(true)
	}
	for (const field of ["composerIcon", "logo"] as const) {
		const path = codexManifest.interface[field]
		expect(path.startsWith("./assets/")).toBe(true)
		expect(existsSync(join(root, "plugin", path))).toBe(true)
	}
})

test("capability tour is one model-only skill with one cross-client reviewer prompt", () => {
	const skillRoot = join(root, "plugin", "skills", "capability-tour")
	const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8")
	const references = readdirSync(join(skillRoot, "references")).sort()
	expect(references).toEqual(["capability-reviewer.md"])
	const reviewer = readFileSync(join(skillRoot, "references", references[0]), "utf8")
	const combined = `${skill}\n${reviewer}`

	for (const label of [
		"native-subagent-via-skill",
		"inline-fallback-unavailable",
		"inline-recovery-delegation-failed",
	]) {
		expect(skill).toContain(label)
	}
	for (const group of [
		"Overall verdict",
		"Evidence matrix",
		"Available portable skills",
		"Next action",
	]) {
		expect(skill).toContain(group)
	}
	for (const evidence of [
		"declaration",
		"direct handler",
		"currentSessionHook",
		"external candidate qualification",
		"delegation delivery",
	]) {
		expect(skill).toContain(evidence)
	}
	expect(skill).toContain("exactly one")
	expect(skill).toContain("three directories above this `SKILL.md`")
	expect(skill).toContain("host-owned")
	expect(skill).toContain("lifecycle mechanics proof")
	expect(skill).toContain(
		"<absolute-installed-plugin-root>/hooks/native-capability-hook Stop <active-client>",
	)
	expect(reviewer).toContain("Do not mutate")
	expect(reviewer).toContain("bounded inputs")
	expect(reviewer).toContain("structured handback")
	expect(reviewer).toContain("Do not select or pin a model")
	expect(reviewer).toContain(
		"<absolute-installed-plugin-root>/hooks/native-capability-hook Stop <active-client>",
	)
	expect(combined).not.toMatch(/\bv?\d+\.\d+\.\d+\b/)
	expect(combined).not.toMatch(/default[_ -]?agent|model:\s|model_name|modelName/i)

	const catalog = JSON.parse(readFileSync(join(root, "runtime", "skill-catalog.json"), "utf8"))
	const bundles = JSON.parse(
		readFileSync(join(root, "plugin", "runtime", "bundle-inventory.json"), "utf8"),
	)
	expect(catalog.skills).not.toHaveProperty("capability-tour")
	expect(bundles.bundles).not.toHaveProperty("capability-tour")
	expect(existsSync(join(root, "plugin", "bin", "capability-tour"))).toBe(false)
})

test("payload contains only the named capability sidecars and no standalone agent surface", () => {
	const inventory = pluginPayloadInventory(root)
	expect(inventory.filter((path) => path.startsWith("hooks/"))).toEqual([
		"hooks/claude/hooks.json",
		"hooks/codex/hooks.json",
		"hooks/fixture/lifecycle-mechanics-proof.generated.json",
		"hooks/fixture/lifecycle-mechanics-proof.source.json",
		"hooks/native-capability-hook",
	])
	expect(inventory.filter((path) => path.startsWith("assets/"))).toEqual([
		"assets/composer-icon.svg",
		"assets/logo.svg",
	])
	for (const forbidden of [
		"agents/",
		"apps/",
		"channels/",
		"connectors/",
		"extensions/",
		"mcp/",
		"monitors/",
		"settings/",
		"themes/",
	]) {
		expect(inventory.some((path) => path.startsWith(forbidden))).toBe(false)
	}
})

test("identity-neutral assets have deterministic packaged bytes", () => {
	const expected = {
		"assets/composer-icon.svg":
			"70bd6e6077d47ac739f1669e2694b07fe3edeb21bbddb537882c3a60acb0c850",
		"assets/logo.svg": "4f61b6d0d1fb75695fc882ce99cf3e5ad750b6e5ca0eb54a62534d2ee38e8a9b",
	}
	for (const [path, digest] of Object.entries(expected)) {
		const bytes = readFileSync(join(root, "plugin", path))
		expect(bytes.byteLength).toBeLessThan(1_024)
		expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(digest)
		expect(bytes.toString()).not.toMatch(/Harness Plugin Prototype|harness-native-plugin-prototype/)
	}
})

test("static capability sidecars do not own the plugin version", () => {
	for (const path of [
		"assets/composer-icon.svg",
		"assets/logo.svg",
		"hooks/claude/hooks.json",
		"hooks/codex/hooks.json",
		"skills/capability-tour/SKILL.md",
		"skills/capability-tour/references/capability-reviewer.md",
	]) {
		expect(readFileSync(join(root, "plugin", path), "utf8")).not.toMatch(
			/\bv?\d+\.\d+\.\d+\b/,
		)
	}
})

test("repository docs separate lifecycle mechanics from fresh-native qualification", () => {
	const readme = readFileSync(join(root, "README.md"), "utf8")
	const context = readFileSync(join(root, "CONTEXT.md"), "utf8")
	const custody = readFileSync(join(root, "docs", "adr", "0005-shared-runtime-custody.md"), "utf8")
	const capability = readFileSync(
		join(root, "docs", "adr", "0008-native-plugin-capability-tour.md"),
		"utf8",
	)
	const docs = `${readme}\n${context}\n${custody}\n${capability}`

	expect(docs).not.toMatch(/no lifecycle hooks|lifecycle hooks \| None/i)
	for (const claim of [
		"lifecycle mechanics proof",
		"SessionStart",
		"Stop",
		"native activation",
		"exact hook definition",
		"disabled or untrusted",
	]) {
		expect(docs).toContain(claim)
	}
	expect(docs).toMatch(/fail[- ]open/)
	for (const exclusion of ["No MCP", "No standalone agent", "No telemetry"]) {
		expect(capability).toContain(exclusion)
	}
	expect(capability).toMatch(/production integrity or security\s+guarantee/)
	expect(capability).not.toMatch(/\bv?\d+\.\d+\.\d+\b/)
})

test("recursive package copy preserves the complete payload inventory", () => {
	const installation = mkdtempSync(join(tmpdir(), "capability-tour-payload-"))
	const installedRoot = join(installation, "plugin")
	try {
		const sourceInventory = pluginPayloadInventory(root)
		expect(copyPluginPayload(root, installedRoot)).toEqual(sourceInventory)
		expect(pluginPayloadInventory(installation)).toEqual(sourceInventory)
	} finally {
		rmSync(installation, { recursive: true, force: true })
	}
})
